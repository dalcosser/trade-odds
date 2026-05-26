#!/usr/bin/env node
/**
 * setup_scanners.mjs — Book-rule setup detectors that feed the confluence
 * engine via the signal bus.
 *
 * Implements 5 specific setups from the trading book research:
 *   1. BB Squeeze (Bollinger)         — bandwidth at 126-day min = breakout imminent
 *   2. Holy Grail (Connors/Raschke)   — strong trend pullback to 21EMA
 *   3. ID/NR4 (Connors/Raschke)       — inside day + narrowest-4 range = vol explosion
 *   4. Turtle Soup (Connors/Raschke)  — false 20-day breakout reversal
 *   5. MACD Divergence (Encyclopedia) — best oscillator signal in the book
 *
 * Each scan fires per ticker, emits to the signal bus, and contributes to the
 * idea board's confluence score. Universe = watchlist + SPX/NDX (avg vol ≥ 1M).
 *
 * Usage:
 *   node setup_scanners.mjs --setup bb-squeeze            # single setup
 *   node setup_scanners.mjs --setup all                   # run all 5
 *   node setup_scanners.mjs --tickers NVDA,TSLA --setup all
 *   node setup_scanners.mjs --setup all --emit            # push to signal bus
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chQuery, getDailyBars } from './lib/clickhouse.mjs';
import { emitSignals } from './lib/signals.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const MEM = resolve(ROOT, 'memory');

const args = process.argv.slice(2);
function argVal(flag, def) { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : def; }
const SETUP = (argVal('--setup', 'all') || 'all').toLowerCase();
const TICKERS_RAW = argVal('--tickers', '');
const EMIT = args.includes('--emit');
const JSON_OUT = args.includes('--json');
const CONCURRENCY = parseInt(argVal('--concurrency', '6'), 10);
const MAX_TICKERS = parseInt(argVal('--max', '120'), 10);

function readJSON(p) { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } }
const num = (v) => Number.isFinite(+v) ? +v : NaN;

// ── Universe ──────────────────────────────────────────────────────────────

async function buildUniverse() {
  if (TICKERS_RAW) return TICKERS_RAW.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const set = new Set();
  const wl = readJSON(resolve(SCRIPTS, 'lib', 'watchlist.json'));
  if (wl) {
    for (const t of wl.watchlist || []) set.add(t);
    for (const t of wl.mag7 || []) set.add(t);
    for (const t of wl.extras || []) set.add(t);
  }
  const spx = readJSON(resolve(SCRIPTS, 'lib', 'spx500.json'));
  const ndx = readJSON(resolve(SCRIPTS, 'lib', 'ndx100.json'));
  const all = [...new Set([...(spx?.tickers || []), ...(ndx?.tickers || [])])];
  if (all.length) {
    const list = all.map(t => `'${t}'`).join(',');
    const rows = await chQuery(`
      SELECT Ticker FROM daily_ohlcv
      WHERE (Ticker, Timestamp) IN (
        SELECT Ticker, max(Timestamp) FROM daily_ohlcv WHERE Ticker IN (${list}) GROUP BY Ticker
      ) AND AvgVol_20 >= 1000000
    `).catch(() => null);
    if (rows) for (const r of rows) set.add(r.Ticker);
  }
  return [...set].slice(0, MAX_TICKERS);
}

// ── Setup detectors (each returns { fired: bool, dir, str, detail } or null) ──

// 1. Bollinger Squeeze — bandwidth at 126-day minimum
async function detectBBSqueeze(ticker) {
  const rows = await chQuery(`
    SELECT Timestamp, Open, High, Low, Close, BB_Upper_20, BB_Lower_20, BB_Middle_20, RSI_14, ATR_14
    FROM daily_ohlcv
    WHERE Ticker = '${ticker}' AND BB_Middle_20 > 0
    ORDER BY Timestamp DESC LIMIT 130
  `).catch(() => null);
  if (!rows || rows.length < 126) return null;
  const bw = rows.map(r => (num(r.BB_Upper_20) - num(r.BB_Lower_20)) / num(r.BB_Middle_20));
  if (!bw[0] || !Number.isFinite(bw[0])) return null;
  const last = bw[0];
  const window = bw.slice(0, 126).filter(Number.isFinite);
  const minBW = Math.min(...window);
  if (last > minBW * 1.10) return null;
  const rsi = num(rows[0].RSI_14);
  const dir = rsi >= 55 ? 'bullish' : rsi <= 45 ? 'bearish' : 'neutral';
  const close = num(rows[0].Close), low = num(rows[0].Low), high = num(rows[0].High), atr = num(rows[0].ATR_14);
  return {
    fired: true, dir,
    str: 0.7 + (last <= minBW * 1.02 ? 0.2 : 0),
    detail: `BB squeeze (BW ${(last * 100).toFixed(2)}% vs 126d min ${(minBW * 100).toFixed(2)}%) — breakout imminent`,
    // Ticket fields — refLevel is today's low for bullish, today's high for bearish.
    entry: close, atr, refLevel: dir === 'bearish' ? high : low,
    bandwidth: Math.round(last * 10000) / 10000, bwMin: Math.round(minBW * 10000) / 10000, rsi,
  };
}

// 2. Holy Grail — strong trend (EMA21 + EMA50 rising, above SMA50) + pullback to EMA21
async function detectHolyGrail(ticker, mode = 'long') {
  const rows = await chQuery(`
    SELECT Close, High, Low, EMA_21, EMA_50, SMA_50, SMA_200, EMA_21_Slope1, EMA_50_Slope1, RSI_14, ATR_14
    FROM daily_ohlcv
    WHERE Ticker = '${ticker}'
    ORDER BY Timestamp DESC LIMIT 1
  `).catch(() => null);
  if (!rows || !rows[0]) return null;
  const r = rows[0];
  const close = num(r.Close), high = num(r.High), low = num(r.Low);
  const ema21 = num(r.EMA_21), ema50 = num(r.EMA_50), sma50 = num(r.SMA_50), sma200 = num(r.SMA_200);
  const ema21Slope = num(r.EMA_21_Slope1), ema50Slope = num(r.EMA_50_Slope1);
  if (!ema21 || !ema50 || !sma50) return null;

  // Long Holy Grail
  const trendUp = ema21 > ema50 && ema50 > sma200 && ema21Slope > 0 && ema50Slope > 0 && close > ema50;
  const pullbackToEma21 = low <= ema21 * 1.005 && close > ema21 * 0.995;
  const atr = num(r.ATR_14);
  if (trendUp && pullbackToEma21) {
    return {
      fired: true, dir: 'bullish', str: 0.85,
      detail: `Holy Grail long: strong uptrend (EMA21>EMA50>SMA200, slopes up), pullback to EMA21 (${ema21.toFixed(2)})`,
      // Ticket fields — bullish stop anchored at EMA21 (the line we bought against)
      entry: close, atr, refLevel: ema21,
      ema21, ema50, sma200,
    };
  }
  const trendDn = ema21 < ema50 && ema50 < sma200 && ema21Slope < 0 && ema50Slope < 0 && close < ema50;
  const rallyToEma21 = high >= ema21 * 0.995 && close < ema21 * 1.005;
  if (trendDn && rallyToEma21) {
    return {
      fired: true, dir: 'bearish', str: 0.85,
      detail: `Holy Grail short: strong downtrend, rally to EMA21 (${ema21.toFixed(2)})`,
      // Short stop anchored at EMA21 (the line we shorted against)
      entry: close, atr, refLevel: ema21,
      ema21, ema50, sma200,
    };
  }
  return null;
}

// 3. ID/NR4 — Inside Day + Narrowest Range of last 4 days = volatility explosion
async function detectIDNR4(ticker) {
  const rows = await chQuery(`
    SELECT High, Low, Close, RSI_14, ATR_14
    FROM daily_ohlcv
    WHERE Ticker = '${ticker}'
    ORDER BY Timestamp DESC LIMIT 5
  `).catch(() => null);
  if (!rows || rows.length < 5) return null;
  const today = rows[0], y1 = rows[1];
  const todayH = num(today.High), todayL = num(today.Low), y1H = num(y1.High), y1L = num(y1.Low);
  const insideDay = todayH <= y1H && todayL >= y1L;
  const todayRange = todayH - todayL;
  const ranges = rows.slice(0, 4).map(r => num(r.High) - num(r.Low));
  const isNR4 = ranges.every((r, i) => i === 0 || todayRange <= r);
  if (!(insideDay && isNR4)) return null;
  const rsi = num(today.RSI_14);
  const dir = rsi >= 55 ? 'bullish' : rsi <= 45 ? 'bearish' : 'neutral';
  const close = num(today.Close), atr = num(today.ATR_14);
  return {
    fired: true, dir, str: 0.75,
    detail: `ID/NR4: inside day + narrowest range of last 4 (${todayRange.toFixed(2)}) — volatility expansion next`,
    // Ticket: stop below today's low for bullish, above today's high for bearish
    entry: close, atr, refLevel: dir === 'bearish' ? todayH : todayL,
    todayRange,
  };
}

// 4. Turtle Soup — false 20-day breakout reversal
async function detectTurtleSoup(ticker) {
  const rows = await chQuery(`
    SELECT Timestamp, High, Low, Close, Open, High_20d, Low_20d, RSI_14, ATR_14
    FROM daily_ohlcv
    WHERE Ticker = '${ticker}'
    ORDER BY Timestamp DESC LIMIT 25
  `).catch(() => null);
  if (!rows || rows.length < 22) return null;
  const today = rows[0], y1 = rows[1];
  const atr = num(today.ATR_14);
  const close = num(today.Close);

  const y1L = num(y1.Low);
  const priorLowsBefore = rows.slice(5, 22).map(r => num(r.Low));
  const priorMinLow = Math.min(...priorLowsBefore);
  if (y1L < priorMinLow && close > priorMinLow) {
    return {
      fired: true, dir: 'bullish', str: 0.8,
      detail: `Turtle Soup long: y1 new 20d low ${y1L.toFixed(2)} below prior min ${priorMinLow.toFixed(2)}, today reclaims it (${close.toFixed(2)})`,
      // Stop anchored just under the reclaimed level (the thesis breaks if we go back below)
      entry: close, atr, refLevel: priorMinLow,
    };
  }
  const y1H = num(y1.High);
  const priorHighsBefore = rows.slice(5, 22).map(r => num(r.High));
  const priorMaxHigh = Math.max(...priorHighsBefore);
  if (y1H > priorMaxHigh && close < priorMaxHigh) {
    return {
      fired: true, dir: 'bearish', str: 0.8,
      detail: `Turtle Soup short: y1 new 20d high ${y1H.toFixed(2)} above prior max ${priorMaxHigh.toFixed(2)}, today fails (${close.toFixed(2)})`,
      // Stop anchored just above the failed-break level
      entry: close, atr, refLevel: priorMaxHigh,
    };
  }
  return null;
}

// 5. MACD Divergence — best oscillator signal per Encyclopedia of Trading Strategies.
// Bullish: price makes lower low while MACD_Hist makes higher low.
// Bearish: price makes higher high while MACD_Hist makes lower high.
async function detectMACDDivergence(ticker) {
  const rows = await chQuery(`
    SELECT Timestamp, Close, High, Low, MACD_Hist, ATR_14
    FROM daily_ohlcv
    WHERE Ticker = '${ticker}' AND MACD_Hist IS NOT NULL
    ORDER BY Timestamp DESC LIMIT 25
  `).catch(() => null);
  if (!rows || rows.length < 20) return null;
  const hist = rows.map(r => num(r.MACD_Hist));
  const lows = rows.map(r => num(r.Low));
  const highs = rows.map(r => num(r.High));
  const close = num(rows[0].Close), atr = num(rows[0].ATR_14);

  function findExtrema(arr, type) {
    const out = [];
    for (let i = 2; i < arr.length - 2; i++) {
      const isPeak = arr[i] > arr[i - 1] && arr[i] > arr[i - 2] && arr[i] > arr[i + 1] && arr[i] > arr[i + 2];
      const isTrough = arr[i] < arr[i - 1] && arr[i] < arr[i - 2] && arr[i] < arr[i + 1] && arr[i] < arr[i + 2];
      if ((type === 'peak' && isPeak) || (type === 'trough' && isTrough)) out.push(i);
    }
    return out;
  }

  // Bullish divergence
  const histTroughs = findExtrema(hist, 'trough');
  if (histTroughs.length >= 2) {
    const [recent, prior] = histTroughs;
    if (lows[recent] < lows[prior] && hist[recent] > hist[prior] && hist[recent] < 0) {
      return {
        fired: true, dir: 'bullish', str: 0.95,
        detail: `MACD bullish divergence: price LL (${lows[recent].toFixed(2)} vs ${lows[prior].toFixed(2)}), MACD_Hist HL (${hist[recent].toFixed(3)} vs ${hist[prior].toFixed(3)})`,
        // Stop anchored at the recent swing low (divergence invalidates if we break below)
        entry: close, atr, refLevel: lows[recent],
      };
    }
  }
  const histPeaks = findExtrema(hist, 'peak');
  if (histPeaks.length >= 2) {
    const [recent, prior] = histPeaks;
    if (highs[recent] > highs[prior] && hist[recent] < hist[prior] && hist[recent] > 0) {
      return {
        fired: true, dir: 'bearish', str: 0.95,
        detail: `MACD bearish divergence: price HH (${highs[recent].toFixed(2)} vs ${highs[prior].toFixed(2)}), MACD_Hist LH (${hist[recent].toFixed(3)} vs ${hist[prior].toFixed(3)})`,
        // Stop anchored at the recent swing high (divergence invalidates if we break above)
        entry: close, atr, refLevel: highs[recent],
      };
    }
  }
  return null;
}

// ── Pool runner ───────────────────────────────────────────────────────────

async function runPool(items, fn, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() { while (idx < items.length) { const i = idx++; results[i] = await fn(items[i]); } }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

const SETUP_FNS = {
  'bb-squeeze':      { fn: detectBBSqueeze,        src: 'setup-bb-squeeze',   label: 'BB Squeeze' },
  'holy-grail':      { fn: detectHolyGrail,        src: 'setup-holy-grail',   label: 'Holy Grail' },
  'id-nr4':          { fn: detectIDNR4,            src: 'setup-id-nr4',       label: 'ID/NR4' },
  'turtle-soup':     { fn: detectTurtleSoup,       src: 'setup-turtle-soup',  label: 'Turtle Soup' },
  'macd-divergence': { fn: detectMACDDivergence,   src: 'setup-macd-div',     label: 'MACD Divergence' },
};

// Build a trade ticket so signals are journalable. ATR-based stop, never penny-stops.
// Used to enrich every fired setup with entry/stop/t1/t2 in meta so journal_consumer.mjs
// can append the signal to the learning loop.
function buildTicket({ direction, entry, refLevel, atr, stopAtr = 0.5, t1Atr = 1.5, t2Atr = 3.0, minRiskAtr = 0.5 }) {
  if (!entry || !refLevel || !atr || atr <= 0) return null;
  const sign = direction === 'short' ? -1 : 1;
  let stop = direction === 'long' ? refLevel - stopAtr * atr : refLevel + stopAtr * atr;
  const minRisk = minRiskAtr * atr;
  if (direction === 'long') {
    if (entry - stop < minRisk) stop = entry - minRisk;
    if (stop >= entry) return null;
  } else {
    if (stop - entry < minRisk) stop = entry + minRisk;
    if (stop <= entry) return null;
  }
  const risk = Math.abs(entry - stop);
  const t1 = entry + sign * t1Atr * atr;
  const t2 = entry + sign * t2Atr * atr;
  return {
    entry: +entry.toFixed(2), stop: +stop.toFixed(2),
    t1: +t1.toFixed(2), t2: +t2.toFixed(2),
    rr1: +(Math.abs(t1 - entry) / risk).toFixed(2),
    rr2: +(Math.abs(t2 - entry) / risk).toFixed(2),
    atr: +atr.toFixed(2),
  };
}

async function runSetup(setupKey, universe) {
  const def = SETUP_FNS[setupKey];
  if (!def) return null;
  const results = await runPool(universe, async (t) => {
    try { const r = await def.fn(t); return r ? { ...r, ticker: t } : null; }
    catch { return null; }
  }, CONCURRENCY);
  const fired = results.filter(Boolean);
  if (EMIT && fired.length) {
    // Enrich each signal with a trade ticket so the journal consumer can pick it up.
    // refLevel/atr/entry must be provided by the detector (added to each detector below).
    emitSignals(def.src, fired.map(r => {
      const direction = (r.dir === 'bearish' || r.dir === 'short') ? 'short' : 'long';
      const ticket = (r.entry && r.refLevel && r.atr)
        ? buildTicket({ direction, entry: r.entry, refLevel: r.refLevel, atr: r.atr })
        : null;
      return {
        ticker: r.ticker, dir: r.dir || 'neutral', str: r.str || 0.7,
        meta: {
          setup: def.label, detail: r.detail,
          ...(ticket || {}),
          // tier hint for journal classification — str ≥ 0.85 = TRADE
          tier: (r.str || 0.7) >= 0.85 ? 'TRADE' : 'WATCHLIST',
        },
      };
    }));
  }
  return { setup: setupKey, label: def.label, fired };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const universe = await buildUniverse();
  if (!JSON_OUT) console.error(`[setup-scanners] universe: ${universe.length} tickers`);

  const setupsToRun = SETUP === 'all' ? Object.keys(SETUP_FNS) : [SETUP];
  const all = [];
  for (const s of setupsToRun) {
    const r = await runSetup(s, universe);
    if (r) all.push(r);
  }

  const summary = {
    ts: new Date().toISOString(),
    runtimeMs: Date.now() - t0,
    universeSize: universe.length,
    setupsRun: setupsToRun,
    results: all,
  };

  if (EMIT) writeFileSync(resolve(MEM, 'setup_scans.json'), JSON.stringify(summary, null, 2));

  if (JSON_OUT) { console.log(JSON.stringify(summary, null, 2)); return; }

  const localTime = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  console.log(`\n══════ SETUP SCANNERS — ${localTime} ET ══════`);
  console.log(`Universe: ${universe.length}  ·  Runtime: ${(summary.runtimeMs / 1000).toFixed(1)}s\n`);
  for (const r of all) {
    if (!r.fired.length) { console.log(`  ${r.label.padEnd(20)} 0 hits`); continue; }
    console.log(`  ▼ ${r.label.toUpperCase()} — ${r.fired.length} hit(s)`);
    for (const h of r.fired.slice(0, 8)) {
      const arrow = h.dir === 'bullish' ? '↑' : h.dir === 'bearish' ? '↓' : '·';
      console.log(`    ${arrow} ${h.ticker.padEnd(6)} str=${(h.str || 0).toFixed(2)}  ${h.detail || ''}`);
    }
    console.log('');
  }
  if (EMIT) console.log(`✓ Emitted to signal bus (sources: ${setupsToRun.map(s => SETUP_FNS[s]?.src).filter(Boolean).join(', ')})`);
}

main().catch(e => { console.error('Fatal:', e.message || e); process.exit(1); });
