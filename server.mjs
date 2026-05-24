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
//   REMOTE_DATA_URL   one URL, or a comma-separated fallback chain. The client
//                     picks the first one that responds 200 on /api/state and
//                     proxies everything to it. If none respond, the user sees
//                     a clear offline page.
//                     Default chain (in order):
//                       1. Cloudflare Tunnel — works on any machine, anywhere
//                       2. Tailscale Funnel  — fallback if Cloudflare drops
//                       3. Tailscale tailnet — direct, only when on Tailscale
//   PORT              (default 7071) — local port to listen on.

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

const DEFAULT_REMOTES = [
  'https://blink-reg-basketball-dodge.trycloudflare.com',         // Cloudflare Tunnel (works anywhere, no Tailscale)
  'https://davids-mac-mini.tailfd4a41.ts.net:8443',               // Tailscale Funnel (if Funnel enabled)
  'http://davids-mac-mini:7071',                                  // Tailscale tailnet (only when on Tailscale)
];
const REMOTES = (process.env.REMOTE_DATA_URL || DEFAULT_REMOTES.join(','))
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const PORT = parseInt(process.env.PORT || '7071', 10);

let activeRemote = null;
let lastProbe = 0;
async function pickRemote() {
  // Re-probe every 60s, or whenever the active one fails
  if (activeRemote && Date.now() - lastProbe < 60_000) return activeRemote;
  for (const url of REMOTES) {
    try {
      const r = await fetch(url + '/api/state', { signal: AbortSignal.timeout(4_000), method: 'HEAD' });
      // HEAD might 405; treat any non-5xx as alive
      if (r.status < 500) {
        if (activeRemote !== url) console.log(`[trade-odds] upstream → ${url}`);
        activeRemote = url; lastProbe = Date.now();
        return url;
      }
    } catch { /* try next */ }
  }
  return null;
}

console.log(`[trade-odds] upstream candidates (in order):`);
for (const u of REMOTES) console.log(`  - ${u}`);
console.log(`[trade-odds] listening on: http://localhost:${PORT}`);

// ---------- proxy server ----------
const server = createServer(async (req, res) => {
  const remote = await pickRemote();
  if (!remote) {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(offlinePage('No upstream reachable. Tried: ' + REMOTES.join(', ')));
    return;
  }
  const target = remote + req.url;
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
    // Mark active remote as bad so next request re-probes
    activeRemote = null;
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(offlinePage('Upstream ' + remote + ' failed: ' + String(e.message || e)));
  }
});

function offlinePage(detail) {
  return '<!doctype html><html><head><title>Trade Odds — Offline</title>' +
    '<style>body{font:14px/1.5 -apple-system,Segoe UI,system-ui;background:#0a0c10;color:#e6edf3;margin:0;padding:60px 40px;max-width:680px}' +
    'h1{font-size:22px;color:#f85149;margin:0 0 14px}code{background:#1a212c;padding:2px 8px;border-radius:4px;color:#7ee787;font-size:12px}' +
    '.meta{color:#7a8693;font-size:12px;margin-top:24px;padding-top:14px;border-top:1px solid #232b36}' +
    'li{margin:4px 0}</style></head><body>' +
    '<h1>Can\'t reach the data server</h1><p>' + detail + '</p>' +
    '<p>Tried upstream candidates in order:</p><ul>' +
    REMOTES.map(u => '<li><code>' + u + '</code></li>').join('') +
    '</ul><p>Override with <code>REMOTE_DATA_URL=https://...</code> in <code>.env</code> (comma-separated chain supported).</p>' +
    '<div class="meta">Trade Odds thin-client · proxy mode · listening on :' + PORT + '</div></body></html>';
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('[trade-odds] ready — open http://localhost:' + PORT);
});
