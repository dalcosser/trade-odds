#!/usr/bin/env node
/**
 * confluence.mjs — Programmatic 14-step Confluence Read for any ticker.
 *
 * The 14 checks (per CLAUDE.md trading playbook + book-rule + UW + behavioral + mosaic):
 *   1. Cohort         — is this name moving with or against its peers?
 *   2. News           — combined Tiingo+Polygon catalyst hunt
 *   3. Stat           — historical analog odds from ClickHouse
 *   4. Flow           — UW unusual options + dark pool
 *   5. Regime         — what's working in the broader tape
 *   6. WhatsWorking   — explicit dislocation flag (lone red in green / vice versa)
 *   7. BookRules      — 14 codified rules from 8 trading books
 *   8. Seasonality    — UW 19-yr monthly history: win rate + avg return for current month
 *   9. EarningsHist   — UW per-ticker earnings: beat rate + post-print drift,
 *                       weighted up when print is within 10 trading days
 *  10. EarningsPattern — Per-ticker post-earnings BEHAVIORAL signature (gap-up-fader,
 *                       gap-down-bouncer, etc). Conditional analog prediction when
 *                       just printed (uses actual gap), bidirectional preview T-0/T-1.
 *                       e.g. "GOOGL: 6/6 last gap-ups faded intraday avg -2.2%."
 *  11. DeskCalls       — sell-side desk picks (BofA CatCal × overlay + Barclays BETS)
 *  12. CatalystProx   — MOSAIC: email_catalysts.json — earnings/events within 21d
 *                       (intensity, neutral-direction; amplifies conviction).
 *  13. StreetConvic   — MOSAIC: ratings_today.json + knowledge.db — multi-desk
 *                       agreement on today's ratings + 30d historical context.
 *  14. GammaMagnetics — MOSAIC: uw.maxPain + uw.gex — distance to call/put walls
 *                       in ATR units + OPEX horizon. Catches gamma squeeze setups.
 *
 * Score each pass (1) / partial (0.5) / fail (0). >=8.5 = TRADE. >=5 = WATCHLIST. <5 = PASS.
 *
 * Output: trade ticket — direction, setup, entry, stop, T1, T2, R:R, invalidation.
 *
 * Usage:
 *   node confluence.mjs NVDA                    # full read, human-readable
 *   node confluence.mjs NVDA --json             # machine output
 *   node confluence.mjs NVDA --hours 12         # news lookback
 *   node confluence.mjs NVDA --emit             # emit to signal bus + journal
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLatestDaily, getDailyBars, chQuery } from './lib/clickhouse.mjs';
import { uw, num, sumField } from './lib/uw_api.mjs';
import { tiingo, classifyHeadlineSentiment, articleFingerprint } from './lib/tiingo_api.mjs';
import { emitSignals, readSignals } from './lib/signals.mjs';
import { applyBookRules } from './lib/bookRules.mjs';
import { getReactionHistory, predictForGap, summarizeBidirectional, getNearestPrintMeta, composeNarrative } from './lib/postEarningsPattern.mjs';
import { checkCatalystProximity, checkStreetConviction, checkGammaMagnetics } from './lib/mosaicChecks.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
// memory/ lives at <repo>/memory/ (sibling of /source/, two levels up from this file)
const MEM = process.env.MEMORY_DIR || resolve(__dir, '..', '..', 'memory');

// ── Cohort definitions (mirror whats_working.mjs) ─────────────────────────
const THEMES = {
  'AI Infra':    ['NVDA', 'AVGO', 'ANET', 'SMCI', 'DELL', 'HPE', 'NBIS', 'CRWV'],
  'Semis':       ['AMD', 'AVGO', 'MRVL', 'TSM', 'AMAT', 'LRCX', 'KLAC', 'ON'],
  'Memory':      ['MU', 'SNDK', 'STX', 'WDC'],
  'Rare Earth':  ['MP', 'CRML', 'USAR', 'UAMY', 'TMC', 'LAC', 'UUUU', 'NB'],
  'Space':       ['ASTS', 'RKLB', 'LUNR', 'PL', 'SATS', 'FLY', 'IRDM'],
  'Banks':       ['JPM', 'BAC', 'C', 'MS', 'GS', 'WFC', 'KRE'],
  'Energy':      ['XOM', 'CVX', 'COP', 'OXY', 'EOG', 'SLB'],
  'Defense':     ['LMT', 'RTX', 'NOC', 'GD', 'BA', 'LHX'],
  'Biotech':     ['XBI', 'IBB', 'GILD', 'MRNA', 'REGN', 'VRTX'],
  'Software':    ['CRM', 'ADBE', 'NOW', 'WDAY', 'SNOW', 'DDOG', 'NET', 'CRWD', 'PANW'],
  'Crypto':      ['COIN', 'MSTR', 'HOOD', 'IREN', 'CIFR', 'WULF', 'HUT'],
  'Mag7':        ['AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NVDA', 'TSLA'],
};

const args = process.argv.slice(2);
function argVal(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const TICKER = (args.find(a => !a.startsWith('--') && /^[A-Z.\-]{1,8}$/i.test(a)) || '').toUpperCase();
const HOURS = parseFloat(argVal('--hours', '48'));
const JSON_OUT = args.includes('--json');
const EMIT = args.includes('--emit');

if (!TICKER) {
  console.error('usage: confluence.mjs TICKER [--hours 48] [--json] [--emit]');
  process.exit(2);
}

function readJSON(p) { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } }

// ── Check 1: Cohort ───────────────────────────────────────────────────────

function findCohorts(ticker) {
  const matches = [];
  for (const [name, members] of Object.entries(THEMES)) {
    if (members.includes(ticker)) matches.push({ name, members });
  }
  return matches;
}

async function checkCohort(ticker, tickerRow) {
  const cohorts = findCohorts(ticker);
  if (cohorts.length === 0) {
    return { score: 0, status: 'no-cohort', detail: 'Ticker not in any tracked cohort', isolated: false, dislocation: false };
  }
  // Use the first matching cohort (most specific theme)
  const cohort = cohorts[0];
  const peers = cohort.members.filter(t => t !== ticker);
  if (peers.length === 0) return { score: 0, status: 'no-peers', detail: 'No peers in cohort' };

  // Pull peer DayPct from ClickHouse latest bars
  const peerList = peers.map(t => `'${t}'`).join(',');
  const rows = await chQuery(`
    SELECT Ticker, DayPct, GapPct, Close
    FROM daily_ohlcv
    WHERE (Ticker, Timestamp) IN (
      SELECT Ticker, max(Timestamp) FROM daily_ohlcv WHERE Ticker IN (${peerList}) GROUP BY Ticker
    )
  `).catch(() => null);
  if (!rows || !rows.length) return { score: 0, status: 'no-data', detail: 'Could not fetch peer data' };

  const tDay = num(tickerRow?.DayPct) || 0;
  const peerDays = rows.map(r => num(r.DayPct) || 0);
  const peerAvg = peerDays.reduce((s, n) => s + n, 0) / peerDays.length;
  const peerGreens = peerDays.filter(p => p > 0.5).length;
  const peerReds = peerDays.filter(p => p < -0.5).length;
  const peerNetDir = peerGreens - peerReds;

  // Dislocation logic: ticker moves opposite cohort majority
  let dislocation = false;
  let dislocationKind = null;
  if (tDay < -1 && peerNetDir >= Math.ceil(peers.length * 0.4)) {
    dislocation = true; dislocationKind = 'lone-red-in-green'; // GOLD: dip-buy candidate
  } else if (tDay > 1 && -peerNetDir >= Math.ceil(peers.length * 0.4)) {
    dislocation = true; dislocationKind = 'lone-green-in-red'; // GOLD: short-strength candidate
  }

  // Score: dislocation = full point. Same direction as cohort = partial. Mixed = 0.
  let score = 0;
  let status;
  if (dislocation) {
    score = 1;
    status = 'DISLOCATION';
  } else if (Math.sign(tDay) === Math.sign(peerAvg) && Math.abs(peerAvg) > 0.5) {
    score = 0.5;
    status = 'with-cohort';
  } else {
    score = 0.25;
    status = 'mixed';
  }

  return {
    score, status, dislocation, dislocationKind,
    cohort: cohort.name,
    tickerDay: tDay,
    peerAvg: Math.round(peerAvg * 100) / 100,
    peerGreens, peerReds, peerCount: peers.length,
    detail: `${cohort.name}: ${ticker} ${tDay.toFixed(1)}% vs peer avg ${peerAvg.toFixed(1)}% (${peerGreens}↑/${peerReds}↓ of ${peers.length})`,
  };
}

// ── Check 2: News ─────────────────────────────────────────────────────────

async function checkNews(ticker) {
  const startDate = new Date(Date.now() - HOURS * 3600 * 1000).toISOString().slice(0, 10);
  const [tArts, pArts] = await Promise.all([
    tiingo.news({ tickers: ticker, limit: 30, sortBy: 'publishedDate', startDate }, { ttlMs: 300_000 }).catch(() => []),
    fetch(`https://api.polygon.io/v2/reference/news?ticker=${ticker}&limit=30&apiKey=${process.env.MASSIVE_API_KEY}`)
      .then(r => r.json()).then(j => (j.results || []).filter(a => Date.now() - new Date(a.published_utc).getTime() < HOURS * 3600 * 1000))
      .catch(() => []),
  ]);

  // Merge by URL fingerprint
  const merged = new Map();
  for (const a of tArts || []) {
    const fp = articleFingerprint(a);
    merged.set(fp, {
      provider: 'tiingo', title: a.title, url: a.url, publishedAt: a.publishedDate,
      sentiment: classifyHeadlineSentiment(a), domain: a.source || (() => { try { return new URL(a.url).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
      sources: ['tiingo'],
    });
  }
  for (const a of pArts || []) {
    const fp = articleFingerprint({ url: a.article_url });
    const insight = (a.insights || []).find(i => (i.ticker || '').toUpperCase() === ticker);
    const sentiment = insight && insight.sentiment ? insight.sentiment : 'neutral';
    if (merged.has(fp)) {
      const existing = merged.get(fp);
      existing.sources.push('polygon');
      if (sentiment !== 'neutral') { existing.sentiment = sentiment; existing.sentimentReason = insight?.sentiment_reasoning; }
    } else {
      merged.set(fp, {
        provider: 'polygon', title: a.title, url: a.article_url, publishedAt: a.published_utc,
        sentiment, sentimentReason: insight?.sentiment_reasoning,
        domain: a.publisher?.name?.toLowerCase() || '',
        sources: ['polygon'],
      });
    }
  }

  const articles = [...merged.values()].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  const bullish = articles.filter(a => a.sentiment === 'bullish' || a.sentiment === 'positive').length;
  const bearish = articles.filter(a => a.sentiment === 'bearish' || a.sentiment === 'negative').length;
  const dual = articles.filter(a => a.sources.length > 1).length;

  let score = 0;
  let dir = 'neutral';
  if (bullish + bearish === 0) { score = 0.1; }
  else {
    const lean = bullish - bearish;
    dir = lean > 0 ? 'bullish' : lean < 0 ? 'bearish' : 'mixed';
    score = Math.min(1, Math.abs(lean) * 0.25 + (dual > 0 ? 0.3 : 0));
  }

  return {
    score, status: dir, articleCount: articles.length,
    bullish, bearish, dual,
    topArticle: articles[0] || null,
    topReason: articles[0]?.sentimentReason || null,
    detail: articles.length ? `${articles.length} articles (${bullish}↑/${bearish}↓), ${dual} cross-confirmed${articles[0] ? ` · top: "${articles[0].title.slice(0, 80)}"` : ''}` : 'No news in window',
  };
}

// ── Check 3: Statistical edge (ClickHouse) ────────────────────────────────

async function checkStat(ticker, row) {
  const gap = num(row?.GapPct);
  const rsi = num(row?.RSI_14);
  const close = num(row?.Close);
  const bbU = num(row?.BB_Upper_20);
  const bbL = num(row?.BB_Lower_20);

  // Find a meaningful trigger
  let trigger = null, sql = null;
  if (Math.abs(gap) >= 3) {
    trigger = `gap-${gap > 0 ? 'up' : 'down'} ${Math.abs(gap).toFixed(1)}%`;
    const op = gap > 0 ? '>=' : '<=';
    const bound = gap > 0 ? gap * 0.7 : gap * 0.7;
    sql = `
      SELECT count() AS n,
             avg(Fwd5d) AS avg_fwd5,
             countIf(Fwd5d > 0) / count() AS win_rate,
             avg(Fwd1d) AS avg_fwd1
      FROM daily_ohlcv
      WHERE Ticker = '${ticker}' AND GapPct ${op} ${bound} AND Fwd5d IS NOT NULL
    `;
  } else if (rsi >= 75) {
    trigger = `RSI14 ${rsi.toFixed(0)} (extreme overbought)`;
    sql = `SELECT count() AS n, avg(Fwd5d) AS avg_fwd5, countIf(Fwd5d > 0) / count() AS win_rate FROM daily_ohlcv WHERE Ticker = '${ticker}' AND RSI_14 >= 75 AND Fwd5d IS NOT NULL`;
  } else if (rsi <= 25) {
    trigger = `RSI14 ${rsi.toFixed(0)} (extreme oversold)`;
    sql = `SELECT count() AS n, avg(Fwd5d) AS avg_fwd5, countIf(Fwd5d > 0) / count() AS win_rate FROM daily_ohlcv WHERE Ticker = '${ticker}' AND RSI_14 <= 25 AND Fwd5d IS NOT NULL`;
  } else if (bbU && close > bbU) {
    trigger = `Close > BB upper (${close.toFixed(2)} > ${bbU.toFixed(2)})`;
    sql = `SELECT count() AS n, avg(Fwd5d) AS avg_fwd5, countIf(Fwd5d > 0) / count() AS win_rate FROM daily_ohlcv WHERE Ticker = '${ticker}' AND Close > BB_Upper_20 AND Fwd5d IS NOT NULL`;
  } else if (bbL && close < bbL) {
    trigger = `Close < BB lower (${close.toFixed(2)} < ${bbL.toFixed(2)})`;
    sql = `SELECT count() AS n, avg(Fwd5d) AS avg_fwd5, countIf(Fwd5d > 0) / count() AS win_rate FROM daily_ohlcv WHERE Ticker = '${ticker}' AND Close < BB_Lower_20 AND Fwd5d IS NOT NULL`;
  }

  if (!trigger) {
    return { score: 0, status: 'no-trigger', detail: 'No statistical trigger in current data' };
  }
  try {
    const rows = await chQuery(sql);
    const r = rows?.[0];
    if (!r || !num(r.n) || num(r.n) < 5) {
      return { score: 0.1, status: 'thin-sample', trigger, detail: `${trigger}: only ${r?.n || 0} historical analogs` };
    }
    const winRate = num(r.win_rate);
    const avgFwd5 = num(r.avg_fwd5);
    const dir = avgFwd5 > 0 ? 'bullish' : 'bearish';
    let score = 0.3;
    if (Math.abs(winRate - 0.5) > 0.15 && Math.abs(avgFwd5) > 0.5) score = 0.8;
    else if (Math.abs(winRate - 0.5) > 0.1) score = 0.5;
    return {
      score, status: dir, trigger,
      n: num(r.n), winRate: Math.round(winRate * 100), avgFwd5: Math.round(avgFwd5 * 100) / 100,
      detail: `${trigger} → n=${num(r.n)}, win=${Math.round(winRate * 100)}%, avgFwd5=${avgFwd5.toFixed(2)}%`,
    };
  } catch (e) {
    return { score: 0, status: 'error', detail: 'ClickHouse query failed: ' + e.message };
  }
}

// ── Check 4: UW flow ──────────────────────────────────────────────────────

async function checkFlow(ticker) {
  const DBG2 = process.env.CONF_DEBUG ? (msg) => process.stderr.write(`[checkFlow] ${msg}\n`) : () => {};
  DBG2(`enter ticker=${ticker}`);
  let alerts = null, dp = null;
  DBG2(`calling uw.flowAlertsTicker (typeof=${typeof uw.flowAlertsTicker})`);
  try {
    alerts = await uw.flowAlertsTicker(ticker, { ttlMs: 300_000 });
    DBG2(`flowAlertsTicker returned: ${Array.isArray(alerts) ? alerts.length + ' rows' : typeof alerts}`);
  } catch (e) {
    DBG2(`flowAlertsTicker THREW: ${e.message}`);
    alerts = [];
  }
  DBG2(`calling uw.darkpool`);
  try {
    dp = await uw.darkpool(ticker, { ttlMs: 300_000 });
    DBG2(`darkpool returned: ${Array.isArray(dp) ? dp.length + ' rows' : typeof dp}`);
  } catch (e) {
    DBG2(`darkpool THREW: ${e.message}`);
    dp = [];
  }

  if (!Array.isArray(alerts) || alerts.length === 0) {
    return { score: 0.1, status: 'no-flow', detail: 'No UW flow alerts in window', alertsCount: 0, callPrem: 0, putPrem: 0 };
  }
  const todayStart = Date.now() - 24 * 3600 * 1000;
  const recent = alerts.filter(a => {
    const ts = new Date(a.created_at || a.executed_at || a.timestamp || 0).getTime();
    return ts > todayStart;
  });
  const callPrem = sumField(recent.filter(a => (a.option_type || '').toUpperCase() === 'CALL'), 'total_premium');
  const putPrem = sumField(recent.filter(a => (a.option_type || '').toUpperCase() === 'PUT'), 'total_premium');

  let score = 0, dir = 'neutral';
  if (callPrem + putPrem > 0) {
    const ratio = callPrem / Math.max(1, putPrem);
    if (ratio >= 3) { score = 1; dir = 'bullish'; }
    else if (ratio >= 1.5) { score = 0.6; dir = 'bullish'; }
    else if (ratio <= 0.33) { score = 1; dir = 'bearish'; }
    else if (ratio <= 0.67) { score = 0.6; dir = 'bearish'; }
    else { score = 0.3; dir = 'mixed'; }
  }

  // Dark pool buy bias bonus
  let dpBuy = 0, dpSell = 0;
  if (Array.isArray(dp)) {
    for (const t of dp.slice(0, 50)) {
      const side = (t.side || '').toUpperCase();
      if (side === 'BUY') dpBuy += num(t.premium) || 0;
      else if (side === 'SELL') dpSell += num(t.premium) || 0;
    }
  }
  return {
    score, status: dir,
    alertsCount: recent.length,
    callPrem: Math.round(callPrem),
    putPrem: Math.round(putPrem),
    callPutRatio: putPrem > 0 ? Math.round((callPrem / putPrem) * 10) / 10 : null,
    dpBuy: Math.round(dpBuy), dpSell: Math.round(dpSell),
    detail: `${recent.length} alerts · call $${(callPrem / 1e6).toFixed(1)}M / put $${(putPrem / 1e6).toFixed(1)}M (${putPrem > 0 ? (callPrem / putPrem).toFixed(1) : '∞'}x) · DP buy $${(dpBuy / 1e6).toFixed(1)}M / sell $${(dpSell / 1e6).toFixed(1)}M`,
  };
}

// ── Check 5 + 6: Regime + What's Working ──────────────────────────────────

function checkRegime(ticker, cohortResult) {
  const ww = readJSON(resolve(MEM, 'whats_working.json'));
  if (!ww) return { score: 0, status: 'no-data', detail: 'whats_working.json not found' };

  const regime = ww.regimeTag || 'UNKNOWN';
  const indices = ww.indices || [];
  const spy = indices.find(i => i.ticker === 'SPY');
  const iwm = indices.find(i => i.ticker === 'IWM');
  const qqq = indices.find(i => i.ticker === 'QQQ');

  const themes = (ww.themesRanked || []).slice();
  const cohortName = cohortResult?.cohort;
  const cohortRank = cohortName ? themes.findIndex(t => t.name === cohortName) : -1;
  const cohortPos = cohortRank >= 0 ? `#${cohortRank + 1} of ${themes.length}` : 'untracked';

  // Score: top-3 cohort = strong tailwind, bottom-3 = headwind
  let score = 0.5; // baseline
  let status = 'neutral';
  if (cohortRank >= 0) {
    if (cohortRank < 3) { score = 0.8; status = 'tailwind'; }
    else if (cohortRank >= themes.length - 3) { score = 0.2; status = 'headwind'; }
  }

  return {
    score, status,
    regime,
    cohortName, cohortPos,
    spy: spy?.chg, iwm: iwm?.chg, qqq: qqq?.chg,
    topThemes: themes.slice(0, 3).map(t => `${t.name} ${t.avg.toFixed(1)}%`),
    bottomThemes: themes.slice(-3).map(t => `${t.name} ${t.avg.toFixed(1)}%`),
    detail: `Regime: ${regime} · cohort ${cohortName || '?'} ${cohortPos} · SPY ${spy?.chg?.toFixed(2) || '?'}% IWM ${iwm?.chg?.toFixed(2) || '?'}% QQQ ${qqq?.chg?.toFixed(2) || '?'}%`,
  };
}

// ── Check 7: Book Rules (Weinstein/Bollinger/MACD/Elder/Holy-Grail/etc) ───
// Codified rules from 8 trading books. Returns fired rules + net direction.
// High-priority rules (Stage 2 breakout, BB squeeze, Holy Grail) carry more
// score weight than low-priority ones (RSI regime context, MA alignment).

function checkBookRules(row, bars = null) {
  const rules = applyBookRules(row, { bars });
  if (!rules.length) {
    return { score: 0, status: 'no-rules', detail: 'No book rules fired', rules: [] };
  }
  let bullW = 0, bearW = 0;
  const fired = [];
  for (const r of rules) {
    const w = (r.priority || 5) / 10; // priority 1-10 → 0.1-1.0 weight
    if (r.signal === 'bullish') bullW += w;
    else if (r.signal === 'bearish') bearW += w;
    fired.push(`${r.rule}(${r.signal})`);
  }
  const net = bullW - bearW;
  const dir = net > 0.3 ? 'bullish' : net < -0.3 ? 'bearish' : 'neutral';
  // Score: cap at 1, scaled by total directional weight
  const score = Math.min(1, Math.abs(net) * 0.5 + (rules.length >= 3 ? 0.2 : 0));
  return {
    score, status: dir,
    rules: rules.slice(0, 5).map(r => ({ rule: r.rule, signal: r.signal, source: r.source, detail: r.detail })),
    bullWeight: Math.round(bullW * 10) / 10,
    bearWeight: Math.round(bearW * 10) / 10,
    detail: `${rules.length} rule(s) fired · ${fired.slice(0, 4).join(', ')}${rules.length > 4 ? '…' : ''} → net ${dir}`,
  };
}

// ── Check 8: Seasonality (UW /api/seasonality/{t}/monthly — 19yr history) ─

async function checkSeasonality(ticker) {
  let rows = null;
  try { rows = await uw.seasonalityMonthly(ticker, { ttlMs: 24 * 3600_000 }); } catch { rows = null; }
  if (!Array.isArray(rows) || !rows.length) {
    return { score: 0, status: 'no-data', detail: 'No UW seasonality data' };
  }
  const month = new Date().getUTCMonth() + 1;
  const cur = rows.find(r => Number(r.month) === month);
  if (!cur) return { score: 0, status: 'no-month', detail: `No row for month ${month}` };
  const winRate = num(cur.positive_months_perc); // 0-1
  const avg = num(cur.avg_change); // decimal e.g. 0.0373 = +3.73%
  const median = num(cur.median_change);
  const years = num(cur.years);
  const avgPct = avg * 100;
  const medPct = median * 100;

  // Score: cap at 0.7 — confirming signal, not primary driver. 19yr base is strong
  // but one calendar month is one slice. Require BOTH win rate edge AND avg-change
  // magnitude to score higher than 0.4.
  let score = 0.1;
  let dir = 'neutral';
  const wrEdge = Math.abs(winRate - 0.5);
  if (wrEdge >= 0.15 && Math.abs(avgPct) >= 1.5) {
    score = 0.7;
    dir = winRate > 0.5 ? 'bullish' : 'bearish';
  } else if (wrEdge >= 0.10 && Math.abs(avgPct) >= 1.0) {
    score = 0.5;
    dir = winRate > 0.5 ? 'bullish' : 'bearish';
  } else if (wrEdge >= 0.08) {
    score = 0.3;
    dir = winRate > 0.5 ? 'bullish' : 'bearish';
  }
  // Sanity: if avg_change and win rate disagree directionally (rare), neutralize
  if ((avgPct > 0) !== (winRate > 0.5)) {
    score = Math.min(score, 0.2);
    dir = 'mixed';
  }
  const monthName = new Date(2000, month - 1, 1).toLocaleString('en-US', { month: 'long' });
  return {
    score, status: dir,
    month, monthName, years,
    winRatePct: Math.round(winRate * 100),
    avgPct: Math.round(avgPct * 100) / 100,
    medianPct: Math.round(medPct * 100) / 100,
    detail: `${monthName}: ${Math.round(winRate * 100)}% win-rate, avg ${avgPct >= 0 ? '+' : ''}${avgPct.toFixed(2)}% over ${years}yr (median ${medPct >= 0 ? '+' : ''}${medPct.toFixed(2)}%)`,
  };
}

// ── Check 9: Earnings history (UW /api/stock/{t}/earnings) ────────────────
// Beat rate from last 8 quarters + average post-print 1d drift (from
// pre/post earnings closes when UW has them). Weighted UP when next print
// is within 10 trading days, DOWN to ~0.1 when no print is on the horizon.

async function checkEarningsHistory(ticker) {
  let rows = null;
  try { rows = await uw.tickerEarnings(ticker, { ttlMs: 3600_000 }); } catch { rows = null; }
  if (!Array.isArray(rows) || !rows.length) {
    return { score: 0, status: 'no-data', detail: 'No UW earnings history' };
  }

  // Quarterly only, sorted newest-first by report_date
  const quarters = rows
    .filter(r => r.report_type === 'quarterly' && r.report_date)
    .sort((a, b) => (b.report_date || '').localeCompare(a.report_date || ''));

  // Next upcoming print
  const todayISO = new Date().toISOString().slice(0, 10);
  const upcoming = quarters
    .filter(r => r.report_date >= todayISO && r.reported_eps == null)
    .sort((a, b) => (a.report_date || '').localeCompare(b.report_date || ''))[0];

  let daysToPrint = null;
  if (upcoming) {
    const ms = new Date(upcoming.report_date).getTime() - Date.now();
    daysToPrint = Math.max(0, Math.round(ms / (24 * 3600_000)));
  }

  // Last reported print (could be very recent)
  const lastReported = quarters.find(r => r.reported_eps != null && r.surprise_percentage != null && r.report_date < todayISO);
  let daysSinceLast = null;
  if (lastReported) {
    const ms = Date.now() - new Date(lastReported.report_date).getTime();
    daysSinceLast = Math.round(ms / (24 * 3600_000));
  }

  // Beat rate: last 8 reported quarters with valid surprise_percentage
  const reported = quarters.filter(r => r.reported_eps != null && r.surprise_percentage != null).slice(0, 8);
  const beats = reported.filter(r => num(r.surprise_percentage) > 0).length;
  const beatRate = reported.length ? beats / reported.length : null;
  const avgSurprise = reported.length
    ? reported.reduce((s, r) => s + (num(r.surprise_percentage) || 0), 0) / reported.length
    : null;

  // Post-print drift: pull pre/post earnings closes from history if available.
  // UW returns these on the per-ticker endpoint when present (older quarters).
  const drifts = [];
  for (const r of reported) {
    const pre = num(r.pre_earnings_close);
    const post = num(r.post_earnings_close);
    if (pre > 0 && post > 0) drifts.push(((post - pre) / pre) * 100);
  }
  const avgDrift = drifts.length ? drifts.reduce((s, n) => s + n, 0) / drifts.length : null;

  // Score logic — strong only when print is on the horizon OR very recent.
  let score = 0.1;
  let dir = 'neutral';
  let weight = 0.3; // baseline (history exists but no near-term catalyst)
  if (daysToPrint != null && daysToPrint <= 10) weight = 1.0;     // imminent print
  else if (daysToPrint != null && daysToPrint <= 21) weight = 0.6; // approaching
  else if (daysSinceLast != null && daysSinceLast <= 5) weight = 0.7; // post-print drift window
  else if (daysSinceLast != null && daysSinceLast <= 20) weight = 0.4; // late drift

  if (beatRate != null) {
    if (beatRate >= 0.75 && (avgDrift == null || avgDrift >= 0)) {
      score = 0.85 * weight; dir = 'bullish';
    } else if (beatRate >= 0.625 && (avgDrift == null || avgDrift >= 0)) {
      score = 0.6 * weight; dir = 'bullish';
    } else if (beatRate <= 0.25 && (avgDrift == null || avgDrift <= 0)) {
      score = 0.85 * weight; dir = 'bearish';
    } else if (beatRate <= 0.375 && (avgDrift == null || avgDrift <= 0)) {
      score = 0.6 * weight; dir = 'bearish';
    } else {
      score = 0.3 * weight; dir = 'mixed';
    }
    // Override: avgDrift directly contradicts beatRate dir → neutralize.
    if (avgDrift != null) {
      if (dir === 'bullish' && avgDrift < -1) { score *= 0.5; dir = 'mixed'; }
      if (dir === 'bearish' && avgDrift > 1) { score *= 0.5; dir = 'mixed'; }
    }
  }

  const beatRatePct = beatRate != null ? Math.round(beatRate * 100) : null;
  const avgSurprisePct = avgSurprise != null ? Math.round(avgSurprise * 10) / 10 : null;
  const avgDriftPct = avgDrift != null ? Math.round(avgDrift * 10) / 10 : null;

  let context;
  if (daysToPrint != null && daysToPrint <= 21) context = `print in ${daysToPrint}d`;
  else if (daysSinceLast != null && daysSinceLast <= 20) context = `last print ${daysSinceLast}d ago`;
  else context = upcoming ? `next print ${daysToPrint}d out` : 'no upcoming print';

  const driftStr = avgDriftPct != null ? ` · drift ${avgDriftPct >= 0 ? '+' : ''}${avgDriftPct}%` : '';
  const surpriseStr = avgSurprisePct != null ? ` · avg surprise ${avgSurprisePct >= 0 ? '+' : ''}${avgSurprisePct}%` : '';

  return {
    score, status: dir,
    daysToPrint, daysSinceLast,
    beatRatePct, avgSurprisePct, avgDriftPct,
    sampleQuarters: reported.length,
    detail: `${context}${reported.length ? ` · beat ${beatRatePct}% of last ${reported.length}q${surpriseStr}${driftStr}` : ' · no history'}`,
  };
}

// ── Check 10: Post-earnings reaction pattern ──────────────────────────────
// Per-ticker BEHAVIORAL signature — does this name fade gap-ups or extend
// them? Conditional analog prediction when just printed (uses actual gap).
// Bidirectional preview when about to print (T-0 / T-1).

async function checkEarningsPattern(ticker, row, earningsHistResult) {
  const reactions = await getReactionHistory(ticker, 12);
  if (!reactions.length) {
    return { score: 0, status: 'no-data', detail: 'No earnings reaction history' };
  }

  const daysToPrint = earningsHistResult?.daysToPrint;
  const daysSinceLast = earningsHistResult?.daysSinceLast;
  const meta = getNearestPrintMeta(ticker);

  // Implied move check (works in both pre- and post-print windows when meta is present)
  // For post-print: actual move = current price vs pre_earnings_close (or today's gap as proxy).
  // For pre-print: just surface the expected_move so the trader knows the gate.
  let impliedMoveCheck = null;
  if (meta && meta.expectedMovePct != null) {
    const expPct = meta.expectedMovePct;
    let actualPct = null;
    let basis = null;
    if (meta.role === 'past' && meta.preEarningsClose && row?.Close) {
      actualPct = ((num(row.Close) - num(meta.preEarningsClose)) / num(meta.preEarningsClose)) * 100;
      basis = 'price-vs-pre-print-close';
    } else if (meta.role === 'past' && meta.reaction != null) {
      actualPct = num(meta.reaction) * 100;
      basis = 'reaction-field';
    } else if (meta.role === 'upcoming') {
      basis = 'pre-print-preview';
    }
    impliedMoveCheck = {
      expectedPct: expPct,
      actualPct,
      basis,
      role: meta.role,
      printDate: meta.date,
      session: meta.session,
      through: actualPct != null ? Math.abs(actualPct) > Math.abs(expPct) : null,
    };
  }

  // Window logic — when does this check actively contribute vs sit idle?
  //   - Just printed (≤1 trading day ago): apply analog filter using the actual gap
  //   - About to print (≤5 days out): show bidirectional preview + implied-move
  //     gate so the trader is prepared. 5d window matches earnings-week briefings.
  const justPrinted = daysSinceLast != null && daysSinceLast <= 1;
  const aboutToPrint = daysToPrint != null && daysToPrint <= 5;

  if (justPrinted) {
    const gap = num(row?.GapPct) * 100;
    const pred = predictForGap(reactions, gap);
    if (!pred) return { score: 0.05, status: 'no-prediction', detail: `${reactions.length}q history but no analog returned` };
    let score = pred.score;
    // Extra weight when the print blew through implied move — that's the
    // "outlier reaction" condition that historically fades hardest.
    if (impliedMoveCheck?.through) score = Math.min(1, score + 0.1);
    const narrative = composeNarrative({ ticker, prediction: pred, impliedMoveCheck, mode: 'just-printed' });
    return {
      score, status: pred.status,
      mode: 'just-printed', signature: pred.signature, confidence: pred.confidence,
      currentGap: pred.currentGap, n: pred.n,
      intradayFadeRate: pred.intradayFadeRate, avgO2c: pred.avgO2c,
      avgFwd5d: pred.avgFwd5d, fwd5dWinRate: pred.fwd5dWinRate,
      closePosition: pred.closePosition, avgCloseInRange: pred.avgCloseInRange,
      impliedMove: impliedMoveCheck,
      narrative,
      detail: narrative || `Just printed (gap ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}%) — ${pred.detail}`,
    };
  }

  if (aboutToPrint) {
    const summary = summarizeBidirectional(reactions);
    const im = impliedMoveCheck?.expectedPct != null ? ` · implied ±${Math.abs(impliedMoveCheck.expectedPct).toFixed(1)}%` : '';
    return {
      score: 0.3, status: 'preview',
      mode: 'about-to-print',
      gapUpProfile: summary?.gapUp || null,
      gapDownProfile: summary?.gapDown || null,
      impliedMove: impliedMoveCheck,
      detail: `Print ${daysToPrint <= 0 ? 'today' : 'tomorrow'}${im} — ${summary?.detail || 'no gap-direction sample'}`,
    };
  }

  // Idle window — informational
  const summary = summarizeBidirectional(reactions);
  return {
    score: 0.1, status: 'idle',
    mode: 'idle',
    impliedMove: impliedMoveCheck,
    detail: summary?.detail
      ? `Pattern: ${summary.detail}`
      : `${reactions.length}q reactions on file (no near-term print)`,
  };
}

function checkWhatsWorking(cohortResult, regimeResult) {
  // This is the explicit dislocation flag — promotes the cohort dislocation
  // to a top-tier signal when paired with the regime context.
  if (cohortResult?.dislocation) {
    const goldKind = cohortResult.dislocationKind;
    return {
      score: 1, status: 'GOLD-DISLOCATION', kind: goldKind,
      detail: `★★ DISLOCATION: ${goldKind} in ${cohortResult.cohort}. Highest-edge setup per playbook.`,
    };
  }
  // Otherwise inherit weight from regime fit
  return {
    score: regimeResult?.score >= 0.5 ? 0.4 : 0.2,
    status: 'no-dislocation',
    detail: 'No cohort dislocation present',
  };
}

// ── Trade ticket builder ──────────────────────────────────────────────────

// Regime → setup affinity: which setups score better in which tape regime.
// Per CLAUDE.md doctrine: risk-on rotational favors small-cap dip-buys + breakouts;
// mega-tech-led favors semis/AI infra breakouts; broad-weakness favors shorts/fades.
const REGIME_SETUP_MULTIPLIER = {
  'RISK-ON ROTATIONAL':   { long: 1.15, short: 0.85, dislocBullish: 1.25 },
  'MEGA-TECH LED':        { long: 1.10, short: 0.90, megacapBoost: 1.15 },
  'BROAD STRENGTH':       { long: 1.10, short: 0.85 },
  'BROAD WEAKNESS':       { long: 0.85, short: 1.15, dislocBearish: 1.20 },
  'MIXED':                { long: 1.0,  short: 1.0 },
  'UNKNOWN':              { long: 1.0,  short: 1.0 },
};

const ACCOUNT_SIZE = parseFloat(process.env.CONFLUENCE_ACCOUNT_SIZE || '50000'); // default $50k account
const RISK_PER_TRADE_PCT = parseFloat(process.env.CONFLUENCE_RISK_PCT || '1.0'); // default 1% risk

function buildTradeTicket(ticker, row, checks) {
  const close = num(row?.Close);
  const atr = num(row?.ATR_14);
  const high20 = num(row?.High_20d);
  const low20 = num(row?.Low_20d);
  const sma50 = num(row?.SMA_50);
  const bbU = num(row?.BB_Upper_20);
  const bbL = num(row?.BB_Lower_20);

  // Determine direction by stacking signals
  let bullVotes = 0, bearVotes = 0;
  const w = (s) => s?.score || 0;
  if (checks.cohort?.dislocationKind === 'lone-red-in-green') bullVotes += 2; // dip-buy gold
  if (checks.cohort?.dislocationKind === 'lone-green-in-red') bearVotes += 2; // short-strength gold
  if (checks.news?.status === 'bullish' || checks.news?.status === 'positive') bullVotes += w(checks.news) * 2;
  if (checks.news?.status === 'bearish' || checks.news?.status === 'negative') bearVotes += w(checks.news) * 2;
  if (checks.stat?.status === 'bullish') bullVotes += w(checks.stat) * 2;
  if (checks.stat?.status === 'bearish') bearVotes += w(checks.stat) * 2;
  if (checks.flow?.status === 'bullish') bullVotes += w(checks.flow) * 2;
  if (checks.flow?.status === 'bearish') bearVotes += w(checks.flow) * 2;
  if (checks.bookRules?.status === 'bullish') bullVotes += w(checks.bookRules) * 1.5;
  if (checks.bookRules?.status === 'bearish') bearVotes += w(checks.bookRules) * 1.5;
  // Seasonality is a confirming signal — light weight (0.8x). 19yr base supports it
  // but one calendar month is one slice of the picture.
  if (checks.seasonality?.status === 'bullish') bullVotes += w(checks.seasonality) * 0.8;
  if (checks.seasonality?.status === 'bearish') bearVotes += w(checks.seasonality) * 0.8;
  // Earnings history — heavy weight (1.5x) when print is imminent because the
  // pattern is the catalyst. Lib already de-weights when no print is on the
  // horizon so this multiplier is applied to an already-conditioned score.
  if (checks.earningsHist?.status === 'bullish') bullVotes += w(checks.earningsHist) * 1.5;
  if (checks.earningsHist?.status === 'bearish') bearVotes += w(checks.earningsHist) * 1.5;
  // Earnings reaction pattern — even heavier (2x) when active because it's the
  // most specific signal: this name's actual behavioral history conditioned on
  // the actual gap. Lib already de-weights when not in active window.
  if (checks.earningsPattern?.status === 'bullish') bullVotes += w(checks.earningsPattern) * 2.0;
  if (checks.earningsPattern?.status === 'bearish') bearVotes += w(checks.earningsPattern) * 2.0;
  // Sell-side desk calls (BofA CatCal × overlay + Barclays BETS) — moderate weight 1.2x.
  // The overlay already cross-checked vs our engine, so a STRONGER verdict is heavily
  // weighted via the underlying signal strength (0.9). Multi-desk agreement gets a
  // bonus inside the check itself.
  if (checks.deskCalls?.status === 'bullish') bullVotes += w(checks.deskCalls) * 1.2;
  if (checks.deskCalls?.status === 'bearish') bearVotes += w(checks.deskCalls) * 1.2;

  // ── MOSAIC checks ─────────────────────────────────────────────────────
  // Catalyst proximity is direction-NEUTRAL — it amplifies whichever direction
  // the rest of the brain settles on. Half the score goes to whichever side is
  // already winning (the "catalyst trade" multiplier).
  if (checks.catalystProximity?.score > 0) {
    const cs = checks.catalystProximity.score;
    if (bullVotes > bearVotes) bullVotes += cs * 1.0;
    else if (bearVotes > bullVotes) bearVotes += cs * 1.0;
    // If totally tied, don't pick a side — catalyst still raises total score
    // but doesn't break the tie.
  }
  // Street conviction — same weight as deskCalls (1.2x). Multi-desk bonus
  // already applied inside the check.
  if (checks.streetConviction?.status === 'bullish') bullVotes += w(checks.streetConviction) * 1.2;
  if (checks.streetConviction?.status === 'bearish') bearVotes += w(checks.streetConviction) * 1.2;
  // Gamma magnetics — directional via the .direction field. Heavy weight (1.6x)
  // because the setup is mechanical, not narrative — call wall/put wall trades
  // close themselves into Friday OPEX.
  if (checks.gammaMagnetics?.direction === 'bullish') bullVotes += w(checks.gammaMagnetics) * 1.6;
  if (checks.gammaMagnetics?.direction === 'bearish') bearVotes += w(checks.gammaMagnetics) * 1.6;

  // Regime conditioning — multiply votes by regime/setup affinity. The same
  // raw score means different things in different regimes; this re-weights
  // the direction call based on whether the tape supports it.
  const regimeTag = checks.regime?.regime || 'UNKNOWN';
  const mult = REGIME_SETUP_MULTIPLIER[regimeTag] || REGIME_SETUP_MULTIPLIER.UNKNOWN;
  bullVotes *= (mult.long || 1);
  bearVotes *= (mult.short || 1);
  if (mult.dislocBullish && checks.cohort?.dislocationKind === 'lone-red-in-green') bullVotes *= mult.dislocBullish;
  if (mult.dislocBearish && checks.cohort?.dislocationKind === 'lone-green-in-red') bearVotes *= mult.dislocBearish;

  const direction = bullVotes > bearVotes + 0.3 ? 'long' : bearVotes > bullVotes + 0.3 ? 'short' : 'pass';

  // Setup classification
  let setup = 'context';
  if (checks.cohort?.dislocation) setup = `dislocation (${checks.cohort.dislocationKind})`;
  else if (Math.abs(num(row?.GapPct)) >= 3) setup = `gap-${num(row?.GapPct) > 0 ? 'up' : 'down'} fade/follow`;
  else if (num(row?.Is_20d_High) === 1) setup = '20-day breakout';
  else if (num(row?.Is_20d_Low) === 1) setup = '20-day breakdown';
  else if (close && bbU && close > bbU) setup = 'BB upper breach';
  else if (close && bbL && close < bbL) setup = 'BB lower breach';
  else if (close && sma50 && Math.abs(close - sma50) / close < 0.015) setup = 'SMA50 pullback';

  // Entry/stop/target — ATR-based per Encyclopedia of Trading Strategies findings
  const a = atr || (close * 0.02);
  let entry, stop, t1, t2, invalidation;
  if (direction === 'long') {
    entry = close;
    stop = Math.max(close - 2 * a, low20 || close - 2 * a);
    t1 = close + 2 * a;
    t2 = close + 4.5 * a; // Encyclopedia: 4.5 ATR target optimal
    invalidation = `close < ${stop.toFixed(2)} (2 ATR or 20-day low)`;
  } else if (direction === 'short') {
    entry = close;
    stop = Math.min(close + 2 * a, high20 || close + 2 * a);
    t1 = close - 2 * a;
    t2 = close - 4.5 * a;
    invalidation = `close > ${stop.toFixed(2)} (2 ATR or 20-day high)`;
  } else {
    return { direction, setup, ticket: 'PASS — insufficient confluence' };
  }
  const risk = Math.abs(entry - stop);
  const reward1 = Math.abs(t1 - entry);
  const reward2 = Math.abs(t2 - entry);

  // Position sizing — 1% account risk per trade (Elder rule). Shares = (account × risk%) / per-share-risk.
  const riskDollars = ACCOUNT_SIZE * (RISK_PER_TRADE_PCT / 100);
  const shares = risk > 0 ? Math.floor(riskDollars / risk) : 0;
  const positionDollars = shares * entry;
  const positionPctOfAccount = ACCOUNT_SIZE > 0 ? (positionDollars / ACCOUNT_SIZE) * 100 : 0;

  return {
    direction, setup,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    t1: Math.round(t1 * 100) / 100,
    t2: Math.round(t2 * 100) / 100,
    rr1: Math.round((reward1 / risk) * 10) / 10,
    rr2: Math.round((reward2 / risk) * 10) / 10,
    riskPct: Math.round((risk / entry) * 1000) / 10,
    atr: Math.round(a * 100) / 100,
    invalidation,
    // Position sizing
    shares, positionDollars: Math.round(positionDollars),
    positionPctOfAccount: Math.round(positionPctOfAccount * 10) / 10,
    riskDollars: Math.round(riskDollars),
    regimeMultiplier: { long: mult.long, short: mult.short },
  };
}

// ── Check 11: Sell-side desk calls (BofA CatCal × our overlay + Barclays BETS) ─
// Reads from signal bus, where:
//   src='bofa-overlay'   → catcal_overlay.mjs (already cross-referenced w/ our engine)
//   src='bofa-catcal'    → raw BofA CatCal ticker calls
//   src='barclays-bets'  → Barclays BETS ticker calls
// Multi-desk agreement = real conviction; lone-desk view = light weight.
function checkDeskCalls(ticker) {
  const t = ticker.toUpperCase();
  // Pull from signal bus (4hr TTL — fresh emits) + memory/desk_calls.json (7d TTL — persistent)
  const busSigs = readSignals(60 * 24 * 7)
    .filter(s => ['bofa-overlay', 'bofa-catcal', 'barclays-bets'].includes(s.src))
    .filter(s => (s.ticker || '').toUpperCase() === t);
  let persisted = [];
  try {
    const store = JSON.parse(readFileSync(resolve(MEM, 'desk_calls.json'), 'utf-8'));
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const today = new Date().toISOString().slice(0, 10);
    persisted = (store.calls || [])
      .filter(c => (c.ts || 0) > cutoff)
      .filter(c => (c.ticker || '').toUpperCase() === t)
      // Drop calls whose catalyst date has already passed — the trade is gone.
      .filter(c => !c.meta?.catalyst_date || c.meta.catalyst_date >= today);
  } catch {}
  // Dedupe by src+dir (each desk emits one current view per ticker — keep latest)
  const byKey = new Map();
  for (const s of [...busSigs, ...persisted]) {
    const k = `${s.src}|${s.dir}`;
    const existing = byKey.get(k);
    if (!existing || (s.ts || 0) > (existing.ts || 0)) byKey.set(k, s);
  }
  const sigs = [...byKey.values()];
  if (!sigs.length) {
    return { score: 0, status: 'no-data', detail: 'No desk calls in 7d window', sources: 0 };
  }
  let bullStr = 0, bearStr = 0;
  const sources = new Set();
  const notes = [];
  for (const s of sigs) {
    sources.add(s.src);
    const w = s.str || 0.5;
    if (s.dir === 'long') bullStr += w;
    else if (s.dir === 'short') bearStr += w;
    const desk = s.src === 'bofa-overlay' ? `BofA✓${s.meta?.verdict || ''}` : s.src === 'bofa-catcal' ? 'BofA' : 'Barclays';
    const cat = s.meta?.catalyst ? ` ${s.meta.catalyst}` : '';
    notes.push(`${desk} ${s.dir}${cat}`);
  }
  // Bonus if multiple desks agree
  const multiDesk = sources.size >= 2;
  let dir = 'mixed', score = 0;
  if (bullStr > bearStr * 1.3) {
    dir = 'bullish';
    score = Math.min(1, bullStr * (multiDesk ? 1.2 : 0.9));
  } else if (bearStr > bullStr * 1.3) {
    dir = 'bearish';
    score = Math.min(1, bearStr * (multiDesk ? 1.2 : 0.9));
  } else if (sigs.length) {
    score = 0.2; dir = 'mixed';
  }
  return {
    score: Math.round(score * 100) / 100,
    status: dir,
    sources: sources.size,
    sigCount: sigs.length,
    detail: `${sigs.length} desk call${sigs.length > 1 ? 's' : ''} from ${sources.size} desk${sources.size > 1 ? 's' : ''}: ${notes.slice(0, 4).join(', ')}`,
    notes: notes.slice(0, 5),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const DBG = process.env.CONF_DEBUG ? (msg) => process.stderr.write(`[conf-dbg] ${msg}\n`) : () => {};
  if (process.env.CONF_DEBUG) {
    process.on('exit', (c) => process.stderr.write(`[conf-dbg] EXIT EVENT code=${c}\n`));
    process.on('beforeExit', (c) => process.stderr.write(`[conf-dbg] BEFORE-EXIT code=${c}\n`));
    process.on('unhandledRejection', (r) => process.stderr.write(`[conf-dbg] UNHANDLED-REJECTION ${r?.stack || r?.message || r}\n`));
    process.on('uncaughtException', (e) => process.stderr.write(`[conf-dbg] UNCAUGHT-EXCEPTION ${e?.stack || e?.message || e}\n`));
    process.on('SIGTERM', () => process.stderr.write(`[conf-dbg] SIGTERM received\n`));
    process.on('SIGINT', () => process.stderr.write(`[conf-dbg] SIGINT received\n`));
  }
  DBG(`main start ticker=${TICKER} JSON_OUT=${JSON_OUT}`);
  const row = await getLatestDaily(TICKER);
  DBG(`getLatestDaily returned ${row ? 'row' : 'null'}`);
  if (!row) {
    if (JSON_OUT) console.log(JSON.stringify({ error: `no ClickHouse data for ${TICKER}` }));
    else console.error(`No data for ${TICKER}`);
    process.exit(1);
  }
  // Pull 50 daily bars for DeMark Setup/Countdown/Waldo rules. Cheap CH read.
  let bars = null;
  try { bars = await getDailyBars(TICKER, 50); } catch {}
  DBG(`getDailyBars done; bars=${bars ? bars.length : 'null'}`);

  const cohort = await checkCohort(TICKER, row);
  DBG(`cohort done score=${cohort.score}`);
  const regime = checkRegime(TICKER, cohort);
  DBG(`regime done score=${regime.score}`);
  DBG(`about to run checkNews`);
  const news = await checkNews(TICKER).catch(e => { DBG(`checkNews THREW: ${e.message}`); return { score: 0, status: 'error', detail: e.message }; });
  DBG(`checkNews done`);
  const stat = await checkStat(TICKER, row).catch(e => { DBG(`checkStat THREW: ${e.message}`); return { score: 0, status: 'error', detail: e.message }; });
  DBG(`checkStat done`);
  const flow = await checkFlow(TICKER).catch(e => { DBG(`checkFlow THREW: ${e.message}`); return { score: 0, status: 'error', detail: e.message }; });
  DBG(`checkFlow done`);
  const seasonality = await checkSeasonality(TICKER).catch(e => { DBG(`checkSeasonality THREW: ${e.message}`); return { score: 0, status: 'error', detail: e.message }; });
  DBG(`checkSeasonality done`);
  const earningsHist = await checkEarningsHistory(TICKER).catch(e => { DBG(`checkEarningsHistory THREW: ${e.message}`); return { score: 0, status: 'error', detail: e.message }; });
  DBG(`earningsHist done`);
  const whatsWorking = checkWhatsWorking(cohort, regime);
  DBG(`whatsWorking done`);
  const bookRules = checkBookRules(row, bars);
  DBG(`bookRules done`);
  // Check 10 needs Check 9's daysToPrint/daysSinceLast for active-window logic
  const earningsPattern = await checkEarningsPattern(TICKER, row, earningsHist);
  DBG(`earningsPattern done`);
  // Check 11: sell-side desk calls (zero-LLM, just signal-bus aggregation)
  const deskCalls = checkDeskCalls(TICKER);
  DBG(`deskCalls done`);
  // Mosaic checks (12-14): catalyst proximity, street conviction, gamma magnetics.
  // catalystProximity + streetConviction are local file reads (sync), gamma hits UW (async).
  const catalystProximity = checkCatalystProximity(TICKER);
  DBG(`catalystProximity done`);
  const streetConviction = checkStreetConviction(TICKER);
  DBG(`streetConviction done`);
  const gammaMagnetics = await checkGammaMagnetics(TICKER, row).catch(() => ({ score: 0, status: 'error', direction: 'neutral', detail: 'gamma fetch failed' }));
  DBG(`gammaMagnetics done`);

  const checks = { cohort, news, stat, flow, regime, whatsWorking, bookRules, seasonality, earningsHist, earningsPattern, deskCalls, catalystProximity, streetConviction, gammaMagnetics };
  const totalScore = cohort.score + news.score + stat.score + flow.score + regime.score
                   + whatsWorking.score + bookRules.score + seasonality.score
                   + earningsHist.score + earningsPattern.score + deskCalls.score
                   + catalystProximity.score + streetConviction.score + gammaMagnetics.score;
  // Tier thresholds scale to /14: TRADE >= 8.5, WATCHLIST >= 5.0
  const tier = totalScore >= 8.5 ? 'TRADE' : totalScore >= 5.0 ? 'WATCHLIST' : 'PASS';

  const ticket = buildTradeTicket(TICKER, row, checks);

  const out = {
    ticker: TICKER,
    ts: new Date().toISOString(),
    price: num(row.Close),
    dayPct: num(row.DayPct),
    rsi14: num(row.RSI_14),
    atr14: num(row.ATR_14),
    score: Math.round(totalScore * 10) / 10,
    tier,
    direction: ticket.direction,
    setup: ticket.setup,
    ticket,
    checks,
  };

  if (EMIT && tier !== 'PASS') {
    emitSignals('confluence', [{
      ticker: TICKER,
      dir: ticket.direction === 'long' ? 'bullish' : ticket.direction === 'short' ? 'bearish' : 'neutral',
      str: Math.min(1, totalScore / 10),
      meta: { tier, setup: ticket.setup, score: out.score, entry: ticket.entry, stop: ticket.stop, t1: ticket.t1, t2: ticket.t2 },
    }]);
  }

  DBG(`built out object, JSON_OUT=${JSON_OUT}, about to emit`);
  if (JSON_OUT) {
    const json = JSON.stringify(out, null, 2);
    DBG(`JSON serialized, length=${json.length}`);
    process.stdout.write(json + '\n');
    DBG(`stdout.write returned`);
    return;
  }

  // Human-readable trade ticket
  console.log(`\n═══ CONFLUENCE READ — ${TICKER} ═══`);
  console.log(`Price ${num(row.Close).toFixed(2)} (${num(row.DayPct).toFixed(2)}%)  RSI14 ${num(row.RSI_14).toFixed(0)}  ATR ${num(row.ATR_14).toFixed(2)}`);
  console.log(`Score ${out.score}/14  ·  ${tier}  ·  ${ticket.direction.toUpperCase()}  ·  setup: ${ticket.setup}\n`);

  const fmt = (label, c) => {
    const sym = c.score >= 0.7 ? '✓' : c.score >= 0.4 ? '·' : '✗';
    console.log(`  [${sym}] ${label.padEnd(18)} ${c.score.toFixed(2)}  ${c.detail || c.status}`);
  };
  fmt('1. Cohort',           checks.cohort);
  fmt('2. News',             checks.news);
  fmt('3. Stat',             checks.stat);
  fmt('4. Flow',             checks.flow);
  fmt('5. Regime',           checks.regime);
  fmt('6. Whats-Working',    checks.whatsWorking);
  fmt('7. Book Rules',       checks.bookRules);
  fmt('8. Seasonality',      checks.seasonality);
  fmt('9. Earnings Hist',    checks.earningsHist);
  fmt('10. EarningsPattern', checks.earningsPattern);
  fmt('11. Desk Calls',      checks.deskCalls);
  fmt('12. CatalystProx',    checks.catalystProximity);
  fmt('13. StreetConvic',    checks.streetConviction);
  fmt('14. GammaMagnetics',  checks.gammaMagnetics);
  if (checks.earningsPattern?.narrative) {
    console.log(`\n  ★ Reaction: ${checks.earningsPattern.narrative}`);
  }

  if (checks.news.topReason) console.log(`\n  News-why: ${checks.news.topReason.slice(0, 200)}`);

  if (checks.bookRules?.rules?.length) {
    console.log('\n  Book rules fired:');
    for (const r of checks.bookRules.rules) {
      console.log(`    [${r.signal}] ${r.rule} (${r.source}): ${r.detail || ''}`);
    }
  }

  console.log(`\n--- TRADE TICKET ---`);
  if (ticket.direction === 'pass') {
    console.log(`  PASS — score ${out.score}/10 below threshold`);
  } else {
    console.log(`  ${ticket.direction.toUpperCase()}  setup: ${ticket.setup}`);
    console.log(`  entry ${ticket.entry}  stop ${ticket.stop} (-${ticket.riskPct}%)  T1 ${ticket.t1} (${ticket.rr1}R)  T2 ${ticket.t2} (${ticket.rr2}R)`);
    console.log(`  size: ${ticket.shares} shares = $${ticket.positionDollars.toLocaleString()} (${ticket.positionPctOfAccount}% of acct)  risk $${ticket.riskDollars}`);
    console.log(`  invalidation: ${ticket.invalidation}`);
  }
  console.log('');
}

main().catch(e => { console.error('Fatal:', e.message || e); process.exit(1); });
