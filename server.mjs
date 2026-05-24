// Trade Odds — thin-client proxy. Serves the dashboard UI on localhost by
// forwarding all requests to the canonical instance running on the Mac mini.
//
// This makes the dashboard usable from any machine (Windows, Linux, Mac) with
// nothing but Node 20+ installed — no API keys, no ClickHouse access, no data
// directory. The Mac instance does all the work; this just transports.
//
// USAGE
//   macOS / Linux:  ./run.sh
//   Windows:        double-click run.bat
//   then open      http://localhost:7071
//
// CONFIG
//   REMOTE_DATA_URL  (default below) — the canonical instance to proxy to.
//                    Override in .env to point at a different host.
//   PORT             (default 7071)   — local port to listen on.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- portable .env loader ----------
const __dir = dirname(fileURLToPath(import.meta.url));
(function loadDotEnv() {
  const envPath = resolve(__dir, '.env');
  if (!existsSync(envPath)) return;
  try {
    for (const raw of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && process.env[k] == null) process.env[k] = v;
    }
  } catch (e) { console.error('[trade-odds] .env load skipped:', e.message); }
})();

const REMOTE = (process.env.REMOTE_DATA_URL || 'https://davids-mac-mini.tailfd4a41.ts.net:8443').replace(/\/$/, '');
const PORT = parseInt(process.env.PORT || '7071', 10);

console.log(`[trade-odds] proxying to: ${REMOTE}`);
console.log(`[trade-odds] listening on: http://localhost:${PORT}`);

// ---------- proxy server ----------
const server = createServer(async (req, res) => {
  const target = REMOTE + req.url;
  try {
    // Forward request (GET only — dashboard is read-only)
    const r = await fetch(target, {
      method: req.method,
      headers: {
        // Don't forward Host (would mismatch the upstream cert)
        'User-Agent': 'trade-odds-client/1.0',
        ...(req.headers.accept ? { Accept: req.headers.accept } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });

    // Copy status and content-type; let fetch handle the body stream
    const ct = r.headers.get('content-type') || 'text/plain';
    const headers = {
      'Content-Type': ct,
      'Cache-Control': 'no-cache, no-store',
    };
    res.writeHead(r.status, headers);
    if (r.body) {
      // Stream through
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!doctype html><html><head><title>Trade Odds — Offline</title>
      <style>
        body{font:14px/1.5 -apple-system,Segoe UI,system-ui;background:#0a0c10;color:#e6edf3;margin:0;padding:60px 40px;max-width:680px}
        h1{font-size:22px;color:#f85149;margin:0 0 14px}
        code{background:#1a212c;padding:2px 8px;border-radius:4px;color:#7ee787;font-size:13px}
        .meta{color:#7a8693;font-size:12px;margin-top:24px;padding-top:14px;border-top:1px solid #232b36}
      </style></head>
      <body>
        <h1>Can't reach the data server</h1>
        <p>This Trade Odds client tried to proxy to:</p>
        <p><code>${REMOTE}</code></p>
        <p>Error: <code>${String(e.message || e)}</code></p>
        <p>Things to check:</p>
        <ul>
          <li>Is the Mac mini at home online and the dashboard daemon running?</li>
          <li>If you're using Tailscale, is it connected on this machine? (Or is the public Funnel URL enabled?)</li>
          <li>Override the upstream by setting <code>REMOTE_DATA_URL</code> in <code>.env</code>.</li>
        </ul>
        <div class="meta">Trade Odds thin-client · proxy mode · listening on :${PORT}</div>
      </body></html>
    `);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[trade-odds] ready — open http://localhost:${PORT}`);
});
