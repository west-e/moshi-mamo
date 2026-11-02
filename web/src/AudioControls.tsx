import { useEffect, useRef, useState } from "react";
import { type AudioInput, type Segment, startFile, startMic, transcribe } from "./audioInput.ts";
import type { CallSession } from "./useCallSession.ts";

type Health = { model: string; device: string } | null;

// 音声入力（架空の録音音声 / 同意したマイク）。文字にした発話は話者「不明」として判定に流す。
export function AudioControls({ session }: { session: CallSession }) {
  const { addUtterance } = session;
  const [health, setHealth] = useState<Health | "down">(null);
  const [mode, setMode] = useState<"idle" | "mic" | "file">("idle");
  const [askConsent, setAskConsent] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState("");
  const input = useRef<AudioInput | null>(null);
  const queue = useRef(Promise.resolve()); // 発話の順番を崩さないよう、文字起こしは順番に

  useEffect(() => {
    fetch("/stt/health")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setHealth)
      .catch(() => setHealth("down"));
    return () => input.current?.stop();
  }, []);

  const onSegment = (seg: Segment) => {
    setPending((p) => p + 1);
    queue.current = queue.current.then(async () => {
      try {
        const r = await transcribe(seg.wav);
        if (r.text) addUtterance("unknown", r.text, { sttMs: r.ms, speechEndedAt: seg.endedAt });
      } catch (e) {
        setError(e instanceof Error ? e.message : "文字起こしに失敗しました");
      } finally {
        setPending((p) => p - 1);
      }
    });
  };

  const stop = () => {
    input.current?.stop();
    input.current = null;
    setMode("idle");
    setSpeaking(false);
  };

  const begin = async (kind: "mic" | "file", file?: File) => {
    setError("");
    try {
      input.current =
        kind === "mic"
          ? await startMic(onSegment, setSpeaking)
          : await startFile(file!, onSegment, () => { input.current = null; setMode("idle"); setSpeaking(false); }, setSpeaking);
      setMode(kind);
    } catch (e) {
      setError(e instanceof Error ? e.message : "音声入力を開始できませんでした");
    }
  };

  const ready = health !== null && health !== "down";

  return (
    <div className="audio-controls">
      <div className="audio-row">
        <strong>音声入力</strong>
        <span className="dev-meta">
          {health === null ? "文字起こしサーバー確認中…"
            : health === "down" ? "文字起こしサーバー未起動（npm run stt）"
            : `ローカル文字起こし: ${health.model} / ${health.device}`}
        </span>
      </div>
      <div className="audio-row">
        {mode === "idle" ? (
          <>
            <label className={`file-button ${ready ? "" : "disabled"}`}>
              📁 架空の録音音声を流す
              <input
                type="file"
                accept="audio/*"
                disabled={!ready}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void begin("file", f); }}
              />
            </label>
            <button disabled={!ready} onClick={() => setAskConsent(true)}>🎤 マイクを使う</button>
          </>
        ) : (
          <button onClick={stop}>⏹ 音声入力を止める</button>
        )}
        {mode !== "idle" && (
          <span className={`pill-dev ${speaking ? "on" : ""}`}>
            {mode === "mic" ? "マイク" : "録音音声"}: {speaking ? "発話中" : "待機"}{pending > 0 && ` / 文字起こし中 ${pending}`}
          </span>
        )}
      </div>
      {askConsent && mode === "idle" && (
        <div className="consent">
          <p>
            マイクの音声は、このパソコンの中だけで文字にします。音声は保存せず、外部にも送りません。
            文字にした会話は、判定のため Claude API（Anthropic）に送ります。会話の文字も保存しません。
            実在の人の通話や個人情報は話さないでください（架空の会話で試してください）。
          </p>
          <button onClick={() => { setAskConsent(false); void begin("mic"); }}>同意して開始</button>
          <button onClick={() => setAskConsent(false)}>やめる</button>
        </div>
      )}
      {error && <p className="audio-error">{error}</p>}
    </div>
  );
}
