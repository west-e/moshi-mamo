// 使い方: npm run eval -- tuning  （評価用は holdout。--keyword-only で API を呼ばず比較方式だけ）
// シナリオを発話ごとに逐次判定し、正解ラベルと突き合わせる。
// 判定（assess）に渡すのはその時点までの発話だけ。ラベルは判定後の採点にのみ使う。
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { MODEL, assess } from "../server/assess.ts";
import type { AssessResponse, Speaker, Utterance } from "../shared/types.ts";

type Label = {
  category: "normal_family" | "normal_money" | "gradual_scam" | "ambiguous";
  max_level: "none" | "caution" | "warning";
  caution_by?: number;
  warning_by?: number;
  expect_injection_flag_from?: number;
};
type Scenario = { id: string; title: string; utterances: { speaker: Speaker; text: string }[] };
type Step = { uttId: number; raw: string; latched: string; latencyMs: number; injection: boolean };

const RANK = { none: 0, caution: 1, warning: 2 } as const;
type Alert = keyof typeof RANK;

const args = process.argv.slice(2);
const set = args.find((a) => !a.startsWith("--")) ?? "tuning";
const judges = args.includes("--keyword-only") ? (["keyword"] as const) : (["claude", "keyword"] as const);
const root = new URL("./", import.meta.url);

// 比較対象: 単語が出たら反応するだけの方式
const KEYWORDS = ["お金", "振込", "振り込", "銀行", "口座", "カード", "暗証番号", "ATM", "還付", "払い戻し", "警察", "現金"];
function keywordLevel(utts: Utterance[]): Alert {
  const hits = new Set(KEYWORDS.filter((k) => utts.some((u) => u.text.includes(k))));
  return hits.size >= 3 ? "warning" : hits.size >= 1 ? "caution" : "none";
}

async function runScenario(s: Scenario, judge: "claude" | "keyword") {
  const utts: Utterance[] = s.utterances.map((u, i) => ({ id: i + 1, ...u }));
  const steps: Step[] = [];
  let latched: Alert = "none";
  let errors = 0;
  for (let k = 1; k <= utts.length; k++) {
    const prefix = utts.slice(0, k);
    let raw: string;
    let latencyMs = 0;
    let injection = false;
    if (judge === "keyword") {
      raw = keywordLevel(prefix);
    } else {
      const r: AssessResponse = await assess(prefix);
      latencyMs = r.latencyMs;
      if (r.ok) {
        raw = r.assessment.level;
        injection = r.assessment.injection_suspected;
      } else {
        raw = `error:${r.kind}`;
        errors++;
      }
    }
    if (raw in RANK && RANK[raw as Alert] > RANK[latched]) latched = raw as Alert;
    steps.push({ uttId: k, raw, latched, latencyMs, injection });
  }
  return { steps, errors };
}

function score(label: Label, steps: Step[]) {
  const firstAt = (lv: Alert) => steps.find((s) => RANK[s.latched as Alert] >= RANK[lv])?.uttId ?? null;
  const final = steps.at(-1)!.latched as Alert;
  const problems: string[] = [];
  if (RANK[final] > RANK[label.max_level]) problems.push(`過剰警告(${final})`);
  const c = firstAt("caution");
  const w = firstAt("warning");
  if (label.caution_by && (c === null || c > label.caution_by)) problems.push(c === null ? "見逃し(注意なし)" : `注意が遅い(${c}>${label.caution_by})`);
  if (label.warning_by && (w === null || w > label.warning_by)) problems.push(w === null ? "強い注意に届かず" : `強い注意が遅い(${w}>${label.warning_by})`);
  if (label.expect_injection_flag_from) {
    const flagged = steps.some((s) => s.uttId >= label.expect_injection_flag_from! && s.injection);
    if (!flagged) problems.push("操作の試みを未検知");
  }
  return { final, firstCaution: c, firstWarning: w, problems };
}

function pct(xs: number[], p: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

async function main() {
  const dir = new URL(`scenarios/${set}/`, root);
  const labels: Record<string, Label> = JSON.parse(await readFile(new URL(`labels/${set}.json`, root), "utf8"));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const scenarios: Scenario[] = await Promise.all(files.map(async (f) => JSON.parse(await readFile(new URL(f, dir), "utf8"))));

  const lines: string[] = [`# 評価結果: ${set} / model=${MODEL} / ${new Date().toISOString()}`, ""];
  const latencies: number[] = [];
  const summary = { claude: { ok: 0, ng: 0 }, keyword: { ok: 0, ng: 0 } };
  let errorCount = 0;

  // シナリオ同士は並列、シナリオ内の発話は逐次（実際の通話と同じ順序）
  const results = await Promise.all(
    scenarios.map(async (s) => {
      const runs: Partial<Record<(typeof judges)[number], Awaited<ReturnType<typeof runScenario>>>> = {};
      for (const j of judges) runs[j] = await runScenario(s, j);
      return { s, runs };
    }),
  );

  lines.push("| シナリオ | 分類 | 方式 | 最終 | 初回注意 | 初回強い注意 | 判定の推移 | 問題 |", "|---|---|---|---|---|---|---|---|");
  for (const { s, runs } of results) {
    const label = labels[s.id];
    if (!label) throw new Error(`ラベルがありません: ${s.id}`);
    for (const name of judges) {
      const run = runs[name]!;
      const sc = score(label, run.steps);
      summary[name][sc.problems.length ? "ng" : "ok"]++;
      const trace = run.steps.map((st) => ({ none: "・", caution: "注", warning: "警", unclear: "?" })[st.raw] ?? "×").join("");
      lines.push(`| ${s.id} | ${label.category} | ${name} | ${sc.final} | ${sc.firstCaution ?? "-"} | ${sc.firstWarning ?? "-"} | \`${trace}\` | ${sc.problems.join(", ") || "OK"} |`);
    }
    if (runs.claude) {
      latencies.push(...runs.claude.steps.map((st) => st.latencyMs));
      errorCount += runs.claude.errors;
    }
  }

  lines.push(
    "",
    ...judges.map((j) => `- ${j === "claude" ? "Claude" : "単語一致"}: 合格 ${summary[j].ok} / ${scenarios.length}`),
    ...(latencies.length
      ? [
          `- 応答時間（サーバー計測, ${latencies.length}回）: p50 ${(pct(latencies, 50) / 1000).toFixed(1)}s / p95 ${(pct(latencies, 95) / 1000).toFixed(1)}s / 最大 ${(Math.max(...latencies) / 1000).toFixed(1)}s`,
          `- 判定エラー: ${errorCount} 回`,
        ]
      : []),
    "- 推移の記号: ・なし 注=注意 警=強い注意 ?=判定不能 ×=エラー（1文字=1発話時点の判定）",
    `- 注意: シナリオ ${scenarios.length} 本の結果であり、一般的な精度を示すものではない。`,
  );

  const report = lines.join("\n");
  console.log(report);
  await mkdir(new URL("results/", root), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(new URL(`results/${stamp}-${set}.md`, root), report + "\n");
}

await main();
