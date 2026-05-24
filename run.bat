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

echo.
echo  Starting Trade Odds client...
echo  Open http://localhost:7071 in your browser.
echo  ^(Ctrl+C in this window to stop.^)
echo.

start "" http://localhost:7071
node server.mjs

echo.
echo  Trade Odds client stopped.
pause
