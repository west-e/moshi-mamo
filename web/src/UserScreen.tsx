import { useEffect, useRef, useState } from "react";
import { enableSound, playAlert, soundEnabled } from "./sound.ts";
import { type AlertLevel, type UserView, faceOf } from "./userView.ts";

const REPEAT_MS = 8000; // 強い注意のチャイムを繰り返す間隔

// 利用者向け画面。大きな見出しと短い行動案内だけを出す。
export function UserScreen({ view }: { view: UserView }) {
  const face = faceOf(view);
  const [sound, setSound] = useState(soundEnabled());
  const [muted, setMuted] = useState(false);

  // 注意が強まった瞬間だけチャイムを鳴らす（文は読み上げず、画面を見てもらう）
  const prev = useRef<AlertLevel | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = view.latched;
    if (!sound || view.latched === before) return;
    if (view.latched === "warning" || (view.latched === "caution" && before !== "warning")) {
      playAlert(view.latched);
    }
  }, [view.latched, sound]);

  // 強い注意の間は、チャイムを繰り返す（「チャイムを止める」で止められる。通話が変われば元に戻る）
  useEffect(() => {
    if (view.latched !== "warning") setMuted(false);
  }, [view.latched]);
  useEffect(() => {
    if (!sound || muted || view.latched !== "warning") return;
    const timer = setInterval(() => playAlert("warning"), REPEAT_MS);
    return () => clearInterval(timer);
  }, [sound, muted, view.latched]);
  const repeating = sound && !muted && view.latched === "warning";

  return (
    <section className={`user-screen tone-${face.tone}`} aria-live="assertive">
      <div className="user-status">
        <span className="brand"><img src="/logo-mark.svg" alt="" /> もしまも</span>
        <span className="status-right">
          {view.recording && <span className="pill">● 記録中（このパソコンの中だけ）</span>}
          {view.evaluating && <span className="pill">確認中…</span>}
        </span>
      </div>
      <h1 className="user-headline">{face.headline}</h1>
      <ul className="user-lines">
        {face.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {face.note && <p className="user-note">{face.note}</p>}
      <div className="user-controls">
        {repeating ? (
          <button onClick={() => setMuted(true)}>🔕 チャイムを止める</button>
        ) : sound ? (
          <span>🔔 注意のときにチャイムが鳴ります</span>
        ) : (
          <button onClick={() => setSound(enableSound())}>🔔 音を有効にする</button>
        )}
      </div>
    </section>
  );
}
