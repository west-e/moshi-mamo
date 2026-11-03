// 架空シナリオを、2人で読み上げるための台本（Markdown）にする。マイクの練習・デモ撮影用。
// 使い方: node scripts/reading-sheet.mjs demo practice > docs/reading-sheet.md
// 評価用（holdout）は対象にしない。
import { readdirSync, readFileSync } from "node:fs";

const sets = process.argv.slice(2);
if (!sets.length || sets.includes("holdout")) {
  console.error("使い方: node scripts/reading-sheet.mjs demo practice（holdout は不可）");
  process.exit(1);
}

const ROLE = { caller: "相手", user: "本人", unknown: "どちらか" };
const SET_NAME = { demo: "デモ用", practice: "練習用", tuning: "調整用" };
const root = new URL("../eval/", import.meta.url);

function expectation(label) {
  if (!label) return "";
  if (label.category === "gradual_scam") return `期待: 発話${label.caution_by}までに注意（黄）、発話${label.warning_by}までに強い注意（赤）`;
  if (label.category === "ambiguous") return "期待: 強い注意（赤）は出ない。注意（黄）は出てもよい";
  return "期待: 強い注意（赤）は出ない。最後に注意（黄）が残らない";
}

const out = [
  "# 読み上げ用の台本",
  "",
  "> すべて架空の会話です。実在の通話の書き起こしではありません。`eval/scenarios/` から `node scripts/reading-sheet.mjs " + sets.join(" ") + "` で作成しました。",
  "",
  "## 読み方",
  "- 2人で「相手」と「本人」を分けて読みます。1文読んだら1秒ほど間をあけます（無音で発話を区切るため）。",
  "- スピーカーの音（もしまもの読み上げ）をマイクが拾わないよう、ヘッドホンを使うか、利用者画面の「音声で読み上げ」のチェックを外します。",
  "- マイク入力では話者が分からないため、画面ではすべて「不明」と表示されます。",
  "- 「期待」は台本を書いたときに決めた目安です。合わなくても失敗ではなく、記録して改善に使います。",
  "- 声を動画に入れる場合は、読む人の了承を取ります。",
  "",
];

for (const set of sets) {
  const labels = JSON.parse(readFileSync(new URL(`labels/${set}.json`, root), "utf8"));
  const dir = new URL(`scenarios/${set}/`, root);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  out.push(`## ${SET_NAME[set] ?? set}`, "");
  for (const f of files) {
    const s = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    out.push(`### ${s.title}`, "", expectation(labels[s.id]), "", "| # | 役 | せりふ |", "|---|---|---|");
    s.utterances.forEach((u, i) => out.push(`| ${i + 1} | ${ROLE[u.speaker]} | ${u.text} |`));
    out.push("");
  }
}

process.stdout.write(out.join("\n"));
