#!/usr/bin/env node
/**
 * mean_reversion_scan.mjs
 *
 * Scans watchlist for mean-reversion setups:
 *   - RSI14 > 75 (overbought) OR RSI14 < 25 (oversold) on daily
 *   - Price outside Bollinger Bands (20-day, 2 std)
 *   - Both conditions together = HIGH PRIORITY
 *
 * Outputs WhatsApp-friendly alert or NO_ALERTS.
 *
 * Usage: node mean_reversion_scan.mjs [--rsi-high 75] [--rsi-low 25]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

try {
  const envFile = readFileSync(resolve(__dir, '..', '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}

import { WATCHLIST, MAG7, EXTRAS } from './lib/loadWatchlist.mjs';
import { emitSignals } from './lib/signals.mjs';
import { buildTicket } from './lib/journalEmit.mjs';

const API_KEY = process.env.MASSIVE_API_KEY;
const BASE = 'https://api.polygon.io';

const args = process.argv.slice(2);
const RSI_HIGH = parseFloat(args.find(a => a.startsWith('--rsi-high='))?.split('=')[1] ?? '75');
const RSI_LOW  = parseFloat(args.find(a => a.startsWith('--rsi-low='))?.split('=')[1] ?? '25');
const EMIT = args.includes('--emit');

const UNIVERSE = [...new Set([...WATCHLIST, ...MAG7])];

async function fetchJSON(url) {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}apiKey=${API_KEY}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function getRSI(ticker) {
  try {
    const d = await fetchJSON(`${BASE}/v1/indicators/rsi/${ticker}?timespan=day&adjusted=true&window=14&series_type=close&limit=1`);
    return d.results?.values?.[0]?.value ?? null;
  } catch { return null; }
}

async function getBollingerBands(ticker) {
  // Polygon doesn't have BB directly — use SMA20 + fetch 20 daily closes to compute std dev
  try {
    const [smaData, aggData] = await Promise.all([
      fetchJSON(`${BASE}/v1/indicators/sma/${ticker}?timespan=day&adjusted=true&window=20&series_type=close&limit=1`),
      fetchJSON(`${BASE}/v2/aggs/ticker/${ticker}/range/1/day/20230101/${Date.now()}?adjusted=true&sort=desc&limit=25`)
    ]);
    const sma = smaData.results?.values?.[0]?.value;
    const closes = (aggData.results || []).slice(0, 20).map(b => b.c);
    if (!sma || closes.length < 20) return null;
    const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
    const variance = closes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / closes.length;
    const std = Math.sqrt(variance);
    const lastClose = closes[0];
    return {
      upper: sma + 2 * std,
      lower: sma - 2 * std,
      sma,
      lastClose,
      std,
    };
  } catch { return null; }
}

async function scanTicker(ticker) {
  const [rsi, bb] = await Promise.all([getRSI(ticker), getBollingerBands(ticker)]);
  if (!rsi && !bb) return null;

  const overbought = rsi !== null && rsi > RSI_HIGH;
  const oversold   = rsi !== null && rsi < RSI_LOW;
  const aboveUpper = bb !== null && bb.lastClose > bb.upper;
  const belowLower = bb !== null && bb.lastClose < bb.lower;

  // Only flag if RSI condition OR BB condition met
  if (!overbought && !oversold && !aboveUpper && !belowLower) return null;

  const direction = (overbought || aboveUpper) ? 'SHORT' : 'LONG';
  const priority  = ((overbought && aboveUpper) || (oversold && belowLower)) ? '🔴 HIGH' : '🟡 WATCH';

  // Distance from the violated BB band, as % of price
  let bbDistPct = null;
  if (bb && aboveUpper) bbDistPct = ((bb.lastClose - bb.upper) / bb.lastClose) * 100;
  else if (bb && belowLower) bbDistPct = ((bb.lower - bb.lastClose) / bb.lastClose) * 100;

  return {
    ticker,
    direction,
    priority,
    isHigh: priority.includes('HIGH'),
    rsi,
    rsiStr: rsi != null ? rsi.toFixed(1) : null,
    price: bb?.lastClose ?? null,
    priceStr: bb?.lastClose != null ? bb.lastClose.toFixed(2) : 'n/a',
    bbUpper: bb?.upper ?? null,
    bbLower: bb?.lower ?? null,
    bbUpperStr: bb?.upper != null ? bb.upper.toFixed(2) : 'n/a',
    bbLowerStr: bb?.lower != null ? bb.lower.toFixed(2) : 'n/a',
    bbDistPct,
    aboveUpper,
    belowLower,
    overbought,
    oversold,
    bbStd: bb?.std ?? null,    // std-dev of last 20 closes — our volatility proxy for ticket
  };
}

// Process in batches of 10 to avoid rate limits
async function processBatch(tickers) {
  const results = [];
  for (let i = 0; i < tickers.length; i += 10) {
    const batch = tickers.slice(i, i + 10);
    const batchResults = await Promise.all(batch.map(scanTicker));
    results.push(...batchResults.filter(Boolean));
    if (i + 10 < tickers.length) await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', year: 'numeric' });

const hits = await processBatch(UNIVERSE);

if (hits.length === 0) {
  console.log('NO_ALERTS');
  process.exit(0);
}

// Sort: HIGH priority first, then by RSI extremity
hits.sort((a, b) => {
  if (a.priority.includes('HIGH') && !b.priority.includes('HIGH')) return -1;
  if (!a.priority.includes('HIGH') && b.priority.includes('HIGH')) return 1;
  const aRsi = parseFloat(a.rsi) || 50;
  const bRsi = parseFloat(b.rsi) || 50;
  const aDist = Math.abs(aRsi - 50);
  const bDist = Math.abs(bRsi - 50);
  return bDist - aDist;
});

const shorts = hits.filter(h => h.direction === 'SHORT');
const longs  = hits.filter(h => h.direction === 'LONG');

// Emit to signal bus with full trade tickets so journal_consumer captures.
// LONG (oversold + below BB lower): refLevel = bbLower, stop below the band.
// SHORT (overbought + above BB upper): refLevel = bbUpper, stop above the band.
// Use std as the volatility proxy (the BB IS std-based; same unit).
if (EMIT) {
  const signals = [];
  for (const h of hits) {
    if (!h.price || !h.bbStd) continue;
    const direction = h.direction === 'LONG' ? 'long' : 'short';
    const refLevel = direction === 'long' ? h.bbLower : h.bbUpper;
    if (!refLevel) continue;
    const ticket = buildTicket({ direction, entry: h.price, refLevel, atr: h.bbStd });
    const str = h.isHigh ? 0.85 : 0.7;   // HIGH priority = TRADE tier
    signals.push({
      ticker: h.ticker, dir: direction === 'long' ? 'bullish' : 'bearish', str,
      meta: {
        setup: direction === 'long' ? 'BB lower breach' : 'BB upper breach',
        detail: `RSI ${h.rsiStr ?? 'n/a'} ${h.aboveUpper ? 'above BB upper' : h.belowLower ? 'below BB lower' : ''}`,
        ...(ticket || {}),
        tier: h.isHigh ? 'TRADE' : 'WATCHLIST',
      },
    });
  }
  if (signals.length) emitSignals('mean-reversion', signals);
}

let out = `📉📈 MEAN REVERSION SCAN — ${today} ${now} ET\n`;
out += `RSI14 threshold: >${RSI_HIGH} overbought | <${RSI_LOW} oversold\n\n`;

if (shorts.length) {
  out += `🔴 FADE CANDIDATES (overbought/extended):\n`;
  for (const h of shorts) {
    const bbTag = h.aboveUpper ? ` · above BB` : '';
    out += `  ${h.priority} ${h.ticker} — RSI ${h.rsiStr ?? 'n/a'}${bbTag} · $${h.priceStr} (BB upper $${h.bbUpperStr})\n`;
  }
}

if (longs.length) {
  out += `\n🟢 REVERSION LONGS (oversold/extended down):\n`;
  for (const h of longs) {
    const bbTag = h.belowLower ? ` · below BB` : '';
    out += `  ${h.priority} ${h.ticker} — RSI ${h.rsiStr ?? 'n/a'}${bbTag} · $${h.priceStr} (BB lower $${h.bbLowerStr})\n`;
  }
}

out += `\n${hits.length} name(s) flagged. HIGH = both RSI + BB triggered.`;
console.log(out.trim());

// ── PNG table for WhatsApp ─────────────────────────────────
try {
  const { renderTable, COLORS } = await import('./lib/tableRenderer.mjs');

  const columns   = ['Ticker', 'Side', 'RSI14', 'Price', 'BB Lvl', 'BB Dist', 'Prio'];
  const colWidths = [70, 60, 55, 70, 70, 70, 60];
  const allRows   = [];

  // Fades first (red), then longs (green)
  for (const h of shorts) {
    const bbStr  = h.aboveUpper && h.bbUpper != null ? `$${h.bbUpper.toFixed(2)}` : '-';
    const bbDist = h.bbDistPct != null ? `+${h.bbDistPct.toFixed(2)}%` : '-';
    const rsiStr = h.rsiStr ?? '-';
    allRows.push({
      values: [h.ticker, 'FADE', rsiStr, `$${h.priceStr}`, bbStr, bbDist, h.isHigh ? 'HIGH' : 'WATCH'],
      styles: [
        { color: COLORS.red, bold: true },
        { color: COLORS.red, align: 'center' },
        { color: h.overbought ? COLORS.red : COLORS.bodyText, bold: h.overbought, align: 'center' },
        { color: COLORS.bodyText, align: 'center' },
        { color: COLORS.muted, align: 'center' },
        { color: h.aboveUpper ? COLORS.red : COLORS.muted, align: 'center' },
        { color: h.isHigh ? COLORS.red : COLORS.muted, bold: h.isHigh, align: 'center' },
      ],
    });
  }
  for (const h of longs) {
    const bbStr  = h.belowLower && h.bbLower != null ? `$${h.bbLower.toFixed(2)}` : '-';
    const bbDist = h.bbDistPct != null ? `-${h.bbDistPct.toFixed(2)}%` : '-';
    const rsiStr = h.rsiStr ?? '-';
    allRows.push({
      values: [h.ticker, 'LONG', rsiStr, `$${h.priceStr}`, bbStr, bbDist, h.isHigh ? 'HIGH' : 'WATCH'],
      styles: [
        { color: COLORS.green, bold: true },
        { color: COLORS.green, align: 'center' },
        { color: h.oversold ? COLORS.green : COLORS.bodyText, bold: h.oversold, align: 'center' },
        { color: COLORS.bodyText, align: 'center' },
        { color: COLORS.muted, align: 'center' },
        { color: h.belowLower ? COLORS.green : COLORS.muted, align: 'center' },
        { color: h.isHigh ? COLORS.green : COLORS.muted, bold: h.isHigh, align: 'center' },
      ],
    });
  }

  if (allRows.length) {
    const imgPath = resolve(__dir, '..', 'memory', 'mean_reversion_scan.png');
    const highCount = hits.filter(h => h.isHigh).length;
    // Dump structured JSON for dashboards (so they can render fresh HTML tables
    // instead of embedding the WhatsApp PNG).
    try {
      const jsonPath = resolve(__dir, '..', 'memory', 'mean_reversion_scan.json');
      writeFileSync(jsonPath, JSON.stringify({
        ts: Date.now(),
        updatedAt: new Date().toISOString(),
        runId: `${today} ${now} ET`,
        rsiHigh: RSI_HIGH, rsiLow: RSI_LOW,
        shorts: shorts.map(h => ({
          ticker: h.ticker, side: 'FADE',
          rsi: h.rsi, rsiStr: h.rsiStr,
          price: h.price, priceStr: h.priceStr,
          bbUpper: h.bbUpper, bbDistPct: h.bbDistPct,
          isHigh: h.isHigh, overbought: h.overbought, aboveUpper: h.aboveUpper,
        })),
        longs: longs.map(h => ({
          ticker: h.ticker, side: 'LONG',
          rsi: h.rsi, rsiStr: h.rsiStr,
          price: h.price, priceStr: h.priceStr,
          bbLower: h.bbLower, bbDistPct: h.bbDistPct,
          isHigh: h.isHigh, oversold: h.oversold, belowLower: h.belowLower,
        })),
        counts: { shorts: shorts.length, longs: longs.length, high: highCount },
      }, null, 2));
    } catch (e) { console.error(`[mean-rev] json dump failed: ${e.message}`); }
    await renderTable({
      title: `MEAN REVERSION — ${today} ${now} ET  (RSI >${RSI_HIGH} / <${RSI_LOW})`,
      columns,
      colWidths,
      rows: allRows,
      footer: `${shorts.length} fades · ${longs.length} longs · ${highCount} HIGH (RSI+BB confirmed)`,
      outputPath: imgPath,
    });

    // Delivery handled by run-and-forward-slack.mjs via PNG_PATH below.
    console.log(`PNG_PATH:${imgPath}`);
  }
} catch (e) {
  console.error(`[mean-reversion] PNG render failed: ${e.message}`);
}
