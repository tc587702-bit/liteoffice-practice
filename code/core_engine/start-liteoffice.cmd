@echo off
rem ============================================================================
rem  LiteOffice launcher (double-click me)
rem
rem  Why this file exists: starting the dev server needs a terminal, which is
rem  friction for "just take a look". This script builds the app, starts the
rem  server in its own window, then opens the browser at the right URL.
rem
rem  Content is intentionally ASCII-only: Windows cmd.exe reads batch files using
rem  the current OEM code page, so Chinese text here would turn into mojibake on
rem  some machines. English messages are ugly but always correct.
rem ============================================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [LiteOffice] Node.js not found in PATH.
  echo               Install Node.js 22.18 or newer, then run this again.
  pause
  exit /b 1
)

echo [LiteOffice] Building...
node tools\build.mjs --quiet
if errorlevel 1 (
  echo [LiteOffice] Build FAILED. See the errors above.
  echo               Try: node tools\lint.mjs
  pause
  exit /b 1
)

echo [LiteOffice] Starting dev server in a separate window...
start "LiteOffice server (close this window to stop)" cmd /k node tools\serve.mjs

echo [LiteOffice] Waiting for the server to listen...
timeout /t 3 /nobreak >nul

echo [LiteOffice] Opening http://127.0.0.1:5180/apps/web/
start "" "http://127.0.0.1:5180/apps/web/"

echo.
echo Done. The server keeps running in its own window; close that window to stop it.
echo If the browser did not open, paste this address manually:
echo     http://127.0.0.1:5180/apps/web/
timeout /t 5 /nobreak >nul
exit /b 0
