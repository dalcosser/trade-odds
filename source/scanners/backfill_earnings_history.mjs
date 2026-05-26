#!/usr/bin/env node
/**
 * backfill_earnings_history.mjs — Pull full per-ticker earnings history from UW
 * and persist into memory/uw_earnings_history.json so the Trade Odds tab's
 * Earnings Proximity / Earnings Performance conditions have real data.
 *
 * Universe = watchlist + Mag7 + S&P 500 + NDX. ~565 tickers. Rate-limited
 * via lib/uw_api.mjs (5 concurrent, ~80ms spacing). Expect ~10-15 min on
 * first run, much faster on re-runs (response cache is 24h-warm).
 *
 * Usage:  node scripts/backfill_earnings_history.mjs [--universe spx|wl|mag7|all]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uw } from './lib/uw_api.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');
const MEMORY = join(ROOT, 'memory');
const OUT = join(MEMORY, 'uw_earnings_history.json');

function readJSON(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function extract(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.tickers)) return raw.tickers;
  if (Array.isArray(raw.watchlist)) return raw.watchlist;
  return Object.keys(raw).filter(k => /^[A-Z]{1,8}$/.test(k));
}

const wl  = extract(readJSON(join(ROOT, 'scripts', 'lib', 'watchlist.json')));
const spx = extract(readJSON(join(ROOT, 'scripts', 'lib', 'spx500.json')));
const ndx = extract(readJSON(join(ROOT, 'scripts', 'lib', 'ndx100.json')));
const mag7 = ['AAPL','MSFT','AMZN','GOOGL','META','NVDA','TSLA'];

const which = (process.argv.find(a => a.startsWith('--universe='))?.split('=')[1]) || 'all';
let universe;
if (which === 'wl') universe = wl;
else if (which === 'mag7') universe = mag7;
else if (which === 'spx') universe = spx;
else universe = [...new Set([...wl, ...mag7, ...spx, ...ndx, 'SPY','QQQ','IWM','DIA'])];
universe = [...new Set(universe)].filter(t => /^[A-Z.\-]{1,8}$/.test(t)).sort();

console.log(`[backfill] universe=${which} (${universe.length} tickers)`);

// Merge into existing file if present (keep what we already have)
const existing = readJSON(OUT) || { updatedAt: null, rows: {} };
let kept = 0, added = 0, failed = 0;

const t0 = Date.now();
let done = 0;
for (const ticker of universe) {
  done++;
  let earns;
  try {
    earns = await uw.tickerEarnings(ticker, { ttlMs: 24 * 3600 * 1000 });
  } catch (e) {
    failed++;
    if (failed <= 5) console.error(`  ${ticker}: ${e.message}`);
    continue;
  }
  if (!earns || !Array.isArray(earns)) continue;
  for (const e of earns) {
    const date = e.report_date || e.date;
    if (!date) continue;
    const key = `${ticker}|${date}|${e.report_time || e._ah_session || ''}`;
    if (existing.rows[key]) { kept++; continue; }
    existing.rows[key] = {
      ticker,
      date,
      session: e.report_time || e._ah_session || null,
      full_name: e.full_name || null,
      sector: e.sector || null,
      marketcap: e.marketcap != null ? Number(e.marketcap) : null,
      has_options: !!e.has_options,
      is_s_p_500: !!e.is_s_p_500,
      expected_move: e.expected_move != null ? Number(e.expected_move) : null,
      expected_move_perc: e.expected_move_perc != null ? Number(e.expected_move_perc) : null,
      street_mean_est: e.street_mean_est != null ? Number(e.street_mean_est) : null,
      actual_eps: e.actual_eps != null ? Number(e.actual_eps) : null,
      pre_earnings_close: e.pre_earnings_close != null ? Number(e.pre_earnings_close) : null,
      post_earnings_close: e.post_earnings_close != null ? Number(e.post_earnings_close) : null,
      reaction: e.reaction != null ? Number(e.reaction) : null,
      ending_fiscal_quarter: e.ending_fiscal_quarter || null,
      backfilledAt: new Date().toISOString(),
    };
    added++;
  }
  if (done % 25 === 0) {
    const pct = ((done / universe.length) * 100).toFixed(0);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`[backfill] ${done}/${universe.length} (${pct}%) · ${added} new · ${kept} existing · ${failed} failed · ${elapsed}s`);
  }
}

existing.updatedAt = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(existing, null, 2));
const total = Object.keys(existing.rows).length;
console.log(`[backfill] done in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${total} total events · ${added} added · ${failed} ticker fetches failed`);
console.log(`[backfill] wrote ${OUT}`);
