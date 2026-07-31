// src/lib/favourites.ts
//
// The managers this dashboard is actually about.
//
// WHY THIS LIVES IN THE FRONTEND
// ------------------------------
// The ingest also carries a watchlist, but that one only decides which filers
// get a `watch` flag baked into meta/filers.json — changing it means a full
// re-ingest before the change is visible. Since every filer in the universe is
// stored with line items, the comparison set is purely a display decision, and
// a display decision should not need a 30-minute pipeline run. Editing this
// array and deploying is enough.
//
// WHY CIKs AND NOT NAMES
// ----------------------
// Every CIK below was resolved against the live filer index and checked to be
// the entity that actually files the 13F. Name matching is unreliable for this
// asset class and quietly picks the wrong entity:
//
//   "Pershing Sq" matches both Pershing Square Capital Management ($13.7B) and
//                 PERSHING SQUARE HOLDCO ($0.6B)
//   "TCI"         matches TCI Fund Management ($45.2B) and an unrelated
//                 registered advisor called TCI Wealth Advisors ($1.9B)
//   "Abrams"      matches Abrams Capital Management ($4.6B) and Abrams Bison
//                 Investments ($2.3B)
//
// In each case the larger, well-known manager is the intended one, but that is
// a judgement — so it is recorded here rather than re-derived from a substring
// match at runtime.

export interface WatchFund {
  cik: string;
  /** Short label for matrix columns. Kept to 3 characters and unique. */
  code: string;
  /** Display name, shortened where the filed name is unwieldy. */
  label: string;
}

/**
 * The client's comparison set, in the order they gave it.
 *
 * Order is preserved deliberately: it is their mental ranking, and sorting it
 * by size or alphabetically would quietly overrule that.
 */
export const CLIENT_WATCHLIST: WatchFund[] = [
  { cik: "0001067983", code: "BRK", label: "Berkshire Hathaway" },
  { cik: "0001590531", code: "FOX", label: "Foxhaven" },
  { cik: "0001061165", code: "LNP", label: "Lone Pine" },
  { cik: "0001336528", code: "PSH", label: "Pershing Square" },
  { cik: "0001960830", code: "SRG", label: "SurgoCap" },
  { cik: "0001647251", code: "TCI", label: "TCI Fund Mgmt" },
  { cik: "0001599383", code: "WND", label: "WindAcre" },
  { cik: "0001768375", code: "ASP", label: "Aspex" },
  { cik: "0001798849", code: "DUR", label: "Durable" },
  { cik: "0001358706", code: "ABR", label: "Abrams Capital" },
  { cik: "0001609098", code: "DAR", label: "Darsana" },
  { cik: "0002087378", code: "AVY", label: "Avantyr" },
  { cik: "0001279936", code: "CAN", label: "Cantillon" },
];

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
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [...SEED];
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
