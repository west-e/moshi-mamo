import type { AlertLevel } from "../../shared/display.ts";
import type { AssessResponse, Level, SignalType } from "../../shared/types.ts";

// 「電話を 切っても 大丈夫」は、電話を切らせてもらえず確かめられなかった制作者の祖母の体験から加えた（docs/impact.md）。
// 利用者画面に出すのは、ここにある検証済みの定型文だけ。
// モデルが生成した文章は利用者画面に出さない（短く保つため、会話中の命令文が画面に届かないようにするため）。

export type { AlertLevel };
export type Problem = "unclear" | "eval_error" | "network_error" | null;

export type UserView = {
  started: boolean; // 発話が1つ以上ある
  latched: AlertLevel | null; // 表示する注意（shared/display.ts のルールで決める）
  cleared: boolean; // 注意を出した後、「なし」が続いて解除した
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

export function isAlert(level: Level | AlertLevel | null): level is "caution" | "warning" {
  return level === "caution" || level === "warning";
}

// 通信・判定の失敗はすぐに出す（見守りが止まっていることを隠さない）。
// 判定不能は続いたときだけ（shared/display.ts の unclear）。
export function problemOf(res: AssessResponse, unclear: boolean): Problem {
  if (res.ok) return unclear ? "unclear" : null;
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

  // 強い注意はその通話の間は下げない。注意は「なし」が続いたら解除する（shared/display.ts）
  if (view.latched === "warning") {
    return {
      tone: "warning",
      headline: "詐欺の おそれが あります",
      lines: [...hint(view.topSignal), "電話を 切っても 大丈夫", "家族か #9110 に 相談を"],
      note: stopped,
    };
  }
  if (view.latched === "caution") {
    return {
      tone: "caution",
      headline: "ちょっと 待って",
      lines: [...hint(view.topSignal), "電話を 切っても 大丈夫", "家族に 確かめてから 決めましょう"],
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
  if (view.cleared) {
    return {
      tone: "calm",
      headline: "いまは 気になる点は ありません",
      lines: ["さきほどの話で 不安が残るなら 家族に 確かめて"],
      note: "※ 安全を 保証するものでは ありません",
    };
  }
  return {
    tone: "calm",
    headline: "いまのところ 気になる点は ありません",
    lines: ["お金や 暗証番号の話が出たら すぐ決めないで"],
    note: "※ 安全を 保証するものでは ありません",
  };
}
