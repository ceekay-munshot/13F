// shared/calendar.mjs
//
// 13F quarter and filing-deadline arithmetic. Imported by BOTH scripts/*.mjs
// (Node) and functions/api/**/*.js (Workers) — wrangler bundles the import, so
// there is one implementation and no keep-in-sync hazard.
//
// Deadlines are COMPUTED, never hardcoded. Rule 13f-1(a)(1): due within 45 days
// after each calendar quarter end, rolling forward past weekends and US federal
// holidays. The 4Q-2025 case shows why hardcoding fails: day 45 was Saturday
// 2026-02-14, 2026-02-16 was Presidents' Day, so the real deadline was
// 2026-02-17 — and 1,589 filings landed that day. A pipeline anchored on
// "Feb 14" would have missed the single biggest day of the quarter.
//
// Verified against SEC FAQ Q25 (updated 2026-03-06):
//   1Q2026 -> 2026-05-15   2Q2026 -> 2026-08-14
//   3Q2026 -> 2026-11-16   4Q2026 -> 2027-02-16
// and empirically against peak filing volume in master.idx for 2025.

const DAY_MS = 86_400_000;

/** ISO date string (YYYY-MM-DD) -> UTC Date at midnight. */
export function parseISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** UTC Date -> ISO date string. */
export function toISO(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(date, n) {
  return new Date(date.getTime() + n * DAY_MS);
}

/** Nth (1-based) weekday of a month, e.g. nthWeekday(2026, 2, 1, 3) = 3rd Monday of Feb. */
function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7));
}

/** Last given weekday of a month, e.g. last Monday in May. */
function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0)); // day 0 of next month
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month - 1, last.getUTCDate() - offset));
}

/**
 * Fixed-date holidays shift when they fall on a weekend: Saturday -> observed
 * the preceding Friday, Sunday -> observed the following Monday.
 */
function observed(date) {
  const dow = date.getUTCDay();
  if (dow === 6) return addDays(date, -1);
  if (dow === 0) return addDays(date, 1);
  return date;
}

/** All US federal holidays for a year, as a Set of ISO date strings. */
export function federalHolidays(year) {
  const days = [
    observed(new Date(Date.UTC(year, 0, 1))),   // New Year's Day
    nthWeekday(year, 1, 1, 3),                  // MLK Jr. Day — 3rd Monday Jan
    nthWeekday(year, 2, 1, 3),                  // Washington's Birthday — 3rd Monday Feb
    lastWeekday(year, 5, 1),                    // Memorial Day — last Monday May
    observed(new Date(Date.UTC(year, 5, 19))),  // Juneteenth (federal since 2021)
    observed(new Date(Date.UTC(year, 6, 4))),   // Independence Day
    nthWeekday(year, 9, 1, 1),                  // Labor Day — 1st Monday Sep
    nthWeekday(year, 10, 1, 2),                 // Columbus Day — 2nd Monday Oct
    observed(new Date(Date.UTC(year, 10, 11))), // Veterans Day
    nthWeekday(year, 11, 4, 4),                 // Thanksgiving — 4th Thursday Nov
    observed(new Date(Date.UTC(year, 11, 25))), // Christmas Day
  ];
  // Juneteenth only became a federal holiday in 2021; before that it never
  // moved a deadline, so excluding it keeps historical deadlines right.
  const set = new Set(days.map(toISO));
  if (year < 2021) set.delete(toISO(observed(new Date(Date.UTC(year, 5, 19)))));
  return set;
}

export function isBusinessDay(date) {
  const dow = date.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !federalHolidays(date.getUTCFullYear()).has(toISO(date));
}

/** Roll forward to the next business day (returns the input if already one). */
export function rollForward(date) {
  let d = date;
  // 45 days after a quarter end can land in a stretch of at most a few
  // non-business days; 10 is a generous bound that can never loop.
  for (let i = 0; i < 10 && !isBusinessDay(d); i++) d = addDays(d, 1);
  return d;
}

/** Calendar quarter ends are the only valid 13F periods. */
export function quarterEnd(year, q) {
  const ends = [
    [3, 31],
    [6, 30],
    [9, 30],
    [12, 31],
  ][q - 1];
  return toISO(new Date(Date.UTC(year, ends[0] - 1, ends[1])));
}

export function quarterOf(iso) {
  const m = Number(iso.slice(5, 7));
  return Math.ceil(m / 3);
}

/** "2026-06-30" -> "Q2 2026" */
export function periodLabel(iso) {
  return `Q${quarterOf(iso)} ${iso.slice(0, 4)}`;
}

/** Is this ISO date an actual calendar quarter end? */
export function isQuarterEnd(iso) {
  const y = Number(iso.slice(0, 4));
  return [1, 2, 3, 4].some((q) => quarterEnd(y, q) === iso);
}

/** Step a period by n quarters (negative to go back). */
export function shiftPeriod(iso, n) {
  const y = Number(iso.slice(0, 4));
  const q = quarterOf(iso);
  const total = (y * 4 + (q - 1)) + n;
  return quarterEnd(Math.floor(total / 4), (total % 4) + 1);
}

/**
 * The PRIOR period is always the immediately preceding CALENDAR quarter.
 *
 * Never resolve it as "the previous row in the filings table" — that silently
 * skips gaps, which is precisely the bug that made a reference site compare a
 * fund's Q2 row deltas against Q1 while its header stat used Q4.
 */
export function priorPeriod(iso) {
  return shiftPeriod(iso, -1);
}

/** Filing deadline for a period: +45 days, rolled past weekends and holidays. */
export function filingDeadline(periodEndISO) {
  return toISO(rollForward(addDays(parseISO(periodEndISO), 45)));
}

/** The most recent quarter end on or before `todayISO`. */
export function currentPeriod(todayISO) {
  const y = Number(todayISO.slice(0, 4));
  for (let q = 4; q >= 1; q--) {
    const end = quarterEnd(y, q);
    if (end <= todayISO) return end;
  }
  return quarterEnd(y - 1, 4);
}

/**
 * The latest period whose filings are actually expected to exist. 13F has a
 * structural ~45-day lag: on 2026-07-15 the Q2 quarter has ENDED but almost
 * nothing has been filed, so the newest period a dashboard should default to
 * is still Q1.
 */
export function latestFiledPeriod(todayISO) {
  let p = currentPeriod(todayISO);
  // Filings only start arriving in volume well after the quarter closes; use
  // the deadline as the switchover point so the default view is never empty.
  for (let i = 0; i < 4; i++) {
    if (filingDeadline(p) <= todayISO) return p;
    p = priorPeriod(p);
  }
  return p;
}

/** The last `n` period ends, newest first, ending at `endISO`. */
export function recentPeriods(endISO, n) {
  const out = [];
  let p = endISO;
  for (let i = 0; i < n; i++) {
    out.push(p);
    p = priorPeriod(p);
  }
  return out;
}

/**
 * Where we are relative to the current filing deadline. Drives BOTH the cron
 * density and the watchdog thresholds — a pipeline that legitimately does
 * nothing for ten weeks then handles ~3,000 filings in 72 hours cannot use one
 * flat "did it run today?" alert.
 *
 * Returns { period, deadline, daysToDeadline, season }, where season is:
 *   quiet    the quarter has just closed; only a trickle files
 *   ramp     T-30 -> T-2; volume building steadily
 *   peak     T-1 -> T+2; roughly a third of all filings land on the deadline
 *   tail     T+3 -> T+45; stragglers, then amendments
 *
 * The ramp window is 30 days, not 14. Observed on 2026-07-29 — sixteen days
 * before the 2026-08-14 deadline — 3,192 filings for the Q2 period had already
 * been published, about a third of the eventual ~9,300. Calling that "quiet"
 * would both under-poll during real volume and print a visibly wrong label.
 */
export const RAMP_WINDOW_DAYS = 30;

export function filingSeason(todayISO) {
  const period = currentPeriod(todayISO);
  const deadline = filingDeadline(period);
  const days = Math.round(
    (parseISO(deadline).getTime() - parseISO(todayISO).getTime()) / DAY_MS,
  );

  let season = "quiet";
  if (days <= 1 && days >= -2) season = "peak";
  else if (days > 1 && days <= RAMP_WINDOW_DAYS) season = "ramp";
  else if (days < -2 && days >= -45) season = "tail";

  return { period, deadline, daysToDeadline: days, season };
}

/**
 * The DERA Form 13F Data Set windows. Since March 2024 the SEC runs these for
 * the prior three months after February, May, August and November — keyed on
 * FILING month, not period — and publishes shortly after the due date.
 * Measured lag on the 01mar2026-31may2026 set: Last-Modified 2026-06-04, about
 * four days after the window closed.
 *
 * So DERA is the authoritative reconciliation backstop, NOT the day-of feed.
 * Day-of freshness comes from the submissions API.
 */
export function deraWindowFor(filingDateISO) {
  const y = Number(filingDateISO.slice(0, 4));
  const m = Number(filingDateISO.slice(5, 7));
  // The Dec-Jan-Feb window is the only one that straddles a year boundary, and
  // WHICH two years it spans depends on which of its three months you are in:
  //
  //   December y      belongs to the window that OPENS that December  -> y..y+1
  //   January/February y belong to the one opened the PREVIOUS December -> y-1..y
  //
  // Treating all three alike — which is what `start: [12, 1, y - 1]` for every
  // month did — sent every December date to a window a FULL YEAR stale:
  // 2025-12-15 resolved to 01dec2024-28feb2025. The ingest walks back month by
  // month, so one December in the walk silently pulled an 18-month-old data set
  // and the quarters it produced were non-contiguous.
  const winter =
    m === 12
      ? { start: [12, 1, y], end: [2, 28, y + 1] }
      : { start: [12, 1, y - 1], end: [2, 28, y] };

  const windows = [
    { ...winter, months: [12, 1, 2] },
    { start: [3, 1, y], end: [5, 31, y], months: [3, 4, 5] },
    { start: [6, 1, y], end: [8, 31, y], months: [6, 7, 8] },
    { start: [9, 1, y], end: [11, 30, y], months: [9, 10, 11] },
  ];
  const w = windows.find((x) => x.months.includes(m));
  if (!w) return null;
  const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const lastDay = new Date(Date.UTC(w.end[2], w.end[0], 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, "0");
  const slug =
    `01${MON[w.start[0] - 1]}${w.start[2]}-` +
    `${pad(lastDay)}${MON[w.end[0] - 1]}${w.end[2]}`;
  return {
    slug,
    url: `https://www.sec.gov/files/structureddata/data/form-13f-data-sets/${slug}_form13f.zip`,
  };
}
