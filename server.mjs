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
//                     proxies everything to it. If none respond, the cache is
//                     served (see below).
//   PORT              (default 7071) — local port to listen on.
//   CACHE_DIR         (default ~/.trade-odds-cache) — where to persist snapshots.
//   CACHE_DISABLE     set to '1' to skip disk caching entirely.
//
// SNAPSHOT MIRRORING (Phase 1)
//   Every successful proxy response is mirrored to disk. When the upstream is
//   unreachable, the client serves the cached version + injects a "STALE: last
//   fresh N min ago" banner into the HTML. Means the dashboard stays usable
//   even when the Mac mini is rebooting, the Cloudflare tunnel is rotating,
//   or your laptop is on an island with no connectivity.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

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

// ─────────────────────────────────────────────────────────────
// STANDALONE MODE
// If STANDALONE=1 (or --standalone arg), don't proxy to a remote upstream.
// Instead run the canonical dashboard (source/dashboard.mjs) IN-PROCESS so
// this machine serves the dashboard from its own memory/*.json files
// produced by source/runScanners.mjs. Make sure to start run-scanners.bat
// (or .sh) in another window so the data actually refreshes.
// ─────────────────────────────────────────────────────────────
const STANDALONE = process.env.STANDALONE === '1' || process.argv.includes('--standalone');
if (STANDALONE) {
  console.log('[trade-odds] STANDALONE mode — running canonical dashboard locally');
  console.log('[trade-odds] make sure run-scanners.bat (or .sh) is running too,');
  console.log('[trade-odds] otherwise memory/ stays empty and tiles will be sparse.');
  // dashboard.mjs auto-loads .env, starts its own HTTP server on PORT,
  // reads memory/*.json relative to its own __dirname. Just import + done.
  await import('./source/dashboard.mjs');
  // dashboard.mjs holds the event loop alive via its server.listen() call
} else {

// IMPORTANT: the Cloudflare URL below is EPHEMERAL — it changes when the
// home-side cloudflared daemon restarts (e.g. Mac mini reboot). The repo
// is auto-updated whenever it changes; pull latest if the client says
// "upstream offline" and you suspect a stale URL.
const DEFAULT_REMOTES = [
  'https://shelf-generally-bowl-workplace.trycloudflare.com',     // Cloudflare Tunnel (current ephemeral URL)
  'https://davids-mac-mini.tailfd4a41.ts.net:8443',               // Tailscale Funnel (fallback, if Funnel enabled)
  'http://davids-mac-mini:7071',                                  // Tailscale tailnet (direct, only when on Tailscale)
];
const REMOTES = (process.env.REMOTE_DATA_URL || DEFAULT_REMOTES.join(','))
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const PORT = parseInt(process.env.PORT || '7071', 10);

// ---------- snapshot cache ----------
const CACHE_DISABLE = process.env.CACHE_DISABLE === '1';
const CACHE_DIR = process.env.CACHE_DIR || join(homedir(), '.trade-odds-cache');
if (!CACHE_DISABLE) {
  try { if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true }); }
  catch (e) { console.error('[trade-odds] cache dir create failed:', e.message); }
}
function cacheKey(urlPath) {
  // Hash the URL path so paths like /api/scan/PANW are filesystem-safe.
  // Keep a short prefix so we can eyeball what's what when inspecting the dir.
  const h = createHash('sha1').update(urlPath).digest('hex').slice(0, 12);
  const prefix = urlPath.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
  return prefix + '_' + h;
}
function cachePathFor(urlPath, ext = 'bin') {
  return join(CACHE_DIR, cacheKey(urlPath) + '.' + ext);
}
function writeCache(urlPath, buf, contentType) {
  if (CACHE_DISABLE) return;
  try {
    const ext = contentType?.includes('json') ? 'json'
              : contentType?.includes('html') ? 'html'
              : contentType?.includes('png') ? 'png'
              : 'bin';
    const path = cachePathFor(urlPath, ext);
    writeFileSync(path, buf);
    // Sidecar with content-type so we can replay it correctly on cache hit
    writeFileSync(path + '.meta', JSON.stringify({ contentType, savedAt: Date.now() }));
  } catch (e) { /* cache write is best-effort */ }
}
function readCache(urlPath) {
  if (CACHE_DISABLE) return null;
  const exts = ['json', 'html', 'png', 'bin'];
  for (const ext of exts) {
    const path = cachePathFor(urlPath, ext);
    if (!existsSync(path)) continue;
    try {
      const buf = readFileSync(path);
      const metaPath = path + '.meta';
      const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : { contentType: 'application/octet-stream', savedAt: statSync(path).mtimeMs };
      return { buf, contentType: meta.contentType, savedAt: meta.savedAt, ageMs: Date.now() - meta.savedAt };
    } catch { /* try next ext */ }
  }
  return null;
}
function injectStaleBanner(html, ageMs) {
  // Floating banner in top-right so it's hard to miss but doesn't break layout
  const min = Math.round(ageMs / 60000);
  const ageStr = min < 1 ? 'just now' : min < 60 ? min + 'm ago' : Math.round(min / 60) + 'h ago';
  const banner = '<div id="trade-odds-stale-banner" style="position:fixed;top:8px;right:8px;z-index:9999;background:rgba(248,81,73,.95);color:#fff;padding:8px 14px;border-radius:6px;font:600 12px/1.3 -apple-system,Segoe UI,system-ui;box-shadow:0 4px 16px rgba(0,0,0,.4)">⚠ Mac mini unreachable — showing snapshot from ' + ageStr + '</div>';
  if (html.includes('</body>')) return html.replace('</body>', banner + '</body>');
  return html + banner;
}

let activeRemote = null;
let lastProbe = 0;
async function pickRemote() {
  if (activeRemote && Date.now() - lastProbe < 60_000) return activeRemote;
  for (const url of REMOTES) {
    try {
      const r = await fetch(url + '/api/state', { signal: AbortSignal.timeout(4_000), method: 'HEAD' });
      if (r.status < 500) {
        if (activeRemote !== url) console.log('[trade-odds] upstream → ' + url);
        activeRemote = url; lastProbe = Date.now();
        return url;
      }
    } catch { /* try next */ }
  }
  return null;
}

console.log('[trade-odds] upstream candidates (in order):');
for (const u of REMOTES) console.log('  - ' + u);
console.log('[trade-odds] cache dir: ' + (CACHE_DISABLE ? 'disabled' : CACHE_DIR));
console.log('[trade-odds] listening on: http://localhost:' + PORT);

// ---------- proxy server ----------
async function serveFromCache(req, res, reason) {
  const cached = readCache(req.url);
  if (!cached) {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(offlinePage(reason + '. No cached snapshot for this URL either.'));
    return;
  }
  let body = cached.buf;
  let ct = cached.contentType || 'application/octet-stream';
  // If it's the HTML dashboard, inject a stale banner so the user sees the warning
  if (ct.includes('html')) {
    body = Buffer.from(injectStaleBanner(body.toString('utf8'), cached.ageMs), 'utf8');
  }
  res.writeHead(200, {
    'Content-Type': ct,
    'Cache-Control': 'no-store',
    'X-Trade-Odds-Cache': 'stale; age=' + Math.round(cached.ageMs / 1000) + 's',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const remote = await pickRemote();
  if (!remote) return serveFromCache(req, res, 'No upstream reachable (tried: ' + REMOTES.join(', ') + ')');

  const target = remote + req.url;
  try {
    const r = await fetch(target, {
      method: req.method,
      headers: {
        'User-Agent': 'trade-odds-client/1.0',
        ...(req.headers.accept ? { Accept: req.headers.accept } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });

    const ct = r.headers.get('content-type') || 'text/plain';
    // Collect the body so we can both write the response AND mirror to cache.
    const chunks = [];
    if (r.body) {
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    }
    const full = Buffer.concat(chunks.map(c => Buffer.from(c)));

    // Only cache successful responses
    if (r.status >= 200 && r.status < 300 && full.length > 0) {
      writeCache(req.url, full, ct);
    }

    res.writeHead(r.status, {
      'Content-Type': ct,
      'Cache-Control': 'no-cache, no-store',
      'X-Trade-Odds-Cache': 'live',
    });
    res.end(full);
  } catch (e) {
    // Live request failed — try the cache
    activeRemote = null;
    return serveFromCache(req, res, 'Upstream ' + remote + ' failed: ' + String(e.message || e));
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
    '</ul><p>No usable snapshot cached either. Open the dashboard at least once while online so the cache populates, then this fallback will work.</p>' +
    '<div class="meta">Trade Odds thin-client · proxy mode · listening on :' + PORT + '</div></body></html>';
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('[trade-odds] ready — open http://localhost:' + PORT);
});

} // end !STANDALONE
