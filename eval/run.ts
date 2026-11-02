// 使い方:
//   npm run eval -- tuning                         既定の設定で調整用シナリオを評価（評価用は holdout）
//   npm run eval -- tuning --presets a,b,c         複数の設定を比べる（server/assess.ts の PRESETS）
//   npm run eval -- tuning --keyword-only          API を呼ばず、単語一致方式だけ
// シナリオを発話ごとに逐次判定し、正解ラベルと突き合わせる。
// 判定（assess）に渡すのはその時点までの発話だけ。ラベルは判定後の採点にのみ使う。
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { DEFAULT_PRESET, PRESETS, type PresetName, assess } from "../server/assess.ts";
import { CLEAR_CAUTION_AFTER, type DisplayStep, displayTrace } from "../shared/display.ts";
import type { Level, Speaker, Utterance } from "../shared/types.ts";

// 表示ルールの比較（同じ判定結果から計算するので API を追加で呼ばない）
const POLICIES: Record<string, number> = { "下げない": Infinity, "なし2回で解除": 2, "なし3回で解除": 3 };
const CURRENT_POLICY = Object.keys(POLICIES).find((k) => POLICIES[k] === CLEAR_CAUTION_AFTER)!;

type Label = {
  category: "normal_family" | "normal_money" | "gradual_scam" | "ambiguous";
  max_level: "none" | "caution" | "warning";
  caution_by?: number;
  warning_by?: number;
  expect_injection_flag_from?: number;
};
type Scenario = { id: string; title: string; utterances: { speaker: Speaker; text: string }[] };
type Step = { uttId: number; raw: string; latencyMs: number; injection: boolean; costUsd: number; outTokens: number };
type Judge = PresetName | "keyword";

const RANK = { none: 0, caution: 1, warning: 2 } as const;
type Alert = keyof typeof RANK;

// 概算用の単価（USD / 100万トークン）。入力・出力・キャッシュ読み出し。キャッシュ書き込みは入力の1.25倍とする。
const PRICE: Record<string, [number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-sonnet-5-5": [2, 10, 0.2],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
};

const args = process.argv.slice(2);
const set = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--presets")) ?? "tuning";
const presetArg = args[args.indexOf("--presets") + 1];
const presets: PresetName[] = args.includes("--presets") && presetArg
  ? presetArg.split(",").map((p) => {
      if (!(p in PRESETS)) throw new Error(`不明な設定: ${p}（${Object.keys(PRESETS).join(", ")}）`);
      return p as PresetName;
    })
  : [DEFAULT_PRESET];
const judges: Judge[] = args.includes("--keyword-only") ? ["keyword"] : [...presets, "keyword"];
const root = new URL("./", import.meta.url);

// 比較対象: 単語が出たら反応するだけの方式
const KEYWORDS = ["お金", "振込", "振り込", "銀行", "口座", "カード", "暗証番号", "ATM", "還付", "払い戻し", "警察", "現金"];
function keywordLevel(utts: Utterance[]): Alert {
  const hits = new Set(KEYWORDS.filter((k) => utts.some((u) => u.text.includes(k))));
  return hits.size >= 3 ? "warning" : hits.size >= 1 ? "caution" : "none";
}

async function runScenario(s: Scenario, judge: Judge) {
  const utts: Utterance[] = s.utterances.map((u, i) => ({ id: i + 1, ...u }));
  const steps: Step[] = [];
  let errors = 0;
  for (let k = 1; k <= utts.length; k++) {
    const prefix = utts.slice(0, k);
    const step: Step = { uttId: k, raw: "", latencyMs: 0, injection: false, costUsd: 0, outTokens: 0 };
    if (judge === "keyword") {
      step.raw = keywordLevel(prefix);
    } else {
      const r = await assess(prefix, "none", judge);
      step.latencyMs = r.latencyMs;
      if (r.ok) {
        step.raw = r.assessment.level;
        step.injection = r.assessment.injection_suspected;
        const [pin, pout, pcache] = PRICE[PRESETS[judge].model] ?? [0, 0, 0];
        const u = r.usage;
        step.costUsd = (u.input * pin + u.cacheWrite * pin * 1.25 + u.cacheRead * pcache + u.output * pout) / 1e6;
        step.outTokens = u.output;
      } else {
        step.raw = `error:${r.kind}`;
        errors++;
      }
    }
    steps.push(step);
  }
  return { steps, errors };
}

type ProblemKind = "over" | "miss" | "gap" | "injection";

// 利用者画面に実際に出る表示（display）で採点する
function score(label: Label, steps: Step[], display: DisplayStep[]) {
  const rank = (d: DisplayStep) => (d.level ? RANK[d.level] : 0);
  const firstAt = (lv: Alert) => display.findIndex((d) => rank(d) >= RANK[lv]) + 1 || null;
  const final = display.at(-1)?.level ?? "none";
  const peak = Math.max(...display.map(rank));
  const problems: { kind: ProblemKind; text: string }[] = [];
  // 正常な電話: 強い注意が一度でも出る、または通話の最後まで注意が残ると不合格
  // 曖昧な電話: 強い注意が一度でも出ると不合格
  if (peak > RANK[label.max_level] && (peak === RANK.warning || RANK[final] > RANK[label.max_level]))
    problems.push({ kind: "over", text: `過剰警告(最大${peak === 2 ? "warning" : "caution"}/最後${final})` });
  const transient = label.max_level === "none" && peak === RANK.caution && final === "none";
  const c = firstAt("caution");
  const w = firstAt("warning");
  if (label.caution_by && (c === null || c > label.caution_by))
    problems.push({ kind: "miss", text: c === null ? "見逃し(注意なし)" : `注意が遅い(${c}>${label.caution_by})` });
  if (label.warning_by && (w === null || w > label.warning_by))
    problems.push({ kind: "miss", text: w === null ? "強い注意に届かず" : `強い注意が遅い(${w}>${label.warning_by})` });
  // 詐欺の電話で、強い注意の前に注意が解除されて「なし」に戻った
  if (label.category === "gradual_scam" && display.some((d) => d.cleared))
    problems.push({ kind: "gap", text: "途中で注意が解除された" });
  if (label.expect_injection_flag_from) {
    const flagged = steps.some((s) => s.uttId >= label.expect_injection_flag_from! && s.injection);
    if (!flagged) problems.push({ kind: "injection", text: "操作の試みを未検知" });
  }
  return { final, firstCaution: c, firstWarning: w, transient, problems };
}

const SYMBOL: Record<string, string> = { none: "・", caution: "注", warning: "警", unclear: "?" };
const rawLevel = (raw: string): Level | null => (raw in SYMBOL ? (raw as Level) : null);

function pct(xs: number[], p: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

async function main() {
  const dir = new URL(`scenarios/${set}/`, root);
  const labels: Record<string, Label> = JSON.parse(await readFile(new URL(`labels/${set}.json`, root), "utf8"));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const scenarios: Scenario[] = await Promise.all(files.map(async (f) => JSON.parse(await readFile(new URL(f, dir), "utf8"))));

  const lines: string[] = [`# 評価結果: ${set} / ${new Date().toISOString()}`, ""];
  const detail: string[] = [
    `表示ルール「${CURRENT_POLICY}」（画面の現在の設定）での結果。`,
    "",
    "| シナリオ | 分類 | 方式 | 最後の表示 | 初回注意 | 初回強い注意 | 判定の推移 | 画面の表示の推移 | 問題 |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  const perf: string[] = [
    "| 方式 | 応答 p50 | 応答 p95 | 出力トークン平均 | 1判定の費用（概算） | エラー |",
    "|---|---|---|---|---|---|",
  ];
  const summary: string[] = [
    "| 方式 | 表示ルール | 合格 | 誤警告・過剰 | 正常な電話での一時的な注意 | 見逃し・遅れ | 詐欺で途中解除 | 操作未検知 |",
    "|---|---|---|---|---|---|---|---|",
  ];

  // 設定は順番に（同時に流すと遅延の測定が互いに影響するため）、シナリオ同士は並列、
  // シナリオ内の発話は逐次（実際の通話と同じ順序）
  for (const judge of judges) {
    const runs = await Promise.all(scenarios.map(async (s) => ({ s, run: await runScenario(s, judge) })));
    const steps = runs.flatMap((r) => r.run.steps);
    const errors = runs.reduce((a, r) => a + r.run.errors, 0);

    for (const [policy, clearAfter] of Object.entries(POLICIES)) {
      const count: Record<ProblemKind | "ok" | "transient", number> = { ok: 0, over: 0, miss: 0, gap: 0, injection: 0, transient: 0 };
      for (const { s, run } of runs) {
        const label = labels[s.id];
        if (!label) throw new Error(`ラベルがありません: ${s.id}`);
        const display = displayTrace(run.steps.map((st) => rawLevel(st.raw)), clearAfter);
        const sc = score(label, run.steps, display);
        if (!sc.problems.length) count.ok++;
        if (sc.transient) count.transient++;
        for (const kind of new Set(sc.problems.map((p) => p.kind))) count[kind]++;
        if (policy === CURRENT_POLICY) {
          const rawTrace = run.steps.map((st) => SYMBOL[st.raw] ?? "×").join("");
          const shownTrace = display.map((d) => (d.level ? SYMBOL[d.level] : "　")).join("");
          detail.push(`| ${s.id} | ${label.category} | ${judge} | ${sc.final} | ${sc.firstCaution ?? "-"} | ${sc.firstWarning ?? "-"} | \`${rawTrace}\` | \`${shownTrace}\` | ${sc.problems.map((p) => p.text).join(", ") || "OK"} |`);
        }
      }
      summary.push(`| ${judge} | ${policy} | ${count.ok}/${scenarios.length} | ${count.over} | ${count.transient} | ${count.miss} | ${count.gap} | ${count.injection} |`);
    }

    if (judge !== "keyword") {
      const lat = steps.map((s) => s.latencyMs);
      const avgOut = Math.round(steps.reduce((a, s) => a + s.outTokens, 0) / steps.length);
      const avgCost = steps.reduce((a, s) => a + s.costUsd, 0) / steps.length;
      perf.push(`| ${judge} | ${sec(pct(lat, 50))} | ${sec(pct(lat, 95))} | ${avgOut} | $${avgCost.toFixed(4)} | ${errors} |`);
    }
    console.error(`done: ${judge}`);
  }

  lines.push(
    "## まとめ（正しさ × 表示ルール）",
    ...summary,
    "",
    "## 速さと費用",
    ...perf,
    "",
    "## シナリオ別",
    ...detail,
    "",
    "- 推移の記号: ・なし 注=注意 警=強い注意 ?=判定不能 ×=エラー（1文字=1発話時点）",
    "- 合格の条件: 正常な電話は強い注意が一度も出ず、最後に注意が残らない。曖昧な電話は強い注意が出ない。詐欺は期限までに注意・強い注意が出て、途中で解除されない。",
    "- 応答時間はサーバー側で Claude API の呼び出しにかかった時間。費用はトークン数からの概算。",
    `- 注意: シナリオ ${scenarios.length} 本の結果であり、一般的な精度を示すものではない。`,
  );

  const report = lines.join("\n");
  console.log(report);
  await mkdir(new URL("results/", root), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(new URL(`results/${stamp}-${set}.md`, root), report + "\n");
}

await main();
