#!/usr/bin/env node
/**
 * statistical_edge_scanner.mjs — Find high-percentage trades using ClickHouse history.
 *
 * Takes today's movers and setups, queries ClickHouse for historical analogs,
 * calculates odds, and generates trade ideas with statistical backing.
 *
 * Examples:
 *   "SNDK up 5% closing near high → faded 65% of the time, avg -1.8% next day"
 *   "SPY gapped up 3% → these stocks faded 78% of the time"
 *   "RSI > 75 + vol 3x + up 4%+ → 71% fade rate next day"
 *
 * Cost: $0 (pure ClickHouse SQL, no LLM)
 *
 * Usage:
 *   node statistical_edge_scanner.mjs [--force] [--minMove 3] [--universe watchlist|beta]
 *
 * Schedule: 2:45pm weekdays via timer-dispatch
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chQuery, getMultiTickerLatest, getLatestDate } from './lib/clickhouse.mjs';
import { marketClock } from './lib/marketClock.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Load env ────────────────────────────────────────────────
try {
  const envFile = readFileSync(resolve(__dir, '..', '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch {}

const API_KEY = process.env.MASSIVE_API_KEY;
const BASE = 'https://api.polygon.io';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const MIN_MOVE = (() => { const i = args.indexOf('--minMove'); return i >= 0 ? parseFloat(args[i + 1]) : 3; })();

const mc = marketClock();
if (!FORCE && !mc.isMarketOpen && !mc.isAfterHours) {
  console.log('NO_ALERTS');
  process.exit(0);
}

// ── Load universes ──────────────────────────────────────────
const wlData = JSON.parse(readFileSync(resolve(__dir, 'lib', 'watchlist.json'), 'utf-8'));
const WATCHLIST = [...new Set([...(wlData.watchlist || []), ...(wlData.mag7 || []), ...(wlData.extras || [])])];

let betaData;
try { betaData = JSON.parse(readFileSync(resolve(__dir, 'lib', 'beta_universe.json'), 'utf-8')); } catch { betaData = { tickers: [] }; }
const BETA = betaData.tickers || [];

const UNIVERSE = [...new Set([...WATCHLIST, ...BETA])];

// ── Polygon snapshot ────────────────────────────────────────
async function fetchJSON(url) {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}apiKey=${API_KEY}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  return res.json();
}

async function getTodayMovers() {
  const movers = [];
  const batches = [];
  for (let i = 0; i < UNIVERSE.length; i += 50) {
    batches.push(UNIVERSE.slice(i, i + 50));
  }
  for (const batch of batches) {
    const data = await fetchJSON(`${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${batch.join(',')}`);
    if (data?.tickers) {
      for (const t of data.tickers) {
        const prevClose = t.prevDay?.c || 0;
        const price = t.day?.c || t.lastTrade?.p || prevClose;
        const dayOpen = t.day?.o || prevClose;
        const dayHigh = t.day?.h || price;
        const dayLow = t.day?.l || price;
        const dayVol = t.day?.v || 0;
        const prevVol = t.prevDay?.v || 1;
        if (prevClose <= 0) continue;
        const chgPct = ((price - prevClose) / prevClose) * 100;
        const range = dayHigh - dayLow;
        const closeInRange = range > 0 ? (price - dayLow) / range : 0.5;
        const gapPct = dayOpen > 0 ? ((dayOpen - prevClose) / prevClose) * 100 : 0;
        const rvol = prevVol > 0 ? dayVol / prevVol : 1;

        if (Math.abs(chgPct) >= MIN_MOVE) {
          movers.push({
            ticker: t.ticker, price, prevClose, chgPct: round(chgPct),
            gapPct: round(gapPct), closeInRange: round(closeInRange),
            rvol: round(rvol), dayVol, dayHigh, dayLow,
          });
        }
      }
    }
    if (batches.indexOf(batch) < batches.length - 1) {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  movers.sort((a, b) => Math.abs(b.chgPct) - Math.abs(a.chgPct));
  return movers;
}

// ── Statistical edge queries ────────────────────────────────

// Query 1: "Ticker was up/down X%, what happened next?"
// Returns fade/follow stats for 1d, 5d, AND 10d horizons so we can surface
// the "best timeframe" — the holding period with the strongest edge.
async function analogReturn(ticker, movePct, tolerance = 1.5) {
  const dir = movePct > 0 ? 'up' : 'down';
  const lo = Math.abs(movePct) - tolerance;
  const hi = Math.abs(movePct) + tolerance;
  const sign = movePct > 0 ? '' : '-';

  const rows = await chQuery(`
    SELECT
      count() as N,
      avg(Fwd1d) * 100 as avg_fwd1d,
      avg(Fwd5d) * 100 as avg_fwd5d,
      avg(Fwd10d) * 100 as avg_fwd10d,
      countIf(Fwd1d ${movePct > 0 ? '<' : '>'} 0) * 100.0 / count() as fade_rate_1d,
      countIf(Fwd5d ${movePct > 0 ? '<' : '>'} 0) * 100.0 / count() as fade_rate_5d,
      countIf(Fwd10d ${movePct > 0 ? '<' : '>'} 0) * 100.0 / count() as fade_rate_10d,
      min(Fwd1d) * 100 as worst_1d,
      max(Fwd1d) * 100 as best_1d
    FROM daily_ohlcv
    WHERE Ticker = '${ticker}'
      AND ${movePct > 0 ? '' : '-'}DayPct * 100 BETWEEN ${lo} AND ${hi}
      AND Fwd1d != 0
      AND Fwd10d != 0
  `);
  return rows?.[0] || null;
}

// Determine which timeframe has the strongest statistical edge for a setup.
// "Edge" = how far the fade rate is from 50% (coin flip), weighted by avg return.
// Returns { horizon: '1d'|'5d'|'10d', fade_rate, avg, edge, directionLabel }
function bestTimeframe(base) {
  if (!base) return null;
  const frames = [
    { name: '1d',  fade: base.fade_rate_1d,  avg: base.avg_fwd1d },
    { name: '5d',  fade: base.fade_rate_5d,  avg: base.avg_fwd5d },
    { name: '10d', fade: base.fade_rate_10d, avg: base.avg_fwd10d },
  ].filter(f => Number.isFinite(f.fade) && Number.isFinite(f.avg));

  if (!frames.length) return null;

  // Edge score = |fade_rate - 50| × sqrt(|avg return|) — prefer strong conviction
  // AND meaningful return magnitude. Add abs(avg) so a 60% fade with +0.5% avg
  // ranks higher than 58% fade with +0.01% avg.
  for (const f of frames) {
    const edgeFromCoin = Math.abs(f.fade - 50);
    const magnitudeBonus = Math.sqrt(Math.abs(f.avg));
    f.edge = edgeFromCoin + magnitudeBonus * 3;
  }

  frames.sort((a, b) => b.edge - a.edge);
  const best = frames[0];
  return {
    horizon: best.name,
    fade_rate: best.fade,
    avg: best.avg,
    edge: best.edge,
    directionLabel: best.fade > 50 ? 'FADE' : 'FOLLOW',
  };
}

// Query 2: "Ticker up X% + RSI condition, what happened?"
async function analogWithRSI(ticker, movePct, rsiAbove) {
  const lo = Math.abs(movePct) - 1.5;
  const hi = Math.abs(movePct) + 1.5;

  const rows = await chQuery(`
    SELECT
      count() as N,
      avg(Fwd1d) * 100 as avg_fwd1d,
      avg(Fwd5d) * 100 as avg_fwd5d,
      countIf(Fwd1d < 0) * 100.0 / count() as fade_rate_1d,
      countIf(Fwd5d < 0) * 100.0 / count() as fade_rate_5d
    FROM daily_ohlcv
    WHERE Ticker = '${ticker}'
      AND DayPct * 100 BETWEEN ${lo} AND ${hi}
      AND RSI_14 ${rsiAbove ? '>' : '<'} ${rsiAbove ? 70 : 30}
      AND Fwd1d != 0
  `);
  return rows?.[0] || null;
}

// Query 3: "Ticker up X% + closing near high (top 25% of range), what happened?"
async function analogCloseNearExtreme(ticker, movePct, nearHigh = true) {
  const lo = Math.abs(movePct) - 1.5;
  const hi = Math.abs(movePct) + 1.5;
  const rangeFilter = nearHigh
    ? '(Close - Low) / (High - Low) > 0.75'
    : '(Close - Low) / (High - Low) < 0.25';

  const rows = await chQuery(`
    SELECT
      count() as N,
      avg(Fwd1d) * 100 as avg_fwd1d,
      avg(Fwd5d) * 100 as avg_fwd5d,
      countIf(Fwd1d ${movePct > 0 ? '<' : '>'} 0) * 100.0 / count() as fade_rate_1d
    FROM daily_ohlcv
    WHERE Ticker = '${ticker}'
      AND DayPct * 100 BETWEEN ${lo} AND ${hi}
      AND (High - Low) > 0
      AND ${rangeFilter}
      AND Fwd1d != 0
  `);
  return rows?.[0] || null;
}

// Query 4: "Ticker up X% with volume > 2x average"
async function analogWithVolume(ticker, movePct, minRvol = 2) {
  const lo = Math.abs(movePct) - 1.5;
  const hi = Math.abs(movePct) + 1.5;

  const rows = await chQuery(`
    SELECT
      count() as N,
      avg(Fwd1d) * 100 as avg_fwd1d,
      avg(Fwd5d) * 100 as avg_fwd5d,
      countIf(Fwd1d < 0) * 100.0 / count() as fade_rate_1d
    FROM daily_ohlcv
    WHERE Ticker = '${ticker}'
      AND DayPct * 100 BETWEEN ${lo} AND ${hi}
      AND AvgVol_20 > 0
      AND Volume / AvgVol_20 > ${minRvol}
      AND Fwd1d != 0
  `);
  return rows?.[0] || null;
}

// Query 5: "SPY/market up X%, what faded the most across universe?"
async function marketGapFaders(marketGapPct) {
  const lo = Math.abs(marketGapPct) - 1;
  const hi = Math.abs(marketGapPct) + 1;

  const rows = await chQuery(`
    SELECT
      Ticker,
      count() as N,
      avg(Fwd1d) * 100 as avg_fwd1d,
      countIf(Fwd1d < 0) * 100.0 / count() as fade_rate,
      avg(DayPct) * 100 as avg_day_move
    FROM daily_ohlcv
    WHERE Ticker IN (SELECT DISTINCT Ticker FROM daily_ohlcv WHERE Ticker = 'SPY' AND GapPct * 100 BETWEEN ${lo} AND ${hi})
      AND Ticker != 'SPY'
      AND GapPct * 100 > ${lo}
      AND DayPct * 100 > 3
      AND Fwd1d != 0
      AND Ticker IN (${WATCHLIST.slice(0, 30).map(t => `'${t}'`).join(',')})
    GROUP BY Ticker
    HAVING N >= 5
    ORDER BY fade_rate DESC
    LIMIT 10
  `, { timeout: 60_000 });
  return rows || [];
}

// Query 6: INTRADAY analog — "At this time of day historically, when ticker
// was up Y% from prev close, what was the rest-of-day move?"
// Uses minute_ohlcv (2B rows, pre-enriched). Samples same ET hour bucket.
async function analogIntraday(ticker, movePct, tolerance = 1.5) {
  // Current ET hour (market time). Convert to UTC for the minute_ohlcv filter.
  // EDT = UTC-4. ET 10am..3:59pm → UTC 14..19.
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etHour = etNow.getHours();
  // Pick a ±30-min window centered on now so we get ~30 minute-bars per day.
  // UTC offset: 4 (EDT) most of the year.
  const utcTarget = (etHour + 4) % 24;
  const lo = Math.abs(movePct) - tolerance;
  const hi = Math.abs(movePct) + tolerance;

  const rows = await chQuery(`
    WITH
      target AS (
        SELECT
          toDate(Timestamp) AS d,
          argMax(Close, Timestamp) AS target_price
        FROM minute_ohlcv
        WHERE Ticker = '${ticker}'
          AND toHour(Timestamp) = ${utcTarget}
          AND Close > 0
        GROUP BY d
      ),
      day_close AS (
        SELECT
          toDate(Timestamp) AS d,
          Close AS eod_close,
          lagInFrame(Close) OVER (ORDER BY Timestamp) AS prev_close
        FROM daily_ohlcv
        WHERE Ticker = '${ticker}'
        ORDER BY Timestamp
      )
    SELECT
      count() AS N,
      round(avgIf((dc.eod_close - t.target_price) / t.target_price * 100,
              dc.eod_close > 0 AND t.target_price > 0), 2) AS avg_rest_pct,
      round(countIf(dc.eod_close < t.target_price) * 100.0 / count(), 1) AS fade_rate_rest,
      round(avgIf(t.target_price, dc.prev_close > 0) / avgIf(dc.prev_close, dc.prev_close > 0) * 100 - 100, 2) AS avg_intraday_move,
      round(min((dc.eod_close - t.target_price) / t.target_price * 100), 2) AS worst_rest,
      round(max((dc.eod_close - t.target_price) / t.target_price * 100), 2) AS best_rest
    FROM target t
    INNER JOIN day_close dc ON t.d = dc.d
    WHERE dc.prev_close > 0
      AND ${movePct > 0 ? '' : '-'}((t.target_price - dc.prev_close) / dc.prev_close * 100) BETWEEN ${lo} AND ${hi}
  `, { timeout: 60_000 }).catch(e => { console.error(`[intraday-analog ${ticker}] ${e.message}`); return null; });

  return rows?.[0] || null;
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  // 1. Get today's movers
  const movers = await getTodayMovers();
  if (!movers.length) {
    console.log('NO_ALERTS');
    return;
  }

  // 2. Get ClickHouse data for RSI context
  const chData = await getMultiTickerLatest(movers.map(m => m.ticker));

  // 3. Run statistical analysis for each mover
  const ideas = [];

  for (const mover of movers.slice(0, 15)) {
    const ch = chData.get(mover.ticker);
    const rsi14 = ch?.RSI_14;
    const rsi5 = ch?.RSI_5;
    const bbUpper = ch?.BB_Upper_20;
    const bbLower = ch?.BB_Lower_20;
    const bbMid = ch?.BB_Middle_20;
    const close = ch?.Close || mover.price;

    // Bollinger Band position
    let bbStatus = null;
    if (bbUpper && bbLower && close) {
      if (close > bbUpper) bbStatus = 'ABOVE upper BB';
      else if (close < bbLower) bbStatus = 'BELOW lower BB';
      else if (bbUpper - bbLower > 0) {
        const bbPct = ((close - bbLower) / (bbUpper - bbLower)) * 100;
        if (bbPct > 90) bbStatus = 'near upper BB';
        else if (bbPct < 10) bbStatus = 'near lower BB';
      }
    }

    // Base analog (daily multi-horizon: 1d/5d/10d)
    const base = await analogReturn(mover.ticker, mover.chgPct);
    if (!base || base.N < 5) continue;

    // Intraday analog — rest-of-day behavior at current time
    const intraday = await analogIntraday(mover.ticker, mover.chgPct);

    const idea = {
      ticker: mover.ticker,
      todayMove: mover.chgPct,
      price: mover.price,
      closeInRange: mover.closeInRange,
      rvol: mover.rvol,
      rsi14: rsi14 ? round(rsi14) : null,
      rsi5: rsi5 ? round(rsi5) : null,
      bbStatus,
      base,
      intraday,
      extras: [],
    };

    // RSI overlay (use RSI_14 for the historical analog query)
    if (rsi14 && (rsi14 > 70 || rsi14 < 30)) {
      const rsiAnalog = await analogWithRSI(mover.ticker, mover.chgPct, rsi14 > 70);
      if (rsiAnalog?.N >= 3) {
        idea.extras.push({
          label: `+ RSI14 ${rsi14 > 70 ? '>70' : '<30'}`,
          data: rsiAnalog,
        });
      }
    }

    // Bollinger Band overlay — when outside bands, check historical analog
    if (bbStatus && (bbStatus.includes('ABOVE') || bbStatus.includes('BELOW'))) {
      const bbAbove = bbStatus.includes('ABOVE');
      const bbAnalog = await chQuery(`
        SELECT count() as N,
          avg(Fwd1d) * 100 as avg_fwd1d,
          countIf(Fwd1d ${bbAbove ? '<' : '>'} 0) * 100.0 / count() as fade_rate_1d
        FROM daily_ohlcv
        WHERE Ticker = '${mover.ticker}'
          AND ${bbAbove ? 'Close > BB_Upper_20' : 'Close < BB_Lower_20'}
          AND BB_Upper_20 > 0
          AND Fwd1d != 0
      `, { timeout: 45_000 });
      if (bbAnalog?.[0]?.N >= 3) {
        idea.extras.push({
          label: `+ ${bbStatus}`,
          data: bbAnalog[0],
        });
      }
    }

    // Close near high/low overlay
    if (mover.closeInRange > 0.75 || mover.closeInRange < 0.25) {
      const nearHigh = mover.closeInRange > 0.75;
      const rangeAnalog = await analogCloseNearExtreme(mover.ticker, mover.chgPct, nearHigh);
      if (rangeAnalog?.N >= 3) {
        idea.extras.push({
          label: `+ closing near ${nearHigh ? 'high' : 'low'}`,
          data: rangeAnalog,
        });
      }
    }

    // Volume overlay
    if (mover.rvol > 2) {
      const volAnalog = await analogWithVolume(mover.ticker, mover.chgPct, 2);
      if (volAnalog?.N >= 3) {
        idea.extras.push({
          label: `+ volume >2x avg`,
          data: volAnalog,
        });
      }
    }

    ideas.push(idea);
  }

  // 4. Check for market-wide gap fade opportunities
  const spyMover = movers.find(m => m.ticker === 'SPY');
  let gapFaders = [];
  if (spyMover && Math.abs(spyMover.gapPct) > 1.5) {
    gapFaders = await marketGapFaders(spyMover.gapPct);
  }

  // 5. Format output
  formatOutput(ideas, gapFaders, spyMover);
}

// ── Output ──────────────────────────────────────────────────
function formatOutput(ideas, gapFaders, spyMover) {
  if (!ideas.length && !gapFaders.length) { console.log('NO_ALERTS'); return; }

  const timeStr = new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit',
  });

  const lines = [];
  lines.push(`STATISTICAL EDGE SCANNER — ${timeStr} ET`);
  lines.push('');

  // Sort: highest fade/continuation rate first (most tradeable edge)
  ideas.sort((a, b) => {
    const aEdge = a.base.fade_rate_1d;
    const bEdge = b.base.fade_rate_1d;
    return Math.abs(bEdge - 50) - Math.abs(aEdge - 50); // furthest from 50% = strongest edge
  });

  // High-edge ideas (fade rate > 60% or < 40%)
  const highEdge = ideas.filter(i => i.base.fade_rate_1d > 60 || i.base.fade_rate_1d < 40);
  const moderate = ideas.filter(i => i.base.fade_rate_1d >= 40 && i.base.fade_rate_1d <= 60);

  if (highEdge.length) {
    lines.push('HIGH-EDGE SETUPS:');
    for (const idea of highEdge) {
      const dir = idea.todayMove > 0 ? 'UP' : 'DN';
      const fadeOrFollow = idea.base.fade_rate_1d > 50 ? 'FADE' : 'FOLLOW';
      const best = bestTimeframe(idea.base);

      lines.push(`  ${idea.ticker} ${dir} ${Math.abs(idea.todayMove)}% → ${fadeOrFollow} ${idea.base.fade_rate_1d.toFixed(0)}% of the time (N=${idea.base.N})`);

      // ★ Best timeframe line — the punchline
      if (best) {
        lines.push(`    ★ BEST TIMEFRAME: ${best.horizon.toUpperCase()} → ${best.directionLabel} ${best.fade_rate.toFixed(0)}% of the time, avg ${fmtPct(best.avg)}`);
      }

      // All three horizons side-by-side
      lines.push(`    1d:  fade ${idea.base.fade_rate_1d.toFixed(0)}% avg ${fmtPct(idea.base.avg_fwd1d)}  |  5d:  fade ${idea.base.fade_rate_5d.toFixed(0)}% avg ${fmtPct(idea.base.avg_fwd5d)}  |  10d: fade ${idea.base.fade_rate_10d?.toFixed(0) ?? '—'}% avg ${fmtPct(idea.base.avg_fwd10d)}`);

      const bbTag = idea.bbStatus ? ` | ${idea.bbStatus}` : '';
      lines.push(`    Today: RSI5 ${idea.rsi5 || 'n/a'} RSI14 ${idea.rsi14 || 'n/a'} | close ${idea.closeInRange > 0.75 ? 'near HIGH' : idea.closeInRange < 0.25 ? 'near LOW' : 'mid-range'} | vol ${idea.rvol}x${bbTag}`);

      // Enhanced overlays
      for (const ex of idea.extras) {
        lines.push(`    ${ex.label}: fade ${ex.data.fade_rate_1d?.toFixed(0)}% (N=${ex.data.N}) → avg next day ${fmtPct(ex.data.avg_fwd1d)}`);
      }
      lines.push('');
    }
  }

  if (moderate.length) {
    lines.push('COIN-FLIP (no statistical edge):');
    for (const idea of moderate) {
      const bbTag = idea.bbStatus ? ` | ${idea.bbStatus}` : '';
      lines.push(`  ${idea.ticker} ${idea.todayMove > 0 ? 'UP' : 'DN'} ${Math.abs(idea.todayMove)}% → fade ${idea.base.fade_rate_1d.toFixed(0)}% (N=${idea.base.N}) | RSI5 ${idea.rsi5 || 'n/a'} RSI14 ${idea.rsi14 || 'n/a'}${bbTag} — no edge`);
    }
    lines.push('');
  }

  // Market-wide gap faders
  if (gapFaders.length && spyMover) {
    lines.push(`MARKET GAP FADE CANDIDATES (SPY gapped ${fmtPct(spyMover.gapPct)}):`);
    for (const f of gapFaders.slice(0, 5)) {
      lines.push(`  ${f.Ticker}: fades ${f.fade_rate.toFixed(0)}% of the time on big gap days (N=${f.N}) | avg next day ${fmtPct(f.avg_fwd1d)}`);
    }
    lines.push('');
  }

  lines.push(`${ideas.length} movers analyzed | Min move: ${MIN_MOVE}% | Data: ClickHouse 2021-2026`);
  console.log(lines.join('\n'));

  // ── Structured JSON dump for dashboards ─────────────────────
  try {
    const allIdeas = [...highEdge, ...moderate];
    const slimIdea = (i) => ({
      ticker: i.ticker,
      todayMove: i.todayMove,
      close: i.close ?? null,
      rsi5: i.rsi5 ?? null,
      rsi14: i.rsi14 ?? null,
      bbStatus: i.bbStatus ?? null,
      base: i.base ? {
        N: i.base.N,
        fade_rate_1d: i.base.fade_rate_1d, avg_fwd1d: i.base.avg_fwd1d,
        fade_rate_5d: i.base.fade_rate_5d, avg_fwd5d: i.base.avg_fwd5d,
        fade_rate_10d: i.base.fade_rate_10d, avg_fwd10d: i.base.avg_fwd10d,
      } : null,
      intraday: i.intraday ? {
        N: i.intraday.N,
        fade_rate_rest: i.intraday.fade_rate_rest,
        avg_rest_pct: i.intraday.avg_rest_pct,
      } : null,
      edgeTier: highEdge.includes(i) ? 'HIGH' : 'MODERATE',
    });
    const jsonPath = resolve(__dir, '..', 'memory', 'statistical_edge_scan.json');
    writeFileSync(jsonPath, JSON.stringify({
      ts: Date.now(),
      updatedAt: new Date().toISOString(),
      runId: `${timeStr || ''}`,
      spyMover: spyMover ? { ticker: spyMover.Ticker, gapPct: spyMover.gapPct, todayMove: spyMover.todayMove } : null,
      ideas: allIdeas.map(slimIdea),
      gapFaders: (gapFaders || []).slice(0, 8).map(f => ({
        ticker: f.Ticker, fade_rate: f.fade_rate, avg_fwd1d: f.avg_fwd1d, N: f.N,
      })),
      counts: { high: highEdge.length, moderate: moderate.length },
    }, null, 2));
  } catch (e) { console.error(`[stat-edge] json dump failed: ${e.message}`); }

  // ── PNG composite table (WhatsApp delivery) ────────────────
  renderPng([...highEdge, ...moderate], gapFaders, spyMover, timeStr).catch(e => {
    console.error(`[stat-edge] PNG render failed: ${e.message}`);
  });
}

async function renderPng(ideas, gapFaders, spyMover, timeStr) {
  if (!ideas.length) return;
  const { renderTable, COLORS } = await import('./lib/tableRenderer.mjs');

  // Columns: Ticker · Move% · Close · 1d Fade · 5d Fade · 10d Fade · Rest-of-Day · RSI14 · BB · N
  const columns = ['Ticker', 'Move%', '1d Fade', '5d Fade', '10d Fade', 'RoD Fade', 'Best TF', 'RSI14', 'BB', 'N'];
  const colWidths = [68, 70, 75, 75, 75, 75, 85, 60, 75, 50];

  const rows = [];
  for (const i of ideas.slice(0, 15)) {
    const b = i.base;
    const ind = i.intraday;
    const bt = bestTimeframe(b);

    const fadeColor = (pct) => {
      if (pct == null || !Number.isFinite(pct)) return COLORS.muted;
      if (pct >= 65) return COLORS.red;      // strong fade (high % = fade)
      if (pct <= 35) return COLORS.green;    // strong follow (low % = follow)
      return COLORS.bodyText;
    };
    const fadeCell = (pct, avg) => {
      if (pct == null || !Number.isFinite(pct)) return '—';
      return `${pct.toFixed(0)}%  ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%`;
    };
    const rsiColor = i.rsi14 >= 75 ? COLORS.red : i.rsi14 <= 25 ? COLORS.green : COLORS.bodyText;
    const bbLabel = !i.bbStatus ? '—' :
      i.bbStatus.includes('ABOVE') ? 'ABV upr' :
      i.bbStatus.includes('BELOW') ? 'BLW lwr' :
      i.bbStatus.includes('near upper') ? 'near upr' :
      i.bbStatus.includes('near lower') ? 'near lwr' : 'mid';
    const bbColor = bbLabel.includes('ABV') ? COLORS.red :
                    bbLabel.includes('BLW') ? COLORS.green : COLORS.muted;

    // Best timeframe summary (e.g. "5d FADE")
    const btLabel = bt ? `${bt.horizon.toUpperCase()} ${bt.directionLabel}` : '—';
    const btColor = bt ? (bt.directionLabel === 'FADE' ? COLORS.red : COLORS.green) : COLORS.muted;

    const rodLabel = ind && ind.N >= 3
      ? fadeCell(ind.fade_rate_rest, ind.avg_rest_pct)
      : '—';
    const rodColor = ind && ind.N >= 3 ? fadeColor(ind.fade_rate_rest) : COLORS.muted;

    rows.push({
      values: [
        i.ticker,
        `${i.todayMove >= 0 ? '+' : ''}${i.todayMove.toFixed(1)}%`,
        fadeCell(b.fade_rate_1d,  b.avg_fwd1d),
        fadeCell(b.fade_rate_5d,  b.avg_fwd5d),
        fadeCell(b.fade_rate_10d, b.avg_fwd10d),
        rodLabel,
        btLabel,
        i.rsi14 != null ? String(i.rsi14) : '—',
        bbLabel,
        String(b.N ?? '—'),
      ],
      styles: [
        { color: COLORS.bodyText, bold: true },
        { color: i.todayMove >= 0 ? COLORS.green : COLORS.red, bold: true, align: 'center' },
        { color: fadeColor(b.fade_rate_1d), align: 'center' },
        { color: fadeColor(b.fade_rate_5d), align: 'center' },
        { color: fadeColor(b.fade_rate_10d), align: 'center' },
        { color: rodColor, bold: true, align: 'center' },
        { color: btColor, bold: true, align: 'center' },
        { color: rsiColor, bold: i.rsi14 >= 75 || i.rsi14 <= 25, align: 'center' },
        { color: bbColor, align: 'center' },
        { color: COLORS.muted, align: 'center' },
      ],
    });
  }

  const imgPath = resolve(__dir, '..', 'memory', 'statistical_edge_scan.png');
  await renderTable({
    title: `STAT EDGE — ${timeStr} ET  (daily analogs + rest-of-day intraday)`,
    columns,
    colWidths,
    rows,
    footer: `RoD = rest-of-day from now | Best TF = horizon with strongest edge | Green=follow, Red=fade`,
    outputPath: imgPath,
  });

  // Delivery handled by run-and-forward-slack.mjs via PNG_PATH below.
  console.log(`PNG_PATH:${imgPath}`);
}

function round(n) { return n != null ? Math.round(n * 100) / 100 : null; }
function fmtPct(n) { return n != null ? (n >= 0 ? '+' : '') + n.toFixed(2) + '%' : 'n/a'; }

main().catch(e => { console.error(e.message); process.exit(1); });
