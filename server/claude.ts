import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { EvaluationOutput, type Evaluation, type Setup, type Turn } from "./schemas.js";

export { SetupSchema, TurnSchema } from "./schemas.js";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";

// 認証情報は ANTHROPIC_API_KEY（または `ant auth login` のプロファイル）から読み込まれる
const client = new Anthropic();

// ---------- 出力の型（Structured Outputs） ----------

const QuestionsOutput = z.object({
  questions: z.array(z.string()),
});

const FollowupOutput = z.object({
  needs_followup: z.boolean(),
  followup_question: z.string(),
  brief_comment: z.string(),
});
export type Followup = z.infer<typeof FollowupOutput>;

// ---------- プロンプト ----------

const INTERVIEWER_SYSTEM = `あなたは経験豊富な日本企業の面接官兼キャリアコーチです。
ユーザーは面接練習アプリで、表示された質問に口頭で回答しています。回答は音声認識で文字起こしされたものなので、
誤変換・句読点の欠落・フィラー（えー、あのー）が含まれることがあります。誤変換は文脈から好意的に解釈し、内容そのものを評価してください。
出力はすべて自然な日本語で書いてください。`;

function describeSetup(setup: Setup): string {
  return [
    `面接の種類: ${setup.interviewType || "一般"}`,
    `志望職種・企業: ${setup.role || "（指定なし）"}`,
    setup.notes ? `応募者の事前メモ（経歴・自己PRなど）:\n${setup.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function describeTranscript(turns: Turn[]): string {
  return turns
    .map((t, i) => {
      const label = t.isFollowup ? "深堀質問" : "質問";
      const dur =
        t.durationSec !== undefined ? `（回答時間: 約${Math.round(t.durationSec)}秒）` : "";
      return `[${i + 1}] ${label}: ${t.question}\n回答${dur}: ${t.answer || "（無回答）"}`;
    })
    .join("\n\n");
}

// ---------- 共通の呼び出し ----------

async function callStructured<T extends z.ZodType>(
  schema: T,
  userContent: string,
  effort: "low" | "medium" | "high",
): Promise<z.infer<T>> {
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: INTERVIEWER_SYSTEM,
    messages: [{ role: "user", content: userContent }],
    output_config: { effort, format: betaZodOutputFormat(schema) },
    // 安全分類器で拒否された場合はサーバー側で推奨モデルに自動フォールバック
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude がこのリクエストへの回答を控えました。内容を変えて再度お試しください。");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude の応答が長すぎて途中で切れました。もう一度お試しください。");
  }
  if (!response.parsed_output) {
    throw new Error("Claude の応答を解析できませんでした。");
  }
  return response.parsed_output as z.infer<T>;
}

// ---------- 公開関数 ----------

export async function generateQuestions(setup: Setup, count: number): Promise<string[]> {
  const out = await callStructured(
    QuestionsOutput,
    `以下の条件の面接で実際に聞かれそうな質問を${count}個作成してください。
最初は自己紹介などのアイスブレイク、徐々に志望動機・経験・強み弱み・状況対応などへ進む自然な順番にしてください。
各質問は面接官が口頭で聞く1文〜2文の長さにしてください。

${describeSetup(setup)}`,
    "low",
  );
  return out.questions.slice(0, count);
}

export async function decideFollowup(
  setup: Setup,
  history: Turn[],
  current: Turn[],
  followupsLeft: number,
): Promise<Followup> {
  return callStructured(
    FollowupOutput,
    `${describeSetup(setup)}

## これまでの面接のやりとり
${history.length ? describeTranscript(history) : "（なし）"}

## 現在の質問とその回答
${describeTranscript(current)}

## 指示
現在の質問に対する最新の回答を読み、面接官として深堀質問をすべきか判断してください。
- 回答が抽象的・根拠が薄い・具体例がない・矛盾がある・もっと引き出せる点がある場合は深堀質問をする（needs_followup=true）。
- 十分に具体的で深堀の必要がない場合や、無回答に近い場合は needs_followup=false にして次の質問へ進める。
- この質問であと最大 ${followupsLeft} 回まで深堀できます。
- followup_question は面接官が実際に口頭で聞く自然な1〜2文。needs_followup=false のときは空文字。
- brief_comment は回答への一言リアクション（面接官の相づち程度、30字以内。評価やアドバイスは書かない）。`,
    "low",
  );
}

export async function evaluateInterview(setup: Setup, turns: Turn[]): Promise<Evaluation> {
  return callStructured(
    EvaluationOutput,
    `${describeSetup(setup)}

## 面接の全記録
${describeTranscript(turns)}

## 指示
この模擬面接全体を、面接官かつキャリアコーチとして評価してください。
- overall_score: 0〜100 の整数。grade: S / A / B / C / D のいずれか。
- criteria: 次の5項目をそれぞれ 1〜5 の整数で採点し、根拠を具体的にコメント:
  「論理性・結論ファースト」「具体性・エピソード」「志望度・熱意」「自己理解・一貫性」「話し方・簡潔さ（回答時間も考慮）」
- strengths / improvements: 回答中の具体的な発言を引用しながら、それぞれ3〜5個。
- per_question: 深堀質問ではない元の質問ごとに（深堀でのやりとりも含めて）1〜5 で採点し、feedback と、
  応募者の話した内容を活かした「より良い回答例」（200〜300字程度）を書く。
- next_steps: 次回の練習で意識すべきことを3つ。
厳しすぎず甘すぎず、本番の面接官の視点で率直に評価してください。`,
    "high",
  );
}
