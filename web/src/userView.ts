import type { AssessResponse, Level, SignalType } from "../../shared/types.ts";

// 利用者画面に出すのは、ここにある検証済みの定型文だけ。
// モデルが生成した文章は利用者画面に出さない（短く保つため、会話中の命令文が画面に届かないようにするため）。

export type AlertLevel = "none" | "caution" | "warning";
export type Problem = "unclear" | "eval_error" | "network_error" | null;

export type UserView = {
  started: boolean; // 発話が1つ以上ある
  latched: AlertLevel | null; // この通話でこれまでに出た最も強い注意（下げない）
  problem: Problem; // 最新の判定で起きている問題
  evaluating: boolean;
  topSignal: SignalType | null;
};

export type Face = {
  tone: "idle" | "calm" | "caution" | "warning" | "unclear" | "error";
  headline: string;
  lines: string[];
  note?: string;
};

const RANK: Record<AlertLevel, number> = { none: 0, caution: 1, warning: 2 };

export function maxLevel(a: AlertLevel | null, b: AlertLevel): AlertLevel {
  return a === null || RANK[b] > RANK[a] ? b : a;
}

export function isAlert(level: Level | AlertLevel | null): level is "caution" | "warning" {
  return level === "caution" || level === "warning";
}

export function problemOf(res: AssessResponse): Problem {
  if (res.ok) return res.assessment.level === "unclear" ? "unclear" : null;
  return res.kind === "network" || res.kind === "config" ? "network_error" : "eval_error";
}

// 兆候ごとの一言（優先度順）
const SIGNAL_HINT: [SignalType, string][] = [
  ["secrecy", "「誰にも言わないで」は よくある手口です"],
  ["credentials", "暗証番号は 誰にも 教えません"],
  ["atm_operation", "ATMで お金が戻ることは ありません"],
  ["payment", "お金や カードは 渡さないで"],
  ["urgency", "急かされても 今 決めなくて 大丈夫"],
  ["impersonation", "相手の名乗りを うのみに しないで"],
  ["bait", "お金の話は 自分で 確かめてから"],
];

export function pickTopSignal(types: SignalType[]): SignalType | null {
  return SIGNAL_HINT.find(([t]) => types.includes(t))?.[0] ?? null;
}

function hint(signal: SignalType | null): string[] {
  const h = SIGNAL_HINT.find(([t]) => t === signal)?.[1];
  return h ? [h] : [];
}

const STOPPED_NOTE = "見守りが 止まっています";

export function faceOf(view: UserView): Face {
  if (!view.started) {
    return { tone: "idle", headline: "見守り 待機中", lines: ["通話が 始まると 内容を 確認します"] };
  }
  const stopped =
    view.problem === "network_error" ? `接続が 切れています。${STOPPED_NOTE}`
    : view.problem === "eval_error" ? `確認が できませんでした。${STOPPED_NOTE}`
    : undefined;

  // 一度出した注意は、その通話の間は下げない（ちらつかせない）
  if (view.latched === "warning") {
    return {
      tone: "warning",
      headline: "詐欺の おそれが あります",
      lines: [...hint(view.topSignal), "電話を 切って 家族か #9110 に 相談を"],
      note: stopped,
    };
  }
  if (view.latched === "caution") {
    return {
      tone: "caution",
      headline: "ちょっと 待って",
      lines: [...hint(view.topSignal), "いったん 電話を 切って 家族に 確かめましょう"],
      note: stopped,
    };
  }
  if (view.problem === "network_error") {
    return { tone: "error", headline: "接続が 切れています", lines: [STOPPED_NOTE, "お金の話は 家族に 確かめて"] };
  }
  if (view.problem === "eval_error") {
    return { tone: "error", headline: "確認が できませんでした", lines: [STOPPED_NOTE, "お金の話は 家族に 確かめて"] };
  }
  if (view.problem === "unclear") {
    return { tone: "unclear", headline: "判断が つきません", lines: ["不安なときは いったん切って かけ直しましょう"] };
  }
  if (view.latched === null) {
    return { tone: "idle", headline: "確認中…", lines: ["通話の内容を 確認しています"] };
  }
  return {
    tone: "calm",
    headline: "いまのところ 気になる点は ありません",
    lines: ["お金や 暗証番号の話が出たら すぐ決めないで"],
    note: "※ 安全を 保証するものでは ありません",
  };
}
