import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Assessment, QuickAssessment, type AssessResponse, type Utterance } from "../shared/types.ts";
import { type OutputMode, renderTranscript, systemPrompt } from "./prompt.ts";

type Preset = {
  model: string;
  mode: OutputMode;
  effort: "low" | "medium" | "high";
  thinking?: Anthropic.Beta.Messages.BetaThinkingConfigParam;
};

// 速さと正しさを比べるための設定。thinking を省略したモデルは既定（考えてから答える）のまま。
// Opus 5.5 は thinking を止められないため effort で調整する。
export const PRESETS = {
  "opus-detailed": { model: "claude-opus-5-5", mode: "detailed", effort: "low" },
  "opus-quick": { model: "claude-opus-5-5", mode: "quick", effort: "low" },
  "sonnet-quick": { model: "claude-sonnet-5-5", mode: "quick", effort: "low" },
  "sonnet-quick-nothink": { model: "claude-sonnet-5-5", mode: "quick", effort: "low", thinking: { type: "between_tools" } },
  "haiku-quick": { model: "claude-haiku-5-5", mode: "quick", effort: "low" },
  "haiku-quick-nothink": { model: "claude-haiku-5-5", mode: "quick", effort: "low", thinking: { type: "disabled" } },
} satisfies Record<string, Preset>;
export type PresetName = keyof typeof PRESETS;

function isPresetName(name: string | undefined): name is PresetName {
  return name !== undefined && name in PRESETS;
}

// 既定は Haiku・判定だけ（調整用9本で Opus と同じ正しさ、p50 約1.1秒。docs/DEVLOG.md 参照）
export const DEFAULT_PRESET: PresetName = isPresetName(process.env.MOSHI_PRESET) ? process.env.MOSHI_PRESET : "haiku-quick";

// 通話中に使うので、長く待つより早く「接続できない」と出す方を優先する。
const client = new Anthropic({ timeout: 20_000, maxRetries: 1 });

export type Fault = "none" | "network" | "invalid" | "slow";

// 判定は毎回「その時点までの発話」だけを渡すステートレスな呼び出し。
// 未来の発話やシナリオの正解ラベルはこの関数に到達しない。
export async function assess(
  utterances: Utterance[],
  fault: Fault = "none",
  presetName: PresetName = DEFAULT_PRESET,
): Promise<AssessResponse> {
  const preset: Preset = PRESETS[presetName];
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
      model: preset.model,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      ...(preset.thinking ? { thinking: preset.thinking } : {}),
      output_config: {
        effort: preset.effort,
        format: betaZodOutputFormat(preset.mode === "quick" ? QuickAssessment : Assessment),
      },
      system: [{ type: "text", text: systemPrompt(preset.mode), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: renderTranscript(utterances) }],
    });

    if (response.stop_reason === "refusal") {
      return { ok: false, kind: "refusal", message: `応答拒否 (${response.stop_details?.category ?? "unknown"})`, latencyMs: elapsed() };
    }
    if (response.stop_reason === "max_tokens" || !response.parsed_output) {
      return { ok: false, kind: "invalid", message: `判定を読み取れませんでした (${response.stop_reason})`, latencyMs: elapsed() };
    }

    // 判定だけモードは説明文を持たないので空にして同じ形にそろえる
    let assessment: Assessment;
    if (preset.mode === "detailed") {
      assessment = response.parsed_output as Assessment;
    } else {
      const quick = response.parsed_output as QuickAssessment;
      assessment = { ...quick, signals: quick.signals.map((s) => ({ ...s, summary: "" })), rationale: "" };
    }

    // 存在しない発話番号を根拠として表示しないよう落とす
    const known = new Set(utterances.map((u) => u.id));
    for (const s of assessment.signals) s.utterance_ids = s.utterance_ids.filter((id) => known.has(id));

    return {
      ok: true,
      assessment,
      model: response.model,
      preset: presetName,
      latencyMs: elapsed(),
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cacheRead: response.usage.cache_read_input_tokens ?? 0,
        cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
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
