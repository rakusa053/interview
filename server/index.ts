import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

// .env があれば読み込む（Node 20.12+）
try {
  process.loadEnvFile();
} catch {
  // .env がなければ環境変数をそのまま使う
}

const {
  SetupSchema,
  TurnSchema,
  generateQuestions,
  decideFollowup,
  evaluateInterview,
} = await import("./claude.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "..", "public")));

function handle<T extends z.ZodType>(schema: T, fn: (body: z.infer<T>) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "リクエストの形式が正しくありません。", detail: parsed.error.issues });
      return;
    }
    try {
      res.json(await fn(parsed.data));
    } catch (err) {
      console.error(err);
      let message = err instanceof Error ? err.message : "不明なエラーが発生しました。";
      let status = 500;
      if (err instanceof Anthropic.AuthenticationError) {
        message = "Claude API キーが無効です。.env の ANTHROPIC_API_KEY を確認してください。";
        status = 401;
      } else if (err instanceof Anthropic.RateLimitError) {
        message = "Claude API のレート制限に達しました。少し待ってから再度お試しください。";
        status = 429;
      } else if (err instanceof Anthropic.APIConnectionError) {
        message = "Claude API に接続できませんでした。ネットワークを確認してください。";
        status = 502;
      } else if (err instanceof Anthropic.APIError) {
        message = `Claude API エラー (${err.status ?? "?"}): ${err.message}`;
        status = 502;
      }
      res.status(status).json({ error: message });
    }
  };
}

app.post(
  "/api/questions",
  handle(
    z.object({ setup: SetupSchema, count: z.number().int().min(1).max(15).default(5) }),
    async ({ setup, count }) => ({ questions: await generateQuestions(setup, count) }),
  ),
);

app.post(
  "/api/followup",
  handle(
    z.object({
      setup: SetupSchema,
      history: z.array(TurnSchema).max(100).default([]),
      current: z.array(TurnSchema).min(1).max(20),
      followupsLeft: z.number().int().min(0).max(5),
    }),
    async ({ setup, history, current, followupsLeft }) => {
      if (followupsLeft <= 0) {
        return { needs_followup: false, followup_question: "", brief_comment: "" };
      }
      return decideFollowup(setup, history, current, followupsLeft);
    },
  ),
);

app.post(
  "/api/evaluate",
  handle(
    z.object({ setup: SetupSchema, turns: z.array(TurnSchema).min(1).max(100) }),
    async ({ setup, turns }) => evaluateInterview(setup, turns),
  ),
);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`面接練習アプリ: http://localhost:${port}`);
});
