/**
 * ideaBoardRenderer.mjs — PNG card for the desk's idea board.
 *
 * Three sections: ★ DISLOCATIONS, ▲ TOP LONGS, ▼ TOP SHORTS. Each entry
 * shows ticker, score, setup tag, entry, stop, T1 (R:R). Dark theme
 * matching cardRenderer / tableRenderer.
 *
 * Usage:
 *   import { renderIdeaBoardCard } from './ideaBoardRenderer.mjs';
 *   await renderIdeaBoardCard({ board, outputPath: '/tmp/idea_board.png' });
 */

// `canvas` is a native npm dep that needs compilation. On Windows it's painful
// to install (Cairo + Pixman). We make it optional — if it's not installed the
// PNG render is skipped silently, but the JSON output (the actual data the
// dashboard reads) is unaffected. To enable PNGs on a machine that needs them
// for Slack/WhatsApp delivery, run `npm install canvas` in this directory.
let createCanvas = null;
try {
  const mod = await import('canvas');
  createCanvas = mod.createCanvas;
} catch {
  // No canvas available — PNG rendering will be a no-op
}
import { writeFileSync } from 'node:fs';

const C = {
  bg:          '#0d1117',
  headerBg:    '#161b22',
  cardBorder:  '#30363d',
  divider:     '#21262d',
  title:       '#e6edf3',
  subtitle:    '#8b949e',
  body:        '#c9d1d9',
  muted:       '#484f58',
  green:       '#3fb950',
  red:         '#f85149',
  blue:        '#58a6ff',
  yellow:      '#d29922',
  orange:      '#f0883e',
  purple:      '#bc8cff',
  goldBg:      '#3d2f1a',
  greenBg:     '#1a4731',
  redBg:       '#5a1a1a',
};

const WIDTH = 720;
const PAD = 16;
const FONT = 'monospace';

function drawRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fmt(v, prec = 2) {
  if (v == null || !Number.isFinite(+v)) return '—';
  return (+v).toFixed(prec);
}

function tagOf(r) {
  return r.checks?.cohort?.dislocation ? `★${r.checks.cohort.dislocationKind}` : (r.setup || 'context');
}

export async function renderIdeaBoardCard({ board, outputPath }) {
  if (!createCanvas) {
    // No `canvas` module installed — skip PNG render. The JSON output
    // (memory/idea_board.json) is what the dashboard actually reads;
    // PNGs are only for Slack/WhatsApp pushes.
    return { skipped: true, reason: 'canvas module not installed (Windows standalone runs silent)' };
  }
  const dislocs = board.dislocations || [];
  const longs = board.topLongs || [];
  const shorts = board.topShorts || [];

  const headerH = 60;
  const sectionHeaderH = 28;
  const rowH = 26;
  const sectionGap = 12;

  let height = headerH + PAD;
  if (dislocs.length) height += sectionHeaderH + dislocs.length * rowH + sectionGap;
  if (longs.length)   height += sectionHeaderH + longs.length * rowH + sectionGap;
  if (shorts.length)  height += sectionHeaderH + shorts.length * rowH + sectionGap;
  height += PAD;
  if (height < 200) height = 200;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, WIDTH, height);

  // Header
  ctx.fillStyle = C.headerBg;
  ctx.fillRect(0, 0, WIDTH, headerH);
  ctx.fillStyle = C.title;
  ctx.font = `bold 22px ${FONT}`;
  ctx.fillText('IDEA BOARD', PAD, 30);

  ctx.fillStyle = C.subtitle;
  ctx.font = `12px ${FONT}`;
  const localTime = new Date(board.ts).toLocaleString('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  ctx.fillText(localTime + ' ET', PAD, 48);

  ctx.font = `12px ${FONT}`;
  const meta = `${board.candidatesRun || 0} ran · ${board.validResults || 0} valid · ${((board.runtimeMs || 0) / 1000).toFixed(1)}s`;
  const metaW = ctx.measureText(meta).width;
  ctx.fillText(meta, WIDTH - PAD - metaW, 30);

  // Bottom border on header
  ctx.fillStyle = C.divider;
  ctx.fillRect(0, headerH, WIDTH, 1);

  let y = headerH + PAD;

  function drawSection(title, items, accentColor, bgColor, arrow) {
    if (!items || !items.length) return;

    // Section header band
    drawRoundRect(ctx, PAD, y, WIDTH - 2 * PAD, sectionHeaderH, 4);
    ctx.fillStyle = bgColor;
    ctx.fill();
    ctx.fillStyle = accentColor;
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillText(`${arrow} ${title}`, PAD + 10, y + 18);
    ctx.fillStyle = C.subtitle;
    ctx.font = `11px ${FONT}`;
    const cnt = `${items.length}`;
    ctx.fillText(cnt, WIDTH - PAD - 10 - ctx.measureText(cnt).width, y + 18);

    y += sectionHeaderH + 4;

    // Rows
    for (const r of items) {
      const t = r.ticket || {};
      const tag = tagOf(r);
      const dirColor = r.direction === 'long' ? C.green : r.direction === 'short' ? C.red : C.subtitle;

      // Ticker + score (left)
      ctx.fillStyle = C.title;
      ctx.font = `bold 14px ${FONT}`;
      ctx.fillText(r.ticker.padEnd(6), PAD + 6, y + 17);

      ctx.fillStyle = dirColor;
      ctx.font = `bold 12px ${FONT}`;
      const scoreStr = `${(r.score || 0).toFixed(1)}/14`;
      ctx.fillText(scoreStr, PAD + 80, y + 17);

      // Setup tag (middle)
      ctx.fillStyle = r.checks?.cohort?.dislocation ? C.yellow : C.subtitle;
      ctx.font = `11px ${FONT}`;
      const tagStr = tag.length > 28 ? tag.slice(0, 27) + '…' : tag;
      ctx.fillText(tagStr, PAD + 140, y + 17);

      // Entry/stop/T1 (right)
      ctx.fillStyle = C.body;
      ctx.font = `11px ${FONT}`;
      const ticketStr = `E ${fmt(t.entry)}  S ${fmt(t.stop)}  T1 ${fmt(t.t1)} (${fmt(t.rr1, 1)}R)`;
      const tw = ctx.measureText(ticketStr).width;
      ctx.fillText(ticketStr, WIDTH - PAD - 8 - tw, y + 17);

      y += rowH;
    }
    y += sectionGap - 4;
  }

  drawSection('DISLOCATIONS (gold setups)', dislocs, C.yellow, C.goldBg, '★★');
  drawSection('TOP LONGS', longs, C.green, C.greenBg, '▲');
  drawSection('TOP SHORTS', shorts, C.red, C.redBg, '▼');

  if (!dislocs.length && !longs.length && !shorts.length) {
    ctx.fillStyle = C.muted;
    ctx.font = `13px ${FONT}`;
    ctx.fillText('No actionable ideas — all candidates below tier threshold.', PAD, y + 20);
  }

  const buf = canvas.toBuffer('image/png');
  writeFileSync(outputPath, buf);
  return outputPath;
}
