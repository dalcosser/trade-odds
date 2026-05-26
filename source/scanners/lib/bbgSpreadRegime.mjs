/**
 * bbgSpreadRegime.mjs — Read v_bbg_spread_zscore and classify the current
 * Bloomberg cross-asset regime.
 *
 * Each spread carries:
 *   - z_5y         : standardized over last ~5y
 *   - signal       : EXTENDED_LONG / EXTENDED_SHORT / NORMAL (>=2σ)
 *                    STRETCHED_LONG / STRETCHED_SHORT (>=3σ)
 *
 * The library returns:
 *   - latestTs
 *   - spreads  : full latest snapshot
 *   - stretched: spreads with |z_5y| >= 2 (sorted by |z|)
 *   - tags     : human-readable regime tags (e.g. "early-cycle bid", "high-beta led")
 *   - tilt     : { risk: -1..+1, growth: -1..+1, defensives: -1..+1 }
 */

import { chQuery } from './clickhouse.mjs';

// Spread name → which axis it tilts and in which direction when "LONG" (positive z).
// risk axis: +1 = risk-on, -1 = risk-off
// growth: +1 = growth bid, -1 = value bid
// defensives: +1 = defensives bid, -1 = cyclicals bid
const SPREAD_MAP = {
  'EarLate':            { risk: +1, growth:  0, defensives: -1, label: 'Early Cycle vs Late Cycle' },
  'HighBetaLowBeta':    { risk: +1, growth:  0, defensives: -1, label: 'High Beta vs Low Beta' },
  'CyclDef':            { risk: +1, growth:  0, defensives: -1, label: 'Cyclicals vs Defensives' },
  'Cheap vs Expensive': { risk:  0, growth: -1, defensives:  0, label: 'Cheap vs Expensive' },
  'Software vs Semis':  { risk: -0.5, growth: +1, defensives: 0, label: 'Software vs Semis (SW lead = defensive growth)' },
  'GoldSilver':         { risk: -1, growth:  0, defensives: +1, label: 'Gold vs Silver (ratio up = fear)' },
  'Misc':               { risk: +1, growth:  0, defensives: -1, label: 'GS Momentum Pair' },
  'Info Tech':          { risk: +0.5, growth: +1, defensives: 0, label: 'Info Tech sector strength' },
  'Financial':          { risk: +0.5, growth:  0, defensives: -1, label: 'Financials sector strength' },
  'Cons Disc':          { risk: +1, growth:  0, defensives: -1, label: 'Cons Disc sector strength' },
  'Cons Staples':       { risk: -1, growth:  0, defensives: +1, label: 'Cons Staples sector strength' },
  'Utilities':          { risk: -1, growth:  0, defensives: +1, label: 'Utilities sector strength' },
  'Energy':             { risk:  0, growth: -1, defensives:  0, label: 'Energy sector strength' },
  'Industrials':        { risk: +0.5, growth: 0, defensives: -0.5, label: 'Industrials sector strength' },
  'Materials':          { risk: +0.5, growth: 0, defensives: -0.5, label: 'Materials sector strength' },
  'Health Care':        { risk: -0.5, growth: 0, defensives: +1, label: 'Health Care sector strength' },
  'Comm Svcs':          { risk: +0.5, growth: +0.5, defensives: 0, label: 'Comm Svcs sector strength' },
};

const Z_STRETCHED = 2.0;

export async function getBbgSpreadRegime({ minAbsZ = Z_STRETCHED } = {}) {
  const rows = await chQuery(`
    SELECT spread_id, spread_name, category, ts, value,
           z_200d, z_5y, signal
    FROM v_bbg_spread_zscore
    WHERE ts = (SELECT max(ts) FROM v_bbg_spread_zscore)
    ORDER BY abs(z_5y) DESC NULLS LAST
  `).catch(() => null);

  if (!rows || rows.length === 0) {
    return { latestTs: null, spreads: [], stretched: [], tags: [], tilt: { risk: 0, growth: 0, defensives: 0 } };
  }

  const latestTs = rows[0].ts;
  const stretched = rows.filter(r => r.z_5y != null && Math.abs(Number(r.z_5y)) >= minAbsZ);

  // Compute tilts by weighted-sum of stretched spreads
  let risk = 0, growth = 0, defensives = 0, w = 0;
  for (const s of stretched) {
    const m = SPREAD_MAP[s.spread_id];
    if (!m) continue;
    const z = Number(s.z_5y);
    const cap = Math.max(-4, Math.min(4, z));
    risk       += m.risk       * cap;
    growth     += m.growth     * cap;
    defensives += m.defensives * cap;
    w += 1;
  }
  if (w > 0) { risk /= w; growth /= w; defensives /= w; }

  // Build human-readable tags
  const tags = [];
  for (const s of stretched.slice(0, 6)) {
    const z = Number(s.z_5y).toFixed(1);
    const side = z >= 0 ? 'LONG' : 'SHORT';
    const label = SPREAD_MAP[s.spread_id]?.label || s.spread_name;
    tags.push(`${label} ${side} ${z}σ`);
  }

  // Top-level regime label
  let regime = 'BALANCED';
  if (risk >= 1.0) regime = 'RISK-ON CYCLICAL';
  else if (risk >= 0.4) regime = 'risk-on tilt';
  else if (risk <= -1.0) regime = 'RISK-OFF DEFENSIVE';
  else if (risk <= -0.4) regime = 'risk-off tilt';
  if (defensives >= 1.0 && risk < 0) regime = 'FLIGHT TO DEFENSIVES';
  if (growth >= 1.0) regime += ' · growth-bid';
  if (growth <= -1.0) regime += ' · value-bid';

  return {
    latestTs,
    regime,
    tilt: {
      risk:       +risk.toFixed(2),
      growth:     +growth.toFixed(2),
      defensives: +defensives.toFixed(2),
    },
    stretched: stretched.map(s => ({
      id: s.spread_id, name: s.spread_name, category: s.category,
      value: Number(s.value), z200d: s.z_200d != null ? Number(s.z_200d) : null,
      z5y: Number(s.z_5y), signal: s.signal,
    })),
    spreads: rows.map(s => ({
      id: s.spread_id, name: s.spread_name, category: s.category,
      z200d: s.z_200d != null ? Number(s.z_200d) : null,
      z5y: s.z_5y != null ? Number(s.z_5y) : null,
      signal: s.signal,
    })),
    tags,
  };
}

export function formatBbgRegimeLine(reg) {
  if (!reg || !reg.latestTs) return null;
  const t = reg.tilt;
  const arrow = v => v >= 0.5 ? '↑↑' : v >= 0.2 ? '↑' : v <= -0.5 ? '↓↓' : v <= -0.2 ? '↓' : '·';
  return `BBG REGIME: ${reg.regime}   risk ${arrow(t.risk)}${t.risk.toFixed(1)}  growth ${arrow(t.growth)}${t.growth.toFixed(1)}  def ${arrow(t.defensives)}${t.defensives.toFixed(1)}  (asof ${reg.latestTs})`;
}
