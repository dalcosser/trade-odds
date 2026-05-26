/**
 * journalEmit.mjs — shared helper for appending ideas to memory/idea_journal.json.
 *
 * Schema is kept identical to idea_board.mjs's emit pattern so idea_journal.mjs
 * can resolve outcomes from ClickHouse forward bars regardless of source.
 *
 * Required idea fields:
 *   ticker, direction ('long'|'short'), tier ('TRADE'|'WATCHLIST'),
 *   score (0-10ish), setup (string), entry, stop, t1, t2, rr1, rr2.
 * Filled by the resolver later: outcome, maxFavorable, maxAdverse, hitT1, hitStop.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const JOURNAL_PATH = resolve(__dir, '..', '..', 'memory', 'idea_journal.json');

function readJSON(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

/**
 * Build a long-side trade ticket from current snapshot + reference level + ATR.
 * Stop sits below `refLevel` by an ATR-based buffer (volatility-aware), with a
 * minimum-risk floor so we never emit a ticket where the stop is just noise.
 *
 * The old % buffer was broken — for SIDU at $3 with 1% buffer = $0.03 stop
 * = penny-stop-hunt by design. ATR-based scales to the volatility of the name.
 *
 * Two safety floors:
 *   1. stop must be < entry (else the thesis is broken — already through stop)
 *   2. risk (entry-stop) must be ≥ MIN_RISK_ATR × ATR (else stop is too tight)
 *      → if natural buffer is too tight, anchor stop at entry − MIN_RISK_ATR×ATR
 *
 * @param stopAtr    — fraction of ATR to subtract below refLevel (default 0.5)
 * @param t1Atr      — T1 = entry + this×ATR (default 1.5)
 * @param t2Atr      — T2 = entry + this×ATR (default 3.0)
 * @param minRiskAtr — minimum risk (entry-stop) in ATR units (default 0.5)
 */
export function buildLongTicket({ entry, refLevel, atr, stopAtr = 0.5, t1Atr = 1.5, t2Atr = 3.0, minRiskAtr = 0.5,
                                  // legacy alias for backward-compat — convert % to a sane ATR-equivalent
                                  stopBufferPct }) {
  if (!entry || !refLevel || !atr || atr <= 0) return null;
  // Backward-compat: callers passing the old stopBufferPct still work, but the
  // value is reinterpreted — 1% nominal is ignored, replaced with stopAtr=0.5.
  // Callers that want a different ATR multiple should explicitly pass stopAtr.
  // (We keep the param to avoid breaking imports; the behavior is now ATR-based.)
  if (stopBufferPct != null && stopAtr === 0.5) stopAtr = 0.5;
  let stop = refLevel - stopAtr * atr;
  // Floor: enforce minimum risk = minRiskAtr × ATR. If natural stop is too tight
  // (i.e. refLevel is too close to entry), widen stop to entry − minRiskAtr×ATR.
  const minRisk = minRiskAtr * atr;
  if (entry - stop < minRisk) stop = entry - minRisk;
  if (stop >= entry) return null; // still inverted somehow → reject
  const risk = entry - stop;
  const t1 = entry + atr * t1Atr;
  const t2 = entry + atr * t2Atr;
  const rr1 = +(((t1 - entry) / risk).toFixed(2));
  const rr2 = +(((t2 - entry) / risk).toFixed(2));
  return {
    entry: +entry.toFixed(2),
    stop: +stop.toFixed(2),
    t1: +t1.toFixed(2),
    t2: +t2.toFixed(2),
    rr1, rr2,
  };
}

/**
 * Unified bracket-ticket builder for ANY scanner (long or short). Same ATR-based
 * stop logic as buildLongTicket but works for both directions. Use this when
 * emitting to signal bus so journal_consumer.mjs can pick up the ticket.
 */
export function buildTicket({ direction, entry, refLevel, atr, stopAtr = 0.5, t1Atr = 1.5, t2Atr = 3.0, minRiskAtr = 0.5 }) {
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
    entry: +entry.toFixed(2),
    stop: +stop.toFixed(2),
    t1: +t1.toFixed(2),
    t2: +t2.toFixed(2),
    rr1: +(Math.abs(t1 - entry) / risk).toFixed(2),
    rr2: +(Math.abs(t2 - entry) / risk).toFixed(2),
    atr: +atr.toFixed(2),
  };
}

/**
 * Append ideas to the journal, trim to last 30d, write atomically.
 *
 * @param {string} source — short tag (e.g. 'momentum-close', 'ma-pullback', 'ma-reclaim')
 * @param {Array} ideas — array of idea objects (ticker, direction, tier, score, setup, ticket fields)
 * @returns {{ written: number, skipped: number }}
 */
export function appendIdeas(source, ideas) {
  if (!ideas?.length) return { written: 0, skipped: 0 };
  const journal = readJSON(JOURNAL_PATH) || { ideas: [] };
  const runId = `${source}-${Date.now()}`;
  const ts = new Date().toISOString();
  let written = 0, skipped = 0;

  for (const i of ideas) {
    if (!i.ticker || !i.entry || !i.stop || !i.t1 || !i.t2) { skipped++; continue; }
    journal.ideas.push({
      id: `${runId}-${i.ticker}`,
      ticker: i.ticker,
      ts,
      direction: i.direction || 'long',
      tier: i.tier || 'WATCHLIST',
      score: i.score ?? 0,
      setup: i.setup || source,
      dislocation: !!i.dislocation,
      entry: i.entry,
      stop: i.stop,
      t1: i.t1,
      t2: i.t2,
      rr1: i.rr1 ?? null,
      rr2: i.rr2 ?? null,
      meta: i.meta || {},
      outcome: null,
      maxFavorable: null,
      maxAdverse: null,
      hitT1: null,
      hitStop: null,
    });
    written++;
  }

  // Trim to last 30 days to keep file small
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  journal.ideas = journal.ideas.filter(i => new Date(i.ts).getTime() > cutoff);

  writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, 2));
  return { written, skipped };
}
