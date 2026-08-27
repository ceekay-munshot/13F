// src/lib/favourites.ts
//
// The user's chosen comparison set, on top of the client's list.
//
// THE LIST ITSELF NOW LIVES IN shared/watchlist.mjs. It moved because the
// pipeline needs it too: during a filing season the ingest works through ten
// thousand managers a few hundred at a time, and the funds this dashboard is
// about have to be at the FRONT of that queue rather than wherever EDGAR
// happened to publish them. A frontend-only constant could not do that — the
// client's own funds sat unread for two days while somebody asked about one.
//
// What stays here is the per-user layer: which of them this browser is showing,
// and the add/remove that writes to localStorage.
//
// NOTE THE ASYMMETRY, because it is easy to trip over. Editing the list in
// shared/watchlist.mjs changes BOTH what the pipeline fetches first and what a
// new visitor sees. Adding a fund through the UI changes only what THIS browser
// shows — the pipeline cannot see localStorage, so a fund added that way is
// ingested on the ordinary schedule like any other manager. If a fund should
// always be fetched first, it belongs in shared/watchlist.mjs.

export type { WatchFund } from "../../shared/watchlist.mjs";
export { CLIENT_WATCHLIST } from "../../shared/watchlist.mjs";
import { CLIENT_WATCHLIST, migrateCiks } from "../../shared/watchlist.mjs";

const SEED = CLIENT_WATCHLIST.map((f) => f.cik);
const KEY = "13f:favourites";

/**
 * Read the user's favourites.
 *
 * The seed list is the DEFAULT, not a floor — a user who removes Berkshire
 * should get a dashboard without Berkshire, not one that silently puts it back.
 * So an empty saved array is a legitimate state and is distinguished from
 * "nothing saved yet" by the key existing at all.
 */
export function loadFavourites(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [...SEED];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...SEED];
    const saved = parsed.filter((x) => typeof x === "string");
    // FOLLOW A MANAGER WHOSE REPORTING MOVED.
    //
    // Editing the list in shared/watchlist.mjs only changes what a NEW visitor
    // sees; this key was written the first time this browser loaded the page and
    // keeps whatever CIK was current then. Without this, repointing PSH to
    // Pershing Square's parent reached nobody who had ever used the dashboard —
    // they kept a struck-through empty column for an entity that had stopped
    // reporting, and the page said "no filing this quarter" about it.
    //
    // Written back so it happens once rather than on every load, and so the two
    // stay in step if the user edits their list afterwards. A storage failure
    // here is harmless: the migrated list is already correct in memory.
    const moved = migrateCiks(saved);
    if (moved.length !== saved.length || moved.some((c, i) => c !== saved[i])) {
      saveFavourites(moved);
    }
    return moved;
  } catch {
    // Private mode, disabled storage, or corrupted JSON. The seed set is a
    // perfectly good dashboard; never let storage break the page.
    return [...SEED];
  }
}

export function saveFavourites(ciks: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ciks));
  } catch { /* storage unavailable — the session still works, it just won't persist */ }
}

/** Restore the client's original set. */
export function resetFavourites(): string[] {
  saveFavourites(SEED);
  return [...SEED];
}

export const isSeedFavourite = (cik: string): boolean => SEED.includes(cik);

/** Curated short code where we have one, else derived from the name. */
export function codeFor(cik: string, name: string): string {
  const known = CLIENT_WATCHLIST.find((f) => f.cik === cik);
  if (known) return known.code;
  const words = name.replace(/[^A-Za-z ]/g, " ").trim().split(/\s+/);
  return (words[0] ?? name).slice(0, 3).toUpperCase();
}

/** Curated display name where we have one, else the name as filed. */
export function labelFor(cik: string, name: string): string {
  return CLIENT_WATCHLIST.find((f) => f.cik === cik)?.label ?? name;
}
