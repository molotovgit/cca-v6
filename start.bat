@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM   v5 BATCH MODE — edit lessons.txt to set the list of chapters.
REM   See lessons.txt.example for format.  start.bat will create
REM   lessons.txt from the example on first run and open it in
REM   Notepad for you to edit.
REM ============================================================


REM ---- 1. Prerequisite check ----
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: Node.js not installed. See SETUP.md step 1, then re-run.
  pause
  exit /b 1
)
where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: Python not installed. See SETUP.md step 1, then re-run.
  pause
  exit /b 1
)


REM ---- 2. Bootstrap .env from template (first run only) ----
if not exist .env (
  if not exist .env.example (
    echo ERROR: .env.example missing — cannot bootstrap .env.
    pause
    exit /b 1
  )
  copy .env.example .env >nul
  echo.
  echo ============================================================
  echo   .env created from template. Notepad will open it now.
  echo   Fill in your real credentials, save, and CLOSE Notepad.
  echo ============================================================
  notepad .env
  echo.
  echo .env saved. Continuing...
)


REM ---- 2b. Bootstrap lessons.txt from template (first run only) ----
if not exist lessons.txt (
  if not exist lessons.txt.example (
    echo ERROR: lessons.txt.example missing — cannot bootstrap lessons.txt.
    pause
    exit /b 1
  )
  copy lessons.txt.example lessons.txt >nul
  echo.
  echo ============================================================
  echo   lessons.txt created from template. Notepad will open it now.
  echo   Edit the list of chapters (one per line), save, and CLOSE.
  echo ============================================================
  notepad lessons.txt
  echo.
  echo lessons.txt saved. Continuing...
)


REM ---- 3. Install deps (idempotent — fast on re-run) ----
echo.
echo Checking Node dependencies...
call npm install --silent

echo Checking Python dependencies...
pip install -q -r requirements.txt


REM ---- 4. Ensure both Chrome windows are running ----
echo.
echo Ensuring Chrome windows are up...
node scripts\setup_chrome.cjs


REM ---- 4b. Attempt auto-login (best-effort; falls back to manual on blocker) ----
echo.
echo Attempting auto-login (uses CHATGPT_* / GEMINI_* from .env)...
python auto_login.py
set AUTOLOGIN_RC=%errorlevel%


REM ---- 5. Pause for manual sign-in (fallback if auto-login didn't fully succeed) ----
echo.
echo ============================================================
if "%AUTOLOGIN_RC%"=="0" (
  echo   Auto-login succeeded. Press ENTER to start the pipeline.
) else (
  echo   Auto-login did NOT complete fully ^(see output above^).
  echo   If Chrome was just launched for the first time, sign in manually:
  echo     Window 1: chatgpt.com
  echo     Window 2: gemini.google.com
  echo   Then press ENTER to start the pipeline.
  echo   ^(Sessions persist; subsequent runs will skip the manual step.^)
)
echo ============================================================
pause


REM ---- 6. Run batch pipeline over every chapter in lessons.txt ----
node scripts\run_batch.cjs


echo.
echo ============================================================
echo   Batch finished (or stopped). Press any key to close.
echo ============================================================
pause >nul
