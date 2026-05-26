@echo off
REM ============================================================
REM  Trade Odds — Scanner Scheduler (Windows)
REM
REM  Runs the data-producing scanners on this machine. Writes
REM  fresh memory/*.json that the dashboard (server.mjs --standalone)
REM  can serve. Stays running in the background — Ctrl+C to stop.
REM
REM  REQUIRES:
REM    - Node 20+
REM    - .env at repo root with MASSIVE_API_KEY, UW_API_KEY, CLICKHOUSE_*
REM ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo  [error] Node.js not found in PATH.
  echo  Install Node 20+ from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo.
  echo  [warn] No .env file found. Scanners will fail without API keys.
  echo  See source/scanners/lib/README or copy .env.example to .env.
  echo.
)

echo.
echo  Starting Trade Odds scanner scheduler...
echo  Writes to memory\*.json — readable by the local dashboard.
echo  ^(Ctrl+C in this window to stop.^)
echo.

node source\runScanners.mjs

echo.
echo  Scanner scheduler stopped.
pause
