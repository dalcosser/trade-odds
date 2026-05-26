/**
 * loadUniverse.mjs
 *
 * Builds a complete trading universe from three sources:
 *   1. BETA universe   — David's curated list from BETA Universe2 xlsx (320 names)
 *   2. NDX 100         — Nasdaq-100 components
 *   3. SPX 500         — S&P 500 components
 *   4. Liquid screen   — Polygon grouped daily: US common stocks (CS type only),
 *                        prev close > $5, prev volume > 1M shares
 *
 * Leveraged ETFs, ETNs, and other non-equity instruments are excluded from the
 * dynamic screen via Polygon's reference type filter (type=CS only).
 * Curated lists (BETA/NDX/SPX) bypass this filter — they're pre-verified stocks.
 *
 * Results cached per trading day. Cache: scripts/.liquid_universe_cache.json
 *
 * Exports:
 *   LIQUID_UNIVERSE     — full merged universe (stocks only, ~1500-2000 names)
 *   WATCHLIST_UNIVERSE  — user's curated watchlist (watchlist.json)
 *   BETA_UNIVERSE       — BETA universe tickers only
 *   SECTOR_ETFS         — sector/thematic ETFs for the sector scan (always included)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH    = resolve(__dir, '..', '.liquid_universe_cache.json');
const CS_CACHE_PATH = resolve(__dir, '..', '.cs_tickers_cache.json');

// Load .env
try {
  const envFile = readFileSync(resolve(__dir, '..', '..', '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}

const API_KEY = process.env.MASSIVE_API_KEY;
const BASE = 'https://api.polygon.io';

// Sector / thematic ETFs — explicitly tracked, never filtered out
export const SECTOR_ETFS = [
  // Broad market
  'SPY','QQQ','IWM','DIA','MDY',
  // Tech & semis
  'SMH','SOXX','IGV','XLK','HACK','CIBR','AIQ','BOTZ',
  // Financials
  'XLF','KRE','KBE','IAI',
  // Energy
  'XLE','XOP','OIH',
  // Materials
  'XME','GDX','GDXJ','XLB',
  // Healthcare
  'XLV','XBI','IBB','ARKG',
  // Consumer
  'XLP','XLY','XRT','ITB',
  // Industrials
  'XLI','JETS','ITA',
  // Utilities
  'XLU',
  // Real estate
  'IYR','XLRE',
  // Communications
  'XLC',
  // Bonds / macro
  'TLT','HYG','LQD','GLD','SLV','USO','UNG',
  // International
  'EEM','EWZ','KWEB','FXI',
  // Volatility
  'VXX','UVXY',
];

// Basic junk exclusion (warrants, rights, units — contain special chars)
const JUNK_PATTERN = /[./+\-=]/;

// ── Load curated stock lists ──────────────────────────────────
const wlData   = JSON.parse(readFileSync(resolve(__dir, 'watchlist.json'), 'utf-8'));
const betaData = JSON.parse(readFileSync(resolve(__dir, 'beta_universe.json'), 'utf-8'));
const ndxData  = JSON.parse(readFileSync(resolve(__dir, 'ndx100.json'), 'utf-8'));
const spxData  = JSON.parse(readFileSync(resolve(__dir, 'spx500.json'), 'utf-8'));

export const WATCHLIST_UNIVERSE = [...new Set([
  ...(wlData.watchlist || []),
  ...(wlData.mag7 || []),
  ...(wlData.extras || []),
])];

export const BETA_UNIVERSE = betaData.tickers || [];

// Combined curated anchor — always included, all confirmed common stocks
const CURATED_STOCKS = [...new Set([
  ...BETA_UNIVERSE,
  ...(ndxData.tickers || []),
  ...(spxData.tickers || []),
  ...WATCHLIST_UNIVERSE,
])];

// ─────────────────────────────────────────────────────────────

function prevTradingDay() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = now.getDay();
  const hour = now.getHours();
  let offset = 1;
  if (day === 1 && hour < 7) offset = 3;
  else if (day === 0) offset = 2;
  else if (day === 6) offset = 1;
  const d = new Date(now);
  d.setDate(d.getDate() - offset);
  if (d.getDay() === 6) d.setDate(d.getDate() - 1);
  if (d.getDay() === 0) d.setDate(d.getDate() - 2);
  return d.toISOString().slice(0, 10);
}

async function fetchJSON(url) {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}apiKey=${API_KEY}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// Fetch all active US common stock tickers from Polygon reference API (paginated).
// Cached per trading day to avoid repeated calls.
async function fetchCSTickerSet(date) {
  if (existsSync(CS_CACHE_PATH)) {
    try {
      const cache = JSON.parse(readFileSync(CS_CACHE_PATH, 'utf-8'));
      if (cache.date === date) return new Set(cache.tickers);
    } catch {}
  }

  const csSet = new Set();
  let url = `${BASE}/v3/reference/tickers?type=CS&market=stocks&active=true&limit=1000`;
  let pages = 0;
  while (url && pages < 20) {
    const data = await fetchJSON(url);
    for (const r of (data.results || [])) {
      if (r.ticker) csSet.add(r.ticker);
    }
    // Follow pagination cursor
    url = data.next_url ? data.next_url.replace(/apiKey=[^&]+/, '') : null;
    pages++;
    if (url) await new Promise(r => setTimeout(r, 200));
  }

  try {
    writeFileSync(CS_CACHE_PATH, JSON.stringify({ date, tickers: [...csSet], count: csSet.size }, null, 2));
  } catch {}

  return csSet;
}

async function buildLiquidUniverse(minPrice = 5, minVolume = 1_000_000) {
  const date = prevTradingDay();

  // Check main cache
  if (existsSync(CACHE_PATH)) {
    try {
      const cache = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
      if (cache.date === date && cache.minPrice === minPrice && cache.minVolume === minVolume) {
        return cache.tickers;
      }
    } catch {}
  }

  if (!API_KEY) return CURATED_STOCKS;

  // Fetch CS ticker whitelist (common stocks only — no ETFs/ETNs/leveraged products)
  const csSet = await fetchCSTickerSet(date);

  // Fetch grouped daily for all US stocks
  const data = await fetchJSON(`${BASE}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true`);
  const results = data.results || [];

  const dynamicTickers = results
    .filter(r => {
      const t = r.T;
      if (!t) return false;
      if (JUNK_PATTERN.test(t)) return false;          // warrants, units, rights
      if (t.length > 5) return false;                  // 6+ char = usually ETN/structured product
      if (!csSet.has(t)) return false;                 // must be a common stock (CS type)
      if (r.c < minPrice) return false;                // price filter
      if ((r.v || 0) < minVolume) return false;        // volume filter
      if (r.c <= 0 || r.o <= 0) return false;
      return true;
    })
    .map(r => r.T);

  // Merge: dynamic CS stocks + curated stocks (BETA/NDX/SPX always in)
  // Sector ETFs are excluded from the stock scan universe intentionally
  const merged = [...new Set([...dynamicTickers, ...CURATED_STOCKS])].sort();

  try {
    writeFileSync(CACHE_PATH, JSON.stringify({ date, minPrice, minVolume, tickers: merged, count: merged.length }, null, 2));
  } catch {}

  return merged;
}

// Eagerly build on import
export const LIQUID_UNIVERSE = await buildLiquidUniverse();
