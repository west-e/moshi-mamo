"""ローカル文字起こしサーバー（faster-whisper）。

音声はこのパソコンの中だけで文字にする。外部へは送らず、保存もしない。
ブラウザが発話ごとに区切った音声（WAV, 16kHz モノラル, 16bit）を POST /transcribe で受け取り、文字を返す。
127.0.0.1 だけで待ち受ける。

起動: .venv/Scripts/python stt/server.py
環境変数: MOSHI_STT_MODEL（既定: GPU なら large-v3-turbo、CPU なら small）, MOSHI_STT_PORT（既定 8788）
"""

import io
import json
import os
import sys
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

import numpy as np


def add_cuda_dll_dirs() -> None:
    # pip で入れた cuBLAS / cuDNN の DLL を Windows で見つけられるようにする
    if os.name != "nt":
        return
    nvidia = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    for bin_dir in nvidia.glob("*/bin"):
        os.add_dll_directory(str(bin_dir))
        os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ["PATH"]


add_cuda_dll_dirs()
from faster_whisper import WhisperModel  # noqa: E402  (DLL の場所を先に登録する)


def load_model() -> tuple[WhisperModel, str, str]:
    requested = os.environ.get("MOSHI_STT_MODEL")
    try:
        name = requested or "large-v3-turbo"
        model = WhisperModel(name, device="cuda", compute_type="float16")
        # 初回の推論で CUDA まわりの問題が出ることがあるので、ここで確かめる
        list(model.transcribe(np.zeros(16000, dtype=np.float32), language="ja")[0])
        return model, name, "cuda"
    except Exception as error:  # GPU が使えなければ CPU で動かす
        print(f"[stt] GPU を使えないため CPU で動かします: {error}", flush=True)
        name = requested or "small"
        return WhisperModel(name, device="cpu", compute_type="int8"), name, "cpu"


MODEL, MODEL_NAME, DEVICE = load_model()
LOCK = Lock()  # モデルは1つなので、同時の文字起こしは順番に処理する

# 無音や雑音から Whisper が作りがちな定型文。発話として扱わない
HALLUCINATIONS = ("ご視聴ありがとうございました", "チャンネル登録", "お疲れ様でした。", "ありがとうございました。")


def read_wav(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data)) as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("WAV は 16kHz・モノラル・16bit にしてください")
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return pcm.astype(np.float32) / 32768.0


def transcribe(audio: np.ndarray) -> dict:
    started = time.perf_counter()
    with LOCK:
        segments, _ = MODEL.transcribe(
            audio,
            language="ja",
            beam_size=1,
            condition_on_previous_text=False,
            without_timestamps=True,
        )
        texts = [s.text.strip() for s in segments if s.no_speech_prob < 0.6]
    text = "".join(texts).strip()
    dropped = text == "" or any(text == h or text.startswith(h) for h in HALLUCINATIONS)
    return {
        "text": "" if dropped else text,
        "dropped": dropped,
        "ms": round((time.perf_counter() - started) * 1000),
        "audioMs": round(len(audio) / 16),
        "model": MODEL_NAME,
        "device": DEVICE,
    }


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, body: dict) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path == "/stt/health":
            self._json(200, {"ok": True, "model": MODEL_NAME, "device": DEVICE})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/stt/transcribe":
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 16000 * 2 * 60:  # 1発話は最大60秒
            return self._json(400, {"error": "音声の長さが不正です"})
        try:
            result = transcribe(read_wav(self.rfile.read(length)))
        except ValueError as error:
            return self._json(400, {"error": str(error)})
        # 文字起こしの本文はログに出さない
        print(f"[stt] audio={result['audioMs']}ms took={result['ms']}ms dropped={result['dropped']}", flush=True)
        self._json(200, result)

    def log_message(self, format: str, *args) -> None:  # 既定のアクセスログは出さない
        pass


if __name__ == "__main__":
    port = int(os.environ.get("MOSHI_STT_PORT", "8788"))
    print(f"[stt] http://127.0.0.1:{port} model={MODEL_NAME} device={DEVICE}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
