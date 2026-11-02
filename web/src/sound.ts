import type { AlertLevel } from "./userView.ts";

// 音は Web Audio で合成し、読み上げは固定文のみ（会話本文は読み上げない）。
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

const SPOKEN: Record<"caution" | "warning", string> = {
  caution: "ちょっと待ってください。すぐに決めずに、いったん電話を切って確かめましょう。",
  warning: "詐欺のおそれがあります。お金やカードは渡さず、電話を切って家族に相談してください。",
};

export function playAlert(level: Exclude<AlertLevel, "none">, speak: boolean) {
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
  if (speak && "speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance(SPOKEN[level]);
    u.lang = "ja-JP";
    u.rate = 0.9;
    setTimeout(() => speechSynthesis.speak(u), level === "warning" ? 1600 : 1000);
  }
}
