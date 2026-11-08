@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 node.exe，请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)
echo 正在启动词汇库……
node "%~dp0bin\vocab-app.js" --cwd "%~dp0" --port 7788
if errorlevel 1 pause
