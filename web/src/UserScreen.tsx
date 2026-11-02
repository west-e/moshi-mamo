import { useEffect, useRef, useState } from "react";
import { enableSound, playAlert, soundEnabled } from "./sound.ts";
import { type AlertLevel, type UserView, faceOf } from "./userView.ts";

// 利用者向け画面。大きな見出しと短い行動案内だけを出す。
export function UserScreen({ view }: { view: UserView }) {
  const face = faceOf(view);
  const [sound, setSound] = useState(soundEnabled());
  const [speak, setSpeak] = useState(true);

  // 注意が強まった瞬間だけ鳴らす
  const prev = useRef<AlertLevel | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = view.latched;
    if (!sound || view.latched === before) return;
    if (view.latched === "warning" || (view.latched === "caution" && before !== "warning")) {
      playAlert(view.latched, speak);
    }
  }, [view.latched, sound, speak]);

  return (
    <section className={`user-screen tone-${face.tone}`} aria-live="assertive">
      <div className="user-status">
        <span className="brand">もしまも</span>
        {view.evaluating && <span className="pill">確認中…</span>}
      </div>
      <h1 className="user-headline">{face.headline}</h1>
      <ul className="user-lines">
        {face.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {face.note && <p className="user-note">{face.note}</p>}
      <div className="user-controls">
        {sound ? (
          <label>
            <input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} /> 音声で読み上げ
          </label>
        ) : (
          <button onClick={() => setSound(enableSound())}>🔔 音を有効にする</button>
        )}
      </div>
    </section>
  );
}
