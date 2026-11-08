// Gemini TTS で、架空の台本から通話音声を作る（相手と本人を別の声に）。デモ・練習用。送るのは架空の台本だけ。
// アプリ本体は Gemini を使わない（警告は画面とチャイムだけで、文の読み上げはしない）。
// 使い方: npm run voices -- call <シナリオ.json> audio/<名前>.wav [--caller 声] [--user 声] [--model モデル]
//         audio/ は Git 管理外
// GEMINI_API_KEY は .env に書く（サーバー側・手元のスクリプトだけで読む）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// --model gemini-3.8-flash-lite-tts で軽量版に切り替えられる（無料枠の回数はモデルごと）
const MODEL = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1]! : "gemini-3.8-flash-tts";
const RATE = 24000; // Gemini TTS の出力（24kHz・モノラル・16bit）
const PAUSE_SEC = 0.9; // 発話の間の無音。音声入力は 0.6 秒の無音で発話を区切る

type Speaker = "caller" | "user" | "unknown";

async function synthesize(text: string, voice: string, style: string): Promise<Buffer> {
  const body = {
    model: MODEL,
    input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style }] }] }],
    response_format: { type: "audio" },
    generation_config: { speech_config: [{ voice }] },
  };
  for (let attempt = 1; ; attempt++) {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const j = (await r.json()) as { steps?: { type: string; content?: { type: string; data?: string }[] }[] };
      const audio = (j.steps ?? []).filter((s) => s.type === "model_output").flatMap((s) => s.content ?? []).filter((c) => c.type === "audio").at(-1);
      if (audio?.data) return pcmOf(Buffer.from(audio.data, "base64"));
      throw new Error("音声が返りませんでした");
    }
    // 無料枠は1分あたり3回・1日10回（2026-11-08 時点）。1分の制限なら待ってやり直し、1日の制限なら止める
    const wait = Number(r.headers.get("retry-after")) || 2 * attempt;
    if (attempt >= 10 || wait > 120 || (r.status !== 429 && r.status < 500)) throw new Error(`Gemini TTS エラー ${r.status}（${wait} 秒後に再試行可）`);
    console.log(`  待機 ${wait} 秒（${r.status}）`);
    await new Promise((res) => setTimeout(res, (wait + 1) * 1000));
  }
}

// WAV から PCM（data チャンク）を取り出す
function pcmOf(wav: Buffer): Buffer {
  for (let p = 12; p + 8 <= wav.length; ) {
    const id = wav.toString("ascii", p, p + 4);
    const size = wav.readUInt32LE(p + 4);
    if (id === "data") return wav.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size % 2);
  }
  throw new Error("WAV の data チャンクがありません");
}

function writeWav(path: string, pcm: Buffer) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([h, pcm]));
}

const silence = (sec: number) => Buffer.alloc(Math.round(sec * RATE) * 2);
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1]! : fallback);

if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY が .env にありません");

const [cmd, scenarioPath, out] = args;
if (cmd !== "call" || !scenarioPath || !out) throw new Error("使い方: npm run voices -- call <シナリオ.json> audio/<名前>.wav");
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as { utterances: { speaker: Speaker; text: string }[] };
const voice: Record<Speaker, [string, string]> = {
  caller: [flag("--caller", "Puck"), ""],
  user: [flag("--user", "Gacrux"), "an elderly woman speaking slowly"],
  unknown: [flag("--caller", "Puck"), ""],
};
const parts: Buffer[] = [silence(0.5)];
for (const u of scenario.utterances) {
  const [v, style] = voice[u.speaker];
  parts.push(await synthesize(u.text, v, style), silence(PAUSE_SEC));
}
const pcm = Buffer.concat(parts);
writeWav(out, pcm);
console.log(`作成: ${out}（${scenario.utterances.length} 発話, ${(pcm.length / 2 / RATE).toFixed(1)} 秒）`);
