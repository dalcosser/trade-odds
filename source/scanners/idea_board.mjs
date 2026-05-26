#!/usr/bin/env node
/**
 * idea_board.mjs — Daily idea generator. Runs confluence.mjs over a candidate
 * universe, ranks results, and produces the desk's morning-meeting deck:
 *
 *   ★ TOP LONGS (top 5)
 *   ★ TOP SHORTS (top 5)
 *   ★ DISLOCATIONS (lone-red-in-green / lone-green-in-red — gold setups)
 *
 * Each entry is a full trade ticket: direction, setup, entry, stop, T1, T2, R:R.
 *
 * Universe: signal bus tickers + watchlist + mag7 + top movers (ClickHouse).
 * Capped at ~35 unique names to keep runtime under 60s.
 *
 * Usage:
 *   node idea_board.mjs                          # human-readable deck
 *   node idea_board.mjs --json                   # machine output
 *   node idea_board.mjs --emit                   # write to memory + signal bus + journal
 *   node idea_board.mjs --tickers NVDA,TSLA,MP   # explicit candidate set
 *
 * Schedule: 8:30am, 10:30am, 1:30pm, 3:30pm via timer-dispatch (4x daily).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readSignals, emitSignals } from './lib/signals.mjs';
import { chQuery } from './lib/clickhouse.mjs';
import { renderIdeaBoardCard } from './lib/ideaBoardRenderer.mjs';
import { getBbgSpreadRegime, formatBbgRegimeLine } from './lib/bbgSpreadRegime.mjs';

const exec = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
// Path layout in trade-odds:  <repo>/source/scanners/idea_board.mjs
// memory/ lives at <repo>/memory/  (or MEMORY_DIR env override from runScanners)
// confluence.mjs + lib files are siblings of this script.
const SCRIPTS = __dir;
const MEM = process.env.MEMORY_DIR || resolve(__dir, '..', '..', 'memory');

const args = process.argv.slice(2);
function argVal(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const JSON_OUT = args.includes('--json');
const EMIT = args.includes('--emit');
const EXPLICIT_TICKERS = argVal('--tickers', '');
const CONCURRENCY = parseInt(argVal('--concurrency', '8'), 10);
const MAX_CANDIDATES = parseInt(argVal('--max', '80'), 10);

function readJSON(p) { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } }

// ── Candidate universe ────────────────────────────────────────────────────

async function buildCandidates() {
  if (EXPLICIT_TICKERS) {
    return EXPLICIT_TICKERS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  }

  const set = new Set();

  // 1. Watchlist + mag7 + extras (David's curated universe)
  const wl = readJSON(resolve(SCRIPTS, 'lib', 'watchlist.json'));
  if (wl) {
    for (const t of wl.watchlist || []) set.add(t.toUpperCase());
    for (const t of wl.mag7 || []) set.add(t.toUpperCase());
    for (const t of wl.extras || []) set.add(t.toUpperCase());
  }

  // 2. Active signal-bus tickers (last 4h) — already passed an upstream filter
  const recentSignals = readSignals(240);
  for (const s of recentSignals) {
    if (s.ticker && /^[A-Z]{1,5}$/.test(s.ticker)) set.add(s.ticker);
  }

  // 3. SPX500 + NDX100 names that trade ≥1MM avg shares/day AND have a
  //    movement trigger today (significant move, 20-day breakout/down, or
  //    BB extension). The 1MM AvgVol_20 floor cuts the dead names — the
  //    movement filter focuses confluence on names with something happening.
  try {
    const spx = readJSON(resolve(SCRIPTS, 'lib', 'spx500.json'));
    const ndx = readJSON(resolve(SCRIPTS, 'lib', 'ndx100.json'));
    const indexTickers = [
      ...(spx?.tickers || []),
      ...(ndx?.tickers || []),
    ];
    if (indexTickers.length) {
      const tickerList = [...new Set(indexTickers)].map(t => `'${t}'`).join(',');
      const movers = await chQuery(`
        SELECT Ticker, DayPct, DollarVolume, AvgVol_20
        FROM daily_ohlcv
        WHERE (Ticker, Timestamp) IN (
          SELECT Ticker, max(Timestamp) FROM daily_ohlcv WHERE Ticker IN (${tickerList}) GROUP BY Ticker
        )
          AND AvgVol_20 >= 1000000
          AND (abs(DayPct) >= 1.5 OR Is_20d_High = 1 OR Is_20d_Low = 1
               OR Close > BB_Upper_20 OR Close < BB_Lower_20)
        ORDER BY DollarVolume DESC
        LIMIT 60
      `);
      if (movers) for (const r of movers) set.add(r.Ticker);
    }
  } catch { /* non-fatal */ }

  // 4. Fallback: any high-DV mover (in case index files don't load)
  try {
    const movers = await chQuery(`
      SELECT Ticker, DayPct, DollarVolume
      FROM daily_ohlcv
      WHERE (Ticker, Timestamp) IN (
        SELECT Ticker, max(Timestamp) FROM daily_ohlcv GROUP BY Ticker
      )
        AND abs(DayPct) > 3
        AND DollarVolume > 100000000
      ORDER BY DollarVolume DESC
      LIMIT 15
    `);
    if (movers) for (const r of movers) set.add(r.Ticker);
  } catch { /* non-fatal */ }

  // Cap candidates for runtime control. Prioritize signal-bus + watchlist
  // (already-filtered) over generic movers.
  const candidates = [...set];
  return candidates.slice(0, MAX_CANDIDATES);
}

// ── Run confluence on a single ticker ─────────────────────────────────────

async function runConfluence(ticker) {
  try {
    // process.execPath, not 'node' — launchd PATH may not include /opt/homebrew/bin.
    const { stdout } = await exec(process.execPath, [resolve(SCRIPTS, 'confluence.mjs'), ticker, '--json'], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    });
    return JSON.parse(stdout);
  } catch (e) {
    return { ticker, error: e.message?.slice(0, 200), tier: 'PASS' };
  }
}

// Pool runner with concurrency cap
async function runPool(items, fn, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const candidates = await buildCandidates();
  if (!JSON_OUT) console.error(`[idea-board] running confluence on ${candidates.length} candidates...`);

  const results = await runPool(candidates, runConfluence, CONCURRENCY);
  const valid = results.filter(r => r && !r.error && r.tier);

  // Bucket: dislocations first (gold), then longs by score, then shorts by score
  const dislocations = valid.filter(r => r.checks?.cohort?.dislocation);
  const longs = valid.filter(r => r.direction === 'long' && !r.checks?.cohort?.dislocation && r.tier !== 'PASS')
    .sort((a, b) => b.score - a.score);
  const shorts = valid.filter(r => r.direction === 'short' && !r.checks?.cohort?.dislocation && r.tier !== 'PASS')
    .sort((a, b) => b.score - a.score);

  // BBG cross-asset spread regime — read once per board run
  let bbgRegime = null;
  try { bbgRegime = await getBbgSpreadRegime(); } catch (e) { /* non-fatal */ }

  const board = {
    ts: new Date().toISOString(),
    runtimeMs: Date.now() - t0,
    candidatesRun: candidates.length,
    validResults: valid.length,
    bbgRegime: bbgRegime ? {
      asof: bbgRegime.latestTs,
      regime: bbgRegime.regime,
      tilt: bbgRegime.tilt,
      stretchedCount: bbgRegime.stretched.length,
      topStretched: bbgRegime.stretched.slice(0, 5).map(s => ({ id: s.id, z5y: s.z5y, signal: s.signal })),
    } : null,
    dislocations: dislocations.slice(0, 5),
    topLongs: longs.slice(0, 5),
    topShorts: shorts.slice(0, 5),
  };

  if (EMIT) {
    // Persist to memory
    writeFileSync(resolve(MEM, 'idea_board.json'), JSON.stringify(board, null, 2));

    // Render PNG card for WhatsApp/Slack delivery — print PNG_PATH: line so
    // run-and-forward-slack.mjs picks it up via --media flag.
    try {
      const pngPath = resolve(MEM, 'card_idea_board.png');
      await renderIdeaBoardCard({ board, outputPath: pngPath });
      console.log(`PNG_PATH:${pngPath}`);
    } catch (e) {
      console.error('[idea-board] PNG render failed:', e.message);
    }

    // Re-emit confluence signals (already done by individual runs if --emit, but
    // here we only emit board-level convictions, tagged 'idea-board' for traceability)
    const sigs = [...board.dislocations, ...board.topLongs, ...board.topShorts]
      .filter(r => r.tier === 'TRADE')
      .map(r => ({
        ticker: r.ticker,
        dir: r.direction === 'long' ? 'bullish' : r.direction === 'short' ? 'bearish' : 'neutral',
        str: Math.min(1, r.score / 12),
        meta: { setup: r.setup, score: r.score, entry: r.ticket?.entry, stop: r.ticket?.stop, t1: r.ticket?.t1 },
      }));
    if (sigs.length) emitSignals('idea-board', sigs);

    // Append to journal
    try {
      const journalPath = resolve(MEM, 'idea_journal.json');
      const journal = readJSON(journalPath) || { ideas: [] };
      const runId = `ib-${Date.now()}`;
      for (const r of [...board.dislocations, ...board.topLongs, ...board.topShorts]) {
        if (r.tier === 'PASS') continue;
        journal.ideas.push({
          id: `${runId}-${r.ticker}`,
          ticker: r.ticker, ts: board.ts,
          direction: r.direction, tier: r.tier, score: r.score,
          setup: r.setup, dislocation: !!r.checks?.cohort?.dislocation,
          entry: r.ticket?.entry, stop: r.ticket?.stop, t1: r.ticket?.t1, t2: r.ticket?.t2,
          rr1: r.ticket?.rr1, rr2: r.ticket?.rr2,
          outcome: null, // filled by idea_journal.mjs at EOD
          maxFavorable: null, maxAdverse: null, hitT1: null, hitStop: null,
        });
      }
      // Trim journal to last 30 days to keep file small
      const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
      journal.ideas = journal.ideas.filter(i => new Date(i.ts).getTime() > cutoff);
      writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    } catch (e) { console.error('[idea-board] journal write failed:', e.message); }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(board, null, 2));
    return;
  }

  // Human-readable deck
  const fmtRow = (r) => {
    const t = r.ticket || {};
    const ds = r.checks?.cohort?.dislocation ? `★ ${r.checks.cohort.dislocationKind}` : r.setup;
    const arrow = r.direction === 'long' ? '↑' : r.direction === 'short' ? '↓' : '·';
    return `  ${arrow} ${r.ticker.padEnd(6)} score ${r.score.toFixed(1)}/14  ${ds.padEnd(34)}  E:${t.entry}  S:${t.stop}  T1:${t.t1}(${t.rr1}R)  T2:${t.t2}(${t.rr2}R)`;
  };

  const localTime = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  console.log(`\n══════ IDEA BOARD — ${localTime} ET ══════`);
  console.log(`Ran ${candidates.length} candidates in ${(board.runtimeMs / 1000).toFixed(1)}s · ${valid.length} valid`);
  if (bbgRegime?.latestTs) console.log(formatBbgRegimeLine(bbgRegime));
  console.log('');

  if (board.dislocations.length) {
    console.log(`★★ DISLOCATIONS (gold setups — lone moves vs cohort)`);
    for (const r of board.dislocations) console.log(fmtRow(r));
    console.log('');
  }
  if (board.topLongs.length) {
    console.log(`▲ TOP LONGS`);
    for (const r of board.topLongs) console.log(fmtRow(r));
    console.log('');
  }
  if (board.topShorts.length) {
    console.log(`▼ TOP SHORTS`);
    for (const r of board.topShorts) console.log(fmtRow(r));
    console.log('');
  }
  if (!board.dislocations.length && !board.topLongs.length && !board.topShorts.length) {
    console.log(`  No actionable ideas — all candidates scored below tier threshold.`);
  }
}

main().catch(e => { console.error('Fatal:', e.message || e); process.exit(1); });
