// かんたんセットアップ: setup-mac.command / setup-windows.bat から呼ばれる
// - .env がなければ .env.example からコピー（API モード用）
// - Claude Desktop の設定ファイルに、この面接練習アプリを MCP サーバーとして登録

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ok = (msg) => console.log(`✔ ${msg}`);
const warn = (msg) => console.log(`⚠ ${msg}`);

// Node.js のバージョン確認（process.loadEnvFile は 20.12 以降）
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  warn(`Node.js ${process.versions.node} は古いため動かない可能性があります。https://nodejs.org から LTS 版を入れ直してください。`);
}

// .env（API モード用）
const envPath = path.join(root, ".env");
if (!fs.existsSync(envPath)) {
  fs.copyFileSync(path.join(root, ".env.example"), envPath);
  ok(".env を作成しました（API モードを使うときだけ、中の ANTHROPIC_API_KEY を書き換えてください）");
}

// Claude Desktop の設定ファイルの場所
function claudeConfigPath() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

const serverEntry = {
  // node はフルパスで登録する（Claude Desktop から PATH が見えないことがあるため）
  command: process.execPath,
  args: [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "mcp", "server.ts")],
};

const configPath = claudeConfigPath();
let config = {};
if (fs.existsSync(configPath)) {
  try {
    const text = fs.readFileSync(configPath, "utf8");
    config = text.trim() ? JSON.parse(text) : {};
  } catch {
    warn(`Claude Desktop の設定ファイルを読み込めませんでした: ${configPath}`);
    console.log("ファイルの中身が壊れている可能性があります。次の内容を手で mcpServers に追加してください:\n");
    console.log(JSON.stringify({ mcpServers: { interview: serverEntry } }, null, 2));
    process.exit(1);
  }
  fs.copyFileSync(configPath, `${configPath}.bak`);
} else {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
}

config.mcpServers = { ...(config.mcpServers ?? {}), interview: serverEntry };
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
ok(`Claude Desktop に面接練習アプリを登録しました（${configPath}）`);

console.log(`
セットアップ完了！

【Claude Desktop で使う（API 料金なし）】
  1. Claude Desktop を完全に終了して、もう一度起動する
  2. チャットで「新卒のITエンジニア志望で模擬面接をして」などと話しかける

【API モードで使う】
  .env に API キーを書いてから、start-api-mac.command（Mac）/ start-api-windows.bat（Windows）を開く
`);
