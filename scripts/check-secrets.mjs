// コミット前チェック: 公開リポジトリに秘密情報・音声ファイルを入れないための最後の網。
// .githooks/pre-commit から呼ばれる。--all で追跡中の全ファイルを検査する。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const all = process.argv.includes("--all");
const files = execFileSync("git", all ? ["ls-files"] : ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const BLOCKED_NAME = [/(^|\/)\.env(\..+)?$/, /\.(wav|mp3|m4a|webm|ogg|flac)$/i];
const ALLOWED_NAME = [/(^|\/)\.env\.example$/];
const SECRET = [
  /sk-ant-[A-Za-z0-9_-]{16,}/, // Anthropic APIキー
  /ANTHROPIC_API_KEY[ \t]*=[ \t]*["']?[A-Za-z0-9_-]{8,}/, // キーの代入（空の代入は許す）
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const problems = [];
for (const f of files) {
  if (BLOCKED_NAME.some((r) => r.test(f)) && !ALLOWED_NAME.some((r) => r.test(f))) {
    problems.push(`${f}: コミットできないファイル種別（.env / 音声）`);
    continue;
  }
  let text;
  try {
    text = all ? readFileSync(f, "utf8") : execFileSync("git", ["show", `:${f}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    continue;
  }
  for (const r of SECRET) if (r.test(text)) problems.push(`${f}: 秘密情報らしき文字列 (${r.source.slice(0, 24)}…)`);
}

if (problems.length) {
  console.error("コミットを中止しました:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
