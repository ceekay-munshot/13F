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
