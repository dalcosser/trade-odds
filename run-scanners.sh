#!/usr/bin/env bash
# Trade Odds — Scanner Scheduler (macOS / Linux)
# Runs the data-producing scanners on this machine. Writes fresh memory/*.json
# that the dashboard (server.mjs --standalone) reads. Stays running.
set -euo pipefail
cd "$(dirname "$0")"

if [ -x /opt/homebrew/bin/node ]; then NODE=/opt/homebrew/bin/node
elif [ -x /usr/local/bin/node ]; then NODE=/usr/local/bin/node
else NODE="$(command -v node || true)"; fi
if [ -z "${NODE}" ]; then echo "  [error] Node 20+ not found"; exit 1; fi

if [ ! -f .env ]; then
  echo "  [warn] No .env at $(pwd)/.env — scanners will fail without API keys."
fi

echo "  Starting Trade Odds scanner scheduler..."
echo "  Writes to ./memory/*.json"
echo "  (Ctrl+C to stop.)"
echo
exec "${NODE}" source/runScanners.mjs
