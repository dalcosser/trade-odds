#!/usr/bin/env node
/**
 * relative_strength_scan.mjs
 *
 * Intraday relative strength vs SPY.
 * Flags watchlist names significantly outperforming or underperforming SPY.
 *
 * Usage: node relative_strength_scan.mjs [--rsThreshold 2] [--maxAlerts 12]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pushAlert } from './lib/multiPush.mjs';
import { getBODStats } from './lib/intradayStats.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

try {
  const envFile = readFileSync(resolve(__dir, '..', '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}

import { LIQUID_UNIVERSE } from './lib/loadUniverse.mjs';

const API_KEY = process.env.MASSIVE_API_KEY;
const BASE = 'https://api.polygon.io';

const args = process.argv.slice(2);
function argVal(flag, def) {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? parseFloat(args[idx + 1]) : def;
}
const RS_THRESHOLD = argVal('--rsThreshold', 2);
const MAX_LEADERS = argVal('--maxLeaders', 25);
const MAX_LAGGARDS = argVal('--maxLaggards', 12);
const MIN_AVG_VOL = argVal('--minAvgVol', 1000000);

const UNIVERSE = LIQUID_UNIVERSE;

async function fetchJSON(url) {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}apiKey=${API_KEY}`, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function fmtET() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

async function main() {
  if (!API_KEY) { console.log('NO_ALERTS'); return; }

  // Fetch all snapshots (including SPY) in batches of 50
  const allTickers = [...new Set(['SPY', 'QQQ', ...UNIVERSE])];
  const snapMap = {};

  for (let i = 0; i < allTickers.length; i += 50) {
    const batch = allTickers.slice(i, i + 50).join(',');
    try {
      const data = await fetchJSON(`${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${batch}`);
      if (data.tickers) {
        for (const t of data.tickers) {
          const ticker = t.ticker;
          const changePct = t.todaysChangePerc ?? 0;
          const last = t.lastTrade?.p ?? t.day?.c ?? 0;
          const dayVol = t.day?.v ?? 0;
          const prevVol = t.prevDay?.v ?? 0;
          const vwap = t.day?.vw ?? 0;
          if (ticker && last) {
            snapMap[ticker] = { changePct, last, dayVol, prevVol, vwap };
          }
        }
      }
    } catch {}
    if (i + 50 < allTickers.length) await new Promise(r => setTimeout(r, 300));
  }

  const spy = snapMap['SPY'];
  if (!spy) { console.log('NO_ALERTS'); return; }

  const spyChange = spy.changePct;
  const qqq = snapMap['QQQ'];

  // Compute RS for each ticker
  const hits = [];
  for (const ticker of UNIVERSE) {
    if (ticker === 'SPY' || ticker === 'QQQ') continue;
    const snap = snapMap[ticker];
    if (!snap) continue;

    // Filter: previous day volume must be >= 1M shares (proxy for avg volume)
    if (snap.prevVol < MIN_AVG_VOL) continue;

    const rs = snap.changePct - spyChange;
    if (Math.abs(rs) < RS_THRESHOLD) continue;

    const volRatio = snap.prevVol > 0 ? snap.dayVol / snap.prevVol : null;

    // VWAP filter — strong stocks must be ABOVE VWAP, weak stocks must be BELOW VWAP
    // A stock up big but below VWAP is fading = not a real leader
    // A stock down big but above VWAP is bouncing = not a real laggard
    if (snap.vwap > 0) {
      const aboveVwap = snap.last > snap.vwap;
      if (rs > 0 && !aboveVwap) continue;  // drop "leaders" below VWAP
      if (rs < 0 && aboveVwap) continue;   // drop "laggards" above VWAP
    }

    const vwapDist = snap.vwap > 0 ? ((snap.last - snap.vwap) / snap.vwap) * 100 : null;

    hits.push({
      ticker,
      changePct: snap.changePct,
      rs,
      last: snap.last,
      volRatio,
      vwap: snap.vwap,
      vwapDist,
    });
  }

  if (hits.length === 0) { console.log('NO_ALERTS'); return; }

  // Sort by RS magnitude descending
  hits.sort((a, b) => Math.abs(b.rs) - Math.abs(a.rs));

  const leaders  = hits.filter(h => h.rs > 0).slice(0, MAX_LEADERS);
  const laggards = hits.filter(h => h.rs < 0).slice(0, MAX_LAGGARDS);

  const ts = fmtET();
  const lines = [`💪📉 RELATIVE STRENGTH SCAN — ${ts} ET`];
  lines.push(`SPY ${spyChange >= 0 ? '+' : ''}${spyChange.toFixed(2)}%${qqq ? ` | QQQ ${qqq.changePct >= 0 ? '+' : ''}${qqq.changePct.toFixed(2)}%` : ''} | threshold ±${RS_THRESHOLD}%`);

  if (leaders.length) {
    lines.push('');
    lines.push('🟢 RS LEADERS (outperforming SPY AND above VWAP):');
    for (const h of leaders) {
      const vol = h.volRatio != null ? ` · vol ${h.volRatio.toFixed(1)}x` : '';
      const vwap = h.vwapDist != null ? ` · +${h.vwapDist.toFixed(2)}% vs VWAP` : '';
      lines.push(`  ${h.ticker} ${h.changePct >= 0 ? '+' : ''}${h.changePct.toFixed(2)}% (RS +${h.rs.toFixed(2)}%) · $${h.last.toFixed(2)}${vwap}${vol}`);
    }
  }

  if (laggards.length) {
    lines.push('');
    lines.push('🔴 RS LAGGARDS (underperforming SPY AND below VWAP):');
    for (const h of laggards) {
      const vol = h.volRatio != null ? ` · vol ${h.volRatio.toFixed(1)}x` : '';
      const vwap = h.vwapDist != null ? ` · ${h.vwapDist.toFixed(2)}% vs VWAP` : '';
      lines.push(`  ${h.ticker} ${h.changePct >= 0 ? '+' : ''}${h.changePct.toFixed(2)}% (RS ${h.rs.toFixed(2)}%) · $${h.last.toFixed(2)}${vwap}${vol}`);
    }
  }

  lines.push('');
  lines.push(`${hits.length} name(s) flagged vs SPY.`);
  console.log(lines.join('\n'));

  // ── Enrich with historical follow-through stats (BOD / NXT OPEN / NXT CLOSE) ──
  // For each leader/laggard, query ClickHouse: when this ticker had a similar
  // intraday move at this time of day, what happened balance-of-day + next day?
  const nowET = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  });
  const [curH, curM] = nowET.split(':').map(x => parseInt(x));
  // Clamp the probe time into regular-session minute-data range (9:31 – 15:59).
  // Outside market hours, use a sensible proxy (last regular minute).
  const probeH = Math.max(9, Math.min(15, curH));
  const probeM = probeH === 9 ? Math.max(31, curM) : (probeH === 15 ? Math.min(59, curM) : curM);

  async function enrich(h) {
    // Step 1: bucket match (tight) — same ticker, move ±25% tolerance
    // Step 2: if N=0, widen the bucket
    // Step 3: if still N=0, fall back to threshold match (move ≥ |target|)
    // Step 4: if still N=0, stats stays null → row gets filtered out below
    const tiers = [
      { mode: 'bucket', tolerance: Math.max(1.5, Math.abs(h.changePct) * 0.25) },
      { mode: 'bucket', tolerance: Math.max(3, Math.abs(h.changePct) * 0.5) },
      { mode: 'threshold' },
    ];
    for (const tier of tiers) {
      try {
        const stats = await getBODStats({
          ticker: h.ticker, movePct: h.changePct, hour: probeH, minute: probeM,
          years: 10,
          tolerance: tier.tolerance,
          threshold: tier.mode === 'threshold',
        });
        if (stats && stats.n >= 2) return { ...h, stats, match: tier.mode };
      } catch { /* try next tier */ }
    }
    return { ...h, stats: null };
  }
  // Batch concurrency — too many parallel CH queries will timeout
  async function batched(items, n, fn) {
    const out = [];
    for (let i = 0; i < items.length; i += n) {
      const slice = items.slice(i, i + n);
      const res = await Promise.all(slice.map(fn));
      out.push(...res);
    }
    return out;
  }
  const leadersRaw = await batched(leaders, 4, enrich);
  const laggardsRaw = await batched(laggards, 4, enrich);

  // Drop names with no historical analogs — they contribute nothing to the read.
  // But keep at least 3 leaders/laggards even if blank so the table isn't empty on a no-precedent day.
  const hasEdge = r => r.stats && r.stats.n >= 2;
  const leadersE = leadersRaw.filter(hasEdge).length >= 3 ? leadersRaw.filter(hasEdge) : leadersRaw.slice(0, 5);
  const laggardsE = laggardsRaw.filter(hasEdge).length >= 3 ? laggardsRaw.filter(hasEdge) : laggardsRaw.slice(0, 5);
  const droppedLeaders = leadersRaw.length - leadersE.length;
  const droppedLaggards = laggardsRaw.length - laggardsE.length;

  // ── PNG table for WhatsApp ──
  try {
    const { renderTable, COLORS } = await import('./lib/tableRenderer.mjs');
    const columns = ['Ticker', 'Last', 'Chg%', 'RS', 'VWAP', 'Vol', 'N', 'BOD', 'NXT OPEN', 'NXT CLOSE'];
    const colWidths = [65, 75, 60, 55, 55, 45, 35, 125, 125, 135];
    const allRows = [];

    const fmtStat = (s) => {
      if (!s || s.n === 0) return '—';
      // Compact: drop second decimal on big magnitudes so "(100%)" always fits
      const avg = s.avg;
      const avgStr = Math.abs(avg) >= 10
        ? (avg >= 0 ? '+' : '') + avg.toFixed(1) + '%'
        : (avg >= 0 ? '+' : '') + avg.toFixed(2) + '%';
      const posStr = `${Math.round(s.pct_pos)}%`;
      return `${avgStr} (${posStr})`;
    };
    const statStyle = (s, ref) => {
      // ref: color for direction alignment (leaders=green means "follow-through = good")
      if (!s || s.n === 0) return { color: COLORS.muted };
      if (s.avg == null) return { color: COLORS.muted };
      return { color: s.avg > 0 ? COLORS.green : COLORS.red };
    };

    const mkRow = (h, isLeader) => {
      const chg = `${h.changePct >= 0 ? '+' : ''}${h.changePct.toFixed(2)}%`;
      const rs = `${h.rs >= 0 ? '+' : ''}${h.rs.toFixed(2)}%`;
      const vol = h.volRatio != null ? `${h.volRatio.toFixed(1)}x` : '';
      const vwapDist = h.vwapDist != null ? `${h.vwapDist >= 0 ? '+' : ''}${h.vwapDist.toFixed(1)}%` : '-';
      const sideColor = isLeader ? COLORS.green : COLORS.red;
      const n = h.stats?.n || 0;
      return {
        values: [
          h.ticker,
          `$${h.last.toFixed(2)}`,
          chg,
          rs,
          vwapDist,
          vol,
          String(n),
          fmtStat(h.stats?.bod),
          fmtStat(h.stats?.next_open),
          fmtStat(h.stats?.next_close),
        ],
        styles: [
          { color: sideColor, bold: true },
          { color: COLORS.bodyText, bold: true },
          { color: sideColor },
          { color: sideColor, bold: true },
          { color: sideColor, align: 'center' },
          { color: h.volRatio >= 1.5 ? COLORS.green : COLORS.muted },
          { color: n < 5 ? COLORS.muted : COLORS.bodyText, align: 'center' },
          statStyle(h.stats?.bod),
          statStyle(h.stats?.next_open),
          statStyle(h.stats?.next_close),
        ],
      };
    };

    for (const h of leadersE) allRows.push(mkRow(h, true));
    for (const h of laggardsE) allRows.push(mkRow(h, false));

    if (allRows.length) {
      const spyLine = `SPY ${spyChange >= 0 ? '+' : ''}${spyChange.toFixed(2)}%${qqq ? ` | QQQ ${qqq.changePct >= 0 ? '+' : ''}${qqq.changePct.toFixed(2)}%` : ''}`;
      const imgPath = resolve(__dir, '..', 'memory', 'rs_scan.png');
      // Structured JSON dump for dashboards (parallel to PNG).
      try {
        const slim = (h, kind) => ({
          ticker: h.ticker,
          kind, // 'leader' | 'laggard'
          last: h.last,
          changePct: h.changePct,
          rs: h.rs,
          vwapDist: h.vwapDist,
          volRatio: h.volRatio,
          stats: h.stats ? {
            n: h.stats.n,
            bod: h.stats.bod,
            next_open: h.stats.next_open,
            next_close: h.stats.next_close,
          } : null,
        });
        const jsonPath = resolve(__dir, '..', 'memory', 'rs_scan.json');
        writeFileSync(jsonPath, JSON.stringify({
          ts: Date.now(),
          updatedAt: new Date().toISOString(),
          runId: `${ts} ET`,
          spyChange,
          qqqChange: qqq ? qqq.changePct : null,
          probeWindow: `${probeH}:${String(probeM).padStart(2,'0')} ET`,
          leaders: leadersE.map(h => slim(h, 'leader')),
          laggards: laggardsE.map(h => slim(h, 'laggard')),
          counts: {
            leaders: leadersE.length,
            laggards: laggardsE.length,
            droppedLeaders, droppedLaggards,
          },
        }, null, 2));
      } catch (e) { console.error(`[rs-scan] json dump failed: ${e.message}`); }
      await renderTable({
        title: `RS SCAN — ${ts} ET  (${spyLine})`,
        columns,
        colWidths,
        rows: allRows,
        footer: `${leadersE.length} leaders | ${laggardsE.length} laggards${(droppedLeaders + droppedLaggards) > 0 ? ` | ${droppedLeaders + droppedLaggards} dropped (no precedent)` : ''} · stats = avg return (% positive) · N = analogs matching today's move at ${probeH}:${String(probeM).padStart(2,'0')} ET · match widens to threshold if bucket is empty`,
        outputPath: imgPath,
      });

      try {
        await pushAlert({
          channel: 'setups',
          text: `💪 RS SCAN — ${ts} ET`,
          pngPath: imgPath,
        });
      } catch (e) {
        console.error(`[rs-scan] pushAlert failed: ${e.message}`);
      }
      console.log(`PNG_PATH:${imgPath}`);
    }
  } catch (e) {
    console.error(`[rs-scan] PNG render failed: ${e.message}`);
  }
}

main().catch(() => { console.log('NO_ALERTS'); });
