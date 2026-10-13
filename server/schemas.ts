import { z } from "zod";

// API モード（server/）と MCP モード（mcp/）で共有するスキーマ

// ---------- 入力の型 ----------

export const SetupSchema = z.object({
  role: z.string().max(200).default(""), // 志望職種・企業など
  interviewType: z.string().max(100).default("一般"), // 新卒 / 中途 / アルバイト など
  notes: z.string().max(4000).default(""), // 自己PR・経歴メモなど（任意）
});
export type Setup = z.infer<typeof SetupSchema>;

export const TurnSchema = z.object({
  question: z.string().max(2000),
  answer: z.string().max(10000),
  durationSec: z.number().nonnegative().optional(),
  isFollowup: z.boolean().default(false),
});
export type Turn = z.infer<typeof TurnSchema>;

// ---------- 最終評価 ----------

export const EvaluationOutput = z.object({
  overall_score: z.number(),
  grade: z.string(),
  summary: z.string(),
  criteria: z.array(
    z.object({
      name: z.string(),
      score: z.number(),
      comment: z.string(),
    }),
  ),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
  per_question: z.array(
    z.object({
      question: z.string(),
      score: z.number(),
      feedback: z.string(),
      better_answer_example: z.string(),
    }),
  ),
  next_steps: z.array(z.string()),
});
export type Evaluation = z.infer<typeof EvaluationOutput>;
