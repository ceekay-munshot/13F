// shared/source-archive.mjs
//
// The pure half of scripts/archive-source.mjs: which windows are archived, and
// which fall outside retention.
//
// Split for the same reason shared/rebuild.mjs and shared/witness.mjs are:
// the script does top-level I/O and calls process.exit on import, so anything
// left inside it cannot be reached from a test.

import { deraWindowStart } from "./calendar.mjs";

/** Where the SEC's own bulk files live in R2. */
export const SOURCE_PREFIX = "source/dera/";

/** slug -> key, for what is archived now. */
export function windowsFrom(keys) {
  const out = new Map();
  for (const [key, size] of keys) {
    const m = /^source\/dera\/(.+)_form13f\.zip$/.exec(key);
    if (!m) continue;
    const start = deraWindowStart(m[1]);
    if (!start) continue;
    out.set(m[1], { key, size, start });
  }
  return out;
}

/**
 * Which windows to drop, keeping the `keep` most recent.
 *
 * Ordered by the window's real START DATE, never by its name. The slugs use
 * month abbreviations, so "01sep2025-30nov2025" sorts AFTER "01mar2026-..."
 * lexically — retention by name would delete the newest window and keep the
 * oldest.
 */
export function windowsToDrop(windows, keep) {
  const ordered = [...windows.entries()].sort((a, b) => b[1].start.localeCompare(a[1].start));
  return ordered.slice(keep).map(([slug, w]) => ({ slug, ...w }));
}

/** Where a directly-fetched filing lives in the archive. */
export const EDGAR_PREFIX = "source/edgar/";

/**
 * One filing, keyed by quarter and accession.
 *
 * Grouped by period so retention can drop a whole quarter once the SEC's bulk
 * window covering it has been archived — at which point these records are a
 * duplicate of something we already hold, and a worse one: DERA carries every
 * filer, this carries only the funds the same-day job reached.
 */
export function edgarSourceKey(period, accession) {
  return `${EDGAR_PREFIX}${period}/${accession}.json.gz`;
}

/**
 * Which directly-fetched quarters are now covered by an archived bulk window.
 *
 * A DERA window is keyed by FILING date, and a quarter's filings land in the
 * window containing its DEADLINE — so Q2 2026, due 14 Aug, is covered by
 * 01jun2026-31aug2026 and by nothing earlier. Getting this wrong in the
 * permissive direction deletes the only copy of a quarter.
 */
export function edgarQuartersSupersededBy(archivedWindows, deadlineFor) {
  const covered = new Set();
  for (const [, w] of archivedWindows) {
    for (const period of Object.keys(deadlineFor)) {
      const deadline = deadlineFor[period];
      if (!deadline) continue;
      // The window covers filing dates from its start for three months.
      const end = new Date(Date.UTC(
        Number(w.start.slice(0, 4)),
        Number(w.start.slice(5, 7)) - 1 + 3,
        0,
      )).toISOString().slice(0, 10);
      if (deadline >= w.start && deadline <= end) covered.add(period);
    }
  }
  return covered;
}
