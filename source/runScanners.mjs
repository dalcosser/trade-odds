// runScanners.mjs — cross-platform scheduler for the Trade Odds scanners.
// Replaces the Mac-side launchd + timer-dispatch combo with a single Node
// process that wakes up every minute and runs whichever scanners are due.
//
// All writes go into a local `memory/` folder (sibling of this file). The
// standalone dashboard (server.mjs --standalone) reads from there.
//
// USAGE
//   node source/runScanners.mjs
//   double-click run-scanners.bat  (Windows)
//   ./run-scanners.sh              (Mac / Linux)
//
// REQUIRES .env (sibling) with:
//   MASSIVE_API_KEY=...            # Polygon
//   UW_API_KEY=...                 # Unusual Whales
//   CLICKHOUSE_URL=...             # incl. https://
//   CLICKHOUSE_USER=...
//   CLICKHOUSE_PASSWORD=...
//   CLICKHOUSE_DATABASE=...        # optional
//
// SILENT BY DESIGN
//   Scanners on this machine do NOT push to Slack / Telegram / WhatsApp.
//   The Mac instance handles all alerts. Here we only write to memory/*.json
//   for the dashboard to read.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const SCANNERS = resolve(__dir, 'scanners');
const MEMORY = resolve(REPO, 'memory');
if (!existsSync(MEMORY)) mkdirSync(MEMORY, { recursive: true });

// ---------- portable .env loader ----------
(function loadDotEnv() {
  const envPath = resolve(REPO, '.env');
  if (!existsSync(envPath)) return;
  try {
    for (const raw of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && process.env[k] == null) process.env[k] = v;
    }
  } catch {}
})();

// ---------- schedule ----------
// Each job has: name, script path, cron-ish description, `due(now)` predicate.
// `due` gets a Date in local time (assumed America/New_York since that's the
// trading clock). Returns true if the job should fire on this minute.
//
// We avoid a real cron parser to keep the repo dep-free. Predicates use plain
// JS — easy to tweak.
const ET = () => {
  // Convert "now" to NY-time components
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => fmt.find(p => p.type === t)?.value;
  return {
    hour: parseInt(get('hour'), 10),
    minute: parseInt(get('minute'), 10),
    weekday: get('weekday'), // Mon, Tue, ...
    date: get('month') + '-' + get('day'),
  };
};
const isWeekday = (et) => ['Mon','Tue','Wed','Thu','Fri'].includes(et.weekday);
const atTime = (et, h, m) => et.hour === h && et.minute === m;

const JOBS = [
  {
    name: 'relative_strength_scan',
    script: 'relative_strength_scan.mjs',
    desc: 'every 30 min during RTH (9:30am–4:00pm ET, Mon–Fri)',
    due: (et) => isWeekday(et) && et.minute % 30 === 0 &&
      ((et.hour === 9 && et.minute >= 30) || (et.hour > 9 && et.hour < 16) || (et.hour === 16 && et.minute === 0)),
  },
  {
    name: 'statistical_edge_scanner',
    script: 'statistical_edge_scanner.mjs',
    desc: 'twice daily — 3:30pm and 4:15pm ET',
    due: (et) => isWeekday(et) && ((atTime(et, 15, 30)) || atTime(et, 16, 15)),
  },
  {
    name: 'mean_reversion_scan',
    script: 'mean_reversion_scan.mjs',
    desc: 'EOD — 4:05pm ET',
    due: (et) => isWeekday(et) && atTime(et, 16, 5),
  },
  {
    name: 'setup_scanners',
    script: 'setup_scanners.mjs',
    args: ['--setup', 'all', '--emit'],
    desc: 'twice daily — 7:15am pre-open and 4:00pm post-close',
    due: (et) => isWeekday(et) && (atTime(et, 7, 15) || atTime(et, 16, 0)),
  },
  {
    name: 'backfill_earnings_history',
    script: 'backfill_earnings_history.mjs',
    desc: 'weekly — Sunday 11:00pm ET',
    due: (et) => et.weekday === 'Sun' && atTime(et, 23, 0),
  },
];

// ---------- runner ----------
function runJob(job) {
  const args = [join(SCANNERS, job.script), ...(job.args || ['--emit'])];
  console.log('[' + new Date().toISOString() + '] running ' + job.name);
  const child = spawn(process.execPath, args, {
    cwd: REPO,
    env: { ...process.env, MEMORY_DIR: MEMORY },
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    console.log('[' + new Date().toISOString() + '] ' + job.name + ' exited ' + code);
  });
  child.on('error', (err) => {
    console.error('[' + new Date().toISOString() + '] ' + job.name + ' spawn failed: ' + err.message);
  });
}

// ---------- loop ----------
console.log('=========================================');
console.log(' Trade Odds standalone scanner scheduler');
console.log('=========================================');
console.log(' memory dir: ' + MEMORY);
console.log(' jobs scheduled:');
for (const j of JOBS) console.log('   - ' + j.name + ' :: ' + j.desc);
console.log('');
console.log(' Wakes up every 60 seconds. Ctrl+C to stop.');
console.log('');

let lastMinute = -1;
function tick() {
  const et = ET();
  // Avoid double-firing if multiple ticks hit the same minute
  const key = et.hour * 60 + et.minute;
  if (key === lastMinute) return;
  lastMinute = key;
  for (const job of JOBS) {
    try { if (job.due(et)) runJob(job); }
    catch (e) { console.error('[tick] job ' + job.name + ' error: ' + e.message); }
  }
}

// Run a tick immediately + every 30 seconds (so we catch any minute boundary)
tick();
setInterval(tick, 30_000);
