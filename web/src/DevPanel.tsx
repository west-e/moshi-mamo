import { useEffect, useMemo, useState } from "react";
import type { Speaker, Utterance } from "../../shared/types.ts";
import { AudioControls } from "./AudioControls.tsx";
import type { CallSession, Fault } from "./useCallSession.ts";

type Scenario = { id: string; title: string; utterances: Omit<Utterance, "id">[] };

const SPEAKER_LABEL: Record<Speaker, string> = { caller: "相手", user: "本人", unknown: "不明" };
const LEVEL_LABEL = { none: "なし", caution: "注意", warning: "強い注意", unclear: "判定不能" } as const;
const SIGNAL_LABEL: Record<string, string> = {
  impersonation: "なりすまし",
  urgency: "急がせ",
  secrecy: "口止め",
  payment: "送金誘導",
  credentials: "暗証番号等",
  atm_operation: "ATM誘導",
  bait: "不安/利益",
  manipulation: "見守りへの操作",
  other: "その他",
};

// 開発・デモ用画面。模擬入力であることを常に明示する。
export function DevPanel({ session }: { session: CallSession }) {
  const { utterances, entries, latest, view, fault, setFault, addUtterance, reset } = session;
  const [info, setInfo] = useState<{ model: string; keyConfigured: boolean } | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenarioId, setScenarioId] = useState("");
  const [speaker, setSpeaker] = useState<Speaker>("caller");
  const [text, setText] = useState("");
  const [autoplay, setAutoplay] = useState(false);

  // 判定サーバーの起動が画面より遅れることがあるので、つながるまで数秒おきに確かめる
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      Promise.all([fetch("/api/info").then((r) => r.json()), fetch("/api/scenarios").then((r) => r.json())])
        .then(([i, s]) => { setInfo(i); setScenarios(s); })
        .catch(() => { setInfo(null); timer = setTimeout(load, 3000); });
    void load();
    return () => clearTimeout(timer);
  }, []);

  const scenario = scenarios.find((s) => s.id === scenarioId);
  const nextLine = scenario?.utterances[utterances.length];

  const playNext = () => nextLine && addUtterance(nextLine.speaker, nextLine.text);

  // 自動再生: 発話を一定間隔で流す（判定の完了は待たない＝実際の通話と同じ）
  useEffect(() => {
    if (!autoplay) return;
    if (!nextLine) return setAutoplay(false);
    const t = setTimeout(playNext, 3500);
    return () => clearTimeout(t);
  });

  const latestOk = latest?.response?.ok ? latest.response : null;
  const evidence = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const s of latestOk?.assessment.signals ?? [])
      for (const id of s.utterance_ids) m.set(id, [...(m.get(id) ?? []), SIGNAL_LABEL[s.type] ?? s.type]);
    return m;
  }, [latestOk]);

  return (
    <section className="dev-panel">
      <header className="dev-header">
        <strong>開発・デモ画面</strong>
        <span className="mock-badge">電話機・録音アダプター未接続（模擬入力・架空の音声・マイクのみ）</span>
        <span className="dev-meta">
          {info ? `model: ${info.model} / APIキー: ${info.keyConfigured ? "設定済み" : "未設定"}` : "判定サーバー未接続"}
        </span>
      </header>

      <div className="dev-controls">
        <select value={scenarioId} onChange={(e) => { reset(); setAutoplay(false); setScenarioId(e.target.value); }}>
          <option value="">シナリオを選択（デモ用・調整用、すべて架空）</option>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>{s.title}</option>
          ))}
        </select>
        <button onClick={playNext} disabled={!nextLine}>次の発話 ▶</button>
        <button onClick={() => setAutoplay((a) => !a)} disabled={!nextLine && !autoplay}>
          {autoplay ? "⏸ 停止" : "⏵ 自動再生"}
        </button>
        <button onClick={() => { reset(); setAutoplay(false); }}>通話をリセット</button>
        <label>
          障害注入
          <select value={fault} onChange={(e) => setFault(e.target.value as Fault)}>
            <option value="none">なし</option>
            <option value="network">通信失敗</option>
            <option value="invalid">判定不能な応答</option>
            <option value="slow">8秒遅延</option>
          </select>
        </label>
      </div>

      <form
        className="dev-input"
        onSubmit={(e) => { e.preventDefault(); addUtterance(speaker, text); setText(""); }}
      >
        <select value={speaker} onChange={(e) => setSpeaker(e.target.value as Speaker)}>
          <option value="caller">相手</option>
          <option value="user">本人</option>
          <option value="unknown">不明</option>
        </select>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="発話を入力して Enter（架空の会話のみ）" maxLength={500} />
        <button type="submit" disabled={!text.trim()}>追加</button>
      </form>

      <AudioControls session={session} />

      <div className="dev-grid">
        <div>
          <h3>文字起こし（判定に渡した発話）</h3>
          <ol className="transcript">
            {utterances.map((u) => (
              <li key={u.id} className={evidence.has(u.id) ? "evidence" : ""}>
                <span className="uid">[{u.id}]</span>
                <span className={`spk spk-${u.speaker}`}>{SPEAKER_LABEL[u.speaker]}</span>
                <span className="utext">{u.text}</span>
                {evidence.get(u.id)?.map((t) => <span key={t} className="tag">{t}</span>)}
              </li>
            ))}
          </ol>
          {latestOk && (
            <p className="rationale">
              <b>最新の判定理由（発話{latest?.uttCount}まで）:</b>{" "}
              {latestOk.assessment.rationale || `（判定だけモード ${latestOk.preset} のため理由なし）`}
              {latestOk.assessment.injection_suspected && <span className="tag danger">操作の試みを検知</span>}
            </p>
          )}
        </div>

        <div>
          <h3>判定の変化</h3>
          <p className="dev-meta">
            利用者画面の表示: {view.latched ? LEVEL_LABEL[view.latched] : "—"}
            {view.problem && ` / 問題: ${view.problem}`} {view.evaluating && " / 評価中"}
          </p>
          <table className="timeline">
            <thead>
              <tr><th>#</th><th>発話</th><th>判定</th><th>兆候</th><th>文字起こし</th><th>判定</th><th>話し終わり→表示</th></tr>
            </thead>
            <tbody>
              {[...entries].reverse().map((e) => {
                const r = e.response;
                return (
                  <tr key={e.seq} className={r && !r.ok ? "row-error" : ""}>
                    <td>{e.seq}</td>
                    <td>1–{e.uttCount}</td>
                    <td>
                      {e.status === "pending" ? "評価中…"
                        : r?.ok ? <span className={`lv lv-${r.assessment.level}`}>{LEVEL_LABEL[r.assessment.level]}</span>
                        : `失敗: ${r?.message}`}
                    </td>
                    <td>{r?.ok ? r.assessment.signals.map((s) => SIGNAL_LABEL[s.type]).join("・") : ""}</td>
                    <td>{e.sttMs !== undefined ? `${(e.sttMs / 1000).toFixed(1)}s` : ""}</td>
                    <td>{e.roundTripMs !== undefined ? `${(e.roundTripMs / 1000).toFixed(1)}s` : ""}</td>
                    <td>{e.totalMs !== undefined ? `${(e.totalMs / 1000).toFixed(1)}s` : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
