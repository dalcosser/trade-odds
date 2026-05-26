// tile_dashboard.mjs — Tile-based signal board. Tabs: Desk / Equities / Options.
// Read-only. Polls memory artifacts + signal bus. Auto-refresh every 30s.
//
// Cross-platform — works on macOS, Linux, and Windows.
//
// HOW TO RUN
//   macOS / Linux:  ./run.sh                     (or:  node scripts/tile_dashboard.mjs)
//   Windows:        double-click run.bat         (or:  node scripts\tile_dashboard.mjs)
//
// The script auto-loads `.env` from the repo root if env vars aren't already set,
// so it works the same regardless of how it was launched (launchd, .bat, shell).
//
// Access:
//   localhost:      http://localhost:7071
//   LAN:            http://<host-IP>:7071        (binds 0.0.0.0)
//   Tailscale:      http://<tailnet-name>:7071   (e.g. http://davids-mac-mini:7071)

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- portable .env loader (works on Windows + Unix) ----------
// Loads KEY=VALUE pairs from <repo>/.env into process.env if not already set.
// Handles quoted values and KEY= VALUE typos defensively.
// Runs BEFORE any module that needs API keys is imported.
function loadDotEnv(envPath) {
  try {
    if (!existsSync(envPath)) return;
    const txt = readFileSync(envPath, 'utf8');
    for (const rawLine of txt.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] == null) process.env[key] = val;
    }
  } catch (e) { console.error('[tile-dashboard] .env load skipped:', e.message); }
}

const __dirEarly = dirname(fileURLToPath(import.meta.url));
loadDotEnv(resolve(__dirEarly, '..', '.env'));

const { polygonUrl } = await import('./lib/massive.mjs');

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');
const MEMORY = join(ROOT, 'memory');
const PORT = parseInt(process.env.PORT || '7071', 10);

// ---------- helpers ----------
async function readJSON(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

async function fileStat(path) {
  try { const s = await stat(path); return { exists: true, mtime: s.mtimeMs, size: s.size }; }
  catch { return { exists: false, mtime: null, size: 0 }; }
}

function marketPhase(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short' }).formatToParts(now);
  const parts = Object.fromEntries(fmt.map((p) => [p.type, p.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return 'CLOSED';
  const mins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  if (mins < 240) return 'CLOSED';
  if (mins < 570) return 'PRE-MARKET';
  if (mins < 960) return 'OPEN';
  if (mins < 1200) return 'POST-MARKET';
  return 'CLOSED';
}

// ---------- signal bus grouping ----------
async function loadSignalsBySrc() {
  const d = await readJSON(join(MEMORY, 'signals.json'), { signals: [] });
  const out = {};
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const s of (d.signals || [])) {
    if (!s || !s.src) continue;
    if (Number(s.ts) < cutoff) continue;
    (out[s.src] = out[s.src] || []).push(s);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => b.ts - a.ts);
  return out;
}

// ---------- per-artifact loaders ----------
async function loadIdeaBoard() {
  const d = await readJSON(join(MEMORY, 'idea_board.json'));
  if (!d) return null;
  const slim = (arr) => (arr || []).map((i) => ({
    ticker: i.ticker, score: i.score, tier: i.tier, direction: i.direction,
    setup: i.setup, price: i.price, dayPct: i.dayPct,
    ticket: i.ticket ? { entry: i.ticket.entry, stop: i.ticket.stop, t1: i.ticket.t1, rr1: i.ticket.rr1 } : null,
  }));
  return {
    ts: d.ts || null,
    candidatesRun: d.candidatesRun || 0,
    validResults: d.validResults || 0,
    topLongs: slim(d.topLongs), topShorts: slim(d.topShorts), dislocations: slim(d.dislocations),
  };
}

async function loadWhatsWorking() {
  const d = await readJSON(join(MEMORY, 'whats_working.json'));
  if (!d) return null;
  const indices = (d.indices || []).map((x) => ({ ticker: x.ticker, chg: x.chg }))
    .sort((a, b) => (b.chg || 0) - (a.chg || 0));
  const sectors = (d.sectors || []).map((x) => ({ ticker: x.ticker, chg: x.chg }))
    .sort((a, b) => (b.chg || 0) - (a.chg || 0));
  const mag7 = (d.mag7 || []).map((x) => ({ ticker: x.ticker, chg: x.chg }))
    .sort((a, b) => (b.chg || 0) - (a.chg || 0));
  const themes = (d.themesRanked || []).slice(0, 6).map((t) => ({
    name: t.name, avg: t.avg, greens: t.greens, total: t.total,
    best: t.best ? { ticker: t.best.ticker, chg: t.best.chg } : null,
  }));
  return { updatedAt: d.updatedAt, regimeTag: d.regimeTag, indices, sectors, mag7, themes };
}

async function loadDayNarrative() {
  const d = await readJSON(join(MEMORY, 'day_narrative.json'));
  if (!d) return null;
  return { updatedAt: d.updatedAt || d.ts || null, headline: d.headline || d.theme || null, summary: d.summary || d.narrative || null, bullets: d.bullets || [] };
}

async function loadGammaPin() {
  const state = await readJSON(join(MEMORY, 'gamma_pin_daemon_state.json'));
  const status = await readJSON(join(MEMORY, 'gamma_pin_status.json'));
  if (!state && !status) return null;
  return {
    state: state || null,
    status: status || null,
    updatedAt: status?.updatedAt || state?.updatedAt || null,
  };
}

async function loadUWMarketRegime() {
  const d = await readJSON(join(MEMORY, 'uw_market_regime.json'));
  if (!d) return null;
  return d;
}

async function loadSetupScans() {
  const d = await readJSON(join(MEMORY, 'setup_scans.json'));
  if (!d) return null;
  return d;
}

async function loadRatingsToday() {
  const d = await readJSON(join(MEMORY, 'ratings_today.json'));
  if (!d) return null;
  return d;
}

async function loadEmailCatalysts() {
  const d = await readJSON(join(MEMORY, 'email_catalysts.json'));
  if (!d) return null;
  return d;
}

async function loadPositions() {
  const d = await readJSON(join(MEMORY, 'positions.json'), { positions: [] });
  return { updatedAt: d.updatedAt || null, positions: d.positions || [] };
}

async function loadPngTile(filename) {
  const s = await fileStat(join(MEMORY, filename));
  return { file: filename, exists: s.exists, mtime: s.mtime };
}

async function loadPremarketFades() {
  const d = await readJSON(join(MEMORY, 'premarket_fades.json'));
  if (!d) return null;
  const ideas = (d.ideas || []).map((i) => ({
    ticker: i.ticker, gapPct: i.gapPct, price: i.price, trade: i.trade,
    bestTF: i.bestTF, bestProb: i.bestProb,
    bestAvg: i.stats?.[i.bestTF]?.avgReturn ?? null,
    bestN: i.stats?.[i.bestTF]?.n ?? null,
  }));
  return { updatedAt: d.updatedAt, ideas };
}

async function loadPremarketGappers() {
  for (const fname of ['premarket_gaps.json', 'massive_premarket_gaps.json']) {
    const d = await readJSON(join(MEMORY, fname));
    if (d) return { source: fname, data: d };
  }
  const pngStat = await fileStat(join(MEMORY, 'premarket_gaps.png'));
  if (pngStat.exists) return { source: 'png', png: { file: 'premarket_gaps.png', mtime: pngStat.mtime, exists: true } };
  return null;
}

async function loadMeanReversion() {
  return await readJSON(join(MEMORY, 'mean_reversion_scan.json'));
}

async function loadRsScan() {
  return await readJSON(join(MEMORY, 'rs_scan.json'));
}

async function loadStatEdgeScan() {
  return await readJSON(join(MEMORY, 'statistical_edge_scan.json'));
}

async function loadUwRollup() {
  return await readJSON(join(MEMORY, 'uw_flow_rollup.json'));
}

async function loadPremarketEdge() {
  // premarket_edge_scanner stdout-dumps JSON; we look for an explicit json file
  // (fallback to PNG meta if not present)
  const j = await readJSON(join(MEMORY, 'premarket_edge_scan.json'));
  if (j) return { source: 'json', data: j };
  return null;
}

async function fetchLivePrices(tickers) {
  const skip = new Set(['SBIGW']);
  const clean = (tickers || []).filter((t) => t && !skip.has(t));
  if (!clean.length) return {};
  try {
    const url = polygonUrl('/v2/snapshot/locale/us/markets/stocks/tickers', { tickers: clean.join(',') });
    const res = await fetch(url);
    if (!res.ok) throw new Error('polygon ' + res.status);
    const data = await res.json();
    const out = {};
    for (const t of data.tickers || []) {
      const last = t.lastTrade?.p || t.day?.c || t.prevDay?.c || null;
      out[t.ticker] = { last, dayChangePct: t.todaysChangePerc ?? null };
    }
    return out;
  } catch { return {}; }
}

// ---------- state assembly ----------
async function handleState() {
  const [
    bySrc, ideaBoard, whatsWorking, narrative, gammaPin, uwRegime,
    setupScans, ratings, catalysts, posData, premarketFades, premarketGappers,
    meanRev, rsScan, statEdgeScan, uwRollup, premarketEdge,
    pngMeanRev, pngStatEdge, pngRsScan, pngUwRollup, pngPremarketEdge,
  ] = await Promise.all([
    loadSignalsBySrc(), loadIdeaBoard(), loadWhatsWorking(), loadDayNarrative(),
    loadGammaPin(), loadUWMarketRegime(), loadSetupScans(), loadRatingsToday(),
    loadEmailCatalysts(), loadPositions(), loadPremarketFades(), loadPremarketGappers(),
    loadMeanReversion(), loadRsScan(), loadStatEdgeScan(), loadUwRollup(), loadPremarketEdge(),
    loadPngTile('mean_reversion_scan.png'),
    loadPngTile('statistical_edge_scan.png'),
    loadPngTile('rs_scan.png'),
    loadPngTile('card_uw_flow_rollup.png'),
    loadPngTile('premarket_edge_scan.png'),
  ]);

  const tickers = posData.positions.map((p) => p.symbol);
  const prices = await fetchLivePrices(tickers);
  const positions = posData.positions.map((p) => {
    const live = prices[p.symbol];
    const last = live?.last ?? p.mark;
    const qty = Number(p.qty);
    const cost = qty * Number(p.costBasis);
    const mv = qty * last;
    const unreal = mv - cost;
    const dayPct = live?.dayChangePct ?? null;
    return {
      symbol: p.symbol, qty, last, cost,
      unreal, unrealPct: cost ? (unreal / cost) * 100 : 0,
      dayPct, dayPnl: dayPct != null ? (mv * dayPct) / 100 : null,
      stale: live?.last == null,
    };
  }).sort((a, b) => (b.unreal || 0) - (a.unreal || 0));

  const acct = {
    mv: positions.reduce((a, p) => a + (p.qty * p.last || 0), 0),
    unreal: positions.reduce((a, p) => a + (p.unreal || 0), 0),
    dayPnl: positions.reduce((a, p) => a + (p.dayPnl || 0), 0),
  };

  return {
    now: Date.now(),
    phase: marketPhase(),
    bySrc, ideaBoard, whatsWorking, narrative, gammaPin, uwRegime,
    setupScans, ratings, catalysts, premarketFades, premarketGappers,
    meanRev, rsScan, statEdgeScan, uwRollup, premarketEdge,
    positions, positionsUpdatedAt: posData.updatedAt, account: acct,
    pngTiles: {
      meanRev: pngMeanRev, statEdge: pngStatEdge,
      rsScan: pngRsScan, uwRollup: pngUwRollup,
      premarketEdge: pngPremarketEdge,
    },
  };
}

// ---------- per-ticker scan endpoint ----------
// Try cached idea_board.json first (instant + has the full 14-check engine output).
// If ticker isn't in today's idea board, spawn confluence.mjs --json with a timeout.
async function loadConfluenceFromIdeaBoard(ticker) {
  const d = await readJSON(join(MEMORY, 'idea_board.json'));
  if (!d) return null;
  const all = [...(d.topLongs || []), ...(d.topShorts || []), ...(d.dislocations || [])];
  const match = all.find(i => i.ticker === ticker);
  if (!match) return null;
  return {
    ticker: match.ticker,
    ts: d.ts,
    price: match.price,
    dayPct: match.dayPct,
    rsi14: match.rsi14,
    score: match.score,
    tier: match.tier,
    direction: match.direction,
    setup: match.setup,
    ticket: match.ticket,
    checks: match.checks,
    source: 'idea_board.json',
  };
}

async function runConfluenceScan(ticker) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    // UW_FAST_FAIL=1 collapses the 5-attempt 429-retry chain (~46s each) into
    // a single attempt. Per-ticker scans need to be responsive; partial data
    // (some UW checks empty due to 429) is better than a 5-minute spinner.
    const child = spawn(process.execPath, [join(__dir, 'confluence.mjs'), ticker, '--json'], {
      cwd: ROOT,
      env: { ...process.env, UW_FAST_FAIL: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    // 14-check engine. UW endpoints sometimes 429 and burn 30-60s per call
    // through the retry-with-backoff chain. Give it 3 minutes max.
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ error: 'confluence.mjs timed out after 180s', ticker, source: 'spawn-timeout' });
    }, 180000);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (!stdout.trim()) {
        return resolve({ error: 'confluence.mjs produced no output (exit ' + code + ')' + (stderr ? ' · stderr: ' + stderr.slice(0, 240) : ''), ticker, source: 'spawn-empty' });
      }
      try {
        const data = JSON.parse(stdout);
        data.source = 'confluence.mjs --json';
        data.ts = Date.now();
        resolve(data);
      } catch (e) {
        resolve({ error: 'invalid JSON from confluence.mjs: ' + e.message, ticker, source: 'spawn-parse' });
      }
    });
    child.on('error', (e) => {
      clearTimeout(timeout);
      resolve({ error: 'spawn failed: ' + e.message, ticker, source: 'spawn-error' });
    });
  });
}

async function handleTickerScan(ticker) {
  const t = String(ticker || '').toUpperCase();
  if (!/^[A-Z.\-]{1,8}$/.test(t)) return { error: 'invalid ticker', ticker };
  // 1. Try idea_board.json (instant)
  const fromBoard = await loadConfluenceFromIdeaBoard(t);
  if (fromBoard) return fromBoard;
  // 2. Spawn confluence.mjs --json
  return await runConfluenceScan(t);
}

// ---------- analog / historical-pattern endpoint ----------
// TradeOdds-style: take today's snapshot for any ticker, find similar historical
// days, return forward distribution + matching-day list. Pure ClickHouse, no LLM.

// Conditions catalog. TradeOdds (TO) flag attributes each one to their spec;
// "ours" flag marks conditions we added beyond their list. group=market is
// date-wide (looks up SPY/VIX at the historical date); group=asset is per-ticker;
// group=external means it needs data outside daily_ohlcv (stubbed for now).
const ANALOG_CONDITIONS = {
  // ── Date-wide / market context ──────────────────────────────
  marketRegime: { label: 'Market Regime',       group: 'market',   to: true,  default: false, desc: 'SPY Close vs SMA200 + slope' },
  vixLevel:     { label: 'VIX Level',           group: 'market',   to: true,  default: false, disabled: true, desc: 'low <15 / normal / high >20 — need to load VIX ticker into warehouse (currently only VXX)' },
  vixMove:      { label: 'VIX Move',            group: 'market',   to: true,  default: false, disabled: true, desc: 'VIX rising / flat / falling — need VIX ticker' },
  month:        { label: 'Month of Year',       group: 'market',   to: true,  default: false, desc: 'seasonality — same calendar month' },
  // ── Per-ticker / asset-specific ─────────────────────────────
  pctChange:    { label: '% Change',            group: 'asset',    to: true,  default: false, desc: 'daily % bucket (vs Move Intensity uses ATR)' },
  move:         { label: 'Move Intensity',      group: 'asset',    to: true,  default: true,  desc: 'today’s % range in ATR multiples' },
  relVol:       { label: 'Relative Volume',     group: 'asset',    to: true,  default: false, desc: 'volume vs 20d avg bucket' },
  rsiZone:      { label: 'RSI Zone',            group: 'asset',    to: true,  default: true,  desc: 'RSI14 ±5 of today' },
  rsiSlope:     { label: 'RSI Slope',           group: 'asset',    to: true,  default: false, desc: 'rising / flat / falling (slower)' },
  trend:        { label: 'Trend Structure',     group: 'asset',    to: true,  default: true,  desc: 'EMA8 vs EMA21 (TradeOdds: EMA9 vs 21)' },
  gap:          { label: 'Overnight Gap',       group: 'asset',    to: true,  default: false, desc: 'gap-up / gap-down / flat (ATR-normalised)' },
  priceStreak:  { label: 'Price Streak',        group: 'asset',    to: true,  default: false, desc: '3+ consecutive up/down days' },
  volStreak:    { label: 'Volume Streak',       group: 'asset',    to: true,  default: false, desc: '3+ days above/below avg volume' },
  // ── External-data conditions (sourced from our own warehouse, not TradeOdds Pro) ──
  analystTrend: { label: 'Analyst Trend',        group: 'external', to: true, default: false, desc: 'net analyst sentiment in last 30 days — from knowledge.db analyst_calls' },
  earningsPerf: { label: 'Earnings Performance', group: 'external', to: true, default: false, desc: 'last earnings: beat/miss + day-after reaction — from uw_earnings_history.json' },
  earningsProx: { label: 'Earnings Proximity',   group: 'external', to: true, default: false, desc: 'days-to-next-earnings bucket — from uw_calendars.json + history' },
  // ── Bonus (ours, not TradeOdds — kept because it’s useful) ─
  stage:        { label: 'Weinstein Stage',     group: 'bonus',    to: false, default: true,  desc: 'Close vs SMA200 + slope (Stan Weinstein 1/2/3/4) — our addition, not in TradeOdds' },
};

function bucketMove(dayPct, atrPctOfPrice) {
  if (atrPctOfPrice == null || atrPctOfPrice === 0) return 'flat';
  const atrUnits = dayPct / atrPctOfPrice;
  if (atrUnits >= 2)    return 'strong-up';
  if (atrUnits >= 0.75) return 'up';
  if (atrUnits >= 0.25) return 'small-up';
  if (atrUnits > -0.25) return 'flat';
  if (atrUnits > -0.75) return 'small-down';
  if (atrUnits > -2)    return 'down';
  return 'strong-down';
}
function bucketRsi(r) {
  if (r == null) return 'na';
  if (r < 30) return 'oversold';
  if (r < 40) return '30-40';
  if (r < 55) return '40-55';
  if (r < 70) return '55-70';
  if (r < 80) return '70-80';
  return 'overbought';
}
function bucketSlope(prev, curr) {
  if (prev == null || curr == null) return 'flat';
  const d = curr - prev;
  if (d > 1.5) return 'rising';
  if (d < -1.5) return 'falling';
  return 'flat';
}
function bucketTrend(sma50slope) {
  if (sma50slope == null) return 'flat';
  if (sma50slope > 0.0005) return 'uptrend';
  if (sma50slope < -0.0005) return 'downtrend';
  return 'flat';
}
function bucketStage(close, sma200, sma200slope) {
  if (close == null || sma200 == null) return 'na';
  const above = close > sma200;
  const rising = (sma200slope || 0) > 0;
  if (above && rising) return 'stage-2';   // markup
  if (above && !rising) return 'stage-3';  // distribution
  if (!above && !rising) return 'stage-4'; // decline
  return 'stage-1';                         // basing
}
function bucketVol(volRank) {
  // VolRank_20 in daily_ohlcv is 0..1 (percentile of current vol vs trailing 20).
  if (volRank == null) return 'normal';
  if (volRank < 0.3) return 'low';
  if (volRank > 0.7) return 'high';
  return 'normal';
}
function bucketGap(gapPct, atrPct) {
  if (gapPct == null) return 'flat';
  const norm = atrPct ? gapPct / atrPct : gapPct;
  if (norm > 0.5) return 'gap-up';
  if (norm < -0.5) return 'gap-down';
  return 'flat';
}
function bucketStreak(up, dn) {
  if ((up || 0) >= 3) return 'up-streak';
  if ((dn || 0) >= 3) return 'down-streak';
  return 'no-streak';
}
function bucketPctChange(dayPctRatio) {
  // dayPct is a ratio (0.005 = 0.5%). Bucket in fixed % bins regardless of ATR.
  const p = (dayPctRatio || 0) * 100;
  if (p >= 3) return '>+3%';
  if (p >= 1) return '+1..+3%';
  if (p >= 0.25) return '+0.25..+1%';
  if (p > -0.25) return 'flat';
  if (p > -1) return '-0.25..-1%';
  if (p > -3) return '-1..-3%';
  return '<-3%';
}
function bucketRelVol(volRank01) {
  // Same buckets as the old Volume condition — VolRank_20 ∈ [0,1].
  if (volRank01 == null) return 'normal';
  if (volRank01 < 0.3) return 'low';
  if (volRank01 > 0.7) return 'high';
  return 'normal';
}
function bucketVolStreak(vu, vd) {
  if ((vu || 0) >= 3) return 'vol-up-streak';
  if ((vd || 0) >= 3) return 'vol-down-streak';
  return 'no-vol-streak';
}
function bucketTrendEma(ema8, ema21) {
  // TradeOdds-equivalent (they use EMA9 vs EMA21; we have EMA_8 which is close)
  if (ema8 == null || ema21 == null) return 'flat';
  const spread = (ema8 - ema21) / ema21;
  if (spread > 0.005) return 'uptrend';
  if (spread < -0.005) return 'downtrend';
  return 'flat';
}
function bucketVixLevel(vixClose) {
  if (vixClose == null) return 'normal';
  if (vixClose < 15) return 'low';
  if (vixClose > 20) return 'high';
  return 'normal';
}
function bucketVixMove(vixDayPctRatio) {
  const p = (vixDayPctRatio || 0) * 100;
  if (p > 5) return 'rising';
  if (p < -5) return 'falling';
  return 'flat';
}
function bucketMarketRegime(spyClose, spy200, spy200slope) {
  if (spyClose == null || spy200 == null) return 'na';
  const above = spyClose > spy200;
  const rising = (spy200slope || 0) > 0;
  if (above && rising) return 'bull';
  if (above && !rising) return 'bull-fading';
  if (!above && rising) return 'bear-fading';
  return 'bear';
}

// ---------- External-data sources for Earnings + Analyst conditions ----------
// All three load from local memory/ artifacts. Cached 10 min.
let _extCacheTs = 0;
let _earningsByTicker = null;       // ticker → sorted [{ date, actualEps, streetEst, preClose, postClose, upcoming }]
let _analystCallsByTicker = null;   // ticker → sorted [{ date, actionType }]

async function enrichEarningsWithBars(ticker, events) {
  // For each earnings event with no pre/post close, look up our own daily_ohlcv
  // bars on report_date and report_date+1 to derive the price reaction.
  // Done in batch — one query per ticker, all dates at once.
  const needed = events.filter(e => e.preClose == null || e.postClose == null);
  if (!needed.length) return;
  const dates = [...new Set(needed.map(e => e.date))];
  if (!dates.length) return;
  try {
    const { chQuery } = await import('./lib/clickhouse.mjs');
    const sql = `SELECT toString(toDate(Timestamp)) AS dt, Close, Open FROM daily_ohlcv WHERE Ticker = '${ticker}' AND toDate(Timestamp) IN (${dates.map(d => `'${d}'`).join(',')})`;
    const closeRows = await chQuery(sql);
    const byDate = {};
    for (const r of (closeRows || [])) byDate[r.dt] = { close: Number(r.Close), open: Number(r.Open) };
    // For each event, find report_date close (or open if pre-market report) and the
    // PRIOR trading day's close. Pull all bars in a +/- 3 trading day window.
    const dateMs = (d) => new Date(d).getTime();
    const allBars = await chQuery(`SELECT toString(toDate(Timestamp)) AS dt, Close FROM daily_ohlcv WHERE Ticker = '${ticker}' AND toDate(Timestamp) IN (${dates.flatMap(d => {
      // Generate +/- 3 days
      const out = [];
      const m = new Date(d).getTime();
      for (let i = -3; i <= 3; i++) out.push(new Date(m + i * 86400000).toISOString().slice(0, 10));
      return out;
    }).map(d => `'${d}'`).join(',')})`);
    const closeByDate = {};
    for (const r of (allBars || [])) closeByDate[r.dt] = Number(r.Close);
    for (const e of needed) {
      // pre = close of trading day immediately before report
      // post = close of report day (AMC reports) or close of next day (BMO)
      const reportMs = dateMs(e.date);
      const isBmo = (e.session || '').toLowerCase().includes('bmo') || (e.session || '').toLowerCase() === 'premarket';
      // Walk back to find the previous trading-day close
      let preDt = null, preClose = null;
      for (let i = 1; i <= 4; i++) {
        const d = new Date(reportMs - i * 86400000).toISOString().slice(0, 10);
        if (closeByDate[d] != null) { preDt = d; preClose = closeByDate[d]; break; }
      }
      // Post: close of report day if AMC, else next available trading-day close
      let postDt = null, postClose = null;
      if (!isBmo && closeByDate[e.date] != null) {
        postDt = e.date; postClose = closeByDate[e.date];
      } else {
        for (let i = isBmo ? 0 : 1; i <= 3; i++) {
          const d = new Date(reportMs + i * 86400000).toISOString().slice(0, 10);
          if (closeByDate[d] != null && d !== preDt) { postDt = d; postClose = closeByDate[d]; break; }
        }
      }
      if (preClose != null && postClose != null) {
        e.preClose = preClose;
        e.postClose = postClose;
        e.reactionPct = (postClose - preClose) / preClose;
      }
    }
  } catch (e) { /* enrichment is best-effort */ }
}

async function loadExternalData() {
  if (_earningsByTicker && Date.now() - _extCacheTs < 600_000) return;
  // ─── Earnings: combine history + upcoming calendar ─────────
  const earn = {};
  const hist = await readJSON(join(MEMORY, 'uw_earnings_history.json'));
  if (hist && hist.rows && typeof hist.rows === 'object') {
    for (const row of Object.values(hist.rows)) {
      const t = row.ticker; if (!t || !row.date) continue;
      (earn[t] = earn[t] || []).push({
        date: row.date,
        actualEps: row.actual_eps != null ? Number(row.actual_eps) : null,
        streetEst: row.street_mean_est != null ? Number(row.street_mean_est) : null,
        preClose:  row.pre_earnings_close != null ? Number(row.pre_earnings_close) : null,
        postClose: row.post_earnings_close != null ? Number(row.post_earnings_close) : null,
        upcoming: false,
      });
    }
  }
  const cal = await readJSON(join(MEMORY, 'uw_calendars.json'));
  if (cal && Array.isArray(cal.earnings)) {
    for (const e of cal.earnings) {
      const t = e.symbol; if (!t || !e.report_date) continue;
      (earn[t] = earn[t] || []).push({ date: e.report_date, upcoming: true });
    }
  }
  for (const t of Object.keys(earn)) earn[t].sort((a, b) => a.date.localeCompare(b.date));
  _earningsByTicker = earn;

  // ─── Analyst calls from knowledge.db ───────────────────────
  const calls = {};
  try {
    const { default: Database } = await import('node:sqlite').then(m => ({ default: m.DatabaseSync })).catch(() => ({ default: null }));
    if (Database) {
      const db = new Database(join(MEMORY, 'knowledge.db'), { readonly: true });
      // Filter to plausible tickers only — the analyst_calls parser sometimes
      // captured words like "price"/"Desk" as ticker. Real tickers are
      // 1-5 uppercase letters (with optional . or -). Reject lowercase entirely.
      const rows = db.prepare(`SELECT ticker, action_type, call_date FROM analyst_calls WHERE ticker IS NOT NULL AND call_date IS NOT NULL`).all();
      const TKR_RE = /^[A-Z]{1,5}(?:[.\-][A-Z]{1,3})?$/;
      let kept = 0, skipped = 0;
      for (const r of rows) {
        const raw = String(r.ticker || '');
        if (!TKR_RE.test(raw)) { skipped++; continue; }
        const t = raw.toUpperCase();
        (calls[t] = calls[t] || []).push({ date: r.call_date, actionType: r.action_type });
        kept++;
      }
      for (const t of Object.keys(calls)) calls[t].sort((a, b) => a.date.localeCompare(b.date));
      console.log(`[ext-data] analyst_calls: kept ${kept} legitimate-ticker rows, skipped ${skipped} garbage (parser bug — needs fix in build_knowledge_db.mjs)`);
      db.close();
    }
  } catch (e) { console.error('[ext-data] analyst_calls load failed:', e.message); }
  _analystCallsByTicker = calls;

  _extCacheTs = Date.now();
}

// ── Earnings Proximity ─────────────────────────────────────
function bucketEarningsProx(daysToNext) {
  if (daysToNext == null) return 'no-upcoming';
  if (daysToNext <= 5) return 'imminent';
  if (daysToNext <= 30) return 'near';
  return 'distant';
}
function daysBetween(a, b) { return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000); }
function precomputeEarningsProxDates(ticker, todayBucket, lookbackYears = 15) {
  // Returns the date list to use in WHERE toDate(d.Timestamp) IN (...) — or null
  // if we should use NOT IN (for 'distant'), or [] for no-match.
  const events = _earningsByTicker?.[ticker] || [];
  if (!events.length) return { mode: 'noop' };
  const nowMs = Date.now();
  const lookbackMs = lookbackYears * 365 * 86400000;
  const imminent = new Set(), near = new Set();
  for (const e of events) {
    const eMs = new Date(e.date).getTime();
    for (let d = 1; d <= 30; d++) {
      const dMs = eMs - d * 86400000;
      if (nowMs - dMs > lookbackMs) break;
      const iso = new Date(dMs).toISOString().slice(0, 10);
      if (d <= 5) imminent.add(iso); else near.add(iso);
    }
  }
  if (todayBucket === 'imminent') return { mode: 'in',  dates: [...imminent] };
  if (todayBucket === 'near')     return { mode: 'in',  dates: [...near] };
  if (todayBucket === 'distant')  return { mode: 'notin', dates: [...imminent, ...near] };
  return { mode: 'noop' }; // 'no-upcoming' — can't really filter
}

// ── Earnings Performance ───────────────────────────────────
// We don't always get actual_eps + street_mean_est from UW (the tickerEarnings
// endpoint omits them). So we classify primarily by post-print PRICE REACTION
// — which is the part that actually matters for trading. Reaction is computed
// from pre_earnings_close + post_earnings_close when UW supplies them, falling
// back to the reactionPct field that the backfill could populate from CH bars.
function classifyEarningsEvent(e) {
  // Compute reaction %. Three possible sources, in priority order.
  let reactPct = null;
  if (e.preClose != null && e.postClose != null && e.preClose > 0) {
    reactPct = (e.postClose - e.preClose) / e.preClose;
  } else if (typeof e.reactionPct === 'number') {
    reactPct = e.reactionPct;
  } else if (typeof e.reaction === 'number') {
    reactPct = e.reaction; // already a ratio
  }
  if (reactPct == null) return null;
  // If we ALSO have eps + est, we can refine beat/miss; otherwise just react.
  let beat = null;
  if (e.actualEps != null && e.streetEst != null && Math.abs(e.streetEst) > 0.01) {
    const epsDiff = (e.actualEps - e.streetEst) / Math.max(0.01, Math.abs(e.streetEst));
    beat = epsDiff > 0.05 ? true : epsDiff < -0.05 ? false : null;
  }
  const rally = reactPct > 0.02;
  const tank = reactPct < -0.02;
  if (beat === true && rally) return 'beat-rally';
  if (beat === true && tank)  return 'beat-fade';
  if (beat === false && tank) return 'miss-tank';
  if (beat === false && rally) return 'miss-bounce';
  // No eps data — classify by reaction only
  if (rally) return 'rallied';
  if (tank)  return 'tanked';
  return 'flat';
}
function bucketEarningsPerf(ticker, asOfDate) {
  const events = _earningsByTicker?.[ticker] || [];
  // Find most recent CONFIRMED event (not upcoming) on or before asOfDate
  let latest = null;
  for (const e of events) {
    if (e.upcoming) continue;
    if (e.date <= asOfDate) latest = e;
  }
  if (!latest) return 'no-print';
  return classifyEarningsEvent(latest) || 'inline';
}
function precomputeEarningsPerfDates(ticker, todayBucket, lookbackYears = 15) {
  const events = _earningsByTicker?.[ticker] || [];
  if (!events.length || todayBucket === 'no-print') return { mode: 'noop' };
  const nowMs = Date.now();
  const lookbackMs = lookbackYears * 365 * 86400000;
  // For each confirmed event, classify it + emit the date range until next event
  const confirmed = events.filter(e => !e.upcoming);
  const dates = new Set();
  for (let i = 0; i < confirmed.length; i++) {
    const e = confirmed[i];
    const cls = classifyEarningsEvent(e); if (cls !== todayBucket) continue;
    const startMs = new Date(e.date).getTime();
    const endMs = i + 1 < confirmed.length ? new Date(confirmed[i + 1].date).getTime() : nowMs;
    for (let m = startMs; m <= endMs && nowMs - m <= lookbackMs; m += 86400000) {
      dates.add(new Date(m).toISOString().slice(0, 10));
    }
  }
  return dates.size ? { mode: 'in', dates: [...dates] } : { mode: 'empty' };
}

// ── Analyst Trend ──────────────────────────────────────────
function bucketAnalystTrend(ticker, asOfDate, windowDays = 30) {
  const calls = _analystCallsByTicker?.[ticker] || [];
  if (!calls.length) return 'no-calls';
  const cutMs = new Date(asOfDate).getTime() - windowDays * 86400000;
  let raises = 0, cuts = 0;
  for (const c of calls) {
    const cMs = new Date(c.date).getTime();
    if (cMs > new Date(asOfDate).getTime()) continue;
    if (cMs < cutMs) continue;
    if (c.actionType === 'pt_raise' || c.actionType === 'upgrade') raises++;
    else if (c.actionType === 'pt_cut' || c.actionType === 'downgrade') cuts++;
  }
  if (raises === 0 && cuts === 0) return 'no-calls';
  if (raises >= cuts * 1.5 && raises >= 2) return 'bullish';
  if (cuts >= raises * 1.5 && cuts >= 2) return 'bearish';
  return 'mixed';
}
function precomputeAnalystTrendDates(ticker, todayBucket, lookbackYears = 15) {
  const calls = _analystCallsByTicker?.[ticker] || [];
  if (!calls.length || todayBucket === 'no-calls') return { mode: 'noop' };
  // We only have ~3 months of analyst_calls right now — bucket per trading day
  // in that window. Outside the window we have no data → leave alone.
  const minDate = calls[0].date, maxDate = calls[calls.length - 1].date;
  const dates = new Set();
  const startMs = new Date(minDate).getTime();
  const endMs = new Date(maxDate).getTime();
  for (let m = startMs; m <= endMs; m += 86400000) {
    const iso = new Date(m).toISOString().slice(0, 10);
    if (bucketAnalystTrend(ticker, iso) === todayBucket) dates.add(iso);
  }
  return dates.size ? { mode: 'in', dates: [...dates] } : { mode: 'empty' };
}

// Cached today's market context (SPY + VIX). Refreshed once per minute since
// this drives every analog + factor-match query.
let _marketTodayCache = null;
let _marketTodayCacheTs = 0;
async function getMarketToday() {
  if (_marketTodayCache && Date.now() - _marketTodayCacheTs < 60_000) return _marketTodayCache;
  const { chQuery } = await import('./lib/clickhouse.mjs');
  // VIX index isn't in the warehouse (only VXX). Pull SPY only for now; the
  // VIX Level / VIX Move conditions are flagged disabled in the catalog.
  const rows = await chQuery(`
    SELECT Ticker, Timestamp, Close, DayPct, SMA_200, SMA_200_Slope1
    FROM daily_ohlcv
    WHERE Ticker = 'SPY'
    ORDER BY Timestamp DESC
    LIMIT 1
  `);
  const spy = (rows || [])[0];
  const vix = null;
  const out = {
    asOf: spy ? spy.Timestamp : (vix ? vix.Timestamp : null),
    spy: spy ? { close: Number(spy.Close), sma200: Number(spy.SMA_200), sma200slope: Number(spy.SMA_200_Slope1) } : null,
    vix: vix ? { close: Number(vix.Close), dayPct: Number(vix.DayPct) } : null,
  };
  out.buckets = {
    marketRegime: out.spy ? bucketMarketRegime(out.spy.close, out.spy.sma200, out.spy.sma200slope) : 'na',
    vixLevel:     out.vix ? bucketVixLevel(out.vix.close) : 'na',
    vixMove:      out.vix ? bucketVixMove(out.vix.dayPct) : 'na',
    month:        out.asOf ? new Date(out.asOf).toLocaleString('en-US', { month: 'short' }) : 'na',
  };
  _marketTodayCache = out;
  _marketTodayCacheTs = Date.now();
  return out;
}

async function loadTickerProfile(ticker) {
  const { chQuery } = await import('./lib/clickhouse.mjs');
  // ticker already validated against /^[A-Z.\-]{1,8}$/ in handleAnalogs.
  // Last 2 daily bars so we can compute RSI slope.
  const rows = await chQuery(`
    SELECT Ticker, Timestamp, Close, Open, DayPct, GapPct, ATR_14, RSI_14, RSI_5,
           SMA_50_Slope1, SMA_200, SMA_200_Slope1, VolRank_20,
           UpStreak, DownStreak, VolUpStreak, VolDownStreak,
           EMA_8, EMA_21, Volume, AvgVol_20
    FROM daily_ohlcv
    WHERE Ticker = '${ticker}'
    ORDER BY Timestamp DESC LIMIT 2
  `);
  if (!rows || !rows.length) return null;
  const r = rows[0];
  const prev = rows[1] || {};
  const atrPctOfPrice = r.ATR_14 && r.Close ? (Number(r.ATR_14) / Number(r.Close)) * 100 : null;
  const profile = {
    ticker, asOf: r.Timestamp,
    close: Number(r.Close),
    // Display values are converted to real percentages here. The buckets/where
    // logic below uses the raw ratios since that's what daily_ohlcv stores.
    dayPct: Number(r.DayPct) * 100,
    gapPct: Number(r.GapPct) * 100,
    dayPctRaw: Number(r.DayPct),
    gapPctRaw: Number(r.GapPct),
    atr14: Number(r.ATR_14),
    atrPctOfPrice,
    rsi14: Number(r.RSI_14),
    rsi5: Number(r.RSI_5),
    rsi14Prev: prev.RSI_14 != null ? Number(prev.RSI_14) : null,
    sma50slope: Number(r.SMA_50_Slope1),
    sma200: Number(r.SMA_200),
    sma200slope: Number(r.SMA_200_Slope1),
    volRank: Number(r.VolRank_20),
    upStreak: Number(r.UpStreak),
    downStreak: Number(r.DownStreak),
    volUpStreak: Number(r.VolUpStreak),
    volDownStreak: Number(r.VolDownStreak),
    ema8: Number(r.EMA_8),
    ema21: Number(r.EMA_21),
  };
  const market = await getMarketToday();
  profile.market = market;

  // External-data conditions: earnings + analyst calls
  await loadExternalData();
  // On-demand enrichment: derive pre/post close from our daily_ohlcv for this
  // ticker so Earnings Performance can classify by reaction. Cheap, cached.
  if (_earningsByTicker?.[ticker]) {
    await enrichEarningsWithBars(ticker, _earningsByTicker[ticker]);
  }
  const asOfDate = String(r.Timestamp).slice(0, 10);
  // Earnings proximity (days to next)
  const events = _earningsByTicker?.[ticker] || [];
  const nextE = events.find(e => e.date > asOfDate);
  const daysToNextE = nextE ? daysBetween(asOfDate, nextE.date) : null;
  profile.earningsNextDate = nextE?.date || null;
  profile.daysToNextEarnings = daysToNextE;
  profile.earningsProxBucket = bucketEarningsProx(daysToNextE);
  // Earnings performance bucket (last actual print)
  profile.earningsPerfBucket = bucketEarningsPerf(ticker, asOfDate);
  // Analyst trend over last 30d
  profile.analystTrendBucket = bucketAnalystTrend(ticker, asOfDate, 30);
  // Pre-compute matching-date lists for the WHERE-builder (sync use later)
  profile.earningsProxMatch = precomputeEarningsProxDates(ticker, profile.earningsProxBucket);
  profile.earningsPerfMatch = precomputeEarningsPerfDates(ticker, profile.earningsPerfBucket);
  profile.analystTrendMatch = precomputeAnalystTrendDates(ticker, profile.analystTrendBucket);
  profile.buckets = {
    // Per-ticker
    pctChange: bucketPctChange(profile.dayPctRaw),
    move:      bucketMove(profile.dayPct, atrPctOfPrice),
    relVol:    bucketRelVol(profile.volRank),
    rsiZone:   bucketRsi(profile.rsi14),
    rsiSlope:  bucketSlope(profile.rsi14Prev, profile.rsi14),
    trend:     bucketTrendEma(profile.ema8, profile.ema21),
    stage:     bucketStage(profile.close, profile.sma200, profile.sma200slope),
    gap:       bucketGap(profile.gapPct, atrPctOfPrice),
    priceStreak: bucketStreak(profile.upStreak, profile.downStreak),
    volStreak:   bucketVolStreak(profile.volUpStreak, profile.volDownStreak),
    // Date-wide (cached market)
    marketRegime: market.buckets.marketRegime,
    vixLevel:     market.buckets.vixLevel,
    vixMove:      market.buckets.vixMove,
    month:        market.buckets.month,
    // External-data buckets (now wired from local artifacts)
    analystTrend: profile.analystTrendBucket,
    earningsPerf: profile.earningsPerfBucket,
    earningsProx: profile.earningsProxBucket + (profile.daysToNextEarnings != null ? ' (' + profile.daysToNextEarnings + 'd)' : ''),
  };
  // Adjust buildAnalogWhere to use the raw (fractional) values
  profile._raw = {
    dayPct: profile.dayPctRaw,
    gapPct: profile.gapPctRaw,
  };
  return profile;
}

function buildAnalogWhere(profile, active) {
  // Returns WHERE-clause fragments + the set of CTEs we need to JOIN.
  // joinSpy/joinVix flags signal that the outer SQL must include those CTEs
  // and JOIN them on toDate(d.Timestamp) = ctesvixdate.
  const where = [];
  const flags = { joinSpy: false, joinVix: false };
  const atrUnits = profile.atrPctOfPrice ? (profile.dayPctRaw * 100) / profile.atrPctOfPrice : 0;

  // ── Asset-specific ─────────────────────────────────────────
  if (active.pctChange) {
    const b = profile.buckets.pctChange;
    const cuts = { '>+3%': '> 0.03', '+1..+3%': 'BETWEEN 0.01 AND 0.03', '+0.25..+1%': 'BETWEEN 0.0025 AND 0.01',
                   'flat': 'BETWEEN -0.0025 AND 0.0025', '-0.25..-1%': 'BETWEEN -0.01 AND -0.0025',
                   '-1..-3%': 'BETWEEN -0.03 AND -0.01', '<-3%': '< -0.03' };
    if (cuts[b]) where.push(`d.DayPct ${cuts[b]}`);
  }
  if (active.move) {
    where.push(`(d.ATR_14 > 0 AND d.Close > 0 AND ((d.DayPct * 100 / (d.ATR_14 / d.Close * 100)) BETWEEN ${(atrUnits - 0.5).toFixed(4)} AND ${(atrUnits + 0.5).toFixed(4)}))`);
  }
  if (active.relVol) {
    if (profile.volRank < 0.3) where.push(`d.VolRank_20 < 0.3`);
    else if (profile.volRank > 0.7) where.push(`d.VolRank_20 > 0.7`);
    else where.push(`d.VolRank_20 BETWEEN 0.3 AND 0.7`);
  }
  if (active.rsiZone) {
    const rsi = profile.rsi14 || 50;
    where.push(`d.RSI_14 BETWEEN ${(rsi - 5).toFixed(2)} AND ${(rsi + 5).toFixed(2)}`);
  }
  if (active.rsiSlope && profile.rsi14Prev != null) {
    const slopeDir = profile.rsi14 - profile.rsi14Prev;
    const slopeExpr = `(d.RSI_14 - lagInFrame(d.RSI_14) OVER (PARTITION BY d.Ticker ORDER BY d.Timestamp))`;
    if (slopeDir > 1.5) where.push(`${slopeExpr} > 1.5`);
    else if (slopeDir < -1.5) where.push(`${slopeExpr} < -1.5`);
    else where.push(`abs(${slopeExpr}) <= 1.5`);
  }
  if (active.trend) {
    // EMA8 vs EMA21 spread bucket (TradeOdds uses EMA9/21; we use the same idea
    // with the EMA8 we have in the warehouse — drift difference is negligible)
    const t = profile.buckets.trend;
    if (t === 'uptrend')   where.push(`d.EMA_21 > 0 AND (d.EMA_8 - d.EMA_21) / d.EMA_21 > 0.005`);
    else if (t === 'downtrend') where.push(`d.EMA_21 > 0 AND (d.EMA_8 - d.EMA_21) / d.EMA_21 < -0.005`);
    else where.push(`d.EMA_21 > 0 AND abs((d.EMA_8 - d.EMA_21) / d.EMA_21) <= 0.005`);
  }
  if (active.stage) {
    const above = profile.close > profile.sma200;
    const rising = profile.sma200slope > 0;
    if (above && rising) where.push(`(d.Close > d.SMA_200 AND d.SMA_200_Slope1 > 0)`);
    else if (above && !rising) where.push(`(d.Close > d.SMA_200 AND d.SMA_200_Slope1 <= 0)`);
    else if (!above && !rising) where.push(`(d.Close <= d.SMA_200 AND d.SMA_200_Slope1 <= 0)`);
    else where.push(`(d.Close <= d.SMA_200 AND d.SMA_200_Slope1 > 0)`);
  }
  if (active.gap) {
    const norm = profile.atrPctOfPrice ? (profile.gapPctRaw * 100) / profile.atrPctOfPrice : profile.gapPctRaw;
    if (norm > 0.5) where.push(`(d.ATR_14 > 0 AND d.GapPct * 100 / (d.ATR_14 / d.Close * 100) > 0.5)`);
    else if (norm < -0.5) where.push(`(d.ATR_14 > 0 AND d.GapPct * 100 / (d.ATR_14 / d.Close * 100) < -0.5)`);
    else where.push(`(d.ATR_14 = 0 OR abs(d.GapPct * 100 / (d.ATR_14 / d.Close * 100)) <= 0.5)`);
  }
  if (active.priceStreak) {
    if (profile.upStreak >= 3) where.push(`d.UpStreak >= 3`);
    else if (profile.downStreak >= 3) where.push(`d.DownStreak >= 3`);
    else where.push(`(d.UpStreak < 3 AND d.DownStreak < 3)`);
  }
  if (active.volStreak) {
    if (profile.volUpStreak >= 3) where.push(`d.VolUpStreak >= 3`);
    else if (profile.volDownStreak >= 3) where.push(`d.VolDownStreak >= 3`);
    else where.push(`(d.VolUpStreak < 3 AND d.VolDownStreak < 3)`);
  }

  // ── Date-wide / market context ──────────────────────────────
  if (active.marketRegime && profile.market?.spy) {
    flags.joinSpy = true;
    const b = profile.buckets.marketRegime;
    if (b === 'bull')         where.push(`(spy.spy_close > spy.spy_sma200 AND spy.spy_slope > 0)`);
    else if (b === 'bull-fading') where.push(`(spy.spy_close > spy.spy_sma200 AND spy.spy_slope <= 0)`);
    else if (b === 'bear-fading') where.push(`(spy.spy_close <= spy.spy_sma200 AND spy.spy_slope > 0)`);
    else where.push(`(spy.spy_close <= spy.spy_sma200 AND spy.spy_slope <= 0)`);
  }
  if (active.vixLevel && profile.market?.vix) {
    flags.joinVix = true;
    const b = profile.buckets.vixLevel;
    if (b === 'low') where.push(`vix.vix_close < 15`);
    else if (b === 'high') where.push(`vix.vix_close > 20`);
    else where.push(`vix.vix_close BETWEEN 15 AND 20`);
  }
  if (active.vixMove && profile.market?.vix) {
    flags.joinVix = true;
    const b = profile.buckets.vixMove;
    if (b === 'rising')   where.push(`vix.vix_dayPct > 0.05`);
    else if (b === 'falling') where.push(`vix.vix_dayPct < -0.05`);
    else where.push(`abs(vix.vix_dayPct) <= 0.05`);
  }
  if (active.month && profile.asOf) {
    const m = new Date(profile.asOf).getUTCMonth() + 1;
    where.push(`toMonth(d.Timestamp) = ${m}`);
  }

  // ── External-data conditions (earnings + analyst) ──────────
  // Each pre-computes a matching date list in the profile loader. We just
  // inject the IN/NOT IN here. Cheap because the list is bounded.
  const fmtIn = (arr) => arr.map(d => `'${d}'`).join(',');
  for (const [key, match] of [
    ['earningsProx',   profile.earningsProxMatch],
    ['earningsPerf',   profile.earningsPerfMatch],
    ['analystTrend',   profile.analystTrendMatch],
  ]) {
    if (!active[key] || !match) continue;
    if (match.mode === 'in')      where.push(`toDate(d.Timestamp) IN (${fmtIn(match.dates)})`);
    else if (match.mode === 'notin') where.push(`toDate(d.Timestamp) NOT IN (${fmtIn(match.dates)})`);
    else if (match.mode === 'empty') where.push(`1=0`); // no matching dates → no results
    // 'noop' = no data → toggle has no effect (better than returning 0 rows)
  }

  return { where, flags };
}

async function runAnalogQuery(ticker, profile, activeConditions) {
  const { chQuery } = await import('./lib/clickhouse.mjs');
  const { where, flags } = buildAnalogWhere(profile, activeConditions);
  const slopePred = where.find(w => w.includes('lagInFrame'));
  const baseWhere = where.filter(w => !w.includes('lagInFrame'));
  const baseWhereClause = baseWhere.length ? 'AND ' + baseWhere.join('\n      AND ') : '';
  const slopeHaving = slopePred ? 'AND ' + slopePred.replace(/\(d\.RSI_14 - lagInFrame\(d\.RSI_14\) OVER \(PARTITION BY d\.Ticker ORDER BY d\.Timestamp\)\)/g, 'rsiSlope') : '';
  const asOfLit = String(profile.asOf).replace(/\.\d+$/, '');

  // Conditional CTE joins for market-context conditions
  const ctes = [];
  const joins = [];
  if (flags.joinSpy) {
    ctes.push(`spy_hist AS (SELECT toDate(Timestamp) AS dt, Close AS spy_close, SMA_200 AS spy_sma200, SMA_200_Slope1 AS spy_slope FROM daily_ohlcv WHERE Ticker='SPY')`);
    joins.push(`INNER JOIN spy_hist spy ON spy.dt = toDate(d.Timestamp)`);
  }
  if (flags.joinVix) {
    ctes.push(`vix_hist AS (SELECT toDate(Timestamp) AS dt, Close AS vix_close, DayPct AS vix_dayPct FROM daily_ohlcv WHERE Ticker='VIX')`);
    joins.push(`INNER JOIN vix_hist vix ON vix.dt = toDate(d.Timestamp)`);
  }
  const cteClause = ctes.length ? ctes.join(',\n  ') + ',\n  ' : '';
  const joinClause = joins.join('\n      ');

  const sql = `
    WITH ${cteClause}base AS (
      SELECT
        toString(toDate(d.Timestamp)) AS date,
        d.Timestamp AS ts,
        d.DayPct AS dayPct,
        d.RSI_14 AS rsi14,
        d.Fwd1d AS fwd1d,
        d.Fwd5d AS fwd5d,
        d.Fwd10d AS fwd10d,
        (d.RSI_14 - lagInFrame(d.RSI_14) OVER (PARTITION BY d.Ticker ORDER BY d.Timestamp)) AS rsiSlope
      FROM daily_ohlcv d
      ${joinClause}
      WHERE d.Ticker = '${ticker}'
        AND d.Timestamp < toDateTime('${asOfLit}')
        AND d.Fwd5d IS NOT NULL
        AND d.Fwd5d != 0
        ${baseWhereClause}
    )
    SELECT date, dayPct, rsi14, fwd1d, fwd5d, fwd10d, rsiSlope
    FROM base
    WHERE 1=1 ${slopeHaving}
    ORDER BY ts DESC
  `;
  let rows;
  try {
    rows = await chQuery(sql);
  } catch (e) {
    console.error('[analogs] chQuery threw:', e.message);
    console.error('[analogs] SQL was:\n' + sql);
    throw e;
  }
  if (!rows) {
    console.error('[analogs] chQuery returned null. SQL was:\n' + sql);
    return { ticker, profile, activeConditions, matches: [], stats: { N: 0 }, sql, error: 'query returned null' };
  }
  // ClickHouse stores DayPct/Fwd1d/5d/10d as RATIOS (0.0039 = +0.39%). Multiply
  // by 100 once here so everything downstream is in real-percentage terms.
  const valid = rows.filter(r => r.fwd5d != null && r.fwd5d !== 0);
  const N = valid.length;
  if (!N) return { ticker, profile, activeConditions, matches: [], stats: { N: 0 } };
  const fwd1 = valid.map(r => (Number(r.fwd1d) || 0) * 100).sort((a,b) => a-b);
  const fwd5 = valid.map(r => (Number(r.fwd5d) || 0) * 100).sort((a,b) => a-b);
  const fwd10 = valid.map(r => (Number(r.fwd10d) || 0) * 100).sort((a,b) => a-b);
  const median = (a) => a.length % 2 ? a[(a.length-1)/2] : (a[a.length/2-1] + a[a.length/2]) / 2;
  const avg = (a) => a.reduce((s,n) => s + n, 0) / a.length;
  const pctPos = (a) => a.filter(n => n > 0).length * 100 / a.length;
  // Pull the FULL price history for this ticker so the chart can draw the
  // line + place green/red dots on every matching date. ~4-6K rows; one query.
  let priceHistory = [];
  try {
    const pSql = `SELECT toString(toDate(Timestamp)) AS date, Close AS close FROM daily_ohlcv WHERE Ticker = '${ticker}' AND Timestamp < toDateTime('${asOfLit}') ORDER BY Timestamp`;
    const pRows = await chQuery(pSql);
    priceHistory = (pRows || []).map(r => ({ date: r.date, close: Number(r.close) }));
  } catch (e) { /* chart-only failure, don't break the response */ }

  // Build a fast lookup: matching date → fwd5d (in %)
  const matchByDate = {};
  for (const m of valid) matchByDate[m.date] = (Number(m.fwd5d) || 0) * 100;

  return {
    ticker, profile, activeConditions,
    stats: {
      N,
      fwd1d:  { pctPos: pctPos(fwd1),  median: median(fwd1),  avg: avg(fwd1),  min: fwd1[0],  max: fwd1[fwd1.length-1] },
      fwd5d:  { pctPos: pctPos(fwd5),  median: median(fwd5),  avg: avg(fwd5),  min: fwd5[0],  max: fwd5[fwd5.length-1] },
      fwd10d: { pctPos: pctPos(fwd10), median: median(fwd10), avg: avg(fwd10), min: fwd10[0], max: fwd10[fwd10.length-1] },
    },
    matches: valid.slice(0, 100).map(r => ({
      date: r.date,
      dayPct:  (Number(r.dayPct)  || 0) * 100,
      rsi14:   Number(r.rsi14),
      fwd1d:   (Number(r.fwd1d)   || 0) * 100,
      fwd5d:   (Number(r.fwd5d)   || 0) * 100,
      fwd10d:  (Number(r.fwd10d)  || 0) * 100,
    })),
    chart: {
      priceHistory,
      matchDates: matchByDate,   // { 'YYYY-MM-DD': fwd5dPct, ... }
    },
  };
}

// ---------- Factor Match: today × universe ----------
// Sibling to Analogs. For every ticker in a universe, finds historical days
// that match THAT TICKER's own "today" profile, aggregates forward stats,
// and returns a ranked table (default sort: 5d Win%).

let _universeCache = null;
async function getUniverse() {
  if (_universeCache) return _universeCache;
  const wlRaw = await readJSON(join(ROOT, 'scripts', 'lib', 'watchlist.json'), {});
  const spxRaw = await readJSON(join(ROOT, 'scripts', 'lib', 'spx500.json'), {});
  const ndxRaw = await readJSON(join(ROOT, 'scripts', 'lib', 'ndx100.json'), {});
  const extract = (raw) => {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.tickers)) return raw.tickers;
    if (Array.isArray(raw.watchlist)) return raw.watchlist;
    return Object.keys(raw).filter(k => /^[A-Z]{1,8}$/.test(k));
  };
  const all = [...extract(wlRaw), ...extract(spxRaw), ...extract(ndxRaw),
    'AAPL','MSFT','AMZN','GOOGL','META','NVDA','TSLA','SPY','QQQ','IWM','DIA',
    'XLK','XLF','XLE','XLV','XLY','XLP','XLU','XLI','XLB','XLC','XLRE',
  ];
  const uniq = [...new Set(all)].filter(t => /^[A-Z.\-]{1,8}$/.test(t));
  _universeCache = uniq;
  return uniq;
}

function buildFactorMatchConditions(active, market) {
  // Per-ticker predicates compare `d` (historical bar) to `t` (today bar for
  // same ticker). Date-wide predicates compare `d` against literal buckets
  // derived from today's MARKET state (SPY/VIX). flags signal which CTE JOINs
  // we need.
  const preds = [];
  const flags = { joinSpy: false, joinVix: false };
  // ── per-ticker ────────────────────────────────────────────
  if (active.pctChange) {
    // bucket using a CASE so each side maps to the same bucket label
    const buckets = `multiIf(d.DayPct > 0.03, '>+3%', d.DayPct >= 0.01, '+1..+3%', d.DayPct >= 0.0025, '+0.25..+1%', d.DayPct > -0.0025, 'flat', d.DayPct > -0.01, '-0.25..-1%', d.DayPct > -0.03, '-1..-3%', '<-3%')`;
    const todayBuckets = buckets.replace(/d\./g, 't.');
    preds.push(`${buckets} = ${todayBuckets}`);
  }
  if (active.move) preds.push(`abs((d.DayPct*100/(d.ATR_14/d.Close*100)) - (t.DayPct*100/(t.ATR_14/t.Close*100))) <= 0.5`);
  if (active.relVol) preds.push(`((d.VolRank_20 < 0.3 AND t.VolRank_20 < 0.3) OR (d.VolRank_20 BETWEEN 0.3 AND 0.7 AND t.VolRank_20 BETWEEN 0.3 AND 0.7) OR (d.VolRank_20 > 0.7 AND t.VolRank_20 > 0.7))`);
  if (active.rsiZone) preds.push(`abs(d.RSI_14 - t.RSI_14) <= 5`);
  if (active.trend) preds.push(`sign((d.EMA_8 - d.EMA_21) / nullIf(d.EMA_21, 0) - 0.005) = sign((t.EMA_8 - t.EMA_21) / nullIf(t.EMA_21, 0) - 0.005)`);
  if (active.stage) preds.push(`(d.Close > d.SMA_200) = (t.Close > t.SMA_200) AND sign(d.SMA_200_Slope1) = sign(t.SMA_200_Slope1)`);
  if (active.gap) preds.push(`sign(d.GapPct*100/(d.ATR_14/d.Close*100)) = sign(t.GapPct*100/(t.ATR_14/t.Close*100))`);
  if (active.priceStreak) preds.push(`((d.UpStreak >= 3 AND t.UpStreak >= 3) OR (d.DownStreak >= 3 AND t.DownStreak >= 3) OR (d.UpStreak < 3 AND d.DownStreak < 3 AND t.UpStreak < 3 AND t.DownStreak < 3))`);
  if (active.volStreak) preds.push(`((d.VolUpStreak >= 3 AND t.VolUpStreak >= 3) OR (d.VolDownStreak >= 3 AND t.VolDownStreak >= 3) OR (d.VolUpStreak < 3 AND d.VolDownStreak < 3 AND t.VolUpStreak < 3 AND t.VolDownStreak < 3))`);
  // ── date-wide (uses literal buckets from today's market state) ─
  if (active.marketRegime && market?.spy) {
    flags.joinSpy = true;
    const b = market.buckets.marketRegime;
    if (b === 'bull')              preds.push(`(spy.spy_close > spy.spy_sma200 AND spy.spy_slope > 0)`);
    else if (b === 'bull-fading')  preds.push(`(spy.spy_close > spy.spy_sma200 AND spy.spy_slope <= 0)`);
    else if (b === 'bear-fading')  preds.push(`(spy.spy_close <= spy.spy_sma200 AND spy.spy_slope > 0)`);
    else                            preds.push(`(spy.spy_close <= spy.spy_sma200 AND spy.spy_slope <= 0)`);
  }
  if (active.vixLevel && market?.vix) {
    flags.joinVix = true;
    const b = market.buckets.vixLevel;
    if (b === 'low')       preds.push(`vix.vix_close < 15`);
    else if (b === 'high') preds.push(`vix.vix_close > 20`);
    else                   preds.push(`vix.vix_close BETWEEN 15 AND 20`);
  }
  if (active.vixMove && market?.vix) {
    flags.joinVix = true;
    const b = market.buckets.vixMove;
    if (b === 'rising')       preds.push(`vix.vix_dayPct > 0.05`);
    else if (b === 'falling') preds.push(`vix.vix_dayPct < -0.05`);
    else                       preds.push(`abs(vix.vix_dayPct) <= 0.05`);
  }
  if (active.month && market?.asOf) {
    const m = new Date(market.asOf).getUTCMonth() + 1;
    preds.push(`toMonth(d.Timestamp) = ${m}`);
  }
  return { preds, flags };
}

async function runFactorMatch(activeConditions, opts = {}) {
  const { chQuery } = await import('./lib/clickhouse.mjs');
  const minN = opts.minN || 10;
  const limit = opts.limit || 100;
  const sortBy = opts.sortBy || 'pctPos_5d'; // pctPos_1d|pctPos_5d|pctPos_10d|avg_5d
  const validSort = new Set(['pctPos_1d','pctPos_5d','pctPos_10d','avg_1d','avg_5d','avg_10d','N']);
  const orderCol = validSort.has(sortBy) ? sortBy : 'pctPos_5d';
  const tickers = await getUniverse();
  const tickerList = tickers.map(t => `'${t}'`).join(',');
  const market = await getMarketToday();
  const { preds, flags } = buildFactorMatchConditions(activeConditions, market);
  const condClause = preds.length ? 'AND ' + preds.join('\n      AND ') : '';
  // CTEs for market-context joins (only when toggled on)
  const extraCtes = [];
  const extraJoins = [];
  if (flags.joinSpy) {
    extraCtes.push(`spy_hist AS (SELECT toDate(Timestamp) AS dt, Close AS spy_close, SMA_200 AS spy_sma200, SMA_200_Slope1 AS spy_slope FROM daily_ohlcv WHERE Ticker='SPY')`);
    extraJoins.push(`INNER JOIN spy_hist spy ON spy.dt = toDate(d.Timestamp)`);
  }
  if (flags.joinVix) {
    extraCtes.push(`vix_hist AS (SELECT toDate(Timestamp) AS dt, Close AS vix_close, DayPct AS vix_dayPct FROM daily_ohlcv WHERE Ticker='VIX')`);
    extraJoins.push(`INNER JOIN vix_hist vix ON vix.dt = toDate(d.Timestamp)`);
  }
  const cteHeader = extraCtes.length ? extraCtes.join(',\n    ') + ',\n    ' : '';
  const joinClause = extraJoins.join('\n      ');
  const sql = `
    WITH ${cteHeader}today AS (
      SELECT Ticker, max(Timestamp) AS asOf
      FROM daily_ohlcv WHERE Ticker IN (${tickerList}) GROUP BY Ticker
    ),
    today_p AS (
      SELECT d.Ticker, d.Timestamp AS asOf, d.Close, d.DayPct, d.GapPct, d.ATR_14,
             d.RSI_14, d.SMA_50_Slope1, d.SMA_200, d.SMA_200_Slope1, d.VolRank_20,
             d.UpStreak, d.DownStreak, d.VolUpStreak, d.VolDownStreak,
             d.EMA_8, d.EMA_21
      FROM daily_ohlcv d
      INNER JOIN today t ON d.Ticker = t.Ticker AND d.Timestamp = t.asOf
    ),
    matches AS (
      SELECT d.Ticker, d.Fwd1d, d.Fwd5d, d.Fwd10d,
             t.Close AS today_close, t.DayPct AS today_dayPct, t.RSI_14 AS today_rsi
      FROM daily_ohlcv d
      INNER JOIN today_p t ON d.Ticker = t.Ticker
      ${joinClause}
      WHERE d.Timestamp < t.asOf
        AND d.Timestamp >= subtractYears(t.asOf, 15)
        AND d.Fwd5d != 0
        AND d.ATR_14 > 0 AND d.Close > 0 AND t.ATR_14 > 0 AND t.Close > 0
        ${condClause}
    )
    SELECT Ticker,
      any(today_close) AS today_close,
      any(today_dayPct) AS today_dayPct,
      any(today_rsi) AS today_rsi,
      count() AS N,
      round(countIf(Fwd1d > 0) * 100.0 / count(), 1) AS pctPos_1d,
      round(countIf(Fwd5d > 0) * 100.0 / count(), 1) AS pctPos_5d,
      round(countIf(Fwd10d > 0) * 100.0 / count(), 1) AS pctPos_10d,
      round(avg(Fwd1d) * 100, 2) AS avg_1d,
      round(avg(Fwd5d) * 100, 2) AS avg_5d,
      round(avg(Fwd10d) * 100, 2) AS avg_10d
    FROM matches
    GROUP BY Ticker
    HAVING N >= ${minN}
    ORDER BY ${orderCol} DESC
    LIMIT ${limit}
  `;
  let rows;
  try { rows = await chQuery(sql); } catch (e) { return { error: 'query failed: ' + e.message }; }
  if (!rows) return { error: 'query returned null' };
  return {
    universeSize: tickers.length,
    activeConditions,
    sortBy: orderCol,
    minN,
    rows: rows.map(r => ({
      ticker: r.Ticker,
      today: { close: Number(r.today_close), dayPct: Number(r.today_dayPct) * 100, rsi: Number(r.today_rsi) },
      N: Number(r.N),
      pctPos: { d1: Number(r.pctPos_1d), d5: Number(r.pctPos_5d), d10: Number(r.pctPos_10d) },
      avg: { d1: Number(r.avg_1d), d5: Number(r.avg_5d), d10: Number(r.avg_10d) },
    })),
  };
}

async function handleFactorMatch(params) {
  let active;
  if (params.has('conditions')) {
    const list = params.get('conditions').split(',').filter(Boolean);
    active = Object.fromEntries(Object.keys(ANALOG_CONDITIONS).map(k => [k, list.includes(k)]));
  } else {
    active = Object.fromEntries(Object.entries(ANALOG_CONDITIONS).map(([k, v]) => [k, !!v.default && !v.disabled]));
    // rsiSlope window function adds 10x scan time; off by default for universe scans
    active.rsiSlope = false;
  }
  // Pro stubs are never sent to SQL (their predicates are no-ops anyway)
  active.analystTrend = active.earningsPerf = active.earningsProx = false;
  const minN = parseInt(params.get('minN') || '10', 10);
  const limit = parseInt(params.get('limit') || '100', 10);
  const sortBy = params.get('sortBy') || 'pctPos_5d';
  const result = await runFactorMatch(active, { minN, limit, sortBy });
  result.conditions = ANALOG_CONDITIONS;
  return result;
}

async function handleAnalogs(ticker, params) {
  const t = String(ticker || 'SPY').toUpperCase();
  if (!/^[A-Z.\-]{1,8}$/.test(t)) return { error: 'invalid ticker' };
  const profile = await loadTickerProfile(t);
  if (!profile) return { error: 'no ClickHouse data for ' + t, ticker: t };
  // Active conditions: explicit query string, else defaults
  let active;
  if (params.has('conditions')) {
    const list = params.get('conditions').split(',').filter(Boolean);
    active = Object.fromEntries(Object.keys(ANALOG_CONDITIONS).map(k => [k, list.includes(k)]));
  } else {
    active = Object.fromEntries(Object.entries(ANALOG_CONDITIONS).map(([k, v]) => [k, v.default]));
  }
  try {
    const result = await runAnalogQuery(t, profile, active);
    result.conditions = ANALOG_CONDITIONS;
    return result;
  } catch (e) {
    return { error: 'query failed: ' + e.message, ticker: t, profile, activeConditions: active };
  }
}

async function servePng(req, res, filename) {
  if (!/^[A-Za-z0-9_\-.]+\.png$/.test(filename)) { res.writeHead(400).end('bad name'); return; }
  try {
    const buf = await readFile(join(MEMORY, filename));
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=30' });
    res.end(buf);
  } catch { res.writeHead(404).end('not found'); }
}

// ---------- HTML/CSS/JS ----------
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trade Odds</title>
<style>
  :root {
    --bg:#0a0c10; --bg-2:#0d1117; --panel:#131820; --panel-2:#1a212c; --panel-3:#212a37;
    --ink:#e6edf3; --ink-dim:#b8c2cc; --mute:#7a8693; --mute-2:#5a636e;
    --border:#232b36; --border-bright:#3a4553;
    --accent:#58a6ff; --accent-2:#1f6feb;
    --green:#3fb950; --green-soft:rgba(63,185,80,.15);
    --red:#f85149; --red-soft:rgba(248,81,73,.15);
    --amber:#e3b341; --amber-soft:rgba(227,179,65,.15);
    --violet:#a78bfa;
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--ink); margin: 0; }
  body { font: 13px/1.45 -apple-system, "SF Pro Text", "Segoe UI", "Inter", Roboto, system-ui, sans-serif; }
  .num { font-variant-numeric: tabular-nums; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: #2a3340; border-radius: 5px; }
  ::-webkit-scrollbar-track { background: var(--bg); }

  /* ---------- sticky header ---------- */
  .topbar {
    position: sticky; top: 0; z-index: 20;
    background: linear-gradient(180deg, #11161e 0%, #0c1117 100%);
    border-bottom: 1px solid var(--border);
    backdrop-filter: blur(6px);
  }
  .topbar .row1 {
    display: flex; align-items: center; gap: 18px;
    padding: 12px 24px;
    border-bottom: 1px solid var(--border);
  }
  .brand { font-size: 13px; letter-spacing: 1.5px; font-weight: 700; color: var(--mute); white-space: nowrap; }
  .brand b { color: var(--ink); font-weight: 800; letter-spacing: 1.5px; }

  .tabs { display: flex; gap: 4px; }
  .tab {
    padding: 7px 16px; border-radius: 6px;
    font-size: 13px; font-weight: 600; letter-spacing: .5px;
    color: var(--mute); text-decoration: none;
    border: 1px solid transparent; cursor: pointer;
    transition: all .12s ease;
  }
  .tab:hover { color: var(--ink-dim); background: var(--panel-2); }
  .tab.active {
    color: var(--ink); background: var(--panel-2);
    border-color: var(--accent); box-shadow: 0 0 0 1px rgba(88,166,255,.2);
  }
  .tab-sep {
    width: 1px; height: 22px; background: var(--border); margin: 0 6px;
  }
  .tab.tab-to { color: var(--violet); }
  .tab.tab-to:hover { color: #c4b5fd; background: rgba(167,139,250,.08); }
  .tab.tab-to.active {
    color: #ddd6fe; background: rgba(167,139,250,.14);
    border-color: var(--violet); box-shadow: 0 0 0 1px rgba(167,139,250,.25);
  }

  /* ---------- Analogs view sub-tabs (Matching Days / Price Path) ---------- */
  .analog-viewtabs {
    display: flex; gap: 4px; margin-bottom: 12px;
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 4px; width: fit-content;
  }
  .analog-viewtab {
    padding: 6px 14px; border-radius: 5px; cursor: pointer;
    font-size: 12px; font-weight: 600; letter-spacing: .3px; color: var(--mute);
    border: 1px solid transparent;
  }
  .analog-viewtab:hover { color: var(--ink-dim); background: var(--panel-2); }
  .analog-viewtab.active { color: var(--ink); background: var(--panel-2); border-color: rgba(167,139,250,.4); }
  .analog-chart-box {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 18px 16px 10px;
  }
  .analog-chart-box .chart-meta {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 12px;
    font-size: 11px; color: var(--mute);
  }
  .analog-chart-box .chart-legend { display: flex; gap: 14px; align-items: center; }
  .analog-chart-box .chart-legend .item { display: inline-flex; gap: 5px; align-items: center; font-variant-numeric: tabular-nums; }
  .analog-chart-box .chart-legend .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .analog-chart-box .chart-legend .dot.up { background: #3fb950; }
  .analog-chart-box .chart-legend .dot.dn { background: #f85149; }
  .analog-chart-box .chart-legend .dot.line { width: 18px; height: 2px; background: #6e7681; border-radius: 0; }
  .analog-chart-svg { width: 100%; height: 380px; display: block; }
  .analog-chart-svg .price-line { fill: none; stroke: #6e7681; stroke-width: 1; }
  .analog-chart-svg .grid-line { stroke: var(--border); stroke-width: 0.5; }
  .analog-chart-svg .axis-label { fill: var(--mute-2); font-size: 9px; font-family: ui-monospace, monospace; }
  .analog-chart-svg .match-dot { stroke: rgba(0,0,0,.4); stroke-width: 0.5; }
  .analog-chart-svg .match-dot.up { fill: #3fb950; }
  .analog-chart-svg .match-dot.dn { fill: #f85149; }

  /* ---------- Trade Odds sub-nav (inside the TO tab panel) ---------- */
  .to-subnav {
    display: flex; gap: 6px;
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 6px; margin-bottom: 16px; width: fit-content;
  }
  .to-subtab {
    display: flex; flex-direction: column; align-items: flex-start;
    padding: 7px 16px; border-radius: 6px;
    color: var(--mute); text-decoration: none;
    border: 1px solid transparent;
    transition: all .12s ease; cursor: pointer; min-width: 200px;
  }
  .to-subtab:hover { color: var(--ink-dim); background: var(--panel-2); }
  .to-subtab.active {
    color: var(--ink); background: rgba(167,139,250,.14);
    border-color: rgba(167,139,250,.4);
  }
  .to-subtab b { font-size: 13px; letter-spacing: .3px; font-weight: 700; }
  .to-subhint { font-size: 10px; color: var(--mute-2); margin-top: 2px; letter-spacing: .3px; }
  .to-subtab.active .to-subhint { color: var(--violet); }
  .to-sub { display: none; }
  .to-sub.active { display: block; }

  .spacer { flex: 1; }
  .regime-pill {
    padding: 6px 14px; border-radius: 6px;
    font-size: 12px; font-weight: 700; letter-spacing: 1px;
    background: var(--panel-2); border: 1px solid var(--border);
    white-space: nowrap;
  }
  .regime-pill.risk-on, .regime-pill.broad-strong { background: var(--green-soft); color: #7ee787; border-color: rgba(63,185,80,.45); }
  .regime-pill.broad-weak { background: var(--red-soft); color: #ff7b72; border-color: rgba(248,81,73,.45); }
  .regime-pill.mega-tech { background: rgba(122,167,255,.15); color: #7aa7ff; border-color: rgba(122,167,255,.45); }
  .regime-pill.mixed { background: var(--amber-soft); color: var(--amber); border-color: rgba(227,179,65,.45); }

  .phase {
    padding: 5px 11px; border-radius: 5px;
    font-size: 11px; font-weight: 700; letter-spacing: .8px;
    background: var(--panel-2); border: 1px solid var(--border);
  }
  .phase.OPEN { background: var(--green-soft); color: #7ee787; border-color: rgba(63,185,80,.45); }
  .phase.PRE-MARKET, .phase.POST-MARKET { background: var(--amber-soft); color: var(--amber); border-color: rgba(227,179,65,.45); }
  .phase.CLOSED { background: var(--red-soft); color: #ff7b72; border-color: rgba(248,81,73,.45); }

  .clock { font-size: 13px; color: var(--ink-dim); font-variant-numeric: tabular-nums; min-width: 92px; text-align: right; }
  .refresh-btn {
    background: var(--panel-2); color: var(--ink-dim); border: 1px solid var(--border);
    padding: 5px 12px; border-radius: 6px; font: inherit; font-size: 12px; font-weight: 600;
    cursor: pointer; letter-spacing: .3px;
  }
  .refresh-btn:hover { color: var(--ink); border-color: var(--accent); background: rgba(88,166,255,.08); }
  .refresh-btn.spinning { color: var(--accent); border-color: var(--accent); }
  .refresh-btn.spinning::before { display: inline-block; animation: spin 0.6s linear infinite; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .updated { font-size: 11px; color: var(--mute); min-width: 130px; text-align: right; }
  .countdown { font-size: 11px; color: var(--mute-2); font-variant-numeric: tabular-nums; min-width: 70px; text-align: right; }
  .countdown.fresh { color: var(--green); }

  /* ---------- always-on regime strip (row 2) ---------- */
  .regime-strip {
    display: flex; gap: 14px; padding: 8px 24px;
    overflow-x: auto; align-items: center; white-space: nowrap;
    font-size: 12px;
  }
  .chip-group { display: flex; gap: 5px; align-items: center; padding-right: 14px; border-right: 1px solid var(--border); }
  .chip-group:last-child { border-right: 0; padding-right: 0; }
  .chip-group .lbl {
    font-size: 9px; font-weight: 700; letter-spacing: 1px;
    color: var(--mute); margin-right: 4px; text-transform: uppercase;
  }
  .strip-chip {
    display: inline-flex; gap: 5px; align-items: baseline;
    padding: 3px 8px; border-radius: 4px;
    font-size: 11px; font-variant-numeric: tabular-nums;
    background: var(--panel-2); border: 1px solid var(--border);
  }
  .strip-chip .t { font-weight: 700; letter-spacing: .3px; }
  .strip-chip.up { background: rgba(63,185,80,.10); border-color: rgba(63,185,80,.35); color: var(--green); }
  .strip-chip.dn { background: rgba(248,81,73,.10); border-color: rgba(248,81,73,.35); color: var(--red); }
  .strip-chip.flat { color: var(--mute); }
  .regime-strip .age { color: var(--mute-2); font-size: 11px; margin-left: auto; padding-left: 12px; }

  /* ---------- main layout ---------- */
  main { padding: 24px 24px 80px; max-width: 1840px; margin: 0 auto; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  .section { margin-bottom: 36px; }
  .section-h {
    display: flex; align-items: baseline; gap: 14px;
    padding-bottom: 10px; margin-bottom: 14px;
    border-bottom: 1px solid var(--border);
  }
  .section-h h2 {
    margin: 0; font-size: 12px; font-weight: 700;
    letter-spacing: 2px; text-transform: uppercase; color: var(--ink-dim);
  }
  .section-h .sub { font-size: 12px; color: var(--mute); }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 16px; }
  .grid.wide { grid-template-columns: repeat(auto-fill, minmax(520px, 1fr)); }
  .grid.tight { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }

  /* ---------- tile ---------- */
  .tile {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    display: flex; flex-direction: column;
    overflow: hidden;
    transition: border-color .15s ease;
    min-height: 170px;
  }
  .tile:hover { border-color: var(--border-bright); }
  .tile.span-2 { grid-column: span 2; }
  .tile.fresh::before { content: ""; display: block; height: 2px; background: linear-gradient(90deg, var(--green), transparent); }
  .tile.warm::before { content: ""; display: block; height: 2px; background: linear-gradient(90deg, var(--amber), transparent); }
  .tile.stale::before { content: ""; display: block; height: 2px; background: var(--border); }

  .tile-h { padding: 10px 12px 5px; display: flex; align-items: baseline; gap: 8px; }
  .tile-h .title { font-size: 13px; font-weight: 700; letter-spacing: .3px; color: var(--ink); }
  .tile-h .badge {
    margin-left: auto; padding: 1px 7px; border-radius: 10px;
    font-size: 10px; font-variant-numeric: tabular-nums;
    background: var(--panel-2); color: var(--mute); border: 1px solid var(--border);
  }
  .tile-h .badge.hot { background: var(--green-soft); color: #7ee787; border-color: rgba(63,185,80,.4); }
  .tile-h .badge.warm { background: var(--amber-soft); color: var(--amber); border-color: rgba(227,179,65,.4); }
  .tile-h .badge.cold { background: var(--red-soft); color: #ff7b72; border-color: rgba(248,81,73,.4); }

  .tile-sub {
    padding: 0 12px 7px;
    display: flex; gap: 8px; font-size: 10px; color: var(--mute); letter-spacing: .3px;
  }
  .tile-sub .ago { font-variant-numeric: tabular-nums; }
  .tile-sub .ago.fresh { color: var(--green); }
  .tile-sub .ago.warm { color: var(--amber); }
  .tile-sub .ago.stale { color: var(--mute-2); }

  .tile-body { flex: 1; min-height: 0; overflow: auto; padding: 0; }
  .tile.scroll .tile-body { max-height: 320px; }
  .tile-row {
    padding: 5px 12px;
    border-top: 1px solid var(--border);
    display: flex; align-items: baseline; gap: 8px;
  }
  .tile-row:first-child { border-top: 0; }
  .tile-row .tkr {
    font-size: 13px; font-weight: 700; letter-spacing: .4px;
    min-width: 56px; color: var(--ink);
  }
  .tile-row .dir {
    padding: 1px 5px; border-radius: 3px;
    font-size: 9px; font-weight: 700; letter-spacing: .5px;
  }
  .tile-row .dir.bullish, .tile-row .dir.long, .tile-row .dir.bull { background: var(--green-soft); color: #7ee787; }
  .tile-row .dir.bearish, .tile-row .dir.short, .tile-row .dir.bear { background: var(--red-soft); color: #ff7b72; }
  .tile-row .dir.neutral, .tile-row .dir.neu { background: var(--panel-2); color: var(--mute); }
  .tile-row .meta { color: var(--ink-dim); font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tile-row .time { font-size: 10px; color: var(--mute); font-variant-numeric: tabular-nums; }
  .tile-row.idea .score { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 700; font-size: 13px; }
  .tile-row.idea .tier { font-size: 8px; font-weight: 700; padding: 1px 4px; border-radius: 3px; letter-spacing: .5px; }
  .tile-row.idea .tier.TRADE { background: var(--green-soft); color: #7ee787; }
  .tile-row.idea .tier.WATCHLIST { background: var(--amber-soft); color: var(--amber); }
  .tile-row.idea .tier.PASS { background: var(--panel-2); color: var(--mute); }
  .tile-row.idea .ticket { font-size: 10px; color: var(--mute); font-variant-numeric: tabular-nums; }

  .tile-row.pmf .gap { font-weight: 700; font-variant-numeric: tabular-nums; }
  .tile-row.pmf .gap.up { color: var(--green); }
  .tile-row.pmf .gap.dn { color: var(--red); }
  .tile-row.pmf .stat { color: var(--mute); font-size: 11px; font-variant-numeric: tabular-nums; }
  .tile-row.pmf .stat b { color: var(--ink); }
  .tile-row.pmf .trade {
    font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 3px; letter-spacing: .5px;
    background: var(--accent-2); color: white;
  }

  .tile-foot {
    padding: 6px 12px; border-top: 1px solid var(--border);
    font-size: 10px; color: var(--mute); display: flex; gap: 8px; align-items: center;
  }
  .tile-foot .src { font-family: ui-monospace, SFMono-Regular, "Consolas", monospace; color: var(--mute-2); font-size: 9px; }
  .tile-foot .cadence { margin-left: auto; }
  .tile-empty { padding: 18px 14px; text-align: center; color: var(--mute); font-size: 11px; }
  .tile-empty .next { color: var(--mute-2); font-size: 10px; margin-top: 4px; }

  /* ---------- regime tile body (DESK) ---------- */
  .regime-tile-body { padding: 6px 16px 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .regime-tile-body .col .lbl { font-size: 10px; color: var(--mute); letter-spacing: 1px; font-weight: 700; margin-bottom: 8px; }
  .regime-tile-body .col .row { display: flex; gap: 6px; flex-wrap: wrap; }

  /* ---------- narrative ---------- */
  .narrative-body { padding: 8px 16px 14px; font-size: 13px; line-height: 1.55; color: var(--ink-dim); }
  .narrative-body .head { color: var(--ink); font-weight: 600; margin-bottom: 6px; font-size: 14px; }

  /* ---------- positions ---------- */
  .pos-kpis { display: flex; gap: 14px; padding: 4px 12px 9px; font-size: 11px; }
  .pos-kpis div span { color: var(--mute); margin-right: 4px; }
  .pos-table { width: 100%; border-collapse: collapse; }
  .pos-table td { padding: 4px 12px; border-top: 1px solid var(--border); font-size: 11px; font-variant-numeric: tabular-nums; }
  .pos-table td:first-child { font-weight: 700; font-size: 12px; }
  .pos-table td.num { text-align: right; }
  .pos { color: var(--green); } .neg { color: var(--red); }

  /* ---------- data tables inside tiles ---------- */
  .data-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  .data-table thead th {
    position: sticky; top: 0; background: var(--panel-2); color: var(--mute);
    padding: 5px 8px; font-size: 9px; font-weight: 700; letter-spacing: .7px;
    text-transform: uppercase; text-align: left; border-bottom: 1px solid var(--border);
  }
  .data-table thead th.num { text-align: right; }
  .data-table td { padding: 4px 8px; font-size: 11px; border-top: 1px solid var(--border); color: var(--ink-dim); }
  .data-table td.tkr { font-weight: 700; color: var(--ink); font-size: 12px; letter-spacing: .3px; cursor: pointer; }
  .data-table td.tkr:hover { color: var(--accent); text-decoration: underline; }
  .data-table td.num { text-align: right; }
  .data-table td.dir-bull, .data-table td.dir-up { color: var(--green); font-weight: 600; }
  .data-table td.dir-bear, .data-table td.dir-dn { color: var(--red); font-weight: 600; }
  .data-table td.muted { color: var(--mute); }
  .data-table tr:hover { background: rgba(255,255,255,.02); }
  .data-table .pill {
    display: inline-block; padding: 1px 5px; border-radius: 3px;
    font-size: 9px; font-weight: 700; letter-spacing: .4px;
  }
  .data-table .pill.fade, .data-table .pill.sell, .data-table .pill.bear { background: var(--red-soft); color: #ff7b72; }
  .data-table .pill.long, .data-table .pill.buy, .data-table .pill.bull { background: var(--green-soft); color: #7ee787; }
  .data-table .pill.high { background: var(--amber-soft); color: var(--amber); }

  /* ---------- modal (per-ticker scan) ---------- */
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.78); z-index: 200;
    display: none; align-items: flex-start; justify-content: center; padding: 40px 20px;
    overflow-y: auto;
  }
  .modal-backdrop.on { display: flex; }
  .modal {
    background: var(--panel); border: 1px solid var(--border-bright); border-radius: 10px;
    max-width: 760px; width: 100%; min-height: 240px; box-shadow: 0 20px 60px rgba(0,0,0,.7);
  }
  .modal-h { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .modal-h .tkr { font-size: 22px; font-weight: 800; letter-spacing: .6px; color: var(--ink); }
  .modal-h .tier { padding: 3px 9px; border-radius: 4px; font-size: 10px; font-weight: 700; letter-spacing: .6px; }
  .modal-h .tier.TRADE { background: var(--green-soft); color: #7ee787; }
  .modal-h .tier.WATCHLIST { background: var(--amber-soft); color: var(--amber); }
  .modal-h .tier.PASS { background: var(--panel-2); color: var(--mute); }
  .modal-h .score { color: var(--accent); font-weight: 700; font-variant-numeric: tabular-nums; }
  .modal-h .close { margin-left: auto; background: none; border: 0; color: var(--mute); font-size: 22px; cursor: pointer; padding: 0 6px; line-height: 1; }
  .modal-h .close:hover { color: var(--ink); }
  .modal-body { padding: 14px 18px; }
  .modal-loading { padding: 40px 18px; text-align: center; color: var(--mute); }
  .modal-loading .spinner { display: inline-block; width: 28px; height: 28px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; margin-bottom: 14px; }
  .ticket-box {
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px 14px; margin-bottom: 14px;
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
    font-variant-numeric: tabular-nums;
  }
  .ticket-box .field { font-size: 11px; }
  .ticket-box .field .lbl { color: var(--mute); font-size: 9px; letter-spacing: .8px; text-transform: uppercase; margin-bottom: 2px; }
  .ticket-box .field .val { color: var(--ink); font-weight: 700; font-size: 14px; }
  .ticket-box .field .val.bull { color: var(--green); }
  .ticket-box .field .val.bear { color: var(--red); }
  .checks-table { width: 100%; border-collapse: collapse; }
  .checks-table th { padding: 6px 10px; text-align: left; color: var(--mute); font-size: 10px; letter-spacing: .8px; text-transform: uppercase; border-bottom: 1px solid var(--border); }
  .checks-table td { padding: 8px 10px; border-top: 1px solid var(--border); font-size: 12px; color: var(--ink-dim); }
  .checks-table td.name { color: var(--ink); font-weight: 600; min-width: 130px; }
  .checks-table td.status .badge { display: inline-block; padding: 1px 7px; border-radius: 3px; font-size: 9px; font-weight: 700; letter-spacing: .5px; }
  .checks-table td.status .badge.pos { background: var(--green-soft); color: #7ee787; }
  .checks-table td.status .badge.neg { background: var(--red-soft); color: #ff7b72; }
  .checks-table td.status .badge.neu { background: var(--panel-2); color: var(--mute); }
  .checks-table td.score { text-align: right; font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 600; min-width: 50px; }
  .checks-table td.detail { color: var(--mute); font-size: 11px; }

  /* ---------- PNG tiles ---------- */
  .png-tile .png-wrap { background: var(--panel-2); padding: 6px; max-height: 420px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .png-tile img { max-width: 100%; max-height: 408px; display: block; cursor: zoom-in; border-radius: 4px; object-fit: contain; }
  .png-tile .png-hint { padding: 4px 12px 8px; font-size: 10px; color: var(--mute-2); text-align: center; }
  .lightbox {
    position: fixed; inset: 0; background: rgba(0,0,0,.92); z-index: 100;
    display: none; align-items: center; justify-content: center; cursor: zoom-out;
  }
  .lightbox.on { display: flex; }
  .lightbox img { max-width: 96vw; max-height: 96vh; border: 1px solid var(--border); border-radius: 6px; }

  /* ---------- analogs tab ---------- */
  .analog-workspace { display: flex; flex-direction: column; gap: 16px; }
  .analog-toolbar {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 16px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    flex-wrap: wrap;
  }
  .analog-toolbar label { font-size: 10px; color: var(--mute); letter-spacing: .8px; font-weight: 700; text-transform: uppercase; }
  .analog-toolbar input {
    background: var(--bg); color: var(--ink); border: 1px solid var(--border); border-radius: 6px;
    padding: 7px 12px; font: inherit; font-size: 14px; font-weight: 700; letter-spacing: .8px;
    width: 110px; text-transform: uppercase;
  }
  .analog-toolbar input:focus { border-color: var(--accent); outline: none; }
  .analog-profile-line { color: var(--mute); font-size: 12px; flex: 1; padding-left: 8px; }
  .analog-profile-line b { color: var(--ink); }

  .analog-grid { display: grid; grid-template-columns: 280px 1fr; gap: 14px; }

  .analog-conditions {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 4px; align-self: start;
  }
  .analog-conditions h3 {
    margin: 0 12px 8px; font-size: 10px; font-weight: 700; letter-spacing: 1.4px;
    text-transform: uppercase; color: var(--ink-dim);
  }
  .cond-row {
    display: grid; grid-template-columns: 1fr auto; align-items: center;
    padding: 8px 12px; gap: 10px; cursor: pointer;
    border-radius: 5px; transition: background .1s;
  }
  .cond-row:hover { background: var(--panel-2); }
  .cond-row .cond-label { font-size: 12px; font-weight: 600; color: var(--ink); }
  .cond-row .cond-bucket { font-size: 10px; color: var(--mute); font-variant-numeric: tabular-nums; }
  .cond-row .toggle {
    width: 32px; height: 18px; background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 9px; position: relative; transition: background .15s;
  }
  .cond-row .toggle::after {
    content: ""; position: absolute; top: 1px; left: 1px; width: 14px; height: 14px;
    background: var(--mute); border-radius: 50%; transition: transform .15s, background .15s;
  }
  .cond-row.on .toggle { background: rgba(88,166,255,.25); border-color: var(--accent); }
  .cond-row.on .toggle::after { background: var(--accent); transform: translateX(14px); }
  .cond-row.disabled { opacity: 0.45; cursor: not-allowed; }
  .cond-row.disabled .cond-label { color: var(--mute); }
  .cond-row.disabled:hover { background: transparent; }
  .cond-group-h {
    font-size: 9px; font-weight: 700; letter-spacing: 1.4px; color: var(--mute-2);
    text-transform: uppercase; padding: 12px 12px 4px;
    border-top: 1px solid var(--border); margin-top: 6px;
  }
  .cond-group-h:first-child { border-top: 0; margin-top: 0; padding-top: 0; }
  .to-badge {
    display: inline-block; margin-left: 6px;
    padding: 1px 5px; font-size: 8px; font-weight: 700; letter-spacing: .6px;
    background: rgba(167,139,250,.16); color: var(--violet); border: 1px solid rgba(167,139,250,.35);
    border-radius: 3px; vertical-align: middle;
  }

  .analog-results { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .analog-headline {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 18px 22px;
  }
  .analog-headline .big {
    font-size: 44px; font-weight: 800; letter-spacing: -.5px; font-variant-numeric: tabular-nums;
    line-height: 1; margin-bottom: 6px;
  }
  .analog-headline .big.up { color: var(--green); }
  .analog-headline .big.dn { color: var(--red); }
  .analog-headline .label { font-size: 12px; color: var(--mute); margin-bottom: 14px; }
  .analog-headline .breakdown {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px;
    padding-top: 14px; border-top: 1px solid var(--border);
  }
  .analog-headline .col .h { font-size: 10px; color: var(--mute); letter-spacing: 1px; font-weight: 700; text-transform: uppercase; margin-bottom: 4px; }
  .analog-headline .col .n { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .analog-headline .col .n.up { color: var(--green); }
  .analog-headline .col .n.dn { color: var(--red); }
  .analog-headline .col .meta { font-size: 10px; color: var(--mute); margin-top: 2px; }

  .analog-matches {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    overflow: hidden;
  }
  .analog-matches .h {
    padding: 10px 16px; font-size: 11px; font-weight: 700; color: var(--ink-dim);
    letter-spacing: 1px; text-transform: uppercase;
    border-bottom: 1px solid var(--border); background: var(--panel-2);
    display: flex; justify-content: space-between;
  }
  .analog-matches .h .ct { color: var(--mute); font-weight: 400; letter-spacing: .3px; text-transform: none; }
  .analog-matches .body { max-height: 460px; overflow-y: auto; }
  .analog-matches table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  .analog-matches thead th {
    position: sticky; top: 0; background: var(--panel-2); color: var(--mute);
    padding: 6px 14px; font-size: 9px; font-weight: 700; letter-spacing: .8px;
    text-transform: uppercase; text-align: right; border-bottom: 1px solid var(--border);
  }
  .analog-matches thead th:first-child { text-align: left; }
  .analog-matches td { padding: 6px 14px; font-size: 12px; border-top: 1px solid var(--border); text-align: right; color: var(--ink-dim); }
  .analog-matches td:first-child { text-align: left; font-weight: 600; color: var(--ink); }
  .analog-matches td.up { color: var(--green); }
  .analog-matches td.dn { color: var(--red); }

  @media (max-width: 1000px) {
    .analog-grid { grid-template-columns: 1fr; }
  }

  /* ---------- responsive ---------- */
  @media (max-width: 1100px) {
    .tile.span-2 { grid-column: auto; }
    main { padding: 18px 16px 60px; }
    .grid { grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
    .grid.wide { grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); }
  }
  @media (max-width: 760px) {
    /* tablet / large phone */
    .topbar .row1 { flex-wrap: wrap; padding: 8px 12px; gap: 8px; }
    .brand { font-size: 12px; }
    .brand b { display: none; }
    .tabs { order: 3; flex-basis: 100%; }
    .tab { flex: 1; text-align: center; padding: 6px 8px; font-size: 12px; }
    .clock { min-width: 0; font-size: 12px; }
    .updated, .countdown { min-width: 0; font-size: 10px; }
    .refresh-btn { padding: 4px 9px; font-size: 11px; }
    .regime-pill { font-size: 11px; padding: 4px 9px; letter-spacing: .5px; }
    .phase { font-size: 10px; padding: 4px 8px; }
    main { padding: 14px 10px 40px; }
    .regime-strip { padding: 6px 10px; gap: 10px; font-size: 11px; }
    .chip-group { padding-right: 10px; }
    .strip-chip { font-size: 10px; padding: 2px 6px; }
    .grid, .grid.wide, .grid.tight { grid-template-columns: 1fr; gap: 12px; }
    .section { margin-bottom: 24px; }
    .section-h { padding-bottom: 8px; margin-bottom: 10px; }
    .section-h h2 { font-size: 11px; letter-spacing: 1.4px; }
    .section-h .sub { font-size: 11px; }
    .tile { min-height: 140px; border-radius: 8px; }
    .tile-h { padding: 9px 11px 4px; }
    .tile-h .title { font-size: 12px; }
    .tile-sub { padding: 0 11px 6px; font-size: 9px; }
    .tile-row { padding: 5px 11px; gap: 7px; }
    .tile-row .tkr { font-size: 13px; min-width: 52px; }
    .tile-row .meta { font-size: 10px; }
    .tile-foot { padding: 5px 11px; font-size: 9px; }
    .modal { max-width: 100%; margin: 0; border-radius: 8px; }
    .modal-h { padding: 10px 14px; flex-wrap: wrap; gap: 8px; }
    .modal-h .tkr { font-size: 18px; }
    .modal-h .score { font-size: 12px; }
    .modal-body { padding: 12px 14px; }
    .ticket-box { grid-template-columns: 1fr 1fr; gap: 8px; padding: 10px; }
    .ticket-box .field .val { font-size: 12px; }
    .checks-table th, .checks-table td { padding: 6px 8px; font-size: 11px; }
    .checks-table td.detail { font-size: 10px; }
    .modal-backdrop { padding: 20px 8px; }
    .data-table thead th { font-size: 8px; padding: 4px 6px; }
    .data-table td { font-size: 10px; padding: 3px 6px; }
    .data-table td.tkr { font-size: 11px; }
  }
  @media (max-width: 420px) {
    /* small phone — even tighter */
    .brand { font-size: 11px; }
    .tab { font-size: 11px; padding: 5px 6px; }
    .topbar .row1 { gap: 6px; padding: 7px 10px; }
    .updated { display: none; }
    .clock { font-size: 11px; min-width: 0; }
    .countdown { font-size: 9px; }
    .regime-strip { padding: 5px 8px; }
    .chip-group .lbl { font-size: 8px; }
  }
</style>
</head>
<body>
<header class="topbar">
  <div class="row1">
    <div class="brand"><b>TRADE ODDS</b></div>
    <nav class="tabs" id="tabs">
      <a class="tab" data-tab="desk" href="#desk">Desk</a>
      <a class="tab" data-tab="equities" href="#equities">Equities</a>
      <a class="tab" data-tab="options" href="#options">Options</a>
      <span class="tab-sep"></span>
      <a class="tab tab-to" data-tab="tradeodds" href="#tradeodds">Trade Odds</a>
    </nav>
    <div class="spacer"></div>
    <div id="regime-pill" class="regime-pill">…</div>
    <div id="phase" class="phase">…</div>
    <div class="clock" id="clock">…</div>
    <button id="refresh-btn" class="refresh-btn" title="Refresh all data now">↻ Refresh</button>
    <div class="updated" id="updated">loading…</div>
    <div class="countdown" id="countdown" title="time until next auto-refresh">next in 30s</div>
  </div>
  <div class="regime-strip" id="regime-strip"></div>
</header>

<main>
  <div class="tab-panel" id="panel-desk"></div>
  <div class="tab-panel" id="panel-equities"></div>
  <div class="tab-panel" id="panel-options"></div>
  <div class="tab-panel" id="panel-tradeodds">
    <div class="to-subnav">
      <a class="to-subtab active" data-toview="analogs" href="#analogs"><b>Analogs</b><span class="to-subhint">single asset × all history</span></a>
      <a class="to-subtab" data-toview="factor" href="#factor"><b>Factor Match</b><span class="to-subhint">today × universe</span></a>
    </div>

    <div class="to-sub active" id="to-sub-analogs">
      <div class="analog-workspace">
        <div class="analog-toolbar">
          <label>Ticker</label>
          <input id="analog-tkr" type="text" value="SPY" maxlength="8" autocomplete="off">
          <button id="analog-go" class="refresh-btn">Run</button>
          <span id="analog-profile" class="analog-profile-line">…</span>
        </div>
        <div class="analog-grid">
          <aside class="analog-conditions" id="analog-conditions">…</aside>
          <section class="analog-results" id="analog-results"><div class="modal-loading"><div class="spinner"></div><div>Loading SPY analogs…</div></div></section>
        </div>
      </div>
    </div>

    <div class="to-sub" id="to-sub-factor">
      <div class="analog-workspace">
        <div class="analog-toolbar">
          <label>Universe</label>
          <span id="fm-universe" style="font-size:12px;color:var(--ink-dim);font-weight:600">…</span>
          <label style="margin-left:14px">Min Days</label>
          <input id="fm-minN" type="number" min="1" value="10" style="width:60px">
          <label style="margin-left:14px">Sort</label>
          <select id="fm-sort" style="background:var(--bg);color:var(--ink);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font:inherit;font-size:12px">
            <option value="pctPos_5d">5D Win%</option>
            <option value="avg_5d">5D Avg Return</option>
            <option value="pctPos_1d">1D Win%</option>
            <option value="pctPos_10d">10D Win%</option>
            <option value="avg_10d">10D Avg Return</option>
            <option value="N">Sample Size</option>
          </select>
          <button id="fm-go" class="refresh-btn">Run Scan</button>
          <span id="fm-meta" class="analog-profile-line">…</span>
        </div>
        <div class="analog-grid">
          <aside class="analog-conditions" id="fm-conditions">…</aside>
          <section class="analog-results" id="fm-results"><div class="modal-loading"><div class="spinner"></div><div>Scanning universe…</div><div style="margin-top:6px;font-size:10px;color:var(--mute-2)">~50–600 tickers × historical analog match — 10–30s on first load.</div></div></section>
        </div>
      </div>
    </div>
  </div>
</main>

<div class="lightbox" id="lightbox"><img id="lightbox-img"></div>

<div class="modal-backdrop" id="modal-backdrop">
  <div class="modal" id="modal">
    <div class="modal-h" id="modal-header"><span class="tkr">…</span><button class="close" id="modal-close">×</button></div>
    <div class="modal-body" id="modal-body"><div class="modal-loading"><div class="spinner"></div><div>Running confluence read…</div></div></div>
  </div>
</div>

<script>
// ---------- formatting ----------
const fmt = (n, d) => { d = d == null ? 2 : d; return (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); };
const sign = (n) => n == null ? "" : (n >= 0 ? "+" : "");
const pnlClass = (n) => n == null ? "" : (n >= 0 ? "pos" : "neg");
const ago = (ts) => {
  if (!ts) return "—";
  const t = typeof ts === "string" ? new Date(ts).getTime() : Number(ts);
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
};
const freshness = (ts, hotMin = 15, warmMin = 60) => {
  if (!ts) return "stale";
  const t = typeof ts === "string" ? new Date(ts).getTime() : Number(ts);
  const minAgo = (Date.now() - t) / 60000;
  if (minAgo < hotMin) return "fresh";
  if (minAgo < warmMin) return "warm";
  return "stale";
};
const chipClass = (chg) => chg == null ? "flat" : (chg > 0.1 ? "up" : (chg < -0.1 ? "dn" : "flat"));
const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const fmtPrem = (n) => { if (n == null) return "—"; const a = Math.abs(n); if (a >= 1e6) return (n/1e6).toFixed(1)+"M"; if (a >= 1e3) return (n/1e3).toFixed(1)+"K"; return Number(n).toFixed(0); };

// ---------- tile builder ----------
function tile(opts) {
  const cls = ["tile", opts.freshness || "stale", opts.cls || ""].filter(Boolean).join(" ");
  const badge = opts.badge != null ? '<span class="badge ' + (opts.badgeClass || '') + '">' + opts.badge + '</span>' : '';
  const subAgo = opts.subAgo ? '<span class="ago ' + (opts.freshness || 'stale') + '">' + opts.subAgo + '</span>' : '';
  const subExtra = opts.sub ? '<span>' + opts.sub + '</span>' : '';
  const body = opts.bodyHtml != null ? opts.bodyHtml :
    (opts.rows && opts.rows.length
      ? opts.rows.join('')
      : '<div class="tile-empty">' + (opts.empty || 'No firings yet') + (opts.nextRun ? '<div class="next">' + opts.nextRun + '</div>' : '') + '</div>');
  const foot = opts.foot ? '<div class="tile-foot">' + opts.foot + '</div>' : '';
  return '<div class="' + cls + '"><div class="tile-h"><span class="title">' + escapeHtml(opts.title) + '</span>' + badge + '</div><div class="tile-sub">' + subAgo + subExtra + '</div><div class="tile-body">' + body + '</div>' + foot + '</div>';
}

// ---------- signal-bus generic tile ----------
function sigRow(s, metaFn) {
  const dir = (s.dir || "neutral").toLowerCase();
  const meta = metaFn ? metaFn(s) : '';
  return '<div class="tile-row"><span class="tkr" data-tkr="' + escapeHtml(s.ticker || '?') + '" style="cursor:pointer" title="open confluence scan">' + escapeHtml(s.ticker || '?') + '</span><span class="dir ' + dir + '">' + dir.slice(0, 4).toUpperCase() + '</span><span class="meta">' + meta + '</span><span class="time">' + ago(s.ts) + '</span></div>';
}

const SIG_RENDERERS = {
  'uw-custom':       (s) => { const m = s.meta||{}; return escapeHtml((m.alertType||m.type||'') + (m.strike?(' '+m.strike):'') + (m.expiry?(' '+m.expiry):'') + (m.premium?(' · $'+Number(m.premium).toLocaleString()):'') ); },
  'ema-cross-5m':    (s) => { const m = s.meta||{}; return 'EMA9 ' + fmt(m.ema9) + ' / EMA20 ' + fmt(m.ema20) + (m.volMult?' · '+fmt(m.volMult,1)+'x vol':''); },
  'stocktwits':      (s) => { const m = s.meta||{}; return 'rank #' + (m.rank||'?') + (m.changePct!=null?' · '+sign(m.changePct)+fmt(m.changePct,1)+'%':''); },
  'high-vol-movers': (s) => { const m = s.meta||{}; return sign(m.changePerc)+fmt(m.changePerc,1)+'% · ' + fmt(m.volMultiple,1) + 'x vol' + (m.atrMultiple?' · '+fmt(m.atrMultiple,1)+' ATR':''); },
  'reddit':          (s) => { const m = s.meta||{}; return (m.count||0) + ' mentions' + (m.subs?' in '+escapeHtml(m.subs):''); },
  'news-mover-bind': (s) => { const m = s.meta||{}; return sign(m.chg)+fmt(m.chg,1)+'%' + (m.catalysts&&m.catalysts.length?' · '+escapeHtml(m.catalysts.slice(0,2).join(', ')):''); },
  'wakeup':          (s) => { const m = s.meta||{}; return sign(m.c2c_pct)+fmt(m.c2c_pct,1)+'% · vol '+fmt(m.vol_mult,1)+'x · RSI '+fmt(m.rsi,0); },
  'trade-finder':    (s) => { const m = s.meta||{}; return escapeHtml(m.setup||'') + (m.score!=null?' · score '+fmt(m.score,0):''); },
  'email-research':  (s) => { const m = s.meta||{}; return (m.mentions||1) + ' mentions' + (m.subjects&&m.subjects[0]?' · ' + escapeHtml(m.subjects[0].slice(0,52)) :''); },
  'ti-email':        (s) => { const m = s.meta||{}; return escapeHtml(m.newsletter || m.source || ''); },
  'vol-spike':       (s) => { const m = s.meta||{}; return sign(m.move)+fmt(m.move,1)+'% · '+fmt(m.volMult,1)+'x vol · $'+fmt(m.price); },
};

function sigTile(spec, sigs) {
  const list = (sigs || []).slice(0, spec.limit || 6);
  const renderer = SIG_RENDERERS[spec.src] || ((s) => escapeHtml(s.src));
  const rows = list.map(s => sigRow(s, renderer));
  const newest = sigs && sigs[0] ? sigs[0].ts : null;
  const fr = freshness(newest, spec.hotMin || 15, spec.warmMin || 60);
  const total = (sigs || []).length;
  const showingMore = total > list.length ? ' · showing ' + list.length + ' of ' + total : '';
  return tile({
    title: spec.title,
    subAgo: newest ? 'last fire ' + ago(newest) : '',
    sub: (spec.cadence || '') + showingMore,
    badge: total ? total + (total === 1 ? ' signal' : ' signals') : 'quiet',
    badgeClass: total > 5 ? 'hot' : (total > 0 ? 'warm' : ''),
    freshness: fr,
    rows: rows,
    empty: spec.emptyMsg || 'No firings in last 6h',
    nextRun: spec.nextRun,
    foot: '<span class="src">' + spec.src + '</span><span class="cadence">' + (spec.cadence || '') + '</span>',
    cls: spec.scroll ? 'scroll' : '',
  });
}

// ---------- specialized tile renderers ----------
function ideaBoardTile(ib) {
  if (!ib) return tile({ title: 'Idea Board', freshness: 'stale', empty: 'No idea board run yet', foot: '<span class="src">idea_board.json</span><span class="cadence">7:30 · 10:30 · 13:30 · 15:30 · 16:15</span>' });
  const all = [
    ...ib.topLongs.map(i => ({ ...i, _kind: 'long' })),
    ...ib.topShorts.map(i => ({ ...i, _kind: 'short' })),
    ...ib.dislocations.map(i => ({ ...i, _kind: 'disl' })),
  ];
  const rows = all.slice(0, 10).map(i => {
    const t = i.ticket || {};
    const ticket = t.entry ? ('ENT ' + fmt(t.entry) + ' · STP ' + fmt(t.stop) + ' · T1 ' + fmt(t.t1) + ' (' + fmt(t.rr1,1) + 'R)') : '';
    return '<div class="tile-row idea"><span class="tkr">' + escapeHtml(i.ticker) + '</span><span class="tier ' + (i.tier||'PASS') + '">' + (i.tier||'') + '</span><span class="dir ' + (i.direction||'') + '">' + (i.direction === 'long' ? '▲' : '▼') + ' ' + escapeHtml(i.setup||'') + '</span><span class="ticket">' + ticket + '</span><span class="score">' + fmt(i.score,1) + '</span></div>';
  });
  return tile({
    title: 'Idea Board',
    subAgo: 'last run ' + ago(ib.ts),
    sub: ib.candidatesRun ? ('scored ' + ib.validResults + ' of ' + ib.candidatesRun) : '',
    badge: ib.topLongs.length + 'L · ' + ib.topShorts.length + 'S · ' + ib.dislocations.length + 'D',
    badgeClass: 'hot',
    freshness: freshness(ib.ts, 60, 240),
    rows: rows,
    empty: 'No ranked ideas in latest run',
    foot: '<span class="src">idea_board.json</span><span class="cadence">5x daily</span>',
    cls: 'scroll span-2',
  });
}

function regimeTileFull(r) {
  if (!r) return tile({ title: 'Tape Regime', empty: 'whats_working daemon not running', foot: '<span class="src">whats_working.json</span>' });
  const cChip = x => '<span class="strip-chip ' + chipClass(x.chg) + '"><span class="t">' + x.ticker + '</span><span class="num">' + sign(x.chg) + fmt(x.chg,1) + '%</span></span>';
  const idx = r.indices.map(cChip).join('');
  const m7 = r.mag7.map(cChip).join('');
  const secTop = r.sectors.slice(0,3).map(cChip).join('');
  const secBot = r.sectors.slice(-3).reverse().map(cChip).join('');
  const themes = r.themes.map(t => '<span class="strip-chip ' + chipClass(t.avg) + '"><span class="t">' + escapeHtml(t.name) + '</span><span class="num">' + sign(t.avg) + fmt(t.avg,1) + '% (' + t.greens + '/' + t.total + ')</span></span>').join('');
  const body = '<div class="regime-tile-body">' +
    '<div class="col"><div class="lbl">INDICES</div><div class="row">' + idx + '</div></div>' +
    '<div class="col"><div class="lbl">MAG 7</div><div class="row">' + m7 + '</div></div>' +
    '<div class="col"><div class="lbl">SECTORS · TOP 3</div><div class="row">' + secTop + '</div></div>' +
    '<div class="col"><div class="lbl">SECTORS · BOTTOM 3</div><div class="row">' + secBot + '</div></div>' +
    '<div class="col" style="grid-column:1 / -1"><div class="lbl">THEMES</div><div class="row">' + themes + '</div></div>' +
    '</div>';
  return tile({
    title: 'Tape Regime · Full Read',
    subAgo: 'last tick ' + ago(r.updatedAt),
    sub: 'continuous · 20s tick',
    badge: r.regimeTag, badgeClass: 'hot',
    freshness: freshness(r.updatedAt, 5, 30),
    bodyHtml: body,
    foot: '<span class="src">whats_working.json</span><span class="cadence">launchd daemon</span>',
    cls: 'span-2',
  });
}

function narrativeTile(n) {
  if (!n) return tile({ title: 'Day Narrative', empty: 'No narrative file yet', foot: '<span class="src">day_narrative.json</span><span class="cadence">8 · 10 · 12:30 · 15:00</span>' });
  const hasContent = n.headline || n.summary || (n.bullets && n.bullets.length);
  const bodyHtml = hasContent
    ? '<div class="narrative-body">' + (n.headline ? '<div class="head">' + escapeHtml(n.headline) + '</div>' : '') + (n.summary ? '<div>' + escapeHtml(n.summary).slice(0, 540) + '</div>' : '') + '</div>'
    : '<div class="tile-empty">Narrative engine ran but produced no headline yet.<div class="next">Next run: 12:30 or 15:00 ET</div></div>';
  return tile({
    title: 'Day Narrative',
    subAgo: ago(n.updatedAt),
    freshness: freshness(n.updatedAt, 60, 240),
    bodyHtml,
    foot: '<span class="src">day_narrative.json</span><span class="cadence">4x daily</span>',
  });
}

function gammaTile(g) {
  if (!g || (!g.state && !g.status)) return tile({ title: '0DTE Gamma Pin', empty: 'gamma_pin daemon not reporting', foot: '<span class="src">gamma_pin_daemon</span><span class="cadence">launchd</span>' });
  const st = g.state || {};
  const lastTouch = st.lastTouch || {};
  const lastPushes = st.lastPushes || {};
  const touches = Object.entries(lastTouch)
    .map(([tkr, v]) => ({ ticker: tkr, side: v && v.side, at: v && v.at }))
    .filter(t => t.at).sort((a, b) => b.at - a.at);
  const allPushTs = Object.values(lastPushes).filter(v => typeof v === 'number');
  const newestPush = allPushTs.length ? Math.max(...allPushTs) : null;
  const pushCount = allPushTs.filter(t => Date.now() - t < 60 * 60 * 1000).length;
  const fr = freshness(newestPush, 15, 60);
  const rows = touches.slice(0, 5).map(t => {
    const side = String(t.side || '').toLowerCase();
    const dirClass = side === 'call' ? 'bullish' : side === 'put' ? 'bearish' : 'neutral';
    return '<div class="tile-row"><span class="tkr">' + escapeHtml(t.ticker) + '</span><span class="dir ' + dirClass + '">' + side.toUpperCase() + '</span><span class="meta">pin touch</span><span class="time">' + ago(t.at) + '</span></div>';
  });
  return tile({
    title: '0DTE Gamma Pin',
    subAgo: newestPush ? 'last push ' + ago(newestPush) : 'no recent pushes',
    sub: 'SPY · QQQ · IWM pin watch',
    badge: pushCount + ' alerts · 60m',
    badgeClass: pushCount > 3 ? 'hot' : (pushCount > 0 ? 'warm' : ''),
    freshness: fr,
    rows: rows.length ? rows : null,
    empty: 'No pin touches recorded',
    foot: '<span class="src">gamma_pin_daemon_state.json</span><span class="cadence">live daemon · session ' + escapeHtml(String(st.sessionDate || '')) + '</span>',
  });
}

function uwTideTile(uw) {
  if (!uw) return tile({ title: 'UW Market Tide', empty: 'No UW regime data', foot: '<span class="src">uw_market_regime.json</span>' });
  const tide = uw.tide || {};
  const tideRegime = String(tide.regime || '').toLowerCase();
  const bulls = (uw.topSectorsBull || []).slice(0,3).map(x => '<div class="tile-row"><span class="tkr">' + escapeHtml(x.ticker) + '</span><span class="dir bullish">BULL</span><span class="meta">net +$' + fmtPrem(x.netPrem) + ' · ' + sign(x.chg*100) + fmt(x.chg*100,2) + '%</span></div>').join('');
  const bears = (uw.topSectorsBear || []).slice(0,3).map(x => '<div class="tile-row"><span class="tkr">' + escapeHtml(x.ticker) + '</span><span class="dir bearish">BEAR</span><span class="meta">net −$' + fmtPrem(Math.abs(x.netPrem)) + ' · ' + sign(x.chg*100) + fmt(x.chg*100,2) + '%</span></div>').join('');
  const fr = freshness(uw.ts, 60, 1440);
  return tile({
    title: 'UW Market Tide',
    subAgo: ago(uw.ts),
    sub: tide.momentum || '',
    badge: tide.regime || '?',
    badgeClass: tideRegime === 'bullish' ? 'hot' : (tideRegime === 'bearish' ? 'cold' : ''),
    freshness: fr,
    bodyHtml: (bulls || bears) ? (bulls + bears) : '<div class="tile-empty">No sector lean data</div>',
    foot: '<span class="src">uw_market_regime.json</span><span class="cadence">intraday</span>',
  });
}

function uwRollupPngTile(meta) {
  if (!meta || !meta.exists) return tile({ title: 'UW Flow Rollup', empty: 'uw_flow_rollup.mjs has not produced a card yet', foot: '<span class="src">card_uw_flow_rollup.png</span><span class="cadence">post-RTH</span>' });
  const fr = freshness(meta.mtime, 60, 480);
  return tile({
    title: 'UW Flow Rollup',
    subAgo: ago(meta.mtime),
    sub: 'EOD options flow synthesis',
    badge: 'card', badgeClass: '',
    freshness: fr,
    bodyHtml: '<div class="png-wrap"><img src="/png/' + meta.file + '?t=' + meta.mtime + '"></div><div class="png-hint">click to enlarge</div>',
    foot: '<span class="src">uw_flow_rollup.mjs</span><span class="cadence">post-RTH</span>',
    cls: 'png-tile',
  });
}

function pngTile(title, meta, src, schedule, span) {
  if (!meta || !meta.exists) return tile({ title, empty: 'Scanner has not produced an image yet', foot: '<span class="src">' + src + '</span>' });
  const fr = freshness(meta.mtime, 120, 720);
  return tile({
    title, subAgo: ago(meta.mtime),
    sub: schedule || '',
    badge: 'card', freshness: fr,
    bodyHtml: '<div class="png-wrap"><img src="/png/' + meta.file + '?t=' + meta.mtime + '"></div><div class="png-hint">click to enlarge</div>',
    foot: '<span class="src">' + src + '</span>' + (schedule ? '<span class="cadence">' + schedule + '</span>' : ''),
    cls: 'png-tile' + (span ? ' span-2' : ''),
  });
}

function positionsTile(positions, acct, updatedAt) {
  if (!positions || !positions.length) return tile({ title: 'Positions', empty: 'No positions loaded', foot: '<span class="src">positions.json</span>' });
  const rows = positions.slice(0, 12).map(p => {
    const dCls = pnlClass(p.dayPct); const uCls = pnlClass(p.unreal);
    return '<tr><td>' + p.symbol + '</td><td class="num">' + fmt(p.qty,0) + '</td><td class="num">' + fmt(p.last) + '</td><td class="num ' + dCls + '">' + (p.dayPct==null?'—':sign(p.dayPct)+fmt(p.dayPct,2)+'%') + '</td><td class="num ' + uCls + '">$' + fmt(p.unreal,0) + '</td></tr>';
  }).join('');
  const kpi = '<div class="pos-kpis"><div><span>MV</span><b>$' + fmt(acct.mv,0) + '</b></div><div><span>Day</span><b class="' + pnlClass(acct.dayPnl) + '">$' + fmt(acct.dayPnl,0) + '</b></div><div><span>Unreal</span><b class="' + pnlClass(acct.unreal) + '">$' + fmt(acct.unreal,0) + '</b></div></div>';
  return '<div class="tile fresh"><div class="tile-h"><span class="title">Positions</span><span class="badge">' + positions.length + ' open</span></div><div class="tile-sub"><span>updated ' + (updatedAt ? updatedAt.slice(0,10) : '—') + '</span></div>' + kpi + '<div class="tile-body">' + '<table class="pos-table"><tbody>' + rows + '</tbody></table></div><div class="tile-foot"><span class="src">positions.json</span><span class="cadence">hourly</span></div></div>';
}

function setupBucketTile(scans, bucket, label, src, schedule) {
  const result = scans && Array.isArray(scans.results) ? scans.results.find(r => r.setup === bucket) : null;
  const fires = result?.fired || [];
  const ts = scans?.ts;
  const rows = fires.slice(0, 7).map(f => '<div class="tile-row"><span class="tkr">' + escapeHtml(f.ticker || '?') + '</span><span class="dir ' + (f.dir || 'neutral') + '">' + (f.dir||'neu').slice(0,4).toUpperCase() + '</span><span class="meta">' + escapeHtml(f.detail || '') + '</span></div>');
  return tile({
    title: label,
    subAgo: ts ? 'last scan ' + ago(ts) : '',
    sub: schedule,
    badge: fires.length + (fires.length === 1 ? ' hit' : ' hits'),
    badgeClass: fires.length > 5 ? 'hot' : (fires.length > 0 ? 'warm' : ''),
    freshness: freshness(ts, 120, 480),
    rows,
    empty: 'No hits in latest scan',
    foot: '<span class="src">' + src + '</span><span class="cadence">' + schedule + '</span>',
  });
}

// ---------- data-table tile renderers (replace the PNG screenshots) ----------
function clickableTkr(t) {
  return '<td class="tkr" data-tkr="' + escapeHtml(t) + '" title="open confluence scan">' + escapeHtml(t) + '</td>';
}

function meanReversionTile(d) {
  if (!d) return tile({ title: 'Mean Reversion Scan', empty: 'mean_reversion_scan.mjs has not produced JSON yet', foot: '<span class="src">mean_reversion_scan.json</span><span class="cadence">EOD</span>' });
  const shorts = d.shorts || []; const longs = d.longs || [];
  const fmtRsi = (n) => n == null ? '—' : fmt(n, 1);
  const fmtBb = (n) => n == null ? '—' : '$' + fmt(n);
  const fmtDist = (n) => n == null ? '—' : sign(n) + fmt(n, 2) + '%';
  const row = (h, side) => {
    const sideCls = side === 'FADE' ? 'fade' : 'long';
    const rsiCls = (side === 'FADE' && h.overbought) ? 'dir-dn' : (side === 'LONG' && h.oversold) ? 'dir-up' : '';
    const bbLvl = side === 'FADE' ? h.bbUpper : h.bbLower;
    const bbCls = (side === 'FADE' && h.aboveUpper) ? 'dir-dn' : (side === 'LONG' && h.belowLower) ? 'dir-up' : 'muted';
    const prio = h.isHigh ? '<span class="pill high">HIGH</span>' : '<span class="muted">watch</span>';
    return '<tr>' + clickableTkr(h.ticker) + '<td><span class="pill ' + sideCls + '">' + side + '</span></td><td class="num ' + rsiCls + '">' + fmtRsi(h.rsi) + '</td><td class="num">$' + fmt(h.price) + '</td><td class="num ' + bbCls + '">' + fmtBb(bbLvl) + '</td><td class="num ' + bbCls + '">' + fmtDist(h.bbDistPct) + '</td><td>' + prio + '</td></tr>';
  };
  const rows = [...shorts.map(h => row(h, 'FADE')), ...longs.map(h => row(h, 'LONG'))].join('');
  const totalHits = shorts.length + longs.length;
  const body = totalHits ? '<table class="data-table"><thead><tr><th>Tkr</th><th>Side</th><th class="num">RSI14</th><th class="num">Price</th><th class="num">BB Lvl</th><th class="num">Dist</th><th>Pri</th></tr></thead><tbody>' + rows + '</tbody></table>' : null;
  const counts = d.counts || {};
  return tile({
    title: 'Mean Reversion Scan',
    subAgo: 'last scan ' + ago(d.ts),
    sub: 'RSI>' + (d.rsiHigh || 75) + ' / <' + (d.rsiLow || 25) + ' · outside BB',
    badge: totalHits + ' hits' + (counts.high ? ' · ' + counts.high + ' HIGH' : ''),
    badgeClass: counts.high ? 'hot' : (totalHits > 0 ? 'warm' : ''),
    freshness: freshness(d.ts, 120, 480),
    bodyHtml: body,
    empty: 'No mean-reversion hits in latest scan',
    foot: '<span class="src">mean_reversion_scan.json · mean_reversion_scan.mjs</span><span class="cadence">EOD</span>',
    cls: 'scroll',
  });
}

function rsScanTile(d) {
  if (!d) return tile({ title: 'RS Scan', empty: 'relative_strength_scan.mjs has not produced JSON yet', foot: '<span class="src">rs_scan.json</span><span class="cadence">intraday + EOD</span>' });
  const fmtStat = (s) => {
    if (!s || !s.n) return '<span class="muted">—</span>';
    const avg = s.avg == null ? '—' : sign(s.avg) + fmt(s.avg, Math.abs(s.avg) >= 10 ? 1 : 2) + '%';
    const cls = s.avg == null ? 'muted' : (s.avg > 0 ? 'dir-up' : 'dir-dn');
    return '<span class="' + cls + '">' + avg + ' <span class="muted">(' + Math.round(s.pct_pos) + '%)</span></span>';
  };
  const row = (h) => {
    const cls = h.kind === 'leader' ? 'dir-up' : 'dir-dn';
    const sideCls = h.kind === 'leader' ? 'bull' : 'bear';
    const vol = h.volRatio != null ? fmt(h.volRatio, 1) + 'x' : '—';
    const vwap = h.vwapDist != null ? sign(h.vwapDist) + fmt(h.vwapDist, 1) + '%' : '—';
    const n = (h.stats && h.stats.n) || 0;
    return '<tr>' + clickableTkr(h.ticker) + '<td><span class="pill ' + sideCls + '">' + (h.kind === 'leader' ? 'LEAD' : 'LAG') + '</span></td><td class="num">$' + fmt(h.last) + '</td><td class="num ' + cls + '">' + sign(h.changePct) + fmt(h.changePct, 2) + '%</td><td class="num ' + cls + '">' + sign(h.rs) + fmt(h.rs, 2) + '%</td><td class="num">' + vwap + '</td><td class="num">' + vol + '</td><td class="num muted">' + n + '</td><td class="num">' + fmtStat(h.stats && h.stats.bod) + '</td><td class="num">' + fmtStat(h.stats && h.stats.next_open) + '</td><td class="num">' + fmtStat(h.stats && h.stats.next_close) + '</td></tr>';
  };
  const leaders = d.leaders || []; const laggards = d.laggards || [];
  const rows = [...leaders.map(row), ...laggards.map(row)].join('');
  const body = rows ? '<table class="data-table"><thead><tr><th>Tkr</th><th>Kind</th><th class="num">Last</th><th class="num">Day%</th><th class="num">RS%</th><th class="num">VWAP</th><th class="num">Vol</th><th class="num">N</th><th class="num">BoD</th><th class="num">NxOp</th><th class="num">NxCl</th></tr></thead><tbody>' + rows + '</tbody></table>' : null;
  const counts = d.counts || {};
  return tile({
    title: 'RS Scan',
    subAgo: 'last run ' + ago(d.ts),
    sub: 'SPY ' + sign(d.spyChange) + fmt(d.spyChange, 2) + '%' + (d.qqqChange != null ? ' · QQQ ' + sign(d.qqqChange) + fmt(d.qqqChange, 2) + '%' : '') + ' · probe ' + (d.probeWindow || ''),
    badge: (counts.leaders || 0) + 'L · ' + (counts.laggards || 0) + 'Lg',
    badgeClass: 'hot',
    freshness: freshness(d.ts, 60, 240),
    bodyHtml: body,
    empty: 'No RS leaders or laggards above threshold',
    foot: '<span class="src">rs_scan.json · relative_strength_scan.mjs</span><span class="cadence">intraday + EOD</span>',
    cls: 'scroll span-2',
  });
}

function statEdgeTile(d) {
  if (!d) return tile({ title: 'Statistical Edge', empty: 'statistical_edge_scanner.mjs has not produced JSON yet', foot: '<span class="src">statistical_edge_scan.json</span><span class="cadence">3:30 · 4:15</span>' });
  const fmtFade = (pct, avg) => {
    if (pct == null) return '<span class="muted">—</span>';
    const cls = pct >= 65 ? 'dir-dn' : (pct <= 35 ? 'dir-up' : '');
    const avgStr = avg != null ? ' ' + sign(avg) + fmt(avg, 1) + '%' : '';
    return '<span class="' + cls + '">' + Math.round(pct) + '%</span><span class="muted">' + avgStr + '</span>';
  };
  const ideas = d.ideas || [];
  const row = (i) => {
    const moveCls = i.todayMove >= 0 ? 'dir-up' : 'dir-dn';
    const tierCls = i.edgeTier === 'HIGH' ? 'high' : '';
    const b = i.base || {};
    const ind = i.intraday || {};
    return '<tr>' + clickableTkr(i.ticker) + '<td><span class="pill ' + tierCls + '">' + (i.edgeTier || '—') + '</span></td><td class="num ' + moveCls + '">' + sign(i.todayMove) + fmt(i.todayMove, 1) + '%</td><td class="num">' + fmtFade(b.fade_rate_1d, b.avg_fwd1d) + '</td><td class="num">' + fmtFade(b.fade_rate_5d, b.avg_fwd5d) + '</td><td class="num">' + fmtFade(b.fade_rate_10d, b.avg_fwd10d) + '</td><td class="num">' + (ind.N >= 3 ? fmtFade(ind.fade_rate_rest, ind.avg_rest_pct) : '<span class="muted">—</span>') + '</td><td class="num muted">' + (b.N || '—') + '</td></tr>';
  };
  const rows = ideas.map(row).join('');
  const body = rows ? '<table class="data-table"><thead><tr><th>Tkr</th><th>Edge</th><th class="num">Move%</th><th class="num">1d Fade</th><th class="num">5d Fade</th><th class="num">10d Fade</th><th class="num">RoD</th><th class="num">N</th></tr></thead><tbody>' + rows + '</tbody></table>' : null;
  const counts = d.counts || {};
  return tile({
    title: 'Statistical Edge',
    subAgo: 'last run ' + ago(d.ts),
    sub: 'ClickHouse analogs · fade rate = % of times faded next d',
    badge: (counts.high || 0) + ' high · ' + (counts.moderate || 0) + ' mod',
    badgeClass: counts.high > 0 ? 'hot' : (ideas.length > 0 ? 'warm' : ''),
    freshness: freshness(d.ts, 60, 240),
    bodyHtml: body,
    empty: 'No movers with statistical edge today',
    foot: '<span class="src">statistical_edge_scan.json · statistical_edge_scanner.mjs</span><span class="cadence">3:30 · 4:15</span>',
    cls: 'scroll',
  });
}

function uwRollupTile(d) {
  if (!d) return tile({ title: 'UW Flow Rollup', empty: 'uw_flow_rollup.mjs has not produced JSON yet — runs post-RTH', foot: '<span class="src">uw_flow_rollup.json</span><span class="cadence">post-RTH</span>' });
  const t = d.totals || {};
  const callPct = t.prem ? Math.round(100 * t.callPrem / t.prem) : 0;
  const putPct = 100 - callPct;
  const fmtTrig = (trig) => {
    const parts = [];
    for (const [k, v] of Object.entries(trig || {})) if (v > 0) parts.push(k + ' ' + v);
    return parts.length ? parts.join(' · ') : '<span class="muted">—</span>';
  };
  const row = (r) => {
    const cp = r.prem ? Math.round(100 * r.callPrem / r.prem) : 0;
    const cpCls = cp >= 60 ? 'dir-up' : (cp <= 40 ? 'dir-dn' : '');
    const sideCls = r.isIndex ? 'high' : (cp >= 60 ? 'bull' : (cp <= 40 ? 'bear' : ''));
    const sideLbl = r.isIndex ? 'IDX' : (cp >= 60 ? 'CALL' : (cp <= 40 ? 'PUT' : 'MIX'));
    const askPctStr = (r.askPct * 100).toFixed(0) + '%';
    return '<tr>' + clickableTkr(r.sym) + '<td><span class="pill ' + sideCls + '">' + sideLbl + '</span></td><td class="num">$' + fmtPrem(r.prem) + '</td><td class="num ' + cpCls + '">' + cp + '/' + (100-cp) + '</td><td class="num muted">' + askPctStr + '</td><td class="num">' + (r.prints || 0) + '</td><td class="muted" style="font-size:10px">' + fmtTrig(r.triggers) + '</td><td class="muted" style="font-size:10px">' + escapeHtml(r.strikes || '') + '</td><td class="muted" style="font-size:10px">' + escapeHtml(r.exp || '') + '</td></tr>';
  };
  const rows = (d.tickers || []).map(row).join('');
  const body = rows ? '<table class="data-table"><thead><tr><th>Tkr</th><th>Side</th><th class="num">$ Prem</th><th class="num">C/P</th><th class="num">Ask%</th><th class="num">Prints</th><th>Trigs</th><th>Strikes</th><th>Exp</th></tr></thead><tbody>' + rows + '</tbody></table>' : null;
  return tile({
    title: 'UW Flow Rollup',
    subAgo: 'last run ' + ago(d.ts),
    sub: t.names + ' names · ' + t.prints + ' prints · $' + fmtPrem(t.prem) + ' total · ' + callPct + 'C/' + putPct + 'P',
    badge: (d.tickers || []).length + ' rows' + (d.omitted ? ' · +' + d.omitted + ' more' : ''),
    badgeClass: 'hot',
    freshness: freshness(d.ts, 60, 240),
    bodyHtml: body,
    empty: 'No flow rollup data',
    foot: '<span class="src">uw_flow_rollup.json · uw_flow_rollup.mjs</span><span class="cadence">post-RTH · firehose + custom</span>',
    cls: 'scroll span-2',
  });
}

function premarketFadesTile(pf) {
  if (!pf) return tile({ title: 'Premarket Fades', empty: 'premarket_fade_scanner.mjs not run today', foot: '<span class="src">premarket_fades.json</span><span class="cadence">9:25am ET</span>' });
  const ideas = pf.ideas || [];
  const rows = ideas.slice(0, 12).map(i => {
    const gapCls = i.gapPct > 0 ? 'up' : 'dn';
    const probPct = (i.bestProb != null ? (i.bestProb * 100).toFixed(0) : '?') + '%';
    return '<div class="tile-row pmf"><span class="tkr" data-tkr="' + escapeHtml(i.ticker) + '" style="cursor:pointer" title="open confluence scan">' + escapeHtml(i.ticker) + '</span><span class="trade">' + escapeHtml(i.trade || 'FADE') + '</span><span class="gap ' + gapCls + '">' + sign(i.gapPct) + fmt(i.gapPct,2) + '%</span><span class="stat">@$' + fmt(i.price) + '</span><span class="stat" style="margin-left:auto"><b>' + probPct + '</b> · ' + escapeHtml(i.bestTF || '?') + ' · n=' + (i.bestN || '?') + '</span></div>';
  });
  return tile({
    title: 'Premarket Fades',
    subAgo: 'computed ' + ago(pf.updatedAt),
    sub: 'gap fade probabilities (1m/3m/5m/10m/15m)',
    badge: ideas.length + ' setups', badgeClass: ideas.length > 3 ? 'hot' : (ideas.length > 0 ? 'warm' : ''),
    freshness: freshness(pf.updatedAt, 360, 1440),
    rows, empty: 'No premarket fade setups today',
    foot: '<span class="src">premarket_fades.json · premarket_fade_scanner.mjs</span><span class="cadence">9:25am ET</span>',
  });
}

function premarketGappersTile(pg) {
  if (!pg) return tile({ title: 'Premarket Gappers', empty: 'massive_premarket_gaps has not run today', foot: '<span class="src">massive_premarket_gaps.mjs</span><span class="cadence">premarket</span>' });
  if (pg.source === 'png' && pg.png) return pngTile('Premarket Gappers', pg.png, 'massive_premarket_gaps.mjs', 'premarket', false);
  // JSON shape unknown; render whatever we have
  const d = pg.data || {};
  const items = d.gappers || d.gaps || d.items || [];
  const rows = (Array.isArray(items) ? items : []).slice(0, 8).map(g => {
    const cls = (g.gapPct || g.changePct || 0) >= 0 ? 'up' : 'dn';
    return '<div class="tile-row pmf"><span class="tkr">' + escapeHtml(g.ticker || g.symbol || '?') + '</span><span class="gap ' + cls + '">' + sign(g.gapPct || g.changePct) + fmt(g.gapPct || g.changePct, 2) + '%</span><span class="meta">' + escapeHtml(g.catalyst || g.note || '') + '</span><span class="time">$' + fmt(g.price || g.last) + '</span></div>';
  });
  return tile({
    title: 'Premarket Gappers',
    subAgo: d.updatedAt ? ago(d.updatedAt) : '',
    sub: 'gap classification + catalyst',
    badge: rows.length + ' gappers',
    freshness: freshness(d.updatedAt, 360, 1440),
    rows, empty: 'No gappers right now',
    foot: '<span class="src">' + escapeHtml(pg.source) + '</span><span class="cadence">premarket</span>',
  });
}

function ratingsTile(ratings) {
  if (!ratings) return tile({ title: 'Analyst Ratings', empty: 'ratings_today.json missing', foot: '<span class="src">ratings_today.json</span>' });
  const allCalls = [
    ...(ratings.upgrades || []).map(r => ({ ...r, action: 'upgrade' })),
    ...(ratings.downgrades || []).map(r => ({ ...r, action: 'downgrade' })),
    ...(ratings.ptRaises || []).map(r => ({ ...r, action: 'ptraise' })),
    ...(ratings.initiations || []).map(r => ({ ...r, action: 'init' })),
  ];
  const total = ratings.totalRatings || allCalls.length;
  const rows = allCalls.slice(0, 8).map(r => {
    const dir = r.action === 'upgrade' || r.action === 'ptraise' ? 'bullish' : (r.action === 'downgrade' ? 'bearish' : 'neutral');
    return '<div class="tile-row"><span class="tkr">' + escapeHtml(r.ticker || '?') + '</span><span class="dir ' + dir + '">' + r.action.toUpperCase().slice(0,4) + '</span><span class="meta">' + escapeHtml((r.firm || '') + ' · ' + (r.note || r.detail || r.from || '')) + '</span></div>';
  });
  return tile({
    title: 'Analyst Ratings',
    subAgo: ratings.updatedAt ? ago(ratings.updatedAt) : '',
    sub: ratings.date ? 'for ' + ratings.date : '',
    badge: total + ' calls', badgeClass: total > 10 ? 'hot' : (total > 0 ? 'warm' : ''),
    freshness: freshness(ratings.updatedAt, 240, 1440),
    rows, empty: 'No ratings today',
    foot: '<span class="src">ratings_today.json · ratings_parser.mjs</span><span class="cadence">7:00am · 8:30am</span>',
  });
}

function catalystsTile(cats) {
  if (!cats) return tile({ title: 'Upcoming Catalysts', empty: 'email_catalysts.json missing', foot: '<span class="src">email_catalysts.json</span>' });
  const items = cats.catalysts || cats.events || [];
  const rows = items.slice(0, 8).map(e => '<div class="tile-row"><span class="tkr">' + escapeHtml(e.ticker || e.symbol || '?') + '</span><span class="meta">' + escapeHtml((e.date || e.when || '') + ' · ' + (e.event || e.kind || e.note || '')) + '</span></div>');
  return tile({
    title: 'Upcoming Catalysts',
    subAgo: cats.updatedAt ? ago(cats.updatedAt) : '',
    sub: 'extracted from research email feed',
    badge: (cats.count || items.length) + ' upcoming',
    badgeClass: items.length > 10 ? 'hot' : 'warm',
    freshness: freshness(cats.updatedAt, 720, 2880),
    rows, empty: 'No catalysts queued',
    foot: '<span class="src">email_catalysts.json · catalyst_extractor.mjs</span><span class="cadence">7:30am · 5pm</span>',
  });
}

// ---------- tab panels ----------
function buildDeskPanel(s) {
  const html = [];
  html.push('<div class="section"><div class="section-h"><h2>Desk Synthesis</h2><div class="sub">curated reads · what the brain thinks</div></div><div class="grid wide">');
  html.push(ideaBoardTile(s.ideaBoard));
  html.push(narrativeTile(s.narrative));
  html.push('</div></div>');

  html.push('<div class="section"><div class="section-h"><h2>Top of Mind</h2><div class="sub">EOD trade finder · wakeups · idiosyncratic news · all signals — scroll if more</div></div><div class="grid">');
  html.push(sigTile({ src: 'trade-finder', title: 'Trade Finder', cadence: '10:03 · 14:33', hotMin: 90, warmMin: 360, limit: 50, scroll: true }, s.bySrc['trade-finder']));
  html.push(sigTile({ src: 'wakeup', title: 'Wakeup (gap+vol)', cadence: 'hourly · 5:30pm EOD', hotMin: 90, warmMin: 240, limit: 50, scroll: true }, s.bySrc['wakeup']));
  html.push(sigTile({ src: 'news-mover-bind', title: 'News Mover Bind', cadence: 'every 5m', hotMin: 15, warmMin: 60, limit: 50, scroll: true }, s.bySrc['news-mover-bind']));
  html.push('</div></div>');

  html.push('<div class="section"><div class="section-h"><h2>Positions</h2><div class="sub">your context · regime is in the sticky header</div></div><div class="grid">');
  html.push(positionsTile(s.positions, s.account, s.positionsUpdatedAt));
  html.push('</div></div>');
  return html.join('');
}

function buildEquitiesPanel(s) {
  const html = [];
  // Premarket
  html.push('<div class="section"><div class="section-h"><h2>Premarket</h2><div class="sub">gap stats · fade probabilities · edge scan</div></div><div class="grid">');
  html.push(premarketFadesTile(s.premarketFades));
  html.push(premarketGappersTile(s.premarketGappers));
  html.push(pngTile('Premarket Edge Scan', s.pngTiles.premarketEdge, 'premarket_edge_scanner.mjs', 'pre-open', false));
  html.push('</div></div>');

  // Strength / weakness — fresh HTML tables, not screenshots. Click any ticker.
  html.push('<div class="section"><div class="section-h"><h2>Relative Strength · Statistical Edge</h2><div class="sub">RS leaders/laggards · mean reversion · ClickHouse analogs · click any ticker to open scan</div></div><div class="grid wide">');
  html.push(rsScanTile(s.rsScan));
  html.push(meanReversionTile(s.meanRev));
  html.push(statEdgeTile(s.statEdgeScan));
  html.push('</div></div>');

  // EOD book-rule setups
  html.push('<div class="section"><div class="section-h"><h2>Book-Rule Setups</h2><div class="sub">post-close EOD patterns</div></div><div class="grid">');
  html.push(setupBucketTile(s.setupScans, 'bb-squeeze', 'BB Squeeze', 'setup-bb-squeeze', '7:15a · 4:00p'));
  html.push(setupBucketTile(s.setupScans, 'holy-grail', 'Holy Grail (ADX>30 pullback)', 'setup-holy-grail', '7:15a · 4:00p'));
  html.push(setupBucketTile(s.setupScans, 'id-nr4', 'ID/NR4 (vol squeeze)', 'setup-id-nr4', '7:15a · 4:00p'));
  html.push(setupBucketTile(s.setupScans, 'turtle-soup', 'Turtle Soup', 'setup-turtle-soup', '7:15a · 4:00p'));
  html.push(setupBucketTile(s.setupScans, 'macd-divergence', 'MACD Divergence', 'setup-macd-div', '7:15a · 4:00p'));
  html.push('</div></div>');

  // Intraday
  html.push('<div class="section"><div class="section-h"><h2>Intraday Tape</h2><div class="sub">live momentum · volume · news binds</div></div><div class="grid">');
  html.push(sigTile({ src: 'ema-cross-5m', title: 'EMA Cross (5m)', cadence: 'every 5m', hotMin: 10, warmMin: 30, limit: 7 }, s.bySrc['ema-cross-5m']));
  html.push(sigTile({ src: 'high-vol-movers', title: 'High Volume Movers', cadence: 'hourly', hotMin: 30, warmMin: 90, limit: 7 }, s.bySrc['high-vol-movers']));
  html.push(sigTile({ src: 'vol-spike', title: 'Vol Spike', cadence: 'continuous', hotMin: 15, warmMin: 60, limit: 6 }, s.bySrc['vol-spike']));
  html.push(sigTile({ src: 'news-mover-bind', title: 'News Mover Bind', cadence: 'every 5m', hotMin: 15, warmMin: 60, limit: 6 }, s.bySrc['news-mover-bind']));
  html.push('</div></div>');

  // News / research / catalysts
  html.push('<div class="section"><div class="section-h"><h2>News · Research · Catalysts</h2><div class="sub">analyst flow · email digest · upcoming events</div></div><div class="grid">');
  html.push(sigTile({ src: 'email-research', title: 'Email Research', cadence: 'real-time', hotMin: 60, warmMin: 240, limit: 7 }, s.bySrc['email-research']));
  html.push(sigTile({ src: 'ti-email', title: 'TI Newsletter', cadence: 'on-receipt', hotMin: 360, warmMin: 1440, limit: 6 }, s.bySrc['ti-email']));
  html.push(ratingsTile(s.ratings));
  html.push(catalystsTile(s.catalysts));
  html.push('</div></div>');

  // Social
  html.push('<div class="section"><div class="section-h"><h2>Social Pulse</h2><div class="sub">crowd attention · sentiment</div></div><div class="grid">');
  html.push(sigTile({ src: 'stocktwits', title: 'Stocktwits Trending', cadence: '8:25 · 10:25 · 14:25 · 16:25', hotMin: 60, warmMin: 240, limit: 7 }, s.bySrc['stocktwits']));
  html.push(sigTile({ src: 'reddit', title: 'Reddit Mentions', cadence: 'every 30m', hotMin: 60, warmMin: 180, limit: 7 }, s.bySrc['reddit']));
  html.push('</div></div>');
  return html.join('');
}

function buildOptionsPanel(s) {
  const html = [];
  // Dealer positioning
  html.push('<div class="section"><div class="section-h"><h2>Dealer Positioning</h2><div class="sub">gamma · tide · pin watch</div></div><div class="grid">');
  html.push(gammaTile(s.gammaPin));
  html.push(uwTideTile(s.uwRegime));
  html.push('</div></div>');

  // UW flow + rollup (now a real data table, not a PNG screenshot)
  html.push('<div class="section"><div class="section-h"><h2>UW Flow</h2><div class="sub">unusual whales custom alerts + EOD rollup · click any ticker to open scan</div></div><div class="grid wide">');
  html.push(sigTile({ src: 'uw-custom', title: 'UW Custom Flow', cadence: 'every 20m · 9-3pm', hotMin: 30, warmMin: 90, limit: 10 }, s.bySrc['uw-custom']));
  html.push(uwRollupTile(s.uwRollup));
  html.push('</div></div>');
  return html.join('');
}

// ---------- top-bar render (always-on regime strip) ----------
function renderTopBar(s) {
  const phaseEl = document.getElementById('phase');
  phaseEl.textContent = s.phase; phaseEl.className = 'phase ' + s.phase;
  const reg = s.whatsWorking && s.whatsWorking.regimeTag || '—';
  const regEl = document.getElementById('regime-pill'); regEl.textContent = reg;
  const rl = reg.toLowerCase();
  regEl.className = 'regime-pill ' + (rl.includes('risk-on') ? 'risk-on' : rl.includes('mega-tech') ? 'mega-tech' : rl.includes('broad strength') ? 'broad-strong' : rl.includes('broad weakness') ? 'broad-weak' : 'mixed');

  const ww = s.whatsWorking;
  const strip = document.getElementById('regime-strip');
  if (!ww) { strip.innerHTML = '<span style="color:var(--mute)">whats_working daemon not running</span>'; return; }
  const cChip = x => '<span class="strip-chip ' + chipClass(x.chg) + '"><span class="t">' + x.ticker + '</span><span class="num">' + sign(x.chg) + fmt(x.chg,1) + '%</span></span>';
  const sectorsSorted = [...ww.sectors];
  const secTop = sectorsSorted.slice(0,3).map(cChip).join('');
  const secBot = sectorsSorted.slice(-3).reverse().map(cChip).join('');
  const idx = ww.indices.map(cChip).join('');
  const m7 = ww.mag7.map(cChip).join('');
  const themes = (ww.themes || []).slice(0,3).map(t => '<span class="strip-chip ' + chipClass(t.avg) + '"><span class="t">' + escapeHtml(t.name) + '</span><span class="num">' + sign(t.avg) + fmt(t.avg,1) + '% ' + t.greens + '/' + t.total + '</span></span>').join('');
  strip.innerHTML =
    '<div class="chip-group"><span class="lbl">IDX</span>' + idx + '</div>' +
    '<div class="chip-group"><span class="lbl">MAG 7</span>' + m7 + '</div>' +
    '<div class="chip-group"><span class="lbl">SEC ↑</span>' + secTop + '</div>' +
    '<div class="chip-group"><span class="lbl">SEC ↓</span>' + secBot + '</div>' +
    '<div class="chip-group"><span class="lbl">THEMES</span>' + themes + '</div>' +
    '<span class="age">' + ago(ww.updatedAt) + '</span>';
}

// ---------- render orchestration ----------
function render(s) {
  renderTopBar(s);
  document.getElementById('panel-desk').innerHTML = buildDeskPanel(s);
  document.getElementById('panel-equities').innerHTML = buildEquitiesPanel(s);
  document.getElementById('panel-options').innerHTML = buildOptionsPanel(s);
  document.getElementById('updated').textContent = 'refreshed ' + new Date().toLocaleTimeString();
}

// Maps hash → top tab. #analogs and #factor both live under the Trade Odds tab.
const TAB_FOR_HASH = { desk: 'desk', equities: 'equities', options: 'options', tradeodds: 'tradeodds', analogs: 'tradeodds', factor: 'tradeodds' };
const TO_SUB_FOR_HASH = { analogs: 'analogs', factor: 'factor', tradeodds: 'analogs' };

function activateTab(name) {
  const topTab = TAB_FOR_HASH[name] || 'desk';
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === topTab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + topTab));
  if (topTab === 'tradeodds') {
    const sub = TO_SUB_FOR_HASH[name] || 'analogs';
    setToSubView(sub);
  }
}

function setToSubView(view) {
  document.querySelectorAll('.to-subtab').forEach(t => t.classList.toggle('active', t.dataset.toview === view));
  document.querySelectorAll('.to-sub').forEach(s => s.classList.toggle('active', s.id === 'to-sub-' + view));
  if (view === 'analogs' && !window._analogState.currentData && !window._analogState.loading) {
    loadAnalogs();
  }
  if (view === 'factor' && !window._fmState.currentData && !window._fmState.loading) {
    loadFactorMatch();
  }
}

function tickClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' }) + ' ET';
}

// ---------- refresh + countdown ----------
const REFRESH_MS = 30000;
let lastRefreshTs = 0;

async function refresh() {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  try {
    const r = await fetch('/api/state');
    if (!r.ok) throw new Error(r.status);
    render(await r.json());
    lastRefreshTs = Date.now();
  } catch (e) {
    document.getElementById('updated').textContent = 'error: ' + e.message;
  } finally {
    btn.classList.remove('spinning');
  }
}

function updateCountdown() {
  const el = document.getElementById('countdown');
  if (!el) return;
  const elapsed = Date.now() - lastRefreshTs;
  const remaining = Math.max(0, Math.ceil((REFRESH_MS - elapsed) / 1000));
  el.textContent = 'next in ' + remaining + 's';
  el.className = 'countdown' + (remaining > 25 ? ' fresh' : '');
}

// ---------- per-ticker scan modal ----------
async function openTickerScan(ticker) {
  const backdrop = document.getElementById('modal-backdrop');
  const header = document.getElementById('modal-header');
  const body = document.getElementById('modal-body');
  header.innerHTML = '<span class="tkr">' + escapeHtml(ticker) + '</span><span class="muted" style="font-size:11px;color:var(--mute)">loading…</span><button class="close" id="modal-close">×</button>';
  body.innerHTML = '<div class="modal-loading"><div class="spinner"></div><div>Running confluence read for ' + escapeHtml(ticker) + '…</div><div style="margin-top:8px;font-size:11px;color:var(--mute-2)">14-check engine: cohort · news · stat · flow · regime · book-rules · seasonality · earnings hist · earnings pattern · desk calls · catalyst prox · street conviction · gamma magnetics</div><div style="margin-top:6px;font-size:10px;color:var(--mute-2)">First-time scans can take 30–120s if UW is rate-limiting.</div></div>';
  backdrop.classList.add('on');
  try {
    const r = await fetch('/api/scan/' + encodeURIComponent(ticker));
    if (!r.ok) throw new Error('server ' + r.status);
    const d = await r.json();
    renderTickerScan(d);
  } catch (e) {
    body.innerHTML = '<div class="modal-loading" style="color:var(--red)">scan failed: ' + escapeHtml(e.message) + '</div>';
  }
}

function renderTickerScan(d) {
  const header = document.getElementById('modal-header');
  const body = document.getElementById('modal-body');
  if (d.error) {
    body.innerHTML = '<div class="modal-loading"><div style="color:var(--amber)">' + escapeHtml(d.error) + '</div></div>';
    header.innerHTML = '<span class="tkr">' + escapeHtml(d.ticker || '?') + '</span><button class="close" id="modal-close">×</button>';
    return;
  }
  const tier = d.tier || 'PASS';
  header.innerHTML = '<span class="tkr">' + escapeHtml(d.ticker) + '</span>' +
    '<span class="tier ' + tier + '">' + tier + '</span>' +
    '<span class="score">' + fmt(d.score, 1) + '/14</span>' +
    '<span class="muted" style="color:var(--mute);font-size:11px">' + (d.price != null ? '$' + fmt(d.price) : '') + ' · ' + sign(d.dayPct) + fmt(d.dayPct, 2) + '%' + (d.rsi14 != null ? ' · RSI ' + fmt(d.rsi14, 0) : '') + '</span>' +
    '<button class="close" id="modal-close">×</button>';
  const t = d.ticket || {};
  const dirCls = t.direction === 'long' ? 'bull' : (t.direction === 'short' ? 'bear' : '');
  const ticketHtml = t.entry ? (
    '<div class="ticket-box">' +
      '<div class="field"><div class="lbl">Direction</div><div class="val ' + dirCls + '">' + (t.direction || '').toUpperCase() + '</div></div>' +
      '<div class="field"><div class="lbl">Setup</div><div class="val">' + escapeHtml(t.setup || '—') + '</div></div>' +
      '<div class="field"><div class="lbl">Entry</div><div class="val">' + fmt(t.entry) + '</div></div>' +
      '<div class="field"><div class="lbl">Stop</div><div class="val bear">' + fmt(t.stop) + '</div></div>' +
      '<div class="field"><div class="lbl">Target 1</div><div class="val bull">' + fmt(t.t1) + ' <span style="color:var(--mute);font-weight:400;font-size:11px">(' + fmt(t.rr1, 1) + 'R)</span></div></div>' +
      '<div class="field"><div class="lbl">Target 2</div><div class="val bull">' + fmt(t.t2) + ' <span style="color:var(--mute);font-weight:400;font-size:11px">(' + fmt(t.rr2, 1) + 'R)</span></div></div>' +
      '<div class="field"><div class="lbl">Size</div><div class="val">' + (t.shares || 0) + ' sh · $' + fmt(t.positionDollars, 0) + '</div></div>' +
      '<div class="field"><div class="lbl">Risk</div><div class="val">$' + fmt(t.riskDollars, 0) + ' (' + fmt(t.riskPct, 1) + '%)</div></div>' +
    '</div>'
  ) : '<div class="ticket-box"><div class="field"><div class="lbl">Tier</div><div class="val">PASS</div></div><div class="field" style="grid-column:span 3"><div class="lbl">Reason</div><div class="val" style="font-size:12px;font-weight:400">score below TRADE/WATCHLIST threshold</div></div></div>';
  const checkRows = [];
  for (const [k, v] of Object.entries(d.checks || {})) {
    const sc = Number(v?.score) || 0;
    const cls = sc >= 0.3 ? 'pos' : (sc <= -0.3 ? 'neg' : 'neu');
    const status = v?.status || '—';
    const detail = v?.detail || '';
    checkRows.push('<tr><td class="name">' + escapeHtml(k) + '</td><td class="status"><span class="badge ' + cls + '">' + escapeHtml(status) + '</span></td><td class="score">' + fmt(sc, 2) + '</td><td class="detail">' + escapeHtml(detail.slice(0, 200)) + '</td></tr>');
  }
  body.innerHTML = ticketHtml +
    '<table class="checks-table"><thead><tr><th>Check</th><th>Status</th><th class="num">Score</th><th>Detail</th></tr></thead><tbody>' + checkRows.join('') + '</tbody></table>' +
    (d.source ? '<div style="margin-top:10px;font-size:10px;color:var(--mute-2);text-align:right">source: ' + escapeHtml(d.source) + ' · scanned ' + ago(d.ts) + '</div>' : '');
}

// ---------- analogs tab ----------
// In-page state — the active condition set (subset of ANALOG_CONDITION_KEYS).
// First load uses server defaults; user toggles override.
// Render order. Market context first (date-wide), then asset-specific, then
// external/Pro stubs, then our bonus (Weinstein Stage).
const ANALOG_CONDITION_KEYS = [
  'marketRegime','vixLevel','vixMove','month',
  'pctChange','move','relVol','rsiZone','rsiSlope','trend','gap','priceStreak','volStreak',
  'analystTrend','earningsPerf','earningsProx',
  'stage',
];
window._analogState = { ticker: 'SPY', activeConditions: null, currentData: null, loading: false };

async function loadAnalogs(forceTicker) {
  const st = window._analogState;
  if (forceTicker) st.ticker = forceTicker.toUpperCase();
  const tkr = st.ticker;
  st.loading = true;
  document.getElementById('analog-results').innerHTML = '<div class="modal-loading"><div class="spinner"></div><div>Querying ClickHouse for ' + escapeHtml(tkr) + ' analogs…</div></div>';
  // Build conditions query
  let url = '/api/analogs/' + encodeURIComponent(tkr);
  if (st.activeConditions) {
    const enabled = Object.entries(st.activeConditions).filter(([,v])=>v).map(([k])=>k);
    url += '?conditions=' + enabled.join(',');
  }
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    st.currentData = d;
    if (!st.activeConditions && d.activeConditions) st.activeConditions = { ...d.activeConditions };
    renderAnalogs(d);
  } catch (e) {
    document.getElementById('analog-results').innerHTML = '<div class="modal-loading" style="color:var(--red)">Failed: ' + escapeHtml(e.message) + '</div>';
  } finally {
    st.loading = false;
  }
}

function renderAnalogs(d) {
  const st = window._analogState;
  // Toolbar profile line
  if (d.error) {
    document.getElementById('analog-profile').innerHTML = '<span style="color:var(--red)">' + escapeHtml(d.error) + '</span>';
    document.getElementById('analog-conditions').innerHTML = '<h3>Conditions</h3><div style="padding:12px;color:var(--mute);font-size:11px">No profile</div>';
    document.getElementById('analog-results').innerHTML = '';
    return;
  }
  const p = d.profile;
  const sigClass = p.dayPct >= 0 ? 'pos' : 'neg';
  document.getElementById('analog-profile').innerHTML =
    '<b>' + escapeHtml(p.ticker) + '</b> @ $' + fmt(p.close) +
    ' <span class="' + sigClass + '">' + sign(p.dayPct) + fmt(p.dayPct,2) + '%</span>' +
    ' · RSI ' + fmt(p.rsi14, 0) +
    ' · ' + escapeHtml(p.buckets.stage) +
    ' / ' + escapeHtml(p.buckets.trend) +
    ' · as of ' + String(p.asOf).slice(0,10);

  // Condition toggles — grouped by section, with TradeOdds badge per row.
  const condDefs = d.conditions || {};
  const html = ['<h3>Conditions</h3>'];
  let lastGroup = null;
  for (const k of ANALOG_CONDITION_KEYS) {
    const def = condDefs[k]; if (!def) continue;
    if (def.group !== lastGroup) {
      const groupLabel = def.group === 'market' ? 'Market Context' : def.group === 'asset' ? 'Asset-Specific' : def.group === 'external' ? 'External Data (Pro)' : 'Bonus';
      html.push('<div class="cond-group-h">' + groupLabel + '</div>');
      lastGroup = def.group;
    }
    const isOn = st.activeConditions ? !!st.activeConditions[k] : !!def.default;
    const bucket = p.buckets[k] || '—';
    const toBadge = def.to ? '<span class="to-badge" title="from TradeOdds spec">TO</span>' : '';
    const disabledCls = def.disabled ? ' disabled' : '';
    const disabledTitle = def.disabled ? ' title="' + escapeHtml(def.desc) + '"' : '';
    html.push('<div class="cond-row ' + (isOn ? 'on' : '') + disabledCls + '" data-cond="' + k + '"' + disabledTitle + '><div><div class="cond-label">' + escapeHtml(def.label) + toBadge + '</div><div class="cond-bucket">today: ' + escapeHtml(bucket) + (def.disabled ? ' · not yet wired' : '') + '</div></div><div class="toggle"></div></div>');
  }
  document.getElementById('analog-conditions').innerHTML = html.join('');

  // Results
  if (!d.stats || !d.stats.N) {
    document.getElementById('analog-results').innerHTML = '<div class="analog-headline"><div class="big">0</div><div class="label">matching historical days · loosen a condition to widen the net</div></div>';
    return;
  }
  const f5 = d.stats.fwd5d, f1 = d.stats.fwd1d, f10 = d.stats.fwd10d;
  const headlineCls = f5.pctPos >= 50 ? 'up' : 'dn';
  const head =
    '<div class="analog-headline">' +
      '<div class="big ' + headlineCls + '">' + f5.pctPos.toFixed(1) + '%</div>' +
      '<div class="label">closed higher in the next 5 trading days · across ' + d.stats.N + ' matching days</div>' +
      '<div class="breakdown">' +
        '<div class="col"><div class="h">Fwd 1d</div><div class="n ' + (f1.median>=0?'up':'dn') + '">' + sign(f1.median) + f1.median.toFixed(2) + '%</div><div class="meta">' + f1.pctPos.toFixed(0) + '% higher · avg ' + sign(f1.avg) + f1.avg.toFixed(2) + '%</div></div>' +
        '<div class="col"><div class="h">Fwd 5d</div><div class="n ' + (f5.median>=0?'up':'dn') + '">' + sign(f5.median) + f5.median.toFixed(2) + '%</div><div class="meta">' + f5.pctPos.toFixed(0) + '% higher · avg ' + sign(f5.avg) + f5.avg.toFixed(2) + '% · range ' + f5.min.toFixed(1) + '..' + f5.max.toFixed(1) + '%</div></div>' +
        '<div class="col"><div class="h">Fwd 10d</div><div class="n ' + (f10.median>=0?'up':'dn') + '">' + sign(f10.median) + f10.median.toFixed(2) + '%</div><div class="meta">' + f10.pctPos.toFixed(0) + '% higher · avg ' + sign(f10.avg) + f10.avg.toFixed(2) + '%</div></div>' +
      '</div>' +
    '</div>';

  // Matching days table
  const rows = d.matches.map(m =>
    '<tr><td>' + escapeHtml(m.date) + '</td>' +
    '<td class="' + (m.dayPct >= 0 ? 'up' : 'dn') + '">' + sign(m.dayPct) + m.dayPct.toFixed(2) + '%</td>' +
    '<td>' + (m.rsi14 != null ? m.rsi14.toFixed(0) : '—') + '</td>' +
    '<td class="' + (m.fwd1d >= 0 ? 'up' : 'dn') + '">' + sign(m.fwd1d) + m.fwd1d.toFixed(2) + '%</td>' +
    '<td class="' + (m.fwd5d >= 0 ? 'up' : 'dn') + '">' + sign(m.fwd5d) + m.fwd5d.toFixed(2) + '%</td>' +
    '<td class="' + (m.fwd10d >= 0 ? 'up' : 'dn') + '">' + sign(m.fwd10d) + m.fwd10d.toFixed(2) + '%</td></tr>'
  ).join('');
  const list =
    '<div class="analog-matches">' +
      '<div class="h">Matching Days <span class="ct">showing ' + d.matches.length + ' of ' + d.stats.N + ' · newest first</span></div>' +
      '<div class="body"><table><thead><tr><th>Date</th><th>Δ Day</th><th>RSI14</th><th>Fwd 1d</th><th>Fwd 5d</th><th>Fwd 10d</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '</div>';

  // Sub-tab nav inside the analogs panel
  const view = window._analogView || 'days';
  const tabs =
    '<div class="analog-viewtabs">' +
      '<div class="analog-viewtab ' + (view==='days'?'active':'') + '" data-anview="days">Matching Days</div>' +
      '<div class="analog-viewtab ' + (view==='chart'?'active':'') + '" data-anview="chart">Price Path</div>' +
    '</div>';

  const body = view === 'chart' ? renderAnalogChart(d) : list;
  document.getElementById('analog-results').innerHTML = head + tabs + body;
}

// ---------- Price Path SVG chart ----------
function renderAnalogChart(d) {
  const hist = (d.chart && d.chart.priceHistory) || [];
  const matchDates = (d.chart && d.chart.matchDates) || {};
  if (!hist.length) return '<div class="analog-chart-box"><div class="modal-loading">No price history available</div></div>';

  // Dimensions — SVG will scale via viewBox
  const W = 1200, H = 380, PAD_L = 50, PAD_R = 14, PAD_T = 14, PAD_B = 28;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  // Sample down if huge (>3000 points) to keep SVG responsive
  let pts = hist;
  if (pts.length > 3000) {
    const step = Math.ceil(pts.length / 3000);
    pts = pts.filter((_, i) => i % step === 0);
  }

  // Log-scale Y (SPY goes from ~$30 to $750+ over 25y; linear is unreadable)
  const closes = pts.map(p => p.close).filter(c => c > 0);
  const minP = Math.min(...closes), maxP = Math.max(...closes);
  const logMin = Math.log(minP), logMax = Math.log(maxP);
  const yScale = (price) => PAD_T + (1 - (Math.log(price) - logMin) / (logMax - logMin)) * innerH;
  const xScale = (i) => PAD_L + (i / (pts.length - 1)) * innerW;

  // Build price polyline path
  const pathD = pts.map((p, i) => (i === 0 ? 'M' : 'L') + xScale(i).toFixed(1) + ' ' + yScale(p.close).toFixed(1)).join(' ');

  // Build dots for matching dates (need to find their indices in the sampled pts)
  const dateToIdx = {};
  pts.forEach((p, i) => { dateToIdx[p.date] = i; });
  const matches = Object.entries(matchDates);
  const mkDot = (x, y, fwd5d, dt, close) => {
    const cls = fwd5d >= 0 ? 'up' : 'dn';
    const sgn = fwd5d >= 0 ? '+' : '';
    return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.5" class="match-dot ' + cls + '"><title>' + dt + ' · close $' + close.toFixed(2) + ' · fwd 5d ' + sgn + fwd5d.toFixed(2) + '%</title></circle>';
  };
  const dots = matches.map(([dt, fwd5d]) => {
    const idx = dateToIdx[dt];
    if (idx == null) {
      const exact = hist.find(p => p.date === dt);
      if (!exact) return '';
      const histIdx = hist.indexOf(exact);
      const x = PAD_L + (histIdx / (hist.length - 1)) * innerW;
      return mkDot(x, yScale(exact.close), fwd5d, dt, exact.close);
    }
    return mkDot(xScale(idx), yScale(pts[idx].close), fwd5d, dt, pts[idx].close);
  }).join('');

  // Y-axis labels — 4 log-scale ticks
  const yTicks = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const logPrice = logMin + t * (logMax - logMin);
    const price = Math.exp(logPrice);
    const y = PAD_T + (1 - t) * innerH;
    yTicks.push('<line x1="' + PAD_L + '" y1="' + y + '" x2="' + (PAD_L + innerW) + '" y2="' + y + '" class="grid-line"/>');
    yTicks.push('<text x="' + (PAD_L - 6) + '" y="' + (y + 3) + '" class="axis-label" text-anchor="end">$' + price.toFixed(price >= 100 ? 0 : 2) + '</text>');
  }

  // X-axis labels — 5 date ticks
  const xTicks = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const idx = Math.floor(t * (pts.length - 1));
    const x = PAD_L + t * innerW;
    const dt = pts[idx]?.date || '';
    const year = dt.slice(0, 4);
    xTicks.push('<text x="' + x + '" y="' + (H - 10) + '" class="axis-label" text-anchor="middle">' + year + '</text>');
  }

  // Count up/down dots for legend
  const matchVals = Object.values(matchDates);
  const upCount = matchVals.filter(v => v >= 0).length;
  const dnCount = matchVals.filter(v => v < 0).length;

  return (
    '<div class="analog-chart-box">' +
      '<div class="chart-meta">' +
        '<div><b style="color:var(--ink)">' + escapeHtml(d.ticker) + '</b> · ' + pts.length + ' bars · ' + pts[0].date + ' → ' + pts[pts.length-1].date + ' · log scale</div>' +
        '<div class="chart-legend">' +
          '<span class="item"><span class="dot line"></span> price</span>' +
          '<span class="item"><span class="dot up"></span> match · 5d up <b style="color:#7ee787">' + upCount + '</b></span>' +
          '<span class="item"><span class="dot dn"></span> match · 5d down <b style="color:#ff7b72">' + dnCount + '</b></span>' +
        '</div>' +
      '</div>' +
      '<svg class="analog-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
        yTicks.join('') +
        '<path d="' + pathD + '" class="price-line"/>' +
        dots +
        xTicks.join('') +
      '</svg>' +
    '</div>'
  );
}

// ---------- Factor Match tab (today × universe) ----------
window._fmState = { activeConditions: null, currentData: null, loading: false, minN: 10, sortBy: 'pctPos_5d' };

async function loadFactorMatch() {
  const st = window._fmState;
  st.loading = true;
  document.getElementById('fm-results').innerHTML = '<div class="modal-loading"><div class="spinner"></div><div>Scanning universe… this can take 10–30s on first load.</div><div style="margin-top:6px;font-size:10px;color:var(--mute-2)">For each ticker, finding historical days that match its own current profile.</div></div>';
  st.minN = parseInt(document.getElementById('fm-minN').value, 10) || 10;
  st.sortBy = document.getElementById('fm-sort').value || 'pctPos_5d';
  let url = '/api/factor-match?minN=' + st.minN + '&sortBy=' + encodeURIComponent(st.sortBy);
  if (st.activeConditions) {
    const enabled = Object.entries(st.activeConditions).filter(([,v])=>v).map(([k])=>k);
    url += '&conditions=' + enabled.join(',');
  }
  try {
    const r = await fetch(url);
    const d = await r.json();
    st.currentData = d;
    if (!st.activeConditions && d.activeConditions) st.activeConditions = { ...d.activeConditions };
    renderFactorMatch(d);
  } catch (e) {
    document.getElementById('fm-results').innerHTML = '<div class="modal-loading" style="color:var(--red)">Failed: ' + escapeHtml(e.message) + '</div>';
  } finally {
    st.loading = false;
  }
}

function renderFactorMatch(d) {
  const st = window._fmState;
  if (d.error) {
    document.getElementById('fm-results').innerHTML = '<div class="modal-loading" style="color:var(--red)">' + escapeHtml(d.error) + '</div>';
    return;
  }
  // Toolbar meta + universe size
  document.getElementById('fm-universe').textContent = (d.universeSize || 0) + ' tickers';
  document.getElementById('fm-meta').innerHTML =
    '<b>' + (d.rows ? d.rows.length : 0) + '</b> matches above min N=' + d.minN +
    ' · sorted by <b>' + escapeHtml(d.sortBy.replace('pctPos_','').replace('avg_','avg ')) + '</b>' +
    ' · scanned ' + d.universeSize + ' tickers';
  // Conditions panel — grouped + TradeOdds badge, same as Analogs
  const condDefs = d.conditions || {};
  const html = ['<h3>Conditions</h3>'];
  let lastGroup = null;
  for (const k of ANALOG_CONDITION_KEYS) {
    const def = condDefs[k]; if (!def) continue;
    if (def.group !== lastGroup) {
      const groupLabel = def.group === 'market' ? 'Market Context' : def.group === 'asset' ? 'Asset-Specific' : def.group === 'external' ? 'External Data (Pro)' : 'Bonus';
      html.push('<div class="cond-group-h">' + groupLabel + '</div>');
      lastGroup = def.group;
    }
    const isOn = st.activeConditions ? !!st.activeConditions[k] : !!def.default;
    const toBadge = def.to ? '<span class="to-badge" title="from TradeOdds spec">TO</span>' : '';
    const disabledCls = def.disabled ? ' disabled' : '';
    const disabledTitle = def.disabled ? ' title="' + escapeHtml(def.desc) + '"' : '';
    const sub = def.disabled ? 'not yet wired' : (def.group === 'market' ? 'same date as today' : 'match each ticker');
    html.push('<div class="cond-row ' + (isOn ? 'on' : '') + disabledCls + '" data-fmcond="' + k + '"' + disabledTitle + '><div><div class="cond-label">' + escapeHtml(def.label) + toBadge + '</div><div class="cond-bucket">' + sub + '</div></div><div class="toggle"></div></div>');
  }
  document.getElementById('fm-conditions').innerHTML = html.join('');
  // Results table
  if (!d.rows || !d.rows.length) {
    document.getElementById('fm-results').innerHTML = '<div class="analog-headline"><div class="big">0</div><div class="label">tickers met the threshold · loosen conditions or drop Min Days</div></div>';
    return;
  }
  const rows = d.rows.map(r => {
    const tCls = r.today.dayPct >= 0 ? 'up' : 'dn';
    const w1cls = r.pctPos.d1 >= 50 ? 'up' : 'dn';
    const w5cls = r.pctPos.d5 >= 50 ? 'up' : 'dn';
    const w10cls = r.pctPos.d10 >= 50 ? 'up' : 'dn';
    const a1cls = r.avg.d1 >= 0 ? 'up' : 'dn';
    const a5cls = r.avg.d5 >= 0 ? 'up' : 'dn';
    const a10cls = r.avg.d10 >= 0 ? 'up' : 'dn';
    return '<tr>' +
      '<td><span data-tkr="' + escapeHtml(r.ticker) + '" style="cursor:pointer;color:var(--ink);font-weight:700;letter-spacing:.4px" title="open confluence scan">' + escapeHtml(r.ticker) + '</span></td>' +
      '<td>$' + fmt(r.today.close) + '</td>' +
      '<td class="' + tCls + '">' + sign(r.today.dayPct) + r.today.dayPct.toFixed(2) + '%</td>' +
      '<td>' + r.today.rsi.toFixed(0) + '</td>' +
      '<td class="' + w1cls + '">' + r.pctPos.d1.toFixed(0) + '%</td>' +
      '<td class="' + a1cls + '">' + sign(r.avg.d1) + r.avg.d1.toFixed(2) + '%</td>' +
      '<td class="' + w5cls + '" style="font-weight:700">' + r.pctPos.d5.toFixed(0) + '%</td>' +
      '<td class="' + a5cls + '">' + sign(r.avg.d5) + r.avg.d5.toFixed(2) + '%</td>' +
      '<td class="' + w10cls + '">' + r.pctPos.d10.toFixed(0) + '%</td>' +
      '<td class="' + a10cls + '">' + sign(r.avg.d10) + r.avg.d10.toFixed(2) + '%</td>' +
      '<td class="muted">' + r.N + '</td>' +
    '</tr>';
  }).join('');
  document.getElementById('fm-results').innerHTML =
    '<div class="analog-matches">' +
      '<div class="h">Ranked Matches <span class="ct">' + d.rows.length + ' tickers · click any ticker to scan</span></div>' +
      '<div class="body"><table><thead><tr>' +
        '<th style="text-align:left">Sym</th>' +
        '<th>Last</th>' +
        '<th>Δ Day</th>' +
        '<th>RSI14</th>' +
        '<th>1D Win%</th>' +
        '<th>1D Avg</th>' +
        '<th>5D Win%</th>' +
        '<th>5D Avg</th>' +
        '<th>10D Win%</th>' +
        '<th>10D Avg</th>' +
        '<th>Days</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '</div>';
}

// ---------- events ----------
window.addEventListener('hashchange', () => activateTab(location.hash.replace('#','')));
document.addEventListener('click', (e) => {
  const img = e.target.closest('.png-tile img');
  if (img) { document.getElementById('lightbox-img').src = img.src; document.getElementById('lightbox').classList.add('on'); return; }
  if (e.target.closest('.lightbox')) { document.getElementById('lightbox').classList.remove('on'); return; }
  if (e.target.id === 'refresh-btn') { refresh(); return; }
  if (e.target.id === 'modal-close' || (e.target.id === 'modal-backdrop')) { document.getElementById('modal-backdrop').classList.remove('on'); return; }
  if (e.target.id === 'analog-go') { loadAnalogs(document.getElementById('analog-tkr').value.trim()); return; }
  const anView = e.target.closest('.analog-viewtab');
  if (anView) {
    window._analogView = anView.dataset.anview;
    if (window._analogState && window._analogState.currentData) renderAnalogs(window._analogState.currentData);
    return;
  }
  if (e.target.id === 'fm-go') { loadFactorMatch(); return; }
  const subTab = e.target.closest('.to-subtab');
  if (subTab) {
    // Let the href change update the hash; activateTab on hashchange handles the rest.
    // Allow default anchor nav.
  }
  const condRow = e.target.closest('.cond-row');
  if (condRow) {
    if (condRow.classList.contains('disabled')) return;  // Pro/stubbed toggles
    if (condRow.dataset.fmcond) {
      const k = condRow.dataset.fmcond;
      window._fmState.activeConditions = window._fmState.activeConditions || {};
      window._fmState.activeConditions[k] = !window._fmState.activeConditions[k];
      loadFactorMatch();
      return;
    }
    const k = condRow.dataset.cond;
    if (k) {
      window._analogState.activeConditions = window._analogState.activeConditions || {};
      window._analogState.activeConditions[k] = !window._analogState.activeConditions[k];
      loadAnalogs();
      return;
    }
  }
  const tkrEl = e.target.closest('[data-tkr]');
  if (tkrEl) { openTickerScan(tkrEl.dataset.tkr); return; }
});
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'analog-tkr' && e.key === 'Enter') {
    loadAnalogs(e.target.value.trim());
  }
});

// init
activateTab((location.hash || '#desk').replace('#',''));
if (!location.hash) location.hash = '#desk';
tickClock(); setInterval(tickClock, 1000);
setInterval(updateCountdown, 1000);
refresh(); setInterval(refresh, REFRESH_MS);
</script>
</body>
</html>`;

// ---------- server ----------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') {
      // No-cache so feature updates land immediately on next refresh, no Ctrl+Shift+R needed.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(HTML);
      return;
    }
    if (url.pathname === '/api/state') { const state = await handleState(); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(state)); return; }
    if (url.pathname.startsWith('/api/scan/')) {
      const tkr = decodeURIComponent(url.pathname.slice(10));
      const data = await handleTickerScan(tkr);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }
    if (url.pathname.startsWith('/api/analogs/')) {
      const tkr = decodeURIComponent(url.pathname.slice(13));
      const data = await handleAnalogs(tkr, url.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
      return;
    }
    if (url.pathname === '/api/factor-match') {
      const data = await handleFactorMatch(url.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
      return;
    }
    if (url.pathname.startsWith('/png/')) { await servePng(req, res, url.pathname.slice(5)); return; }
    res.writeHead(404).end('not found');
  } catch (e) {
    console.error('[tile-dashboard] error:', e);
    res.writeHead(500).end('server error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[tile-dashboard] listening on http://0.0.0.0:' + PORT);
});
