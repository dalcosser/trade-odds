/**
 * intradayStats.mjs — Historical follow-through stats given an intraday move.
 *
 * For a ticker that's up/down X% by HH:MM today, query ClickHouse for every
 * historical date where the ticker had a similar intraday move by the same
 * time-of-day, and return forward stats:
 *
 *   bod        — Balance-of-Day: (Close[16:00] - Close[HH:MM]) / Close[HH:MM]
 *   next_open  — Next day's open gap: (Open[D+1 09:30] - Close[D 16:00]) / Close[D 16:00]
 *   next_close — Next day's close: (Close[D+1 16:00] - Close[D 16:00]) / Close[D 16:00]
 *
 * Each stat is { n, pct_pos, avg, med } — sample size + win rate + avg return + median.
 *
 * Cost: $0 (ClickHouse only).
 */

import { chQuery } from './clickhouse.mjs';

function esc(s) { return String(s).replace(/'/g, "''"); }
function sgn(x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }
function round(x, d = 2) { return x == null ? null : Math.round(x * 10 ** d) / 10 ** d; }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function summarize(values) {
  const clean = values.filter(v => v != null && !Number.isNaN(v));
  if (!clean.length) return { n: 0, pct_pos: null, avg: null, med: null };
  const pos = clean.filter(v => v > 0).length;
  const sum = clean.reduce((a, b) => a + b, 0);
  return {
    n: clean.length,
    pct_pos: round((pos / clean.length) * 100, 1),
    avg: round(sum / clean.length, 2),
    med: round(median(clean), 2),
  };
}

/**
 * @param {Object} opts
 * @param {string} opts.ticker
 * @param {number} opts.movePct — today's intraday move % (signed)
 * @param {number} opts.hour — current ET hour (9-15 ideally)
 * @param {number} opts.minute — current ET minute (0-59)
 * @param {number} [opts.years=10] — defaults to "max" (ClickHouse goes back ~5.3y from Jan 2021)
 * @param {number} [opts.tolerance=1.5] — match within ± this much
 * @param {boolean} [opts.threshold=false] — if true, match move >= target (gap-style)
 *
 * Returns { n, bod, next_open, next_close } or null if insufficient data.
 */
export async function getBODStats({
  ticker, movePct, hour, minute, years = 10, tolerance = 1.5, threshold = false,
}) {
  const T = esc(ticker.toUpperCase());
  const daysBack = Math.round(years * 365);
  const dir = sgn(movePct);

  // Step 1: pull minute bars we need per date.
  // We need:
  //   - Close at 9:30 (today's open reference for intraday % calc)
  //   - Close at HH:MM (current time — to check move magnitude + BOD start)
  //   - Close at 15:59 (regular session close — BOD end + reference for next-day)
  // Plus the next session's 9:30 Open and 15:59 Close for next-day stats.
  const h = hour, m = minute;

  const minuteRows = await chQuery(`
    SELECT
      toDate(Timestamp) as d,
      anyIf(Close, toHour(Timestamp) = 9 AND toMinute(Timestamp) = 30) as c_open,
      anyIf(Close, toHour(Timestamp) = ${h} AND toMinute(Timestamp) = ${m}) as c_now,
      anyIf(Close, toHour(Timestamp) = 15 AND toMinute(Timestamp) = 59) as c_close,
      anyIf(Open,  toHour(Timestamp) = 9  AND toMinute(Timestamp) = 30) as o_open
    FROM minute_ohlcv
    WHERE Ticker = '${T}'
      AND toDate(Timestamp) >= today() - ${daysBack}
      AND (
        (toHour(Timestamp) = 9 AND toMinute(Timestamp) = 30)
        OR (toHour(Timestamp) = ${h} AND toMinute(Timestamp) = ${m})
        OR (toHour(Timestamp) = 15 AND toMinute(Timestamp) = 59)
      )
    GROUP BY d
    HAVING c_now > 0 AND c_close > 0 AND o_open > 0
    ORDER BY d ASC
  `, { timeout: 60_000 });

  if (!minuteRows?.length) return null;

  // Step 2: pull prev-session close from minute data (for intraday % calc
  // consistent with today's snapshot — split-adjustment consistent).
  const prevCloseRows = await chQuery(`
    SELECT
      toDate(Timestamp) as d,
      argMax(Close, Timestamp) as c
    FROM minute_ohlcv
    WHERE Ticker = '${T}'
      AND toDate(Timestamp) >= today() - ${daysBack + 10}
      AND toHour(Timestamp) = 15 AND toMinute(Timestamp) >= 55
    GROUP BY d
    ORDER BY d ASC
  `, { timeout: 60_000 });

  const prevCloseMap = new Map();
  for (let i = 1; i < prevCloseRows.length; i++) {
    prevCloseMap.set(prevCloseRows[i].d, prevCloseRows[i - 1].c);
  }

  // Step 3: filter to matching dates + compute BOD per match + collect date list
  const bodValues = [];
  const matchedDates = [];
  const target = Math.abs(movePct);
  for (const r of minuteRows) {
    const prev = prevCloseMap.get(r.d);
    if (!prev || prev <= 0) continue;
    const intradayPct = ((r.c_now - prev) / prev) * 100;
    if (sgn(intradayPct) !== dir) continue;
    const abs = Math.abs(intradayPct);
    if (threshold) {
      if (abs < target) continue;
    } else {
      if (abs < target - tolerance || abs > target + tolerance) continue;
    }
    // BOD return: from c_now to c_close
    const bod = ((r.c_close - r.c_now) / r.c_now) * 100;
    bodValues.push(bod);
    matchedDates.push(r.d);
  }

  if (!matchedDates.length) return { n: 0, bod: summarize([]), next_open: summarize([]), next_close: summarize([]) };

  // Step 4: next-day open + close stats
  // Build a map: today's date → (next_session_open, next_session_close, today's regular close)
  const dateByMin = new Map(minuteRows.map(r => [r.d, r]));
  const allDates = [...dateByMin.keys()].sort();
  const dateIdx = new Map(allDates.map((d, i) => [d, i]));

  const nextOpenValues = [];
  const nextCloseValues = [];
  for (const d of matchedDates) {
    const idx = dateIdx.get(d);
    if (idx == null || idx + 1 >= allDates.length) continue;
    const today = dateByMin.get(d);
    const nextDate = allDates[idx + 1];
    const next = dateByMin.get(nextDate);
    if (!today || !next) continue;
    if (!today.c_close || today.c_close <= 0) continue;

    // Next-day open gap — today's close → next day's 9:30 open
    if (next.o_open > 0) {
      const gap = ((next.o_open - today.c_close) / today.c_close) * 100;
      nextOpenValues.push(gap);
    }
    // Next-day close — today's close → next day's 16:00 close
    if (next.c_close > 0) {
      const cc = ((next.c_close - today.c_close) / today.c_close) * 100;
      nextCloseValues.push(cc);
    }
  }

  return {
    n: matchedDates.length,
    bod: summarize(bodValues),
    next_open: summarize(nextOpenValues),
    next_close: summarize(nextCloseValues),
  };
}
