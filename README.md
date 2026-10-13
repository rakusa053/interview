# 面接練習アプリ

画面に表示された面接の質問に **声で回答** し、録音・文字起こしした内容を Claude に送って
**深堀質問** と **最終評価** を受け取れる面接練習アプリです。

## できること

1. **面接の設定**: 面接の種類（新卒 / 中途 / アルバイト / インターン / 入試）、志望職種・企業、経歴メモ、質問数、深堀の回数を指定
2. **質問の提示**: Claude が条件に合わせて質問を作成（または定番の質問を使用）。聞き方は3種類から選べます
   - **画面表示＋読み上げ**: 質問文を表示し、合成音声でも読み上げ
   - **音声だけで聞く（本番モード）**: 質問文は表示せず、合成音声の質問だけを聞いて答える。「もう一度聞く」「質問文を表示」で補助あり
   - **画面表示だけ**
   - 声（ブラウザ・OS に入っている日本語音声から選択）と読み上げ速度を変更でき、「読み上げ後に自動で録音開始」も設定可能
3. **口頭で回答 → 録音 + 自動文字起こし**: ブラウザのマイクで録音し、リアルタイムで文字起こし。誤変換は手で修正でき、録音の再生もできます
4. **深堀質問**: 回答が抽象的・具体例不足などのとき、Claude が面接官として深堀質問をします（1問あたりの最大回数を設定可能）
5. **最終評価**: 100点満点のスコアと S〜D のランク、5項目の評価（論理性・具体性・熱意・一貫性・話し方）、良かった点・改善点、質問ごとのフィードバックと「より良い回答例」、次回意識すること
6. 記録と評価をテキストファイルで保存

## かんたんセットアップ（ダブルクリック）

1. [Node.js](https://nodejs.org/ja)（LTS 版）をインストール
2. このアプリの ZIP をダウンロードして展開（例:「書類」フォルダに置く）
3. 展開したフォルダの中のファイルをダブルクリック
   - **Mac**: `setup-mac.command`
     （「開いていません」「開発元を確認できない」と出たら「完了」を押し、ターミナルで
     `bash ` と入力したあと（最後にスペース）、`setup-mac.command` をターミナルにドラッグして Enter）
   - **Windows**: `setup-windows.bat`
     （「PC を保護しました」と出たら、「詳細情報」→「実行」）
4. Claude Desktop を完全に終了して起動し直し、チャットで「**模擬面接をして**」と話しかける

セットアップは、必要な部品のインストールと、Claude Desktop への登録（`claude_desktop_config.json` に追記。元のファイルは `.bak` として保存）を自動で行います。
API モードで使うときは、`.env` に API キーを書いてから `start-api-mac.command` / `start-api-windows.bat` をダブルクリックします。

> フォルダを移動したら、もう一度セットアップを実行してください（登録されている場所が変わるため）。


- Node.js 20.12 以上
- Claude API キー（[Claude Console](https://console.anthropic.com/) で発行）
- **Google Chrome または Microsoft Edge**（自動文字起こしに Web Speech API を使っています。その他のブラウザでは録音のみ動作し、回答は手入力になります）

## 起動方法

```bash
npm install
cp .env.example .env   # .env を開いて ANTHROPIC_API_KEY を設定
npm start
```

ブラウザで http://localhost:3000 を開き、マイクの使用を許可してください。

## Claude 連携モード（MCP サーバー）— API 料金なしで使う

Claude Desktop などのアプリにこのアプリを **MCP サーバー** としてつなぐと、チャット中の Claude が面接官になります。
Claude API を呼ばないので **API 料金はかかりません**（ご契約中の Claude プランの利用枠を使います）。

```
Claude Desktop（面接官: 質問・深堀・評価を考える）
   │  MCP（start_interview / ask_question / wait_for_answer / show_evaluation）
   ▼
MCP サーバー（mcp/server.ts）
   │  http://localhost:3939/?mode=mcp
   ▼
ブラウザの練習画面（質問の表示・読み上げ、回答の録音・文字起こし）
```

### 設定方法（Claude Desktop）

1. `npm install` を実行しておく（API キーは不要）
2. Claude Desktop の「設定 → 開発者 → 構成を編集」で `claude_desktop_config.json` を開き、次を追加
   （パスはこのフォルダの場所に合わせて書き換えてください）

   **Mac**
   ```json
   {
     "mcpServers": {
       "interview": {
         "command": "node",
         "args": [
           "/Users/あなた/interview/node_modules/tsx/dist/cli.mjs",
           "/Users/あなた/interview/mcp/server.ts"
         ]
       }
     }
   }
   ```

   **Windows**
   ```json
   {
     "mcpServers": {
       "interview": {
         "command": "node",
         "args": [
           "C:\\Users\\あなた\\interview\\node_modules\\tsx\\dist\\cli.mjs",
           "C:\\Users\\あなた\\interview\\mcp\\server.ts"
         ]
       }
     }
   }
   ```
   `node` が見つからないと言われる場合は、`"command"` に node のフルパス（Mac は `which node`、Windows は `where node` で確認）を書いてください。
3. Claude Desktop を再起動する
4. チャットで「**模擬面接をして**」（例:「新卒のITエンジニア志望で模擬面接をして」）と話しかける
5. ブラウザで練習画面が開くので、質問の聞き方を選んで「Claude との面接を始める」を押す。あとは画面の質問に声で答えるだけです

Claude Code で使う場合:
`claude mcp add interview -- node /path/to/interview/node_modules/tsx/dist/cli.mjs /path/to/interview/mcp/server.ts`

### 補足
- 回答を待つ間、Claude は `wait_for_answer` を繰り返し呼びます（1回あたり最大40秒。`MCP_WAIT_SECONDS` で変更可）
- 練習画面のポートは `3939`（`MCP_PORT` で変更可）
- ブラウザの練習画面は **ローカル MCP に対応した Claude Desktop（Mac / Windows）や Claude Code** で使えます。スマホアプリや Web 版の claude.ai からは使えません
- プランの利用上限の対象になります。長い面接を何度も続けると上限に達することがあります


```
server/index.ts   Express サーバー（API モード: API とフロントエンドの配信）
server/claude.ts  Claude API の呼び出し（質問生成・深堀判定・最終評価）
server/schemas.ts 両モード共通のスキーマ（評価の形式など）
mcp/server.ts     MCP サーバー（Claude 連携モード）
scripts/setup.mjs セットアップ（Claude Desktop への登録など）
public/           画面（HTML / CSS / JavaScript）
```

| API | 内容 |
|---|---|
| `POST /api/questions` | 条件に合わせて質問を生成 |
| `POST /api/followup` | 回答を読んで深堀するか判断し、深堀質問を返す |
| `POST /api/evaluate` | 面接全体を評価（構造化 JSON で返す） |

- モデルは `claude-opus-5-5`（環境変数 `CLAUDE_MODEL` で変更可）。深堀判定は待ち時間を短くするため effort を `low`、最終評価は `high` にしています
- Claude の応答は Structured Outputs（zod スキーマ）で受け取り、そのまま画面に表示しています
- 安全分類器で応答が拒否された場合に備え、サーバー側フォールバック（`fallbacks: "default"`）を有効にしています
- 音声データはブラウザ内にだけ保持され、サーバーや Claude には **文字起こしテキストのみ** 送られます

## 補足・制限

- Chrome の音声認識は Google の音声認識サービスを使うため、インターネット接続が必要です
- 「続けて録音」で追記した場合、文字起こしは追記されますが、再生できる音声は最後に録音した部分のみです
