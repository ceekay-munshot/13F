// shared/watch.mjs
//
// When is the same-day ingest due, and should it be started now?
// Pure, so it can be tested; scripts/watch-ingest.mjs does the talking.
//
// ---------------------------------------------------------------------------
// WHY ANYTHING HAS TO START IT
// ---------------------------------------------------------------------------
// The ingest asks GitHub to start it every two hours. GitHub's timer is
// best-effort, and for this repository it has been keeping about one slot in
// four: measured 5–17 Nov 2026, three or four runs a day instead of twelve,
// gaps of seven or eight hours, and twelve hours on Q3's deadline day itself.
// A run started BY REQUEST starts within seconds — checked on 17 Nov, when one
// asked for by hand was running before the request had returned.
//
// So the watcher asks. It only needs GitHub's timer to wake IT a few times a
// day, because each one stays awake for most of six hours.

import { filingSeason } from "./calendar.mjs";

/**
 * Minutes between ingest runs. Half-hourly in the weeks filings arrive, hourly
 * while late filers and amendments trickle in, every two hours otherwise —
 * the cadence the ingest always claimed to have.
 */
export function dueEveryMinutes(todayISO) {
  const { season } = filingSeason(todayISO);
  if (season === "peak" || season === "ramp") return 30;
  if (season === "tail") return 60;
  return 120;
}

const ACTIVE = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

/**
 * @param {Array<{status:string, created_at:string}>} runs  the ingest's recent runs, any order
 * @param {Date} now
 * @param {number} everyMinutes
 * @returns {{ action: "running"|"wait"|"start", minutesSince: number|null }}
 */
export function decide(runs, now, everyMinutes) {
  if ((runs ?? []).some((r) => ACTIVE.has(r.status))) return { action: "running", minutesSince: null };
  const newest = (runs ?? [])
    .map((r) => Date.parse(r.created_at))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  if (newest === undefined) return { action: "start", minutesSince: null };
  const minutesSince = (now.getTime() - newest) / 60_000;
  return { action: minutesSince >= everyMinutes ? "start" : "wait", minutesSince };
}
