@echo off
chcp 65001 >nul 2>&1
title QQ Agent（便携版）
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo   [错误] 没找到 node_modules\electron
  echo   压缩包可能没解压完整，请整包重新解压一次。
  echo.
  pause
  exit /b 1
)

net session >nul 2>&1
if errorlevel 1 (
  echo   [提示] 当前不是管理员权限。若之后连 QQ 一直失败，
  echo          请关掉本窗口，右键本文件选择「以管理员身份运行」。
  echo.
)

echo 正在自检环境（第一次启动会修一下 Python 路径，之后是秒过）...
echo.
set "ELECTRON_RUN_AS_NODE=1"
"node_modules\electron\dist\electron.exe" "tools\portable-setup.mjs"
set "RC=%ERRORLEVEL%"
set "ELECTRON_RUN_AS_NODE="

if not "%RC%"=="0" (
  echo.
  echo   上面标 [缺失] 的项请先解决再启动。
  echo   如果只是「没检测到 PC 版 QQ」，装好 QQ 后再双击本文件就行。
  echo.
  pause
  exit /b %RC%
)

echo 启动中……窗口几秒后出现，本黑窗口可以关掉。
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
