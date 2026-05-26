/**
 * uw_api.mjs — Thin client for the Unusual Whales REST API.
 *
 * Auth: requires UW_API_KEY in env. Load from .env before invoking:
 *   set -a; source /Users/dalcosser/clawd/.env; set +a
 *
 * Design:
 *   - Bearer-token auth, JSON-only
 *   - Per-call retry with exponential backoff on 429/5xx
 *   - Short-lived disk cache (per endpoint+query) to avoid hammering rate limits
 *     during batch scans — default TTL 60s, override per call
 *   - Endpoints returning {data: [...]} are unwrapped to the array; endpoints
 *     returning a raw array pass through unchanged
 *
 * Non-goals:
 *   - No websocket / streaming (polling is fine for our use cases)
 *   - No automatic pagination (endpoints we use are single-response)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dir = dirname(fileURLToPath(import.meta.url));
// Path layout in trade-odds: <repo>/source/scanners/lib/uw_api.mjs
// Cache lives at <repo>/memory/cache/uw — honor MEMORY_DIR env var when set
// by runScanners.mjs; otherwise compute three levels up.
const CACHE_DIR = process.env.MEMORY_DIR
  ? resolve(process.env.MEMORY_DIR, 'cache', 'uw')
  : resolve(__dir, '..', '..', '..', 'memory', 'cache', 'uw');

const BASE = 'https://api.unusualwhales.com';
const DEFAULT_TTL_MS = 60_000;
// MAX_RETRIES = 4 means up to 5 total attempts. Under sustained 429s this can
// burn 45+ seconds per call (1.5+3+6+12+24s backoff chain). Scripts that need
// fail-fast behavior (dashboard scans, on-demand reads) can set UW_FAST_FAIL=1
// to drop to a single attempt; everything else keeps the full retry budget.
const MAX_RETRIES = process.env.UW_FAST_FAIL === '1' ? 0 : 4;

// In-process rate limiter. UW hasn't published exact limits for this tier, but
// empirically 5 concurrent + ~80ms min spacing stays under the 429 threshold.
const MAX_CONCURRENT = parseInt(process.env.UW_MAX_CONCURRENT || '5', 10);
const MIN_INTERVAL_MS = parseInt(process.env.UW_MIN_INTERVAL_MS || '80', 10);

let inFlight = 0;
let lastStart = 0;
const waiters = [];

function acquire() {
  // FIX 2026-05-22: previously this pushed `tryRun` into `waiters` BEFORE invoking
  // it. When a slot was available, tryRun resolved immediately but stayed queued.
  // On the next release(), waiters.shift() popped that already-resolved tryRun
  // and re-ran it, which incremented inFlight a second time without satisfying
  // any pending acquire. Over a 429-retry loop (5 attempts × leak-1-per-iter),
  // inFlight monotonically climbed to MAX_CONCURRENT and every future acquire()
  // hung forever — silently, because all the in-flight Promises had nothing
  // pending in the event loop, so Node exited cleanly with code 0.
  //
  // Symptom this hid: `confluence.mjs TICKER --json` ran ~15s then exited 0
  // with zero stdout, after the first UW call burned through retries on a 429.
  return new Promise(resolve => {
    const tryRun = () => {
      if (inFlight >= MAX_CONCURRENT) {
        // Can't acquire now — queue for the next release() to retry.
        waiters.push(tryRun);
        return;
      }
      const since = Date.now() - lastStart;
      if (since < MIN_INTERVAL_MS) {
        setTimeout(tryRun, MIN_INTERVAL_MS - since);
        return;
      }
      inFlight++;
      lastStart = Date.now();
      resolve();
    };
    tryRun();
  });
}

function release() {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();
}

function hashKey(path, params) {
  const h = createHash('sha1');
  h.update(path);
  h.update(JSON.stringify(params || {}));
  return h.digest('hex').slice(0, 16);
}

function cachePath(path, params) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  return resolve(CACHE_DIR, hashKey(path, params) + '.json');
}

function readCache(file, ttlMs) {
  try {
    const st = statSync(file);
    if (Date.now() - st.mtimeMs < ttlMs) {
      return JSON.parse(readFileSync(file, 'utf-8'));
    }
  } catch { /* no cache */ }
  return null;
}

function writeCache(file, data) {
  try { writeFileSync(file, JSON.stringify(data)); } catch { /* non-fatal */ }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildUrl(path, params) {
  const url = new URL(BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Core fetch with retry + cache.
 * @param {string} path - UW path (e.g. "/api/stock/NVDA/greek-exposure/strike")
 * @param {object} [opts]
 * @param {object} [opts.params] - query params
 * @param {number} [opts.ttlMs] - cache TTL (0 = no cache)
 * @param {boolean} [opts.unwrap=true] - unwrap {data: ...} to inner value
 * @param {number} [opts.timeoutMs=15000]
 */
export async function uwGet(path, opts = {}) {
  const { params, ttlMs = DEFAULT_TTL_MS, unwrap = true, timeoutMs = 15000 } = opts;
  const key = process.env.UW_API_KEY;
  if (!key) throw new Error('UW_API_KEY not set in env');

  const file = cachePath(path, params);
  if (ttlMs > 0) {
    const cached = readCache(file, ttlMs);
    if (cached !== null) return cached;
  }

  const url = buildUrl(path, params);
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await acquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
        // Honor Retry-After if the server sent one, else exponential backoff
        // with a long floor — UW 429s are sticky when you breach the window.
        const retryAfter = parseFloat(r.headers.get('retry-after') || '');
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(30_000, 1500 * 2 ** attempt);
        lastErr = new Error(`HTTP ${r.status} on ${path}`);
        release();
        await sleep(backoff);
        continue;
      }
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        release();
        throw new Error(`UW ${path} → HTTP ${r.status}: ${body.slice(0, 200)}`);
      }

      const json = await r.json();
      const out = unwrap && json && typeof json === 'object' && 'data' in json ? json.data : json;
      if (ttlMs > 0) writeCache(file, out);
      release();
      return out;
    } catch (e) {
      clearTimeout(timer);
      release();
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await sleep(Math.min(30_000, 1500 * 2 ** attempt));
        continue;
      }
    }
  }
  throw lastErr || new Error('UW request failed: ' + path);
}

// ── Typed helpers ──────────────────────────────────────────────────────────

export const uw = {
  // Ticker fundamentals
  info:             (t, o) => uwGet(`/api/stock/${t}/info`, o),

  // Greek exposure (dealer positioning)
  gex:              (t, o) => uwGet(`/api/stock/${t}/greek-exposure`, o),
  gexByStrike:      (t, o) => uwGet(`/api/stock/${t}/greek-exposure/strike`, o),
  gexByExpiry:      (t, o) => uwGet(`/api/stock/${t}/greek-exposure/expiry`, o),
  spotExposures:    (t, o) => uwGet(`/api/stock/${t}/spot-exposures`, o),
  spotExposuresByStrike: (t, o) => uwGet(`/api/stock/${t}/spot-exposures/strike`, o),

  // Max pain / levels
  maxPain:          (t, o) => uwGet(`/api/stock/${t}/max-pain`, o),

  // Flow
  flowAlertsTicker: (t, o) => uwGet(`/api/stock/${t}/flow-alerts`, o),
  flowAlertsAll:    (o)    => uwGet(`/api/option-trades/flow-alerts`, o),
  flowPerStrike:    (t, o) => uwGet(`/api/stock/${t}/flow-per-strike`, { unwrap: false, ...o }),
  netPremTicks:     (t, o) => uwGet(`/api/stock/${t}/net-prem-ticks`, o),
  optionsVolume:    (t, o) => uwGet(`/api/stock/${t}/options-volume`, o),
  oiChange:         (t, o) => uwGet(`/api/stock/${t}/oi-change`, o),
  nope:             (t, o) => uwGet(`/api/stock/${t}/nope`, o),

  // Dark pool (institutional)
  darkpool:         (t, o) => uwGet(`/api/darkpool/${t}`, o),
  darkpoolRecent:   (o)    => uwGet(`/api/darkpool/recent`, o),

  // Volatility
  realizedVol:      (t, o) => uwGet(`/api/stock/${t}/volatility/realized`, o),
  termStructure:    (t, o) => uwGet(`/api/stock/${t}/volatility/term-structure`, o),

  // Price
  ohlc:             (t, tf = '1d', o) => uwGet(`/api/stock/${t}/ohlc/${tf}`, o),

  // Market-wide
  marketTide:       (o)    => uwGet(`/api/market/market-tide`, o),
  sectorEtfs:       (o)    => uwGet(`/api/market/sector-etfs`, o),
  econCalendar:     (o)    => uwGet(`/api/market/economic-calendar`, o),
  fdaCalendar:      (o)    => uwGet(`/api/market/fda-calendar`, o),

  // News + catalysts
  newsHeadlines:    (o)    => uwGet(`/api/news/headlines`, o),
  earningsAfterhours: (o)  => uwGet(`/api/earnings/afterhours`, o),
  tickerEarnings:   (t, o) => uwGet(`/api/stock/${t}/earnings`, o),

  // Government / insider
  insiderTrades:    (o)    => uwGet(`/api/insider/transactions`, o),
  congressTrades:   (o)    => uwGet(`/api/congress/recent-trades`, o),

  // Seasonality (19 years of history, UW-sourced)
  seasonalityMarket: (o)        => uwGet(`/api/seasonality/market`, o),
  seasonalityMonthly: (t, o)    => uwGet(`/api/seasonality/${t}/monthly`, o),
  seasonalityYearMonth: (t, o)  => uwGet(`/api/seasonality/${t}/year-month`, o),
  seasonalityPerformers: (month, o) => uwGet(`/api/seasonality/${month}/performers`, o),

  // Prediction markets (Polymarket-sourced)
  predictionsUnusual:    (o) => uwGet(`/api/predictions/unusual`, { unwrap: false, ...o }),
  predictionsSmartMoney: (o) => uwGet(`/api/predictions/smart-money`, { unwrap: false, ...o }),
  predictionsWhales:     (o) => uwGet(`/api/predictions/whales`, { unwrap: false, ...o }),
  predictionsInsiders:   (o) => uwGet(`/api/predictions/insiders`, { unwrap: false, ...o }),
  predictionMarket:      (id, o) => uwGet(`/api/predictions/market/${id}`, o),
  predictionMarketLiquidity: (id, o) => uwGet(`/api/predictions/market/${id}/liquidity`, o),
  predictionMarketPositions: (id, o) => uwGet(`/api/predictions/market/${id}/positions`, o),
};

// ── Convenience: parsers for typed strings UW returns ─────────────────────

export function num(s) {
  if (s === null || s === undefined) return NaN;
  const n = typeof s === 'number' ? s : parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

export function sumField(rows, field) {
  let s = 0;
  for (const r of rows || []) s += num(r[field]) || 0;
  return s;
}
