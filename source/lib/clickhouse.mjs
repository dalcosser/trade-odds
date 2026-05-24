/**
 * clickhouse.mjs — ClickHouse Cloud HTTP client for market data warehouse.
 *
 * Single data boundary: all ClickHouse access goes through this module.
 * Tables: daily_ohlcv (14M rows, 19K tickers), minute_ohlcv (2B rows).
 *
 * Usage:
 *   import { chQuery, getDailyBars, getLatestDaily,
 *            getMultiTickerLatest, getMinuteBars } from './lib/clickhouse.mjs';
 *
 *   const rows = await chQuery('SELECT count() FROM daily_ohlcv');
 *   const bars = await getDailyBars('AAPL', 120);
 *   const latest = await getLatestDaily('SPY');
 *   const batch = await getMultiTickerLatest(['AAPL','MSFT','NVDA']);
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Load env ────────────────────────────────────────────────
try {
  const envFile = readFileSync(resolve(__dir, '..', '..', '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch {}

const CH_HOST = process.env.CLICKHOUSE_HOST;
const CH_PORT = process.env.CLICKHOUSE_PORT || '8443';
const CH_USER = process.env.CLICKHOUSE_USER || 'default';
const CH_PASS = process.env.CLICKHOUSE_PASSWORD || '';

if (!CH_HOST) {
  console.error('[clickhouse] CLICKHOUSE_HOST not set in .env');
  process.exit(1);
}

const CH_URL = `https://${CH_HOST}:${CH_PORT}`;
const AUTH = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASS}`).toString('base64');

// ── Core query function ─────────────────────────────────────
/**
 * Execute a ClickHouse SQL query via HTTP interface.
 * Returns parsed JSON rows or null on error.
 */
export async function chQuery(sql, { timeout = 30_000 } = {}) {
  try {
    const body = `${sql.trim()} FORMAT JSONEachRow`;
    const res = await fetch(CH_URL, {
      method: 'POST',
      headers: {
        'Authorization': AUTH,
        'Content-Type': 'text/plain',
      },
      body,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error(`[clickhouse] HTTP ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    const text = await res.text();
    if (!text.trim()) return [];
    return text.trim().split('\n').map(line => JSON.parse(line));
  } catch (e) {
    console.error(`[clickhouse] query error: ${e.message}`);
    return null;
  }
}

// ── Convenience functions ───────────────────────────────────

/**
 * Fetch daily OHLCV + all enrichments for a single ticker.
 * Returns rows sorted by timestamp ascending.
 */
export async function getDailyBars(ticker, days = 120) {
  return chQuery(`
    SELECT *
    FROM daily_ohlcv
    WHERE Ticker = '${esc(ticker)}'
    ORDER BY Timestamp DESC
    LIMIT ${days}
  `) .then(rows => rows ? rows.reverse() : null);
}

/**
 * Fetch the most recent daily bar for a ticker (all columns).
 */
export async function getLatestDaily(ticker) {
  const rows = await chQuery(`
    SELECT *
    FROM daily_ohlcv
    WHERE Ticker = '${esc(ticker)}'
    ORDER BY Timestamp DESC
    LIMIT 1
  `);
  return rows?.[0] ?? null;
}

/**
 * Fetch the latest daily bar for multiple tickers in one query.
 * Returns Map<ticker, row>.
 */
export async function getMultiTickerLatest(tickers) {
  if (!tickers?.length) return new Map();
  const tickerList = tickers.map(t => `'${esc(t)}'`).join(',');
  const rows = await chQuery(`
    SELECT *
    FROM daily_ohlcv
    WHERE (Ticker, Timestamp) IN (
      SELECT Ticker, max(Timestamp)
      FROM daily_ohlcv
      WHERE Ticker IN (${tickerList})
      GROUP BY Ticker
    )
    ORDER BY Ticker
  `, { timeout: 60_000 });
  if (!rows) return new Map();
  return new Map(rows.map(r => [r.Ticker, r]));
}

/**
 * Fetch minute-level bars for a ticker on a specific date.
 * Returns rows sorted by timestamp ascending.
 */
export async function getMinuteBars(ticker, date) {
  return chQuery(`
    SELECT *
    FROM minute_ohlcv
    WHERE Ticker = '${esc(ticker)}'
      AND toDate(Timestamp) = '${esc(date)}'
    ORDER BY Timestamp ASC
  `, { timeout: 60_000 });
}

/**
 * Run a raw backtest query — used by screener stats and econ backtester.
 * Caller provides full SQL; this just handles execution + error wrapping.
 */
export async function runBacktest(sql) {
  return chQuery(sql, { timeout: 120_000 });
}

/**
 * Get the most recent date available in daily_ohlcv.
 */
export async function getLatestDate() {
  const rows = await chQuery(`SELECT max(Timestamp) as latest FROM daily_ohlcv`);
  return rows?.[0]?.latest ?? null;
}

// ── Helpers ─────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/'/g, "\\'");
}
