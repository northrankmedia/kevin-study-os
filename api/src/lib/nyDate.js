'use strict';

/**
 * NY-local calendar date helpers for Kevin Study OS.
 *
 * Kevin's classes happen in America/New_York. This API's server, however,
 * can run anywhere (UTC on the VPS, IST on a dev machine) — so "today" must
 * NEVER be derived from the server's own local clock (`new Date()` rendered
 * with the host's offset, or `process.env.TZ`). `Intl.DateTimeFormat` with an
 * explicit `timeZone` option is unaffected by the host's timezone, so it's
 * the only safe way to answer "what calendar date is it in New York right
 * now" regardless of where this process happens to be deployed.
 */

const NY_TIME_ZONE = 'America/New_York';

// Bounds for a client-submitted `note_date`, relative to "today" in NY.
//
// Notes are a journal, not a same-day-only slot: Kevin sometimes logs a
// make-up note for a class covered a few days late, so the past bound is
// generous (a year covers any realistic backlog without effectively
// disabling validation altogether, e.g. catching a stray wrong-year typo).
// The future bound only tolerates a single day, which exists purely to
// avoid rejecting a legitimate submission that lands right at the NY
// midnight boundary — anything further ahead than that is not a "daily"
// note by definition and is almost certainly a client timezone/date-picker
// bug, not a real future note.
const MAX_PAST_DAYS = 365;
const MAX_FUTURE_DAYS = 1;

// `en-CA` formats as YYYY-MM-DD directly, which avoids manually
// reassembling year/month/day parts from `formatToParts`.
const nyDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: NY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Today's calendar date in America/New_York, as "YYYY-MM-DD".
 *
 * @param {Date} [now] - defaults to the real current instant; callers only
 *   ever pass this explicitly in tests, to simulate a specific moment
 *   without mutating global timer state.
 */
function todayNY(now = new Date()) {
  return nyDateFormatter.format(now);
}

function daysBetween(dateStrA, dateStrB) {
  const a = Date.parse(`${dateStrA}T00:00:00Z`);
  const b = Date.parse(`${dateStrB}T00:00:00Z`);
  return Math.round((a - b) / 86400000);
}

/**
 * Bounds-check a client-submitted `note_date` against "today" in NY.
 *
 * This deliberately does NOT require `note_date` to equal NY-today exactly
 * — the client's own note of "what day it is" is not trusted (it could be
 * computed in any timezone, or be a deliberate backdated entry), only
 * checked to be within a plausible window of the server-computed NY today.
 *
 * @param {string} noteDate - "YYYY-MM-DD"
 * @param {Date} [now] - see `todayNY`
 */
function isNoteDateWithinBounds(noteDate, now = new Date()) {
  const diff = daysBetween(noteDate, todayNY(now));
  return diff >= -MAX_PAST_DAYS && diff <= MAX_FUTURE_DAYS;
}

module.exports = {
  NY_TIME_ZONE,
  MAX_PAST_DAYS,
  MAX_FUTURE_DAYS,
  todayNY,
  isNoteDateWithinBounds,
};
