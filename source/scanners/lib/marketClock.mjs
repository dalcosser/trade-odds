/**
 * marketClock.mjs — Market hours, holidays, and session state.
 *
 * Usage:
 *   import { marketClock } from './lib/marketClock.mjs';
 *   const mc = marketClock();
 *   if (mc.isHoliday) ...
 *   if (mc.isMarketOpen) ...
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const CAL_PATH = resolve(__dir, "market_hours.json");

let _cal;
function loadCal() {
  if (!_cal) _cal = JSON.parse(readFileSync(CAL_PATH, "utf-8"));
  return _cal;
}

export function marketClock(now = new Date()) {
  const cal = loadCal();
  const tz = "America/New_York";

  // Get ET components
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map(p => [p.type, p.value])
  );

  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = parseInt(parts.hour, 10);
  const minute = parseInt(parts.minute, 10);
  const timeMin = hour * 60 + minute;
  const dayName = parts.weekday; // Mon, Tue, ...
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(dayName);
  const isWeekday = dow >= 1 && dow <= 5;

  // Holiday check
  const holiday = cal.holidays_2026?.[dateStr] || null;
  const isHoliday = holiday?.status === "closed";
  const isEarlyClose = holiday?.status === "early_close";
  const closeMin = isEarlyClose
    ? parseInt(holiday.close.split(":")[0]) * 60 + parseInt(holiday.close.split(":")[1])
    : 16 * 60; // 4pm

  // Session states
  const isPremarket = isWeekday && !isHoliday && timeMin >= 4 * 60 && timeMin < 9 * 60 + 30;
  const isMarketOpen = isWeekday && !isHoliday && timeMin >= 9 * 60 + 30 && timeMin < closeMin;
  const isAfterHours = isWeekday && !isHoliday && timeMin >= closeMin && timeMin < 20 * 60;
  const isRegularDay = isWeekday && !isHoliday;

  // Futures: Sun 6pm - Fri 5pm ET
  const isFuturesOpen =
    (dow === 0 && timeMin >= 18 * 60) ||  // Sun 6pm+
    (dow >= 1 && dow <= 4) ||              // Mon-Thu all day
    (dow === 5 && timeMin < 17 * 60);      // Fri until 5pm

  // Next holiday
  const today = new Date(dateStr + "T00:00:00");
  const upcoming = Object.entries(cal.holidays_2026 || {})
    .filter(([d]) => new Date(d + "T00:00:00") > today)
    .sort(([a], [b]) => a.localeCompare(b))[0];

  return {
    dateStr,
    timeET: `${parts.hour}:${parts.minute}`,
    dow,
    dayName,
    isWeekday,
    isHoliday,
    isEarlyClose,
    holiday,
    closeTime: isEarlyClose ? holiday.close : "16:00",
    isPremarket,
    isMarketOpen,
    isAfterHours,
    isRegularDay,
    isFuturesOpen,
    nextHoliday: upcoming ? { date: upcoming[0], ...upcoming[1] } : null,
  };
}

/**
 * Holiday alert suppression — call from any market-data alert script.
 *
 * Returns { suppress: bool, reason: string }.
 *   - suppress=true: market is closed for the day (weekend or full holiday)
 *     AND env var ALLOW_HOLIDAY is NOT set. Caller should skip / exit.
 *   - suppress=false: market is open OR caller has explicitly opted out via
 *     ALLOW_HOLIDAY=1 (use for infra jobs that legitimately run 7 days a
 *     week: calendar refresh, system health checks, OAuth nags, etc.).
 *
 * Weekends are included so weekend-firing market jobs don't leak through
 * either. (Most market jobs are weekday-only via launchd Weekday keys,
 * but this is the belt + suspenders.)
 *
 * Note: early-close days are NOT suppressed — caller decides whether the
 * 13:00 close window matters (use mc.isEarlyClose + mc.closeTime).
 */
export function shouldSuppressHolidayAlerts(now = new Date()) {
  if (process.env.ALLOW_HOLIDAY === "1") {
    return { suppress: false, reason: "ALLOW_HOLIDAY=1 opt-out" };
  }
  const mc = marketClock(now);
  if (mc.isHoliday) {
    return { suppress: true, reason: `MARKET HOLIDAY: ${mc.holiday.name}` };
  }
  if (!mc.isWeekday) {
    return { suppress: true, reason: `WEEKEND (${mc.dayName})` };
  }
  return { suppress: false, reason: "market day" };
}
