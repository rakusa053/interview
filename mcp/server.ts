// 面接練習アプリの MCP サーバー
//
// Claude Desktop などの MCP クライアントにつなぐと、チャット中の Claude が面接官になり、
// ブラウザの練習画面（録音・文字起こし）とツールでやりとりしながら模擬面接と評価を行う。
// Claude API を呼ばないので API 料金はかからない（Claude のプランの利用枠を使う）。
//
// 注意: stdio で MCP をやりとりするため、標準出力には何も書かないこと（ログは console.error）。

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EvaluationOutput, type Evaluation, type Setup } from "../server/schemas.js";

const PORT = Number(process.env.MCP_PORT ?? 3939);
// MCP クライアントのツール呼び出しタイムアウト（多くは60秒）に収まるよう、1回の待ち時間は短めにする
const WAIT_SECONDS = Number(process.env.MCP_WAIT_SECONDS ?? 40);
const PAGE_URL = `http://localhost:${PORT}/?mode=mcp`;

// ---------- 面接セッションの状態 ----------

interface CurrentQuestion {
  id: number;
  text: string;
  number: number; // 何問目か（1始まり）
  isFollowup: boolean;
  reaction: string;
}

interface AnsweredTurn {
  question: string;
  answer: string;
  durationSec: number;
  isFollowup: boolean;
  mainIndex: number;
}

const session = {
  version: 0,
  active: false,
  setup: null as Setup | null,
  totalQuestions: 5,
  maxFollowups: 2,
  current: null as CurrentQuestion | null,
  turns: [] as AnsweredTurn[],
  unread: null as AnsweredTurn | null, // Claude がまだ受け取っていない回答
  evaluation: null as Evaluation | null,
  lastPollAt: 0,
};
const answerWaiters = new Set<() => void>();
let nextQuestionId = 1;

function bump() {
  session.version++;
}

function followupsUsed(number: number) {
  return session.turns.filter((t) => t.mainIndex === number - 1 && t.isFollowup).length;
}

function waitForAnswer(signal: AbortSignal): Promise<AnsweredTurn | null> {
  const take = () => {
    const t = session.unread;
    session.unread = null;
    return t;
  };
  if (session.unread) return Promise.resolve(take());
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      answerWaiters.delete(onAnswer);
      signal.removeEventListener("abort", finish);
      resolve(take());
    };
    const onAnswer = finish;
    const timer = setTimeout(finish, WAIT_SECONDS * 1000);
    answerWaiters.add(onAnswer);
    signal.addEventListener("abort", finish);
  });
}

function describeAnswer(t: AnsweredTurn | null): string {
  if (!t) {
    return "まだ回答中です。ユーザーへのメッセージは書かずに、続けて wait_for_answer を呼んで待ってください。";
  }
  const number = t.mainIndex + 1;
  const left = Math.max(0, session.maxFollowups - followupsUsed(number));
  return [
    `回答を受け取りました（${number}問目${t.isFollowup ? "の深堀" : ""}、回答時間 約${t.durationSec}秒）。`,
    `質問: ${t.question}`,
    `回答（音声認識の文字起こし）: ${t.answer || "（無回答）"}`,
    "",
    `この質問の深堀はあと ${left} 回までできます。全 ${session.totalQuestions} 問中 ${number} 問目です。`,
    left > 0
      ? "深堀が必要なら ask_question(is_followup=true)、十分なら次の質問を ask_question で出してください。"
      : "次の質問を ask_question で出してください。",
    number >= session.totalQuestions ? "これが最後の質問なら、次は show_evaluation で最終評価を表示してください。" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- ブラウザ画面用の HTTP サーバー ----------

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "..", "public")));

app.get("/mcp-api/state", (_req, res) => {
  session.lastPollAt = Date.now();
  res.json({
    version: session.version,
    active: session.active,
    setup: session.setup,
    totalQuestions: session.totalQuestions,
    current: session.current,
    turns: session.turns,
    evaluation: session.evaluation,
  });
});

const AnswerBody = z.object({
  questionId: z.number().int(),
  answer: z.string().max(10000),
  durationSec: z.number().nonnegative(),
});

app.post("/mcp-api/answer", (req, res) => {
  const parsed = AnswerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "リクエストの形式が正しくありません。" });
    return;
  }
  const cur = session.current;
  if (!cur || cur.id !== parsed.data.questionId) {
    res.status(409).json({ error: "この質問はすでに回答済みか、終了しています。" });
    return;
  }
  const turn: AnsweredTurn = {
    question: cur.text,
    answer: parsed.data.answer.trim(),
    durationSec: Math.round(parsed.data.durationSec),
    isFollowup: cur.isFollowup,
    mainIndex: cur.number - 1,
  };
  session.turns.push(turn);
  session.unread = turn;
  session.current = null;
  bump();
  for (const notify of [...answerWaiters]) notify();
  res.json({ ok: true });
});

let httpError: string | null = null;
app
  .listen(PORT, () => console.error(`面接練習画面: ${PAGE_URL}`))
  .on("error", (err: NodeJS.ErrnoException) => {
    httpError =
      err.code === "EADDRINUSE"
        ? `ポート ${PORT} が他のプログラムで使われています。環境変数 MCP_PORT で別のポートを指定してください。`
        : `練習画面のサーバーを起動できませんでした: ${err.message}`;
    console.error(httpError);
  });

function openBrowser(url: string) {
  // すでに練習画面が開いていれば新しいタブは開かない
  if (Date.now() - session.lastPollAt < 5000) return;
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {
    // ブラウザを開けなくても URL は案内するので無視
  }
}

// ---------- MCP サーバー ----------

const GUIDE = `あなたは経験豊富な日本企業の面接官兼キャリアコーチとして、ブラウザの面接練習画面を通じて模擬面接を行います。

## 進め方
1. start_interview で面接を始める。面接の種類（新卒・中途・アルバイトなど）や志望先が分からなければ、始める前にユーザーに一言で確認する（「おまかせ」なら一般的な内容で始める）。
2. 質問は ask_question で1問ずつ出す。質問は練習画面に表示・音声で読み上げられ、ユーザーは口頭で答える。
   - 質問文はチャットに書かない（ユーザーが音声だけで聞く本番モードを選んでいることがあるため）。チャットへの書き込みは最小限にする。
   - 最初は自己紹介などのアイスブレイクから始め、志望動機・経験・強み弱み・状況対応などへ自然に進める。各質問は面接官が口頭で聞く1〜2文にする。
3. ask_question / wait_for_answer の結果が「まだ回答中」なら、ユーザーにメッセージを書かずに wait_for_answer を呼び続ける。
4. 回答が届いたら面接官として判断する:
   - 抽象的・根拠が薄い・具体例がない・矛盾がある・もっと引き出せる点がある → 深堀質問（is_followup=true）。上限回数は守る。
   - 十分に具体的、または無回答に近い → 次の質問へ。
   - reaction には回答への一言の相づち（30字以内、評価やアドバイスは書かない）を入れる。
5. 予定の質問数が終わったら show_evaluation で最終評価を画面に表示し、チャットには2〜3文の総評だけ書く。

## 評価の基準
- overall_score: 0〜100 の整数。grade: S / A / B / C / D。
- criteria: 「論理性・結論ファースト」「具体性・エピソード」「志望度・熱意」「自己理解・一貫性」「話し方・簡潔さ（回答時間も考慮）」をそれぞれ 1〜5 の整数で採点し、根拠を具体的にコメント。
- strengths / improvements: 回答中の具体的な発言を引用しながら、それぞれ3〜5個。
- per_question: 深堀ではない元の質問ごとに、出した順で（深堀のやりとりも含めて）1〜5 で採点し、feedback と、応募者の話した内容を活かした「より良い回答例」（200〜300字程度）。
- next_steps: 次回の練習で意識すべきことを3つ。
厳しすぎず甘すぎず、本番の面接官の視点で率直に評価する。

回答は音声認識の文字起こしなので、誤変換・句読点の欠落・フィラーが含まれる。誤変換は文脈から好意的に解釈し、内容そのものを評価する。`;

const server = new McpServer(
  { name: "interview-practice", version: "0.1.0" },
  { instructions: GUIDE },
);

server.registerTool(
  "start_interview",
  {
    title: "模擬面接を開始",
    description:
      "面接練習を新しく始め、ブラウザで練習画面（質問の表示・読み上げ、回答の録音と文字起こし）を開く。進め方と評価の基準も返す。",
    inputSchema: {
      interview_type: z.string().describe("面接の種類。例: 新卒採用 / 中途採用（転職） / アルバイト・パート / インターン / 大学・高校入試"),
      role: z.string().optional().describe("志望職種・企業（分かれば）"),
      notes: z.string().optional().describe("ユーザーの経歴やアピールしたいこと（分かれば）"),
      total_questions: z.number().int().min(1).max(15).default(5).describe("深堀を除いた質問数"),
      max_followups: z.number().int().min(0).max(3).default(2).describe("1問あたりの深堀の最大回数"),
    },
  },
  async ({ interview_type, role, notes, total_questions, max_followups }) => {
    session.active = true;
    session.setup = { interviewType: interview_type, role: role ?? "", notes: notes ?? "" };
    session.totalQuestions = total_questions;
    session.maxFollowups = max_followups;
    session.current = null;
    session.turns = [];
    session.unread = null;
    session.evaluation = null;
    bump();
    openBrowser(PAGE_URL);

    const text = httpError
      ? `練習画面を開けません: ${httpError}`
      : `練習画面を開きました: ${PAGE_URL}
（ブラウザが開かない場合は、この URL を Chrome か Edge で開くようユーザーに伝えてください。画面で「Claude との面接を始める」を押すと質問が表示されます。）

面接の設定: ${interview_type} / 志望: ${role || "指定なし"} / 質問数 ${total_questions} 問 / 深堀は各 ${max_followups} 回まで

続けて ask_question で1問目を出してください。

${GUIDE}`;
    return { content: [{ type: "text", text }], isError: Boolean(httpError) };
  },
);

server.registerTool(
  "ask_question",
  {
    title: "質問を出す",
    description:
      "練習画面に質問を表示・読み上げし、ユーザーの口頭での回答（文字起こし）を待つ。一定時間で回答がなければ「まだ回答中」を返すので、その場合は wait_for_answer を呼ぶ。",
    inputSchema: {
      question: z.string().min(1).describe("面接官が口頭で聞く質問文（1〜2文）"),
      question_number: z.number().int().min(1).describe("何問目か（深堀は元の質問と同じ番号）"),
      is_followup: z.boolean().default(false).describe("直前の回答への深堀質問なら true"),
      reaction: z.string().optional().describe("直前の回答への一言の相づち（30字以内）。1問目では省略"),
    },
  },
  async ({ question, question_number, is_followup, reaction }, extra) => {
    if (!session.active) {
      return { content: [{ type: "text", text: "先に start_interview を呼んでください。" }], isError: true };
    }
    session.current = {
      id: nextQuestionId++,
      text: question,
      number: question_number,
      isFollowup: is_followup,
      reaction: reaction ?? "",
    };
    session.unread = null;
    bump();
    const answer = await waitForAnswer(extra.signal);
    return { content: [{ type: "text", text: describeAnswer(answer) }] };
  },
);

server.registerTool(
  "wait_for_answer",
  {
    title: "回答を待つ",
    description: "ask_question で出した質問への回答をさらに待つ。まだ回答中なら同じく「まだ回答中」を返す。",
    inputSchema: {},
  },
  async (_args, extra) => {
    if (!session.current && !session.unread) {
      return { content: [{ type: "text", text: "回答待ちの質問はありません。ask_question で質問を出してください。" }] };
    }
    const answer = await waitForAnswer(extra.signal);
    return { content: [{ type: "text", text: describeAnswer(answer) }] };
  },
);

server.registerTool(
  "show_evaluation",
  {
    title: "最終評価を表示",
    description:
      "面接全体の最終評価を練習画面に表示して面接を終える。採点基準は start_interview の結果にある「評価の基準」に従う。",
    inputSchema: EvaluationOutput.shape,
  },
  async (evaluation) => {
    if (!session.active) {
      return { content: [{ type: "text", text: "進行中の面接がありません。" }], isError: true };
    }
    session.evaluation = evaluation;
    session.current = null;
    session.active = false;
    bump();
    return {
      content: [
        {
          type: "text",
          text: "練習画面に最終評価を表示しました。チャットには2〜3文の総評と、次回の練習で意識することを短く伝えてください。",
        },
      ],
    };
  },
);

server.registerPrompt(
  "mock_interview",
  {
    title: "模擬面接を始める",
    description: "音声で答える模擬面接を始めます",
    argsSchema: {
      interview_type: z.string().optional().describe("面接の種類（例: 新卒採用）"),
      role: z.string().optional().describe("志望職種・企業"),
    },
  },
  ({ interview_type, role }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `面接練習ツールで模擬面接をしてください。${interview_type ? `面接の種類: ${interview_type}。` : ""}${role ? `志望: ${role}。` : ""}`,
        },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
