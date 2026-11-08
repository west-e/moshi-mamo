import type { AlertLevel } from "./userView.ts";

// 音は Web Audio で合成したチャイムだけ。文の読み上げはしない（通話の相手の声と重なって聞き取りにくくなるため）。
let ctx: AudioContext | null = null;

export function enableSound(): boolean {
  ctx ??= new AudioContext();
  void ctx.resume();
  return ctx.state !== "closed";
}

export function soundEnabled(): boolean {
  return ctx !== null;
}

function tone(freq: number, start: number, duration: number, gain = 0.25) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  const t = ctx.currentTime + start;
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(gain, t + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.001, t + duration);
  osc.connect(amp).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + duration);
}

export function playAlert(level: Exclude<AlertLevel, "none">) {
  if (!ctx) return;
  if (level === "caution") {
    tone(660, 0, 0.35);
    tone(880, 0.4, 0.5);
  } else {
    for (let i = 0; i < 3; i++) {
      tone(880, i * 0.5, 0.25, 0.35);
      tone(660, i * 0.5 + 0.25, 0.25, 0.35);
    }
  }
}
