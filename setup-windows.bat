@echo off
chcp 65001 >nul
rem ダブルクリックでセットアップ（Windows）
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。https://nodejs.org から LTS 版をインストールしてから、もう一度開いてください。
  start https://nodejs.org/ja
  pause
  exit /b 1
)
echo 必要な部品をインストールしています…（数分かかることがあります）
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo インストールに失敗しました。
  pause
  exit /b 1
)
node scripts\setup.mjs
pause
