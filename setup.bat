@echo off
REM ============================================================
REM   Chrome relaunch — only re-opens the two debug-port Chrome
REM   windows if you accidentally closed them. start.bat already
REM   does this; you only need this file as a standalone shortcut.
REM ============================================================

cd /d "%~dp0"
node scripts\setup_chrome.cjs

echo.
echo ============================================================
echo   Press any key to close.
echo ============================================================
pause >nul
