// src/lib/format.ts
//
// ONE source of truth for every number the dashboard renders. Formatting rules
// are correctness rules here, not cosmetics.

/**
 * Money always carries a unit suffix at 3 significant figures.
 *
 * Never render raw thousands. 13F's own Value column was in thousands before
 * 2023 and the reference sites still print columns headed "Value ($1000)";
 * carrying that convention into the UI is how a reader ends up off by 1000x.
 * Everything downstream of ingest is in dollars, and the suffix says so.
 */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Share counts. Millions for readability, matching the reference convention. */
export function shares(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

/** Portfolio weight, one decimal. */
export function pct(n: number | null | undefined, dp = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(dp)}%`;
}

/**
 * A CHANGE in weight is always percentage points, never percent.
 *
 * This is the single most-confused number in every 13F UI: a position going
 * from 3.0% to 4.8% of a portfolio moved +1.8pp, not +60%, and both numbers are
 * defensible answers to "how much did the weight change". Making the unit part
 * of the formatter means the label cannot drift away from the maths.
 */
export function pp(n: number | null | undefined, dp = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(dp)}pp`;
}

/** A percent CHANGE (share count, value). Signed. */
export function deltaPct(n: number | null | undefined, dp = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(dp)}%`;
}

/**
 * Never render more precision than the data supports. A reference site shows
 * "+1.6096%" for a flow estimate derived from a 45-day-old quarterly snapshot;
 * four decimal places on that is false precision, and it quietly tells the
 * reader the number is more exact than it is.
 */
export function flowPct(n: number | null | undefined): string {
  return deltaPct(n, 1);
}

export function count(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}

/** "2026-06-30" -> "Q2 2026" */
export function periodLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const q = Math.ceil(Number(iso.slice(5, 7)) / 3);
  return `Q${q} ${iso.slice(0, 4)}`;
}

/** "2026-08-14" -> "14 Aug 2026" */
export function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * Absolute timestamps only, never "updated 2 hours ago".
 *
 * A relative timestamp describes when we FETCHED, which is wildly misleading
 * about when the data was TRUE: a 13F filing accepted an hour ago still
 * describes positions as of a quarter end up to four and a half months earlier.
 * The dashboard never invents freshness.
 */
export function utcStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Days between two ISO dates. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** 3-character matrix column code from a manager name. */
export function shortCode(name: string): string {
  const cleaned = name.replace(/[^A-Za-z ]/g, " ").trim();
  const words = cleaned.split(/\s+/).filter((w) => !/^(the|and|of|llc|lp|llp|inc|co|group|capital|management|advisors?|partners)$/i.test(w));
  const base = (words[0] ?? cleaned ?? "???").toUpperCase();
  return base.slice(0, 3).padEnd(3, "·");
}
