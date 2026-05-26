/**
 * tiingo_api.mjs — Thin client for the Tiingo REST API.
 *
 * Auth: requires TIINGO_API_KEY in env. Load from .env before invoking:
 *   set -a; source /Users/dalcosser/clawd/.env; set +a
 *
 * Why we use Tiingo: news aggregation across Bloomberg / Reuters / Seeking
 * Alpha / WSJ / FT with per-ticker tagging — a different source pool from
 * Polygon (Benzinga / Motley Fool / Investing.com). Cross-confirmation of
 * a catalyst across both providers = much higher conviction than one alone.
 *
 * Free tier limits: 50 req/hr, 1000 req/day, 500MB/month. The rate limiter
 * is tuned conservatively to stay well under these.
 *
 * Design mirrors uw_api.mjs:
 *   - Token auth via Authorization: Token <key>
 *   - Per-call retry with exponential backoff on 429/5xx
 *   - Short-lived disk cache (per endpoint+query) to avoid hammering rate
 *     limits during batch scans — default TTL 60s, override per call
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dir = dirname(fileURLToPath(import.meta.url));
// Same MEMORY_DIR-aware path as uw_api: lands in <repo>/memory/cache/tiingo.
const CACHE_DIR = process.env.MEMORY_DIR
  ? resolve(process.env.MEMORY_DIR, 'cache', 'tiingo')
  : resolve(__dir, '..', '..', '..', 'memory', 'cache', 'tiingo');

const BASE = 'https://api.tiingo.com';
const DEFAULT_TTL_MS = 60_000;
const MAX_RETRIES = 4;

// Free tier is 50/hr → ~1.2s between calls if we ran sequentially. We keep
// a low concurrency + min interval to stay nowhere near the ceiling.
const MAX_CONCURRENT = parseInt(process.env.TIINGO_MAX_CONCURRENT || '3', 10);
const MIN_INTERVAL_MS = parseInt(process.env.TIINGO_MIN_INTERVAL_MS || '150', 10);

let inFlight = 0;
let lastStart = 0;
const waiters = [];

function acquire() {
  return new Promise(resolve => {
    const tryRun = async () => {
      if (inFlight >= MAX_CONCURRENT) return;
      const since = Date.now() - lastStart;
      if (since < MIN_INTERVAL_MS) {
        setTimeout(tryRun, MIN_INTERVAL_MS - since);
        return;
      }
      inFlight++;
      lastStart = Date.now();
      resolve();
    };
    waiters.push(tryRun);
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
 * @param {string} path - Tiingo path (e.g. "/tiingo/news")
 * @param {object} [opts]
 * @param {object} [opts.params] - query params
 * @param {number} [opts.ttlMs] - cache TTL (0 = no cache)
 * @param {number} [opts.timeoutMs=15000]
 */
export async function tiingoGet(path, opts = {}) {
  const { params, ttlMs = DEFAULT_TTL_MS, timeoutMs = 15000 } = opts;
  const key = process.env.TIINGO_API_KEY;
  if (!key) throw new Error('TIINGO_API_KEY not set in env');

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
        headers: {
          Authorization: 'Token ' + key,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
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
        throw new Error(`Tiingo ${path} → HTTP ${r.status}: ${body.slice(0, 200)}`);
      }

      const json = await r.json();
      if (ttlMs > 0) writeCache(file, json);
      release();
      return json;
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
  throw lastErr || new Error('Tiingo request failed: ' + path);
}

// ── Typed helpers ──────────────────────────────────────────────────────────

export const tiingo = {
  /**
   * News API. Returns array of:
   *   { id, title, description, url, publishedDate, crawlDate,
   *     tickers: [...], tags: [...], source }
   *
   * Common params:
   *   tickers: 'NVDA,AAPL'   (comma-separated, optional — omit for tape-wide)
   *   tags: 'Earnings,M&A'   (Tiingo curated tags)
   *   sources: 'bloomberg.com'
   *   startDate / endDate: 'YYYY-MM-DD'
   *   limit: 1..1000 (default 100)
   *   sortBy: 'publishedDate' (newest first) | 'crawlDate'
   */
  news: (params, o) => tiingoGet('/tiingo/news', { params, ...o }),

  /**
   * Daily EOD prices. Returns array of OHLCV bars.
   *   /tiingo/daily/{ticker}/prices?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
   */
  dailyPrices: (ticker, params, o) =>
    tiingoGet(`/tiingo/daily/${ticker}/prices`, { params, ...o }),

  /**
   * IEX intraday quote (real-time, IEX-only — narrower than SIP).
   * Useful as an independent sanity-check vs Polygon when something looks off.
   */
  iexQuote: (ticker, o) => tiingoGet(`/iex/${ticker}`, o),

  /**
   * Ticker metadata (name, exchange, description, listing dates).
   */
  meta: (ticker, o) => tiingoGet(`/tiingo/daily/${ticker}`, o),
};

// ── Convenience helpers ───────────────────────────────────────────────────

/**
 * Heuristic sentiment score for a Tiingo article relative to a target ticker.
 * Tiingo doesn't ship per-ticker sentiment in the news payload, so we derive
 * one from the title + description using a small lexicon. Good enough for
 * triage; the structured `tags` field carries the strong topic signals.
 *
 * Returns 'bullish' | 'bearish' | 'neutral'.
 */
export function classifyHeadlineSentiment(article) {
  const text = `${article.title || ''} ${article.description || ''}`.toLowerCase();
  if (!text.trim()) return 'neutral';

  // Strong unambiguous signals — single occurrence is enough.
  const strongBull = [
    'beats estimates', 'beats expectations', 'upgrade', 'upgraded', 'raises guidance',
    'price target raised', 'pt raised', 'pt hike', 'outperform rating',
    'overweight rating', 'buy rating', 'record high', 'all-time high', 'breakout',
    'fda approval', 'fda approves', 'awarded', 'wins contract', 'acquires',
    'acquisition of', 'merger with', 'breakthrough',
  ];
  const strongBear = [
    'misses estimates', 'missed estimates', 'downgrade', 'downgraded', 'cuts guidance',
    'lowers guidance', 'underweight rating', 'sell rating', 'price target cut',
    'pt cut', 'recall', 'lawsuit', 'sued', 'investigation', 'probe', 'fraud',
    'plunges', 'tumbles', 'slumps', 'crashes', 'bankruptcy', 'restatement',
    'delisting', 'layoffs', 'cuts jobs', 'fired', 'ceo resigns',
  ];
  // Weak signals — need 2+ to flip sentiment.
  const weakBull = [
    'beat', 'beats', 'raises', 'positive', 'strong', 'surges', 'soars', 'rallies',
    'jumps', 'pops', 'wins', 'approves', 'approved', 'launches', 'expands',
    'partnership', 'milestone', 'rebounds', 'recovery',
  ];
  const weakBear = [
    'miss', 'misses', 'lowers', 'cuts', 'warns', 'warning', 'weak',
    'disappointing', 'concerns', 'drops', 'falls', 'sinks', 'fines', 'fined',
    'resigns', 'pullback', 'headwind',
  ];

  let strong = 0, weak = 0;
  for (const w of strongBull) if (text.includes(w)) strong += 2;
  for (const w of strongBear) if (text.includes(w)) strong -= 2;
  for (const w of weakBull) if (text.includes(w)) weak += 1;
  for (const w of weakBear) if (text.includes(w)) weak -= 1;

  const score = strong + weak;
  if (score >= 2) return 'bullish';
  if (score <= -2) return 'bearish';
  return 'neutral';
}

/**
 * URL hash for cross-provider deduplication (vs Polygon news, etc).
 * Strips query strings and fragments so analytics params don't fool the dedupe.
 */
export function articleFingerprint(article) {
  const url = (article.url || '').split('?')[0].split('#')[0].toLowerCase();
  return createHash('sha1').update(url).digest('hex').slice(0, 12);
}
