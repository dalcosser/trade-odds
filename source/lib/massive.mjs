// Central Massive/Polygon access helper.
//
// One key: MASSIVE_API_KEY (real-time stocks plan). Options flow is NOT on
// this plan — use UW instead (scripts/lib/uw_api.mjs).
//
// Usage:
//   import { getKey, polygonUrl } from './lib/massive.mjs';
//   const url = polygonUrl('/v2/snapshot/locale/us/markets/stocks/tickers', { tickers: 'AAPL' });

export const BASE = 'https://api.polygon.io';

export function getKey() {
  const k = process.env.MASSIVE_API_KEY;
  if (!k) throw new Error('MASSIVE_API_KEY not set');
  return k;
}

export function polygonUrl(path, params = {}) {
  const u = new URL(path.startsWith('http') ? path : BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  u.searchParams.set('apiKey', getKey());
  return u.toString();
}
