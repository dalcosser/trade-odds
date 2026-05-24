#!/usr/bin/env bash
# Trade Odds — macOS / Linux launcher (thin client)
# Boots a local proxy at http://localhost:7071 that forwards to the canonical
# Trade Odds instance. See server.mjs header for details.
set -euo pipefail
cd "$(dirname "$0")"

if [ -x /opt/homebrew/bin/node ]; then NODE=/opt/homebrew/bin/node
elif [ -x /usr/local/bin/node ]; then NODE=/usr/local/bin/node
else NODE="$(command -v node || true)"; fi

if [ -z "${NODE}" ]; then
  echo "  [error] Node 20+ not found. Install from https://nodejs.org"
  exit 1
fi

echo "  Starting Trade Odds client at http://localhost:7071"
echo "  (Ctrl+C to stop.)"
echo
exec "${NODE}" server.mjs
