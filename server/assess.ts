import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Assessment, type AssessResponse, type Utterance } from "../shared/types.ts";
import { SYSTEM_PROMPT, renderTranscript } from "./prompt.ts";

export const MODEL = process.env.MOSHI_MODEL || "claude-opus-5-5";
const EFFORT = (process.env.MOSHI_EFFORT || "low") as "low" | "medium" | "high";

// 通話中に使うので、長く待つより早く「接続できない」と出す方を優先する。
const client = new Anthropic({ timeout: 20_000, maxRetries: 1 });

export type Fault = "none" | "network" | "invalid" | "slow";

// 判定は毎回「その時点までの発話」だけを渡すステートレスな呼び出し。
// 未来の発話やシナリオの正解ラベルはこの関数に到達しない。
export async function assess(utterances: Utterance[], fault: Fault = "none"): Promise<AssessResponse> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  if (fault === "network") return { ok: false, kind: "network", message: "障害注入: 通信失敗", latencyMs: elapsed() };
  if (fault === "invalid") return { ok: false, kind: "invalid", message: "障害注入: 判定不能な応答", latencyMs: elapsed() };
  if (fault === "slow") await new Promise((r) => setTimeout(r, 8_000));

  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, kind: "config", message: "ANTHROPIC_API_KEY が未設定です", latencyMs: elapsed() };
  }

  try {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: EFFORT, format: betaZodOutputFormat(Assessment) },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: renderTranscript(utterances) }],
    });

    if (response.stop_reason === "refusal") {
      return { ok: false, kind: "refusal", message: `応答拒否 (${response.stop_details?.category ?? "unknown"})`, latencyMs: elapsed() };
    }
    if (response.stop_reason === "max_tokens" || !response.parsed_output) {
      return { ok: false, kind: "invalid", message: `判定を読み取れませんでした (${response.stop_reason})`, latencyMs: elapsed() };
    }

    // 存在しない発話番号を根拠として表示しないよう落とす
    const known = new Set(utterances.map((u) => u.id));
    const assessment = response.parsed_output;
    for (const s of assessment.signals) s.utterance_ids = s.utterance_ids.filter((id) => known.has(id));

    return {
      ok: true,
      assessment,
      model: response.model,
      latencyMs: elapsed(),
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cacheRead: response.usage.cache_read_input_tokens ?? 0,
      },
    };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return { ok: false, kind: "config", message: "APIキーが無効です", latencyMs: elapsed() };
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return { ok: false, kind: "network", message: "Claude API に接続できません", latencyMs: elapsed() };
    }
    if (error instanceof Anthropic.APIError) {
      return { ok: false, kind: "network", message: `Claude API エラー ${error.status}`, latencyMs: elapsed() };
    }
    // スキーマ不一致などの解析失敗
    return { ok: false, kind: "invalid", message: "判定を読み取れませんでした", latencyMs: elapsed() };
  }
}
