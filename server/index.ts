import { readdir, readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { AssessRequest } from "../shared/types.ts";
import { DEFAULT_PRESET, PRESETS, assess } from "./assess.ts";

const MODEL = `${PRESETS[DEFAULT_PRESET].model} (${DEFAULT_PRESET})`;

const app = new Hono();

app.post("/api/assess", async (c) => {
  const parsed = AssessRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid request" }, 400);

  const { utterances, fault } = parsed.data;
  const result = await assess(utterances, fault);
  // 会話本文はログに出さない。件数・判定・時間だけ。
  console.log(
    `[assess] n=${utterances.length} ${result.ok ? `level=${result.assessment.level}` : `error=${result.kind}`} ${result.latencyMs}ms`,
  );
  return c.json(result);
});

app.get("/api/info", (c) => c.json({ model: MODEL, keyConfigured: Boolean(process.env.ANTHROPIC_API_KEY) }));

// 開発画面で流すデモ用・調整用シナリオ（発話のみ）。正解ラベルと評価用シナリオは渡さない。
app.get("/api/scenarios", async (c) => {
  const scenarios = [];
  for (const set of ["demo", "tuning"]) {
    const dir = new URL(`../eval/scenarios/${set}/`, import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      const { id, title, utterances } = JSON.parse(await readFile(new URL(f, dir), "utf8"));
      scenarios.push({ id, title, utterances });
    }
  }
  return c.json(scenarios);
});

// PORT は開発ツールが Vite 用に設定することがあるため、専用の変数名にする（vite.config.ts の proxy と合わせる）
const port = Number(process.env.MOSHI_API_PORT || 8787);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`moshi-mamo api: http://127.0.0.1:${port} (model=${MODEL}, key=${process.env.ANTHROPIC_API_KEY ? "set" : "missing"})`);
});
