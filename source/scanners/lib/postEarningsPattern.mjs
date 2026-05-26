/**
 * postEarningsPattern.mjs — Per-ticker post-earnings reaction signature.
 *
 * Built 2026-04-26 to give the brain *behavioral memory* — not just "did it
 * beat" (earningsHistory.mjs) but how the stock actually trades the print:
 *   - Does it gap-up and fade intraday? (e.g. GOOGL: 6/6 last gap-ups faded)
 *   - Does it gap-down and bounce intraday? (mean-reversion print)
 *   - Does it gap-and-go (rare for mega-cap)?
 *   - What does forward 5d look like conditioned on the gap shape?
 *
 * This is the predictive layer — earningsHistory tells you "AAPL beats 8 of 10
 * with +4% surprises". This tells you "but when AAPL gaps up >5% post-print,
 * forward 5d averages -1.4% — fade the rip".
 *
 * Active windows:
 *   - Just printed (reaction-day or +1): predict the path forward using the
 *     ACTUAL gap as the analog filter.
 *   - About to print (T-1 or T-0): show the typical pattern by direction so the
 *     trader knows what to expect for either gap direction.
 *
 * Usage:
 *   import { getReactionHistory, predictForGap, summarizeBidirectional } from './lib/postEarningsPattern.mjs';
 *   const reactions = await getReactionHistory('GOOGL', 12);
 *   const pred      = predictForGap(reactions, +6.5);   // current premarket gap
 *   const summary   = summarizeBidirectional(reactions); // T-1 / T-0 informational
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uw, num } from './uw_api.mjs';
import { chQuery } from './clickhouse.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const MEM = resolve(__dir, '..', '..', 'memory');

// Gap buckets — chosen to match common earnings-reaction sizes. Anything <2% is
// "no real gap" so we don't extract a pattern from it.
function gapBucket(g) {
  if (g >= 8) return 'gap-up-huge';
  if (g >= 4) return 'gap-up-large';
  if (g >= 2) return 'gap-up-mod';
  if (g <= -8) return 'gap-down-huge';
  if (g <= -4) return 'gap-down-large';
  if (g <= -2) return 'gap-down-mod';
  return 'flat';
}

function isGapUp(g) { return g >= 2; }
function isGapDown(g) { return g <= -2; }

/**
 * Pull the last N quarterly earnings reactions for a ticker.
 * Returns array sorted newest-first:
 *   { date, session, gapPct, o2cPct, dayPct, fwd1d, fwd5d, surprisePct }
 *
 * Notes on date arithmetic:
 *   - AMC prints (report_time = postmarket): reaction = next trading day
 *   - BMO prints (report_time = premarket):  reaction = same day (report_date)
 * We resolve "next trading day" by looking up the first bar at-or-after the
 * target date in the ticker's recent ClickHouse history (handles weekends
 * and holidays naturally).
 */
export async function getReactionHistory(ticker, n = 12) {
  let earnings = null;
  try { earnings = await uw.tickerEarnings(ticker, { ttlMs: 3600_000 }); } catch { earnings = null; }
  if (!Array.isArray(earnings) || !earnings.length) return [];

  const quarters = earnings
    .filter(r => r.report_type === 'quarterly' && r.report_date && r.reported_eps != null)
    .sort((a, b) => (b.report_date || '').localeCompare(a.report_date || ''))
    .slice(0, n);

  if (!quarters.length) return [];

  // Pull a generous window of daily bars to cover all reaction dates plus
  // a fwd-5d lookahead from the oldest print.
  const oldestDate = quarters[quarters.length - 1].report_date;
  const startDate = new Date(oldestDate);
  startDate.setUTCDate(startDate.getUTCDate() - 2);
  const startISO = startDate.toISOString().slice(0, 10);

  const sql = `
    SELECT toDate(Timestamp) AS d,
           round(GapPct * 100, 4) AS gap_pct,
           Open, Close, High, Low,
           round(((Close - Open) / Open) * 100, 4) AS o2c_pct,
           round(DayPct * 100, 4) AS day_pct,
           round(Fwd1d * 100, 4) AS fwd1d_pct,
           round(Fwd5d * 100, 4) AS fwd5d_pct
    FROM daily_ohlcv
    WHERE Ticker = '${ticker}' AND toDate(Timestamp) >= '${startISO}'
    ORDER BY Timestamp ASC
  `;
  let bars = null;
  try { bars = await chQuery(sql); } catch { return []; }
  if (!Array.isArray(bars) || !bars.length) return [];

  const dateMap = new Map();
  const orderedDates = [];
  for (const b of bars) {
    const k = String(b.d);
    dateMap.set(k, b);
    orderedDates.push(k);
  }

  const reactions = [];
  for (const q of quarters) {
    const isAMC = (q.report_time || '').toLowerCase().includes('post');
    const isBMO = (q.report_time || '').toLowerCase().includes('pre');
    if (!isAMC && !isBMO) continue;

    let targetISO;
    if (isAMC) {
      const d = new Date(q.report_date);
      d.setUTCDate(d.getUTCDate() + 1);
      targetISO = d.toISOString().slice(0, 10);
    } else {
      targetISO = q.report_date;
    }
    // Walk forward to first trading day at-or-after target (skip weekends/holidays)
    let bar = null;
    for (let i = 0; i < 5; i++) {
      bar = dateMap.get(targetISO);
      if (bar) break;
      const d = new Date(targetISO);
      d.setUTCDate(d.getUTCDate() + 1);
      targetISO = d.toISOString().slice(0, 10);
    }
    if (!bar) continue;

    // Close-in-range: where in the day's range did the print close?
    // 0 = closed at low, 1 = closed at high, 0.5 = mid. Lower 1/3 (<0.33) is
    // weak hands losing the print; upper 1/3 (>0.66) is buyers winning.
    const high = num(bar.High);
    const low = num(bar.Low);
    const close = num(bar.Close);
    const range = high - low;
    const closeInRange = range > 0 ? (close - low) / range : 0.5;

    reactions.push({
      reportDate: q.report_date,
      reactionDate: String(bar.d),
      session: isAMC ? 'AMC' : 'BMO',
      gapPct: num(bar.gap_pct),
      o2cPct: num(bar.o2c_pct),
      dayPct: num(bar.day_pct),
      fwd1dPct: num(bar.fwd1d_pct),
      fwd5dPct: num(bar.fwd5d_pct),
      closeInRange: Math.round(closeInRange * 100) / 100,
      surprisePct: num(q.surprise_percentage),
      reportedEps: num(q.reported_eps),
      estimatedEps: num(q.estimated_eps),
    });
  }
  return reactions;
}

function aggregate(rows, label) {
  if (!rows.length) return null;
  const intradayFades = rows.filter(r => Math.sign(r.o2cPct) !== Math.sign(r.gapPct) && r.gapPct !== 0).length;
  const fwd5dWins = rows.filter(r => r.fwd5dPct > 0).length;
  const fwd5dLosses = rows.filter(r => r.fwd5dPct < 0).length;
  const avg = (key) => rows.reduce((s, r) => s + (Number.isFinite(r[key]) ? r[key] : 0), 0) / rows.length;
  // Close-in-range bucketing — weak (lower 1/3), mid, strong (upper 1/3)
  const closeLower = rows.filter(r => Number.isFinite(r.closeInRange) && r.closeInRange < 0.33).length;
  const closeUpper = rows.filter(r => Number.isFinite(r.closeInRange) && r.closeInRange > 0.66).length;
  const avgCloseInRange = avg('closeInRange');
  let closePosition = 'mid';
  if (avgCloseInRange < 0.33) closePosition = 'lower-third';
  else if (avgCloseInRange > 0.66) closePosition = 'upper-third';
  return {
    label,
    n: rows.length,
    intradayFadeRate: rows.length ? intradayFades / rows.length : 0,
    intradayFadeCount: intradayFades,
    avgGap: Math.round(avg('gapPct') * 10) / 10,
    avgO2c: Math.round(avg('o2cPct') * 10) / 10,
    avgDay: Math.round(avg('dayPct') * 10) / 10,
    avgFwd1d: Math.round(avg('fwd1dPct') * 10) / 10,
    avgFwd5d: Math.round(avg('fwd5dPct') * 10) / 10,
    fwd5dWins,
    fwd5dLosses,
    fwd5dWinRate: rows.length ? fwd5dWins / rows.length : 0,
    avgCloseInRange: Math.round(avgCloseInRange * 100) / 100,
    closeLowerCount: closeLower,
    closeUpperCount: closeUpper,
    closePosition,
    samples: rows.map(r => ({
      date: r.reactionDate,
      gap: r.gapPct,
      o2c: r.o2cPct,
      fwd5d: r.fwd5dPct,
      closeInRange: r.closeInRange,
    })),
  };
}

/**
 * Look up the upcoming/recent print's expected_move_perc from the rolling
 * earnings history (memory/uw_earnings_history.json — populated by
 * earningsHistory.snapshotFromCache). UW strips this from the per-ticker
 * historical endpoint, so this file is the only source.
 *
 * Returns the row for the print closest to today (next upcoming, or last past).
 */
export function getNearestPrintMeta(ticker) {
  const path = resolve(MEM, 'uw_earnings_history.json');
  if (!existsSync(path)) return null;
  let hist;
  try { hist = JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
  if (!hist?.rows) return null;

  const today = new Date().toISOString().slice(0, 10);
  const tickerRows = Object.values(hist.rows).filter(r => r.ticker === ticker);
  if (!tickerRows.length) return null;

  // Prefer upcoming print; else most-recent past
  const upcoming = tickerRows
    .filter(r => r.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (upcoming) {
    return {
      role: 'upcoming',
      date: upcoming.date,
      session: upcoming.session,
      expectedMovePct: upcoming.expected_move_perc != null ? upcoming.expected_move_perc * 100 : null,
      expectedMoveAbs: upcoming.expected_move,
      streetMeanEst: upcoming.street_mean_est,
      preEarningsClose: upcoming.pre_earnings_close,
    };
  }
  const past = tickerRows
    .filter(r => r.date < today)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (past) {
    return {
      role: 'past',
      date: past.date,
      session: past.session,
      expectedMovePct: past.expected_move_perc != null ? past.expected_move_perc * 100 : null,
      expectedMoveAbs: past.expected_move,
      preEarningsClose: past.pre_earnings_close,
      postEarningsClose: past.post_earnings_close,
      reaction: past.reaction,
    };
  }
  return null;
}

/**
 * Compose a trader-style narrative line in the alert format David sketched:
 *   "GOOGL through implied move +6.2% vs +5.4% expected · 6/6 last gap-ups
 *    faded -2.2% off open · closes lower-third · fwd5d -0.0% (3W/3L) · path:
 *    sideways"
 *
 * Returns null when there's no actionable narrative (no gap, no print near).
 */
export function composeNarrative({ ticker, prediction, impliedMoveCheck, mode }) {
  if (!prediction || prediction.signature === 'no-gap' || prediction.signature === 'thin-sample') return null;
  const parts = [];
  if (impliedMoveCheck?.through) {
    const sign = impliedMoveCheck.actualPct >= 0 ? '+' : '';
    const expSign = impliedMoveCheck.expectedPct >= 0 ? '±' : '±';
    parts.push(`through implied move ${sign}${impliedMoveCheck.actualPct.toFixed(1)}% vs ${expSign}${Math.abs(impliedMoveCheck.expectedPct).toFixed(1)}% expected`);
  } else if (impliedMoveCheck?.expectedPct != null) {
    const sign = impliedMoveCheck.actualPct >= 0 ? '+' : '';
    parts.push(`within implied move ${sign}${impliedMoveCheck.actualPct.toFixed(1)}% vs ±${Math.abs(impliedMoveCheck.expectedPct).toFixed(1)}%`);
  }
  // Behavioral pattern
  parts.push(`${prediction.intradayFadeRate}% fade rate (${prediction.n} analogs) avg ${prediction.avgO2c >= 0 ? '+' : ''}${prediction.avgO2c}% off open`);
  // Close position
  if (prediction.closePosition) {
    parts.push(`closes ${prediction.closePosition.replace('-', ' ')}`);
  }
  // Forward path
  const f5 = prediction.avgFwd5d;
  let pathStr;
  if (Math.abs(f5) < 0.5) pathStr = 'sideways';
  else if (f5 < -2) pathStr = 'down meaningfully';
  else if (f5 < -0.5) pathStr = 'sideways to down';
  else if (f5 > 2) pathStr = 'up meaningfully';
  else pathStr = 'sideways to up';
  parts.push(`fwd5d ${f5 >= 0 ? '+' : ''}${f5}% (${prediction.fwd5dWins}W/${prediction.fwd5dLosses}L) — path: ${pathStr}`);

  return `${ticker} ${parts.join(' · ')}`;
}

/**
 * Given the actual current gap, find historical analogs and return the
 * conditional prediction. Bucket by direction first; if the same-bucket
 * sample is ≥3 use it, otherwise fall back to "all gap-ups" or "all gap-downs".
 */
export function predictForGap(reactions, currentGapPct) {
  if (!Array.isArray(reactions) || !reactions.length) return null;
  const g = num(currentGapPct);
  if (!Number.isFinite(g) || Math.abs(g) < 1) {
    return { signature: 'no-gap', direction: 'neutral', confidence: 'low', detail: `Current gap ${g.toFixed(2)}% — no analog needed`, score: 0.1 };
  }

  const bucket = gapBucket(g);
  const sameBucket = reactions.filter(r => gapBucket(r.gapPct) === bucket);
  const sameDirection = reactions.filter(r => isGapUp(g) ? isGapUp(r.gapPct) : isGapDown(r.gapPct));

  // Prefer specific bucket if we have ≥3, else fall back to direction
  const analogs = sameBucket.length >= 3 ? sameBucket : sameDirection;
  if (analogs.length < 2) {
    return {
      signature: 'thin-sample', direction: 'neutral', confidence: 'low',
      detail: `Only ${analogs.length} historical analogs for ${bucket}`,
      bucket, n: analogs.length, score: 0.1,
    };
  }

  const agg = aggregate(analogs, sameBucket.length >= 3 ? bucket : (isGapUp(g) ? 'all-gap-ups' : 'all-gap-downs'));

  // Classify the dominant signature
  let signature;
  if (isGapUp(g)) {
    if (agg.intradayFadeRate >= 0.7 && agg.avgO2c < -0.5) signature = 'gap-up-fader';
    else if (agg.intradayFadeRate <= 0.3 && agg.avgO2c > 0.5) signature = 'gap-up-and-go';
    else signature = 'gap-up-mixed';
  } else {
    if (agg.intradayFadeRate >= 0.7 && agg.avgO2c > 0.5) signature = 'gap-down-bouncer';
    else if (agg.intradayFadeRate <= 0.3 && agg.avgO2c < -0.5) signature = 'gap-down-bleeder';
    else signature = 'gap-down-mixed';
  }

  // Translate signature → direction prediction
  // Brain consumes the FORWARD direction (next 5 days) as the trade signal,
  // because intraday fade alone isn't a swing trade — it's an open-of-day
  // execution edge. Forward drift is what the swing book wants.
  let direction = 'neutral';
  if (agg.avgFwd5d > 1 && agg.fwd5dWinRate >= 0.6) direction = 'bullish';
  else if (agg.avgFwd5d < -1 && agg.fwd5dWinRate <= 0.4) direction = 'bearish';
  else if (agg.avgFwd5d > 0.3) direction = 'leans-bullish';
  else if (agg.avgFwd5d < -0.3) direction = 'leans-bearish';

  // Confidence — sample size + signal magnitude
  let confidence = 'low';
  if (analogs.length >= 5 && (Math.abs(agg.avgFwd5d) >= 2 || Math.abs(agg.intradayFadeRate - 0.5) >= 0.3)) confidence = 'high';
  else if (analogs.length >= 3) confidence = 'medium';

  // Score for the brain — 0-1, weighted by confidence and directional clarity
  let score = 0.2;
  if (confidence === 'high') {
    score = direction.includes('bullish') || direction.includes('bearish') ? 0.85 : 0.5;
  } else if (confidence === 'medium') {
    score = direction === 'bullish' || direction === 'bearish' ? 0.6 : 0.35;
  }
  // Demote leans → not full directional weight
  if (direction.startsWith('leans-')) score *= 0.7;

  // Final status string consumed by ticket vote logic
  const status = direction === 'bullish' || direction === 'leans-bullish' ? 'bullish'
              : direction === 'bearish' || direction === 'leans-bearish' ? 'bearish'
              : 'neutral';

  const detail = `${signature}: ${agg.intradayFadeCount}/${analogs.length} faded intraday avg ${agg.avgO2c >= 0 ? '+' : ''}${agg.avgO2c}% · closes ${agg.closePosition.replace('-', ' ')} · fwd5d avg ${agg.avgFwd5d >= 0 ? '+' : ''}${agg.avgFwd5d}% (${agg.fwd5dWins}W/${agg.fwd5dLosses}L)`;

  return {
    signature, direction, status, confidence, score,
    bucket, currentGap: g,
    n: analogs.length,
    intradayFadeRate: Math.round(agg.intradayFadeRate * 100),
    avgO2c: agg.avgO2c,
    avgFwd5d: agg.avgFwd5d,
    fwd5dWinRate: Math.round(agg.fwd5dWinRate * 100),
    fwd5dWins: agg.fwd5dWins,
    fwd5dLosses: agg.fwd5dLosses,
    avgCloseInRange: agg.avgCloseInRange,
    closePosition: agg.closePosition,
    closeLowerCount: agg.closeLowerCount,
    closeUpperCount: agg.closeUpperCount,
    detail,
    samples: agg.samples,
  };
}

/**
 * Bidirectional summary for the T-0/T-1 case where we don't yet know which way
 * the gap will go. Returns both gap-up and gap-down behavioral profiles so the
 * trader can plan for either path.
 */
export function summarizeBidirectional(reactions) {
  if (!reactions?.length) return null;
  const ups = reactions.filter(r => isGapUp(r.gapPct));
  const downs = reactions.filter(r => isGapDown(r.gapPct));
  const aggUp = ups.length >= 2 ? aggregate(ups, 'gap-ups') : null;
  const aggDown = downs.length >= 2 ? aggregate(downs, 'gap-downs') : null;
  return {
    totalQuarters: reactions.length,
    gapUp: aggUp,
    gapDown: aggDown,
    detail: [
      aggUp ? `gap-ups ${aggUp.n}: ${aggUp.intradayFadeCount}/${aggUp.n} faded · fwd5d ${aggUp.avgFwd5d >= 0 ? '+' : ''}${aggUp.avgFwd5d}%` : null,
      aggDown ? `gap-downs ${aggDown.n}: ${aggDown.intradayFadeCount}/${aggDown.n} reversed · fwd5d ${aggDown.avgFwd5d >= 0 ? '+' : ''}${aggDown.avgFwd5d}%` : null,
    ].filter(Boolean).join(' · '),
  };
}
