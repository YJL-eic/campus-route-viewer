@echo off
chcp 65001 >nul
title 三校区低空货运航路展示
cd /d "%~dp0web"

where python >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 Python。
  echo 请先安装 Python 3，并勾选 “Add python.exe to PATH”。
  echo 下载：https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

echo ========================================
echo   三校区低空货运航路展示
echo ========================================
echo.
echo 正在启动本地服务：http://localhost:8080/
echo 关闭本窗口即停止服务。
echo.

start "" "http://localhost:8080/"
python -m http.server 8080
