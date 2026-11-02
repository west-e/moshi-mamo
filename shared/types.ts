import { z } from "zod";

// 発話。id は通話開始からの通し番号（1始まり）。
// 録音アダプター経由では話者が分からないことがあるため "unknown" を許す。
export const Speaker = z.enum(["caller", "user", "unknown"]);
export type Speaker = z.infer<typeof Speaker>;

export const Utterance = z.object({
  id: z.number().int().positive(),
  speaker: Speaker,
  text: z.string().min(1).max(500),
});
export type Utterance = z.infer<typeof Utterance>;

export const SignalType = z.enum([
  "impersonation", // 警察・金融機関・役所・家族などを名乗る
  "urgency", // 今すぐ・今日中など急がせる
  "secrecy", // 口止め・第三者への相談を妨げる
  "payment", // 振込・送金・現金/カード手渡し・電子マネー購入への誘導
  "credentials", // 暗証番号・口座・個人情報の聞き出し
  "atm_operation", // ATM操作の誘導
  "bait", // 還付金・未払い・逮捕など、不安や利益で揺さぶる
  "manipulation", // 見守りシステム・AI の判定を操作しようとする
  "other",
]);
export type SignalType = z.infer<typeof SignalType>;

// モデルが一覧にない種類を返しても判定全体を捨てないよう、"other" として受け取る。
// （強い注意を出すべき場面で「確認できませんでした」になるのを防ぐ）
const SignalTypeLenient = SignalType.catch("other");

export const Level = z.enum(["none", "caution", "warning", "unclear"]);
export type Level = z.infer<typeof Level>;

// Claude に返させる判定。根拠（signals）を先に、結論（level）を後に書かせる。
export const Assessment = z.object({
  signals: z.array(
    z.object({
      type: SignalTypeLenient,
      utterance_ids: z.array(z.number().int()),
      summary: z.string(),
    }),
  ),
  injection_suspected: z.boolean(),
  rationale: z.string(),
  level: Level,
});
export type Assessment = z.infer<typeof Assessment>;

// 判定だけモード: 説明文を書かせず、選択肢と発話番号だけを返させる（出力を短くして速くする）
export const QuickAssessment = z.object({
  signals: z.array(z.object({ type: SignalTypeLenient, utterance_ids: z.array(z.number().int()) })),
  injection_suspected: z.boolean(),
  level: Level,
});
export type QuickAssessment = z.infer<typeof QuickAssessment>;

export const AssessRequest = z.object({
  utterances: z.array(Utterance).min(1).max(300),
  // 開発画面からの障害注入（表示確認用）
  fault: z.enum(["none", "network", "invalid", "slow"]).default("none"),
});
export type AssessRequest = z.input<typeof AssessRequest>;

export type AssessResponse =
  | {
      ok: true;
      assessment: Assessment;
      model: string;
      preset: string;
      latencyMs: number;
      usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
    }
  | {
      ok: false;
      // network: API に届かない/タイムアウト, invalid: 応答が判定として使えない,
      // refusal: モデルが応答を拒否, config: キー未設定など
      kind: "network" | "invalid" | "refusal" | "config";
      message: string;
      latencyMs: number;
    };
