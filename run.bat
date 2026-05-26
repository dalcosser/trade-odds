@echo off
REM ============================================================
REM  Trade Odds — Windows launcher (thin client)
REM
REM  This boots a local proxy at http://localhost:7071 that
REM  forwards everything to the canonical Trade Odds instance
REM  running on the Mac mini. You get the full UI with live data
REM  without needing any API keys, ClickHouse access, or sync.
REM
REM  REQUIRES: Node.js 20 or later  (https://nodejs.org)
REM
REM  CONFIG: copy .env.example to .env to override the upstream URL
REM ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo  [error] Node.js not found in PATH.
  echo  Install Node 20+ from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

REM Honor STANDALONE / PORT from .env so server.mjs picks the right mode
set "STANDALONE="
set "PORT=7071"
if exist .env (
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="STANDALONE" set "STANDALONE=%%b"
    if /i "%%a"=="PORT" set "PORT=%%b"
  )
)

if "%STANDALONE%"=="1" (
  echo  Starting Trade Odds in STANDALONE mode...
  echo  Reads from local memory\*.json. Make sure run-scanners.bat is running too.
) else (
  echo  Starting Trade Odds client ^(proxy mode^)...
)
echo  Open http://localhost:%PORT% in your browser.
echo  ^(Ctrl+C in this window to stop.^)
echo.

start "" http://localhost:%PORT%
node server.mjs

echo.
echo  Trade Odds client stopped.
pause
