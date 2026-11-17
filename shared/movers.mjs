// shared/movers.mjs
//
// What each CONCENTRATED manager bought and sold in a quarter, one row per
// stock they traded. Feeds the Sectors tab.
//
// Why it is precomputed: the question "which focused managers sold
// semiconductors?" needs every manager's book, and the browser cannot load
// 8,500 of them. A concentrated book is small, though — at most 40 stocks — so
// all of their trades together fit in one file the tab can load in one go.
//
// Money follows the Sector flows panel exactly, so the two never disagree:
// shares that moved times the quarter-end price; a new position is its whole
// value; a full sale is what the position was worth the quarter before.

import { decodeHoldings } from "./artifacts.mjs";

/** "Concentrated" means this many long stock positions or fewer. */
export const MOVERS_MAX_POSITIONS = 40;
/**
 * And at least this many. A book of one to four stocks is a founder, a
 * foundation or a company holding a stake (Lilly Endowment, NVIDIA's own
 * filing) — not a manager picking stocks.
 */
export const MOVERS_MIN_POSITIONS = 5;
/**
 * Operating companies that file a 13F for the stakes they hold in other
 * companies. Their sales are corporate decisions, not a view on a sector, and
 * NVIDIA's own filing otherwise tops the list of semiconductor sellers. By CIK,
 * because a name rule would also catch "… Capital Management Inc".
 */
export const COMPANY_FILERS = new Set([
  "0001045810", // NVIDIA
  "0000002488", // AMD
  "0000050863", // Intel
  "0000703361", // Renesas Electronics America
  "0000858877", // Cisco
  "0001652044", // Alphabet
  "0001018724", // Amazon
  "0001543151", // Uber
  "0001065521", // SoftBank Group
  "0001928668", // Samsung C&T
  "0000200406", // Johnson & Johnson
  "0000310158", // Merck
  "0000078003", // Pfizer
  "0001058811", // Immersion
  "0002027344", // Koch
]);

/** Percent of the fund in one stock above which a book is not a stock picker's. */
export const MOVERS_MAX_SINGLE_WEIGHT = 50;

/**
 * Bump when fundMoves() changes what it produces. The build reuses last run's
 * rows for any fund whose data has not changed, so without this a change to
 * the rules would only reach funds that happened to file again.
 */
export const MOVERS_VERSION = 1;

export const moversPath = (period) => `movers/${period}.json`;
/** Which funds the last build looked at, and under which build key. */
export const moversSeenPath = (period) => `movers/${period}.seen.json`;

/** One-letter action codes, to keep a 50,000-row file small. */
export const MOVE_CODE = { NEW: "N", ADDED: "A", TRIMMED: "T", EXITED: "X" };

const round = (n, dp) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(dp)));

/**
 * One fund-quarter file -> { positions, value, moves } or a reason it is left out.
 *
 * Left out, rather than shown with a caveat, because the tab is a list of
 * decisions and none of these are one:
 *   - more than MOVERS_MAX_POSITIONS stocks, or a book big enough to be paged;
 *   - fewer than MOVERS_MIN_POSITIONS stocks;
 *   - more in options than in stock — selling shares while holding calls on
 *     them is the same bet in another form (Situational Awareness showed as
 *     $19B "sold" while its options book grew);
 *   - more than half the fund in one stock, either quarter: a founder, a
 *     family office or a venture fund (Valor);
 *   - an operating company reporting its stakes (COMPANY_FILERS);
 *   - no comparable prior quarter, or changes withheld (a structural event);
 *   - a uniform cut across every holding, which is money leaving the fund.
 *
 * Each move is [ticker, code, sharesChangePct, tradedUsd, weightBefore, weightAfter].
 */
export function fundMoves(env, { maxPositions = MOVERS_MAX_POSITIONS, minPositions = MOVERS_MIN_POSITIONS } = {}) {
  const meta = env?.meta ?? {};
  if (COMPANY_FILERS.has(env?.cik)) return { skip: "company", positions: meta.positions_long ?? null };
  const positions = meta.positions_long ?? null;
  if ((env?.pages ?? 1) > 1 || positions == null || positions > maxPositions) {
    return { skip: "not-concentrated", positions };
  }
  if (positions < minPositions) return { skip: "too-few-stocks", positions };
  if (meta.priorState !== "PRIOR_OK" || meta.deltasSuppressed) return { skip: "no-comparison", positions };
  if (meta.structuralEvent === "PRO_RATA_REDUCTION") return { skip: "withdrawal", positions };
  if ((meta.value_options_usd ?? 0) > (meta.value_long_usd ?? 0)) return { skip: "mostly-options", positions };

  const holdings = decodeHoldings(env.data);
  let top = 0;
  for (const h of holdings) {
    if (h.type || h.unit !== "SH") continue;
    top = Math.max(top, h.weight ?? 0);
    if (h.action !== "NEW" && h.dWeightPp != null) top = Math.max(top, (h.weight ?? 0) - h.dWeightPp);
  }
  for (const e of env.exits ?? []) if (!e.type) top = Math.max(top, e.weightPrior ?? 0);
  if (top > MOVERS_MAX_SINGLE_WEIGHT) return { skip: "one-stock-book", positions };

  const moves = [];
  for (const h of holdings) {
    if (h.type || h.unit !== "SH") continue; // long stock only
    const code = MOVE_CODE[h.action];
    if (!code) continue; // HELD, or no action
    // A stock split changes the share count with no decision behind it.
    if (code !== "N" && (h.flags ?? []).includes("SUSPECTED_SPLIT")) continue;
    const traded = code === "N"
      ? h.value ?? 0
      : h.dShares != null && h.price != null ? h.dShares * h.price : null;
    if (traded == null) continue;
    const before = code === "N" ? 0 : h.dWeightPp != null ? (h.weight ?? 0) - h.dWeightPp : null;
    moves.push([
      label(h), code,
      code === "N" ? null : round(h.dSharesPct, 1),
      Math.round(traded), round(before, 2), round(h.weight ?? 0, 2),
    ]);
  }

  // The same sale can arrive twice when the prior quarter was folded from two
  // filings (same stock, same value, different weight). Count it once, at the
  // smaller weight, so a sale is never overstated.
  const seen = new Map();
  for (const e of env.exits ?? []) {
    if (e.type || (e.unit && e.unit !== "SH")) continue;
    const k = `${e.issuerId ?? e.ticker ?? e.name}|${e.valuePrior}`;
    const prev = seen.get(k);
    if (prev) {
      if (e.weightPrior != null && (prev[4] == null || e.weightPrior < prev[4])) prev[4] = round(e.weightPrior, 2);
      continue;
    }
    const m = [label(e), "X", -100, -Math.round(e.valuePrior ?? 0), round(e.weightPrior, 2), 0];
    seen.set(k, m);
    moves.push(m);
  }

  return { positions, value: meta.value_long_usd ?? 0, moves };
}

/** The ticker where there is one; otherwise a short form of the filed name. */
function label(h) {
  return h.ticker || (h.name ?? "?").slice(0, 24);
}
