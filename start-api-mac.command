#!/bin/bash
# ダブルクリックで API モードを起動（Mac）
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
[ -d node_modules ] || npm install --no-fund --no-audit
(sleep 3 && open "http://localhost:${PORT:-3000}") &
echo "このウィンドウを閉じるとアプリが終了します。"
npm start
