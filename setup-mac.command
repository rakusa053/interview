#!/bin/bash
# ダブルクリックでセットアップ（Mac）
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。https://nodejs.org から LTS 版をインストールしてから、もう一度開いてください。"
  open "https://nodejs.org/ja"
  read -r -p "Enter キーで閉じます"
  exit 1
fi

echo "必要な部品をインストールしています…（数分かかることがあります）"
npm install --no-fund --no-audit || { read -r -p "インストールに失敗しました。Enter キーで閉じます"; exit 1; }
node scripts/setup.mjs
read -r -p "Enter キーで閉じます"
