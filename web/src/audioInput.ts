// 音声入力: マイク（同意後）または架空の録音音声ファイルを、無音で発話ごとに区切り、
// ローカルの文字起こしサーバー（stt/server.py）へ送る。
// 音声はブラウザとこのパソコンの中だけで扱い、保存しない。

export type Segment = { wav: Blob; endedAt: number; durationMs: number };
export type AudioInput = { stop: () => void };

// 区切りのパラメータ（20ms ごとの音量で判断）
const FRAME_MS = 20;
const SILENCE_TO_END_MS = 600; // この長さの無音で1発話の終わりとみなす
const MIN_SPEECH_MS = 300; // これより短い音は雑音として捨てる
const MAX_SEGMENT_MS = 15_000; // 長すぎる発話は途中で区切る
const PRE_ROLL_MS = 200; // 話し始めの取りこぼしを防ぐ

// AudioWorklet: 入力をそのままメインスレッドへ渡すだけ
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("moshi-tap", Tap);
`;

async function setup(ctx: AudioContext, source: AudioNode, onSegment: (s: Segment) => void, onLevel?: (speaking: boolean) => void) {
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const tap = new AudioWorkletNode(ctx, "moshi-tap");
  source.connect(tap);
  // 出力先につないでおかないと処理が止まるブラウザがあるため、音量0でつなぐ
  const mute = ctx.createGain();
  mute.gain.value = 0;
  tap.connect(mute).connect(ctx.destination);

  const frameLen = Math.round((ctx.sampleRate * FRAME_MS) / 1000);
  let pending: Samples = new Float32Array(0);
  const preRoll: Float32Array[] = [];
  let speech: Float32Array[] = [];
  let speaking = false;
  let silentMs = 0;
  let speechMs = 0;
  let noise = 0.005; // 周囲の雑音の大きさ（ゆっくり追従）

  const flush = () => {
    if (speaking && speechMs >= MIN_SPEECH_MS) {
      const durationMs = speech.length * FRAME_MS;
      const audio = concat(speech);
      void toWav16k(audio, ctx.sampleRate).then((wav) => onSegment({ wav, endedAt: performance.now(), durationMs }));
    }
    speaking = false;
    speech = [];
    silentMs = 0;
    speechMs = 0;
    onLevel?.(false);
  };

  tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
    pending = concat([pending, e.data]);
    while (pending.length >= frameLen) {
      const frame = pending.slice(0, frameLen);
      pending = pending.slice(frameLen);
      const rms = Math.sqrt(frame.reduce((a, x) => a + x * x, 0) / frame.length);
      const loud = rms > Math.max(0.01, noise * 3);
      if (!loud) noise = noise * 0.95 + rms * 0.05;

      if (!speaking) {
        preRoll.push(frame);
        if (preRoll.length > PRE_ROLL_MS / FRAME_MS) preRoll.shift();
        if (loud) {
          speaking = true;
          speech = [...preRoll];
          preRoll.length = 0;
          onLevel?.(true);
        }
        continue;
      }
      speech.push(frame);
      if (loud) {
        speechMs += FRAME_MS;
        silentMs = 0;
      } else {
        silentMs += FRAME_MS;
      }
      if (silentMs >= SILENCE_TO_END_MS || speech.length * FRAME_MS >= MAX_SEGMENT_MS) flush();
    }
  };
  return { tap, flush };
}

export async function startMic(onSegment: (s: Segment) => void, onLevel?: (speaking: boolean) => void): Promise<AudioInput> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const { flush } = await setup(ctx, source, onSegment, onLevel);
  return {
    stop: () => {
      flush();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

// 架空の録音音声: スピーカーで再生しながら、同じ区切り処理に流す
export async function startFile(
  file: Blob,
  onSegment: (s: Segment) => void,
  onEnd: () => void,
  onLevel?: (speaking: boolean) => void,
): Promise<AudioInput> {
  const ctx = new AudioContext();
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  const { flush } = await setup(ctx, source, onSegment, onLevel);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    flush();
    try {
      source.stop();
    } catch {
      /* 再生前・再生後 */
    }
    // 最後の区切りの WAV 変換が終わるのを待ってから閉じる
    setTimeout(() => void ctx.close(), 1500);
    onEnd();
  };
  source.onended = stop;
  source.start();
  return { stop };
}

type Samples = Float32Array<ArrayBuffer>;

function concat(parts: Float32Array[]): Samples {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function toWav16k(samples: Samples, sampleRate: number): Promise<Blob> {
  // ブラウザの再サンプリングで 16kHz にする
  const length = Math.ceil((samples.length * 16000) / sampleRate);
  const offline = new OfflineAudioContext(1, length, 16000);
  const buf = offline.createBuffer(1, samples.length, sampleRate);
  buf.copyToChannel(samples, 0);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start();
  const pcm = (await offline.startRendering()).getChannelData(0);

  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, 16000, true);
  out.setUint32(28, 32000, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i]!)) * 0x7fff, true);
  return new Blob([out.buffer], { type: "audio/wav" });
}

export type SttResult = { text: string; dropped: boolean; ms: number; audioMs: number; model: string; device: string };

export async function transcribe(wav: Blob): Promise<SttResult> {
  const res = await fetch("/stt/transcribe", { method: "POST", body: wav, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`文字起こしに失敗しました (HTTP ${res.status})`);
  return (await res.json()) as SttResult;
}
