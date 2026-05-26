/**
 * signals.mjs — Shared signal bus for cross-referencing trading alerts.
 *
 * Each scanner calls emitSignals() to register what it found.
 * The confluence aggregator reads all recent signals and finds convergence.
 *
 * Signal bus: memory/signals.json
 * TTL: 4 hours (signals older than this are purged automatically)
 *
 * Usage (in a scanner):
 *   import { emitSignals } from './lib/signals.mjs';
 *   emitSignals('vol-spike', [
 *     { ticker: 'NVDA', dir: 'bullish', str: 0.8, meta: { move: 3.2, volMult: 2.5 } },
 *   ]);
 *
 * Usage (in the aggregator):
 *   import { readSignals, findConfluence } from './lib/signals.mjs';
 *   const recent = readSignals(120);  // last 2 hours
 *   const confluences = findConfluence(recent, 2);  // >=2 sources
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const SIGNALS_PATH = resolve(__dir, '..', '..', 'memory', 'signals.json');
const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ---------------------------------------------------------------------------
// Signal structure
// ---------------------------------------------------------------------------
// {
//   src: string,          // source scanner name
//   ticker: string,       // uppercase ticker symbol
//   dir: string,          // 'bullish' | 'bearish' | 'neutral'
//   str: number,          // 0-1 normalized signal strength
//   meta: object,         // source-specific metadata
//   ts: number            // Unix timestamp (ms)
// }

// ---------------------------------------------------------------------------
// Read / Write helpers
// ---------------------------------------------------------------------------

function loadBus() {
  try {
    return JSON.parse(readFileSync(SIGNALS_PATH, 'utf-8'));
  } catch {
    return { signals: [], lastPurge: 0 };
  }
}

function saveBus(bus) {
  writeFileSync(SIGNALS_PATH, JSON.stringify(bus, null, 2));
}

// ---------------------------------------------------------------------------
// Purge stale signals
// ---------------------------------------------------------------------------

function purge(bus) {
  const cutoff = Date.now() - TTL_MS;
  bus.signals = bus.signals.filter(s => s.ts > cutoff);
  bus.lastPurge = Date.now();
  return bus;
}

// ---------------------------------------------------------------------------
// emitSignals — called by scanners to register signals
// ---------------------------------------------------------------------------

/**
 * @param {string} source - Scanner name (e.g., 'vol-spike', 'uw-flow', 'stocktwits')
 * @param {Array} signals - Array of { ticker, dir, str, meta }
 */
export function emitSignals(source, signals) {
  if (!signals || signals.length === 0) return;

  const bus = loadBus();
  const now = Date.now();

  // Purge if >1 hour since last purge
  if (now - bus.lastPurge > 60 * 60 * 1000) {
    purge(bus);
  }

  // Remove existing signals from this source that are >30 min old
  // (prevents stale signals from same source accumulating)
  const srcCutoff = now - 30 * 60 * 1000;
  bus.signals = bus.signals.filter(s => s.src !== source || s.ts > srcCutoff);

  // Add new signals
  for (const sig of signals) {
    bus.signals.push({
      src: source,
      ticker: (sig.ticker || '').toUpperCase(),
      dir: sig.dir || 'neutral',
      str: Math.min(1, Math.max(0, sig.str || 0.5)),
      meta: sig.meta || {},
      ts: now,
    });
  }

  saveBus(bus);
}

// ---------------------------------------------------------------------------
// readSignals — read signals within a time window
// ---------------------------------------------------------------------------

/**
 * @param {number} windowMin - How many minutes back to look (default 120)
 * @returns {Array} Array of signal objects
 */
export function readSignals(windowMin = 120) {
  const bus = loadBus();
  const cutoff = Date.now() - windowMin * 60 * 1000;
  return bus.signals.filter(s => s.ts > cutoff);
}

// ---------------------------------------------------------------------------
// findConfluence — group signals by ticker, find multi-source convergence
// ---------------------------------------------------------------------------

/**
 * @param {Array} signals - Array of signal objects (from readSignals)
 * @param {number} minSources - Minimum unique sources for confluence (default 2)
 * @returns {Array} Array of { ticker, score, sources, signals, direction }
 */
export function findConfluence(signals, minSources = 2) {
  // Group by ticker
  const byTicker = {};
  for (const sig of signals) {
    if (!sig.ticker) continue;
    if (!byTicker[sig.ticker]) byTicker[sig.ticker] = [];
    byTicker[sig.ticker].push(sig);
  }

  const results = [];

  for (const [ticker, sigs] of Object.entries(byTicker)) {
    // Unique sources
    const sources = [...new Set(sigs.map(s => s.src))];
    if (sources.length < minSources) continue;

    // Calculate weighted score
    const score = sigs.reduce((sum, s) => sum + s.str, 0);

    // Determine net direction
    let bullish = 0, bearish = 0;
    for (const s of sigs) {
      if (s.dir === 'bullish') bullish += s.str;
      else if (s.dir === 'bearish') bearish += s.str;
    }
    const direction = bullish > bearish ? 'bullish'
                    : bearish > bullish ? 'bearish'
                    : 'mixed';

    results.push({
      ticker,
      score: Math.round(score * 100) / 100,
      sourceCount: sources.length,
      sources,
      direction,
      signals: sigs,
    });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---------------------------------------------------------------------------
// Source category labels (for display)
// ---------------------------------------------------------------------------

export const SOURCE_LABELS = {
  'vol-spike':       '📊 Volume Spike',
  'tape-anoms':      '🔍 Tape Anomaly',
  'uw-flow':         '🐋 UW Options Flow',
  'uw-custom':       '🐋 UW Custom Alert',
  'uw-screener':     '🐋 UW Screener',
  'barchart-options': '📈 Barchart Options',
  'polygon-flow':    '📈 Polygon Flow',
  'stocktwits':      '💬 Stocktwits Trending',
  'news-tape':       '📰 News',
  'high-vol-movers': '🔥 High Volume Mover',
  'premarket-gaps':  '🌅 Premarket Gap',
  'relative-strength': '💪 Relative Strength',
  'volume-breakout': '🚀 Volume Breakout',
  'mean-reversion':  '↩️ Mean Reversion',
  'trade-finder':    '🎯 Trade Finder',
  'email-research':  '📧 Email Research',
  'analyst-rating':  '⭐ Analyst Rating',
  'short-squeeze':   '🔥 Short Squeeze',
  'earnings-stat':   '📅 Earnings Stat',
  'revisions':       '📈 Estimate Revisions',
  'theta-skew':      '🌊 IV/Skew Regime',
  'analyst-stack':   '🎙 Analyst Stack',
  'ubs-russell':     '⚖️ Russell Rebal',
  'rebal-flow':      '⚖️ Index Rebal',
};
