import { config } from "./config.js";

/**
 * Weekly peak engagement slots per platform, in the owner's timezone
 * (config.timezone). Sourced July 2026 from Sprout Social's and Buffer's
 * engagement studies:
 *   LinkedIn: Tue-Thu strong, Wed 4pm and Fri 3pm the standouts.
 *   Instagram: Tue/Wed 11am-1pm, the lunch-break scroll window.
 *   X: Tue-Thu midday through late afternoon, Wednesday best.
 * dow: 0=Sun..6=Sat.
 */
const PEAK_SLOTS = {
  linkedin: [
    { dow: 2, hour: 11, minute: 0 },
    { dow: 3, hour: 16, minute: 0 },
    { dow: 4, hour: 11, minute: 0 },
    { dow: 5, hour: 15, minute: 0 },
  ],
  instagram: [
    { dow: 2, hour: 11, minute: 0 },
    { dow: 3, hour: 12, minute: 0 },
    { dow: 4, hour: 11, minute: 30 },
  ],
  x: [
    { dow: 2, hour: 12, minute: 0 },
    { dow: 3, hour: 13, minute: 0 },
    { dow: 4, hour: 17, minute: 0 },
  ],
  // Cross-platform consensus window (Tue-Thu mornings) for anything else.
  default: [
    { dow: 2, hour: 10, minute: 0 },
    { dow: 3, hour: 10, minute: 0 },
    { dow: 4, hour: 10, minute: 0 },
  ],
};

/** UTC Date for the given wall-clock time in a timezone (DST-safe iteration). */
function zonedTimeToUtc(y, m, d, hour, minute, tz) {
  let ts = Date.UTC(y, m, d, hour, minute);
  for (let i = 0; i < 3; i++) {
    const local = new Date(new Date(ts).toLocaleString("en-US", { timeZone: tz }));
    const got = Date.UTC(
      local.getFullYear(), local.getMonth(), local.getDate(),
      local.getHours(), local.getMinutes(),
    );
    ts += Date.UTC(y, m, d, hour, minute) - got;
  }
  return new Date(ts);
}

/**
 * The next `count` peak posting slots for a platform, as UTC Dates, soonest
 * first. Slots less than 20 minutes away are skipped so "approve then edit
 * your mind" never races the publisher.
 */
export function nextPeakSlots(platform, { count = 3, now = new Date(), tz = config.timezone } = {}) {
  const slots = PEAK_SLOTS[platform] || PEAK_SLOTS.default;
  const cutoff = now.getTime() + 20 * 60 * 1000;
  const out = [];
  // Walk day by day (in the target timezone) up to two weeks out.
  for (let offset = 0; offset < 15 && out.length < count; offset++) {
    const probe = new Date(now.getTime() + offset * 86400000);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "numeric", day: "numeric", weekday: "short",
    }).formatToParts(probe);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
    for (const s of slots) {
      if (s.dow !== dow) continue;
      const when = zonedTimeToUtc(
        Number(get("year")), Number(get("month")) - 1, Number(get("day")),
        s.hour, s.minute, tz,
      );
      if (when.getTime() >= cutoff) out.push(when);
    }
  }
  return out.sort((a, b) => a - b).slice(0, count);
}

/** "Tue 11:00 AM" in the owner's timezone. */
export function formatSlot(date, tz = config.timezone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit",
  }).format(date);
}

/** SQLite-comparable UTC timestamp ("YYYY-MM-DD HH:MM:SS"). */
export function toSqliteUtc(date) {
  return date.toISOString().replace("T", " ").slice(0, 19);
}
