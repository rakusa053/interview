@echo off
chcp 65001 >nul
rem ダブルクリックで API モードを起動（Windows）
cd /d "%~dp0"
if not exist node_modules call npm install --no-fund --no-audit
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
echo このウィンドウを閉じるとアプリが終了します。
call npm start
pause
