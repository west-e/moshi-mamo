import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssessResponse, Speaker, Utterance } from "../../shared/types.ts";
import { displayTrace } from "../../shared/display.ts";
import { type UserView, isAlert, pickTopSignal, problemOf } from "./userView.ts";

export type Fault = "none" | "network" | "invalid" | "slow";

export type Entry = {
  seq: number;
  uttCount: number; // この判定に渡した発話数
  status: "pending" | "done";
  response?: AssessResponse;
  roundTripMs?: number;
  sttMs?: number; // 音声入力のとき: 文字起こしにかかった時間
  totalMs?: number; // 音声入力のとき: 話し終わりから判定が届くまで
};

// 音声入力から来た発話の計測値
export type AudioMeta = { sttMs: number; speechEndedAt: number };

export const VIEW_CHANNEL = "moshi-mamo-view";

// 通話1本ぶんの状態。会話本文はメモリ上だけに置き、保存しない。
export function useCallSession() {
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [fault, setFault] = useState<Fault>("none");
  const seqRef = useRef(0);
  const generationRef = useRef(0); // リセット後に古い応答が混ざらないように
  const utterancesRef = useRef<Utterance[]>([]);

  const addUtterance = useCallback(
    (speaker: Speaker, text: string, audio?: AudioMeta) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const generation = generationRef.current;
      const seq = ++seqRef.current;
      const prev = utterancesRef.current;
      const next = [...prev, { id: prev.length + 1, speaker, text: trimmed.slice(0, 500) }];
      utterancesRef.current = next;
      setUtterances(next);
      setEntries((es) => [...es, { seq, uttCount: next.length, status: "pending", sttMs: audio?.sttMs }]);
      void request(next, seq, generation);

      async function request(snapshot: Utterance[], seq: number, generation: number) {
        const started = performance.now();
        let response: AssessResponse;
        try {
          const res = await fetch("/api/assess", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ utterances: snapshot, fault }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          response = (await res.json()) as AssessResponse;
        } catch {
          response = { ok: false, kind: "network", message: "判定サーバーに接続できません", latencyMs: 0 };
        }
        if (generation !== generationRef.current) return;
        const now = performance.now();
        const roundTripMs = Math.round(now - started);
        const totalMs = audio ? Math.round(now - audio.speechEndedAt) : undefined;
        setEntries((es) => es.map((e) => (e.seq === seq ? { ...e, status: "done", response, roundTripMs, totalMs } : e)));
      }
    },
    [fault],
  );

  const reset = useCallback(() => {
    generationRef.current++;
    utterancesRef.current = [];
    setUtterances([]);
    setEntries([]);
  }, []);

  // 表示に使うのは「完了した中で最も新しい判定」。遅れて届いた古い応答で上書きしない。
  const latest = useMemo(() => {
    let best: Entry | undefined;
    for (const e of entries) if (e.status === "done" && (!best || e.seq > best.seq)) best = e;
    return best;
  }, [entries]);

  const view: UserView = useMemo(() => {
    const done = entries.filter((e) => e.status === "done").sort((a, b) => a.seq - b.seq);
    const trace = displayTrace(done.map((e) => (e.response?.ok ? e.response.assessment.level : null)));
    const shown = trace.at(-1);
    const latched = shown?.level ?? null;
    // 注意の根拠は、最も強い注意を出した最新の判定から取る
    let topSignal = null;
    for (const e of [...entries].reverse()) {
      const r = e.response;
      if (r?.ok && isAlert(r.assessment.level) && r.assessment.level === latched) {
        topSignal = pickTopSignal(r.assessment.signals.map((s) => s.type));
        break;
      }
    }
    return {
      started: utterances.length > 0,
      latched,
      cleared: shown?.cleared ?? false,
      problem: latest?.response ? problemOf(latest.response, shown?.unclear ?? false) : null,
      evaluating: entries.some((e) => e.status === "pending" && (!latest || e.seq > latest.seq)),
      topSignal,
    };
  }, [entries, latest, utterances.length]);

  // 別タブの利用者画面（#/user）へ表示状態だけを送る。会話本文は送らない。
  const channelRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    channelRef.current = new BroadcastChannel(VIEW_CHANNEL);
    return () => channelRef.current?.close();
  }, []);
  useEffect(() => {
    channelRef.current?.postMessage(view);
  }, [view]);

  return { utterances, entries, latest, view, fault, setFault, addUtterance, reset };
}

export type CallSession = ReturnType<typeof useCallSession>;
