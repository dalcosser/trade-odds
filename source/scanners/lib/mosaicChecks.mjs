/**
 * mosaicChecks.mjs — three additional confluence checks that close the gap
 * between catalyst data, sell-side flow, and dealer gamma positioning.
 *
 *   checkCatalystProximity(ticker)  → Catalyst within N days?  (intensity, neutral-direction)
 *   checkStreetConviction(ticker)   → Today's analyst calls + multi-desk agreement
 *   checkGammaMagnetics(ticker,row) → Distance to call/put walls in ATR units + OPEX horizon
 *
 * Each returns the same shape used by confluence.mjs:
 *   { score: 0..1, status: <string>, detail: <string>, ...extra }
 *
 * Direction of each:
 *   - catalystProximity is NEUTRAL: it amplifies conviction (added to total score
 *     but NOT to bull/bear votes — let the rest of the brain pick direction).
 *   - streetConviction has direction (bullish/bearish/mixed/no-data).
 *   - gammaMagnetics has direction (gamma-squeeze-up/gamma-pin-down/pin-zone/pin-broken).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// better-sqlite3 is a native npm dep that needs compilation. Node 22+ ships
// a built-in `node:sqlite` with the same prepare()/all()/get() surface we use
// here. Prefer the built-in; fall back to better-sqlite3 only if it's available.
// If neither loads, the analyst-call backfill skips gracefully (the engine's
// 14 checks are designed to tolerate any one source being unavailable).
let Database = null;
try {
  const m = await import('node:sqlite');
  // Adapter so the constructor signature matches better-sqlite3's
  Database = class {
    constructor(path, opts) {
      this._db = new m.DatabaseSync(path, { readOnly: opts?.readonly });
    }
    prepare(sql) { return this._db.prepare(sql); }
    close() { try { this._db.close(); } catch {} }
  };
} catch {
  try { Database = (await import('better-sqlite3')).default; }
  catch { /* both unavailable; checkStreetConviction will return no-data */ }
}
import { uw, num } from './uw_api.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
// Path layout in trade-odds:  <repo>/source/scanners/lib/mosaicChecks.mjs
// memory/ lives at <repo>/memory/  → up three levels from __dir.
const MEM = process.env.MEMORY_DIR || resolve(__dir, '..', '..', '..', 'memory');

function readJSON(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function daysBetween(aStr, bStr) {
  // YYYY-MM-DD strings, returns calendar days a→b (positive = b is in future)
  const a = new Date(aStr + 'T12:00:00Z');
  const b = new Date(bStr + 'T12:00:00Z');
  return Math.round((b - a) / 86_400_000);
}

// ── Check 12: Catalyst Proximity ─────────────────────────────────────────
// Reads memory/email_catalysts.json (refreshed 7:30am, 5pm by catalyst_extractor).
// Scoring weights events by type AND days-out, multi-event names get a bump.
const EVENT_WEIGHTS = [
  { match: /earnings|q[1-4]|1q|2q|3q|4q|results/i, weight: 1.0,  label: 'earnings' },
  { match: /investor.day|capital.markets|analyst.day/i, weight: 0.8, label: 'investor-day' },
  { match: /conference|summit|presents/i, weight: 0.55, label: 'conference' },
  { match: /price.target|pt.rais|target.rais|upgrade/i, weight: 0.5, label: 'pt/upgrade' },
  { match: /guidance|guide/i, weight: 0.5, label: 'guidance' },
  { match: /split|dividend|fda|trial|approval|cmd/i, weight: 0.7, label: 'binary-event' },
];

function classifyEvent(eventStr) {
  const s = String(eventStr || '');
  for (const e of EVENT_WEIGHTS) if (e.match.test(s)) return e;
  return { weight: 0.3, label: 'event' };
}

// Days-out decay: 0d=1.0, 1d=0.95, 3d=0.75, 7d=0.45, 14d=0.20, 21d=0.05, beyond=0
function decayByDays(d) {
  if (d < 0 || d > 21) return 0;
  if (d <= 1) return 1.0 - 0.05 * d;
  if (d <= 3) return 0.95 - 0.10 * (d - 1);
  if (d <= 7) return 0.75 - 0.075 * (d - 3);
  if (d <= 14) return 0.45 - 0.036 * (d - 7);
  return 0.20 - 0.014 * (d - 14);
}

export function checkCatalystProximity(ticker) {
  const t = ticker.toUpperCase();
  const data = readJSON(resolve(MEM, 'email_catalysts.json'));
  if (!data?.catalysts?.length) {
    return { score: 0, status: 'no-data', detail: 'email_catalysts.json missing or empty' };
  }
  const today = todayET();
  const myEvents = data.catalysts
    .filter(c => (c.ticker || '').toUpperCase() === t)
    .map(c => ({ ...c, daysOut: c.date ? daysBetween(today, c.date) : null }))
    .filter(c => c.daysOut !== null && c.daysOut >= 0 && c.daysOut <= 21);

  if (!myEvents.length) {
    return { score: 0, status: 'no-catalyst', detail: 'No catalyst within 21 days', events: [] };
  }

  // Score = max single-event score + small bonus for additional events
  let maxScore = 0;
  let topEvent = null;
  const breakdown = [];
  for (const ev of myEvents) {
    const cls = classifyEvent(ev.event);
    const decay = decayByDays(ev.daysOut);
    const s = cls.weight * decay;
    breakdown.push({ event: ev.event, source: ev.source, daysOut: ev.daysOut, type: cls.label, contrib: Math.round(s * 100) / 100 });
    if (s > maxScore) { maxScore = s; topEvent = { ...ev, type: cls.label }; }
  }
  const multiBonus = myEvents.length > 1 ? Math.min(0.15, (myEvents.length - 1) * 0.05) : 0;
  let score = Math.min(1, maxScore + multiBonus);
  score = Math.round(score * 100) / 100;

  // Status — intensity tiers (NOT bullish/bearish; this is a magnitude flag)
  let status;
  if (score >= 0.7) status = 'imminent-catalyst';
  else if (score >= 0.35) status = 'near-catalyst';
  else if (score > 0) status = 'distant-catalyst';
  else status = 'no-catalyst';

  const detail = topEvent
    ? `${topEvent.type} in ${topEvent.daysOut}d (${topEvent.event}; ${topEvent.source || 'unknown src'})${myEvents.length > 1 ? ` · +${myEvents.length - 1} more` : ''}`
    : 'No qualifying catalyst';

  return { score, status, detail, events: breakdown, topEvent };
}

// ── Check 13: Street Conviction ──────────────────────────────────────────
// Reads memory/ratings_today.json (today's parsed Bloomberg ratings)
// + memory/knowledge.db for 30d analyst-call backfill.
// Direction: bullish = upgrades/PT raises today; bearish = downgrades.
let kbDb = null;
function getKb() {
  if (kbDb !== null) return kbDb;
  if (!Database) { kbDb = false; return kbDb; }
  try {
    kbDb = new Database(resolve(MEM, 'knowledge.db'), { readonly: true, fileMustExist: true });
  } catch { kbDb = false; }
  return kbDb;
}

export function checkStreetConviction(ticker) {
  const t = ticker.toUpperCase();
  const ratings = readJSON(resolve(MEM, 'ratings_today.json')) || {};

  const upToday      = (ratings.upgrades   || []).filter(r => (r.ticker || '').toUpperCase() === t);
  const dnToday      = (ratings.downgrades || []).filter(r => (r.ticker || '').toUpperCase() === t);
  const initToday    = (ratings.initiations|| []).filter(r => (r.ticker || '').toUpperCase() === t);
  const ptToday      = (ratings.ptRaises   || []).filter(r => (r.ticker || '').toUpperCase() === t);
  const todayAll     = [...upToday, ...dnToday, ...initToday, ...ptToday];
  const firmsToday   = new Set(todayAll.map(r => r.firm).filter(Boolean));
  const multiDesk    = firmsToday.size >= 2;

  // 30d backfill from knowledge.db
  let priorCalls = 0, priorUp = 0, priorDn = 0;
  const db = getKb();
  if (db) {
    try {
      const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      const rows = db.prepare(`
        SELECT action_type, firm, call_date FROM analyst_calls
        WHERE ticker = ? AND call_date >= ?
      `).all(t, cutoff);
      priorCalls = rows.length;
      for (const r of rows) {
        const a = String(r.action_type || '').toLowerCase();
        if (/upgrade|buy|raise|overweight|outperform/.test(a)) priorUp++;
        else if (/downgrade|sell|cut|underweight|underperform/.test(a)) priorDn++;
      }
    } catch {}
  }

  if (todayAll.length === 0 && priorCalls === 0) {
    return { score: 0, status: 'no-data', detail: 'No street action today + no 30d history', sources: 0 };
  }

  // Direction
  const bullCount = upToday.length + ptToday.length;
  const bearCount = dnToday.length;
  // Initiations are direction-aware via rating field (Buy/Sell/Hold)
  const initBull = initToday.filter(r => /buy|overweight|outperform/i.test(r.rating || r.action || '')).length;
  const initBear = initToday.filter(r => /sell|underweight|underperform/i.test(r.rating || r.action || '')).length;
  const totalBull = bullCount + initBull;
  const totalBear = bearCount + initBear;

  // Score components: today's action heavily weighted, prior calls light context
  let directional = 0;
  let status = 'mixed';
  if (totalBull > totalBear * 1.3) {
    status = 'bullish';
    directional = Math.min(0.9, 0.45 + 0.20 * (totalBull - totalBear));
  } else if (totalBear > totalBull * 1.3) {
    status = 'bearish';
    directional = Math.min(0.9, 0.45 + 0.20 * (totalBear - totalBull));
  } else if (todayAll.length > 0) {
    status = 'mixed';
    directional = 0.20;
  }
  // Multi-desk bonus
  if (multiDesk && status !== 'mixed') directional = Math.min(1, directional + 0.15);
  // Historical churn — if 30d had 3+ actions and today reinforces, +0.05
  if (priorCalls >= 3 && status !== 'mixed') {
    const reinforces = (status === 'bullish' && priorUp > priorDn) || (status === 'bearish' && priorDn > priorUp);
    if (reinforces) directional = Math.min(1, directional + 0.10);
  }
  // No-action-today fallback: only historical context
  if (todayAll.length === 0) {
    if (priorUp > priorDn * 1.3) { status = 'bullish'; directional = 0.20; }
    else if (priorDn > priorUp * 1.3) { status = 'bearish'; directional = 0.20; }
    else { status = 'context-only'; directional = 0.10; }
  }

  const score = Math.round(directional * 100) / 100;

  const todaySummary = todayAll.length
    ? todayAll.slice(0, 3).map(r => `${r.firm || '?'} ${(r.action || '').replace(/<.*$/, '').trim().slice(0, 40)}`).join(' · ')
    : '';
  const detail = todayAll.length
    ? `${todayAll.length} call${todayAll.length > 1 ? 's' : ''} today across ${firmsToday.size} desk${firmsToday.size > 1 ? 's' : ''}${priorCalls ? ` · ${priorCalls} in prior 30d` : ''}: ${todaySummary}`
    : `${priorCalls} call${priorCalls > 1 ? 's' : ''} in 30d (${priorUp} bull / ${priorDn} bear)`;

  return {
    score, status, detail,
    sources: firmsToday.size,
    todayCount: todayAll.length,
    priorCount: priorCalls,
    multiDesk,
    todaySummary: todayAll.slice(0, 5).map(r => ({ firm: r.firm, action: (r.action || '').replace(/<.*$/, '').trim() })),
  };
}

// ── Shared helper: dealer gamma regime via UW spotExposures ────────────
// Returns the LIVE dealer gamma regime — what really matters for the trade:
//   gammaDir > 0  → long-gamma regime  (dealers stabilize → pin / grind)
//   gammaDir < 0  → short-gamma regime (dealers amplify → vol expansion)
// The SIGN flip is the regime change event. We don't try to compute the exact
// "flip strike" because (a) it requires bisecting strike-level data with
// assumptions about hedging behavior, (b) the cum-GEX-from-OI method is
// unreliable when the book is persistently one-sided (which it often is on
// indices), and (c) what we actually want to alert on is the regime CHANGE,
// not the price level. The sign of gamma_per_one_percent_move_dir is UW's
// best read on regime — track its sign across ticks, alert on flip.
//
// Returns: { regime: 'long-gamma' | 'short-gamma' | 'unknown',
//            gammaDir, spot, weakRegimeFrac (0..1, higher = closer to flipping) }
export async function getGammaRegime(ticker) {
  let series;
  try { series = await uw.spotExposures(ticker, { ttlMs: 60_000 }); } catch { return { regime: 'unknown' }; }
  if (!Array.isArray(series) || !series.length) return { regime: 'unknown' };
  const latest = series[series.length - 1];
  const gammaDir = num(latest?.gamma_per_one_percent_move_dir);
  const spot = num(latest?.price);
  if (!Number.isFinite(gammaDir) || gammaDir === 0) {
    return { regime: 'unknown', gammaDir: null, spot };
  }
  // Weakness: how close to flipping. Compare current |gammaDir| to recent
  // session max — if current is within 15% of zero relative to recent peak,
  // we're at-risk of flipping.
  const recentMagnitudes = series.slice(-20)
    .map(r => Math.abs(num(r.gamma_per_one_percent_move_dir) || 0))
    .filter(x => Number.isFinite(x) && x > 0);
  const peak = recentMagnitudes.length ? Math.max(...recentMagnitudes) : Math.abs(gammaDir);
  const weakRegimeFrac = peak > 0 ? 1 - (Math.abs(gammaDir) / peak) : 0;

  return {
    regime: gammaDir > 0 ? 'long-gamma' : 'short-gamma',
    gammaDir,
    spot,
    weakRegimeFrac: Math.max(0, Math.min(1, weakRegimeFrac)),
  };
}

// ── Shared helper: real gamma walls via spot-exposures-by-strike ────────
// Reusable by gamma_pin_daemon.mjs. Returns { spot, maxPain, callWall, putWall, expiry, daysOut }
// or null if data missing. Walls are strikes within ±2% of spot with the
// largest call_gamma_oi / |put_gamma_oi|. This is the same recipe uw_opex_levels.mjs uses.
export async function findGammaWalls(ticker) {
  const t = ticker.toUpperCase();
  const today = todayET();
  const [maxPainRows, spotStrikes] = await Promise.all([
    uw.maxPain(t, { ttlMs: 300_000 }).catch(() => []),
    uw.spotExposuresByStrike(t, { params: { limit: 500 }, ttlMs: 300_000 }).catch(() => []),
  ]);
  if (!Array.isArray(maxPainRows) || !maxPainRows.length) return null;

  const ranked = maxPainRows
    .map(r => ({ ...r, daysOut: r.expiry ? daysBetween(today, r.expiry) : null }))
    .filter(r => r.daysOut !== null && r.daysOut >= 0)
    .sort((a, b) => a.daysOut - b.daysOut);
  if (!ranked.length) return null;
  // Always pick the soonest forward expiry. For SPY/QQQ/IWM/SPX with daily
  // listings this is true 0DTE (or 1DTE on Tue/Thu when no daily-expiry exists).
  // For single names without dailies, soonest IS the nearest weekly Friday —
  // same outcome, no need for a Friday-preference rule that hijacks 0DTE on Mondays.
  const isFriday = (dStr) => new Date(dStr + 'T12:00:00Z').getUTCDay() === 5;
  const target = ranked[0];

  const maxPain = num(target.max_pain);
  const close   = num(target.close); // current spot from UW (best-effort)

  // Find real walls within ±2% of close. Three concepts:
  //   • call wall — largest call_gamma_oi above spot (resistance / squeeze trigger)
  //   • put wall  — largest |put_gamma_oi| below spot (support / breakdown trigger)
  //   • battle strike — strike within band with largest COMBINED gamma OI (the magnet
  //     dealers most aggressively defend; this is what platforms surface when spot
  //     is sitting on a contested strike, even if it's slightly above or below spot)
  let callWallStrike = null, putWallStrike = null;
  let callWallOi = 0, putWallOi = 0;
  let battleStrike = null, battleOi = 0;
  if (close && Array.isArray(spotStrikes) && spotStrikes.length) {
    const band = close * 0.02;
    for (const r of spotStrikes) {
      const k = num(r.strike);
      if (!k || Math.abs(k - close) > band) continue;
      const cg = num(r.call_gamma_oi) || 0;
      const pg = Math.abs(num(r.put_gamma_oi) || 0);
      const combined = cg + pg;
      if (k > close && cg > callWallOi) { callWallOi = cg; callWallStrike = k; }
      if (k < close && pg > putWallOi)  { putWallOi  = pg; putWallStrike = k; }
      if (combined > battleOi) { battleOi = combined; battleStrike = k; }
    }
  }

  // Fallback to max-pain-adjacent strikes if spot-exposures lookup failed
  if (!callWallStrike && target.next_upper_strike) callWallStrike = num(target.next_upper_strike);
  if (!putWallStrike && target.next_lower_strike)  putWallStrike  = num(target.next_lower_strike);

  return {
    spot: close,
    maxPain,
    callWall: callWallStrike,
    putWall: putWallStrike,
    battleStrike,                  // strike with largest COMBINED |gamma OI| in ±2% band
    callWallOi, putWallOi, battleOi,
    expiry: target.expiry,
    daysOut: target.daysOut,
    isFriday: isFriday(target.expiry),
  };
}

// ── Check 14: Gamma Magnetics ────────────────────────────────────────────
// Distance to call wall / put wall in ATR units + OPEX horizon.
// Bullish bias when spot < call wall < 1.5 ATR away with Friday < 5d (gamma squeeze).
// Bearish bias when spot > put wall, or distance to put wall < 1 ATR (gamma pin down).
// Walls computed via spotExposuresByStrike (real call/put gamma OI within ±2% of spot).
// uw.gex used for gamma-flip context (long vs short dealer gamma regime).
export async function checkGammaMagnetics(ticker, row) {
  const close = num(row?.Close);
  const atr = num(row?.ATR_14);
  if (!close || !atr) {
    return { score: 0, status: 'no-data', detail: 'Missing close or ATR' };
  }

  const walls = await findGammaWalls(ticker);
  if (!walls) {
    return { score: 0, status: 'no-data', detail: 'No UW max_pain / spot-exposures data' };
  }

  const target = { expiry: walls.expiry, daysOut: walls.daysOut };
  const maxPain = walls.maxPain;
  const callWall = walls.callWall;
  const putWall  = walls.putWall;
  const friday = walls.isFriday && walls.daysOut <= 7 ? walls : null;

  const distCall = callWall ? (callWall - close) / atr : null; // ATR units, positive = above spot
  const distPut  = putWall  ? (close - putWall)  / atr : null; // ATR units, positive = above wall
  const distPain = maxPain  ? (close - maxPain)  / atr : null;

  // Pull GEX for flip-side context (best-effort, don't fail if endpoint hiccups)
  let gexFlip = null, gexNetGamma = null;
  try {
    const gex = await uw.gex(t, { ttlMs: 600_000 });
    const latest = Array.isArray(gex) ? gex[gex.length - 1] : gex;
    gexFlip = num(latest?.gamma_flip || latest?.flip);
    gexNetGamma = num(latest?.call_gamma) - num(latest?.put_gamma);
  } catch {}

  // Classify
  let status = 'pin-zone';
  let score = 0.15;
  let direction = 'neutral';
  const opexNear = target.daysOut <= 5;

  // Gamma squeeze setup: spot < callWall, distance < 1.5 ATR, OPEX within 5d, positive net gamma
  if (distCall !== null && distCall > 0 && distCall < 1.5 && opexNear) {
    status = 'gamma-squeeze-up';
    direction = 'bullish';
    // Closer wall + sooner expiry = stronger
    score = Math.min(1, 0.55 + (1.5 - distCall) * 0.20 + (5 - target.daysOut) * 0.05);
  }
  // Gamma pin-down setup: spot > putWall, distance < 1.0 ATR, downside acceleration risk
  else if (distPut !== null && distPut > 0 && distPut < 1.0) {
    status = 'gamma-pin-down';
    direction = 'bearish';
    score = Math.min(0.85, 0.50 + (1.0 - distPut) * 0.25);
  }
  // Pin-broken setup: spot has cleared a wall on the upside (distCall < 0 means spot > callWall)
  else if (distCall !== null && distCall < -0.25) {
    status = 'pin-broken-up';
    direction = 'bullish';
    score = 0.45; // momentum past wall = follow-through, but lower conviction than squeeze-into
  }
  else if (distPut !== null && distPut < -0.25) {
    status = 'pin-broken-down';
    direction = 'bearish';
    score = 0.45;
  }
  // Pin-magnet: price hovering near max_pain ± 0.5 ATR
  else if (distPain !== null && Math.abs(distPain) < 0.5 && opexNear) {
    status = 'pin-magnet';
    direction = 'neutral';
    score = 0.30;
  }
  // Generic mid-range
  else {
    status = 'pin-zone';
    direction = 'neutral';
    score = 0.15;
  }

  // GEX flip alignment bonus — if we're saying squeeze-up and gexNetGamma > 0 (positive
  // gamma supports orderly grind up), bump. If gexNetGamma < 0 in pin-down, bump.
  if (gexNetGamma !== null) {
    if (status === 'gamma-squeeze-up' && gexNetGamma > 0) score = Math.min(1, score + 0.10);
    if (status === 'gamma-pin-down' && gexNetGamma < 0) score = Math.min(1, score + 0.10);
  }

  score = Math.round(score * 100) / 100;

  // distCall positive = wall above spot (room to squeeze up); negative = spot broke wall up
  // distPut  positive = wall below spot (cushion); negative = spot broke wall down
  const fmtATR = (x) => x === null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}ATR`;
  const expiryTag = target.daysOut === 0 ? '0DTE' : `${target.daysOut}DTE`;
  const detail =
    `${target.expiry} [${expiryTag}]: pain ${maxPain?.toFixed(2)}, call wall ${callWall?.toFixed(2)} (${fmtATR(distCall)} above spot), put wall ${putWall?.toFixed(2)} (${fmtATR(distPut)} below spot) → ${status}`;

  return {
    score, status, direction, detail,
    expiry: target.expiry, daysToExpiry: target.daysOut, isFriday: !!friday,
    maxPain, callWall, putWall,
    distToCallATR: distCall !== null ? Math.round(distCall * 100) / 100 : null,
    distToPutATR:  distPut  !== null ? Math.round(distPut  * 100) / 100 : null,
    distToPainATR: distPain !== null ? Math.round(distPain * 100) / 100 : null,
    gexFlip, gexNetGamma,
  };
}
