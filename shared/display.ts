import type { Level } from "./types.ts";

// 判定の列から、利用者画面に出す注意レベルを決めるルール。
// 画面（web/src/useCallSession.ts）と評価（eval/run.ts）の両方がこれを使う。
//
// - 強い注意（warning）は、その通話の間は下げない。
// - 注意（caution）は、その後「なし」が CLEAR_CAUTION_AFTER 回続いたら解除する。
//   正当な電話の出だし（「お父さんが転んで病院に」など）で出た注意が、最後まで残らないようにするため。
// - 判定不能・エラー（null）は「なし」の連続に数えない（確かめられていないので解除の根拠にしない）。
// - 「判断がつきません」は判定不能が UNCLEAR_AFTER 回続いたときだけ出す（1回だけの揺れで表示を変えない）。

export type AlertLevel = "none" | "caution" | "warning";
export type DisplayStep = { level: AlertLevel | null; cleared: boolean; unclear: boolean };

export const UNCLEAR_AFTER = 2;

export const CLEAR_CAUTION_AFTER = 3;

export function displayTrace(raws: (Level | null)[], clearAfter: number = CLEAR_CAUTION_AFTER): DisplayStep[] {
  const out: DisplayStep[] = [];
  let level: AlertLevel | null = null;
  let cleared = false;
  let noneStreak = 0;
  let unclearStreak = 0;
  for (const raw of raws) {
    unclearStreak = raw === "unclear" ? unclearStreak + 1 : 0;
    if (raw === "warning") {
      level = "warning";
      cleared = false;
    } else if (raw === "caution") {
      if (level !== "warning") level = "caution";
      cleared = false;
      noneStreak = 0;
    } else if (raw === "none") {
      noneStreak++;
      if (level === null) level = "none";
      if (level === "caution" && noneStreak >= clearAfter) {
        level = "none";
        cleared = true;
      }
    } else {
      noneStreak = 0; // unclear・エラー
    }
    out.push({ level, cleared, unclear: unclearStreak >= UNCLEAR_AFTER });
  }
  return out;
}
