// Claude Code の PreToolUse フック: 評価用（未使用）シナリオを、開発中の Claude Code に読ませない。
// プロンプトや表示ルールを調整する側が評価用の中身を知ると、評価が「答えを見た試験」になるため。
// 評価スクリプト（npm run eval -- holdout）からの読み込みは止めない（パスを直接含まないコマンドなので通る）。
// 最終評価のあとで中身を確認するときは、利用者が eval/HOLDOUT_UNLOCKED を作ると解除される。
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
if (existsSync(join(projectDir, "eval", "HOLDOUT_UNLOCKED"))) process.exit(0);

const HOLDOUT = /(scenarios|labels)[\\/]+holdout|holdout\.json/i;
const REASON =
  "評価用（未使用）シナリオ eval/scenarios/holdout・eval/labels/holdout.json は、調整中は読めません（評価の独立性を守るため）。" +
  "評価は npm run eval -- holdout で実行し、集計結果だけを見てください。";

const deny = () => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: REASON },
    }),
  );
  process.exit(0);
};

const tool = input.tool_name;
const ti = input.tool_input ?? {};

if (tool === "Bash" || tool === "PowerShell") {
  if (HOLDOUT.test(ti.command ?? "")) deny();
} else if (tool === "Read" || tool === "NotebookEdit" || tool === "Edit" || tool === "Write") {
  if (HOLDOUT.test(ti.file_path ?? ti.notebook_path ?? "")) deny();
} else if (tool === "Glob") {
  if (HOLDOUT.test(`${ti.path ?? ""} ${ti.pattern ?? ""}`)) deny();
} else if (tool === "Grep") {
  if (HOLDOUT.test(`${ti.path ?? ""} ${ti.glob ?? ""}`)) deny();
  // リポジトリ全体や eval/ を検索すると評価用の中身も表示されうるので、除外の glob を足す
  const rel = relative(projectDir, resolve(projectDir, ti.path ?? ".")).replace(/\\/g, "/");
  const covers = ["", "eval", "eval/scenarios", "eval/labels"].includes(rel);
  if (covers) {
    if (!ti.glob) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: { ...ti, glob: "!**/holdout*" },
            additionalContext: "評価用シナリオを検索対象から外しました（glob: !**/holdout*）。",
          },
        }),
      );
      process.exit(0);
    }
    if (/json|\*\s*$|^\*$/i.test(ti.glob)) deny(); // JSON を含みうる glob は、範囲を絞ってもらう
  }
}
process.exit(0);
