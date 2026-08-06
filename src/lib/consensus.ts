// src/lib/consensus.ts
//
// Cross-fund overlap, computed in the browser from the same per-fund artifacts
// the Fund view uses.
//
// This is the join a database would normally do, and doing it client-side is
// what lets the whole product run with no server: seven funds x two quarters is
// fourteen cached file reads and a few milliseconds of grouping. Nothing to
// precompute per watchlist, so a user can pick any set of funds and get an
// answer immediately.

import type { Holding, Exit } from "./data";

export interface FundInput {
  cik: string;
  name: string;
  code: string;
  color: string;
  holdings: Holding[];
  exits: Exit[];
  /** True when this fund's QoQ deltas were withheld for that quarter. */
  suppressed: boolean;
  /** True when this fund contributes no holdings to the period, for any reason. */
  missing: boolean;
  /**
   * `missing` because the LOAD FAILED, not because the manager did not file.
   *
   * These are two completely different statements — "they have not filed yet",
   * which is ordinary and expected for six weeks after every quarter, versus
   * "we could not fetch their book, so every figure on this page is computed
   * over fewer funds than the columns imply". They shared one flag, so the UI
   * reported network failures to the user as non-filings: confidently wrong,
   * and wrong in the direction that hides a problem.
   */
  failed?: boolean;
}

export type CellAction = "NEW" | "ADDED" | "HELD" | "TRIMMED" | "EXITED";

export interface Cell {
  cik: string;
  weight: number | null;
  value: number;
  action: CellAction | null;
  dWeightPp: number | null;
  /** Distinct tickers this fund holds for the issuer, e.g. GOOG and GOOGL. */
  classes: string[];
}

export interface ConsensusRow {
  issuerId: string;
  ticker: string | null;
  name: string;
  cells: Record<string, Cell>;
  fundCount: number;
  combinedValue: number;
  /**
   * Σ of this name's portfolio weight across every fund that still holds it.
   *
   * Deliberately NOT an average and NOT a weight of some combined book. Each
   * fund's weight is a percentage of ITS OWN long equity, so the sum is not
   * itself a percentage of anything — it is a conviction score. Eight funds at
   * 5% each (40) is a stronger group statement than two funds at 12% (24), and
   * that ordering is exactly what the client asked to be able to see. The unit
   * is spelled out wherever it renders so it cannot be read as "40% of the
   * group's money".
   *
   * A fund that EXITED contributes nothing: it has no weight to contribute.
   *
   * NULL, not zero, when no holder reported a weight at all. Weight is a share
   * of the fund's LONG EQUITY book, so a manager with no long equity — one
   * filing pure options, say — has `weight_pct: null` on every row by
   * construction (scripts/_sec-parse.mjs). Folding that into the sum as zero
   * would publish "0.0%" as a measurement when the honest answer is that there
   * is nothing to measure against.
   */
  sumWeight: number | null;
  /** sumWeight ÷ holders THAT REPORTED ONE — "how big is this for a typical holder". */
  avgWeight: number | null;
  /** Σ +1 per add/new, −1 per trim/exit. */
  netDirection: number;
  nNew: number;
  nExited: number;
  shareClasses: number;
}

const DIRECTION: Record<CellAction, number> = {
  NEW: 1, ADDED: 1, HELD: 0, TRIMMED: -1, EXITED: -1,
};

/**
 * Collapse the per-share-class actions of one fund into a single issuer-level
 * action.
 *
 * The naive rule — "rank the actions and take the strongest" — is wrong, and
 * wrong in a way that would embarrass us. In 2026-Q1 both Berkshire and
 * Bridgewater held Alphabet Class A (ADDED, a $15.6B position up 204%) AND
 * opened a small Class C sleeve (NEW). Ranking NEW first labels the issuer NEW,
 * which tells the reader that Berkshire newly bought Alphabet. They did not;
 * they already owned it and added.
 *
 * So: NEW only when EVERY class is new, EXITED only when every class is gone,
 * and otherwise let the net direction across classes decide. That is the
 * statement the data actually supports.
 */
export function dominantAction(actions: (CellAction | null)[]): CellAction | null {
  const present = actions.filter((a): a is CellAction => a != null);
  if (!present.length) return null;
  if (present.every((a) => a === "NEW")) return "NEW";
  if (present.every((a) => a === "EXITED")) return "EXITED";

  // A partial exit of one class while another is retained is a reduction of the
  // issuer position, not an exit from it.
  const net = present.reduce((a, x) => a + DIRECTION[x], 0);
  if (net > 0) return "ADDED";
  if (net < 0) return "TRIMMED";
  return "HELD";
}

/**
 * Group holdings by ISSUER, not by CUSIP or ticker.
 *
 * GOOG and GOOGL are two share classes of Alphabet with different CUSIPs. If
 * overlap were computed per class, a fund holding GOOG and a fund holding GOOGL
 * would show ZERO overlap on Alphabet — the single most misleading answer this
 * widget could give. Both classes carry the same issuerId (resolved at ingest
 * from the CUSIP issuer prefix), so they collapse into one row whose value is
 * the sum. The class count is surfaced separately so the collapse is visible
 * rather than hidden.
 *
 * Long equity only by default: an option row's value is notional, and letting
 * it into a "combined value" would rank a large put alongside real ownership.
 */
export function buildConsensus(
  funds: FundInput[],
  {
    minFunds = 2,
    longsOnly = true,
    // Keep rows where every fund has EXITED, i.e. nobody holds it any more.
    //
    // Such a row has zero holders and so fails any holder threshold — but it is
    // exactly what "who left" means. Without this the exits half of the anchor
    // silently drops the strongest signal it has: a name the whole group sold
    // out of. The matrix leaves this off (a no-holder row is noise there); the
    // anchor turns it on.
    includeExitOnly = false,
  }: { minFunds?: number; longsOnly?: boolean; includeExitOnly?: boolean } = {},
): ConsensusRow[] {
  type Acc = {
    issuerId: string;
    ticker: string | null;
    name: string;
    byFund: Map<string, {
      value: number;
      weight: number;
      /** At least one row carried a real weight. Distinguishes "0%" from "not
          reported" — see the sumWeight note on ConsensusRow. */
      hasWeight: boolean;
      dWeightPp: number | null;
      actions: (CellAction | null)[];
      classes: Set<string>;
    }>;
  };
  const acc = new Map<string, Acc>();

  const touch = (issuerId: string, ticker: string | null, name: string): Acc => {
    let a = acc.get(issuerId);
    if (!a) {
      a = { issuerId, ticker, name, byFund: new Map() };
      acc.set(issuerId, a);
    }
    // Prefer a resolved ticker and the shortest issuer name we have seen: filer-
    // typed names vary ("ALPHABET INC" vs "ALPHABET INC CL C") and the shortest
    // is the closest to the issuer itself.
    if (!a.ticker && ticker) a.ticker = ticker;
    if (name && name.length < a.name.length) a.name = name;
    return a;
  };

  for (const f of funds) {
    if (f.missing) continue;

    for (const h of f.holdings) {
      if (!h.issuerId) continue;
      if (longsOnly && (h.type !== "" || h.unit !== "SH")) continue;
      const a = touch(h.issuerId, h.ticker, h.name);
      let slot = a.byFund.get(f.cik);
      if (!slot) {
        slot = { value: 0, weight: 0, hasWeight: false, dWeightPp: null, actions: [], classes: new Set() };
        a.byFund.set(f.cik, slot);
      }
      slot.value += h.value;
      if (h.weight != null) {
        slot.weight += h.weight;
        slot.hasWeight = true;
      }
      if (h.dWeightPp != null) slot.dWeightPp = (slot.dWeightPp ?? 0) + h.dWeightPp;
      slot.actions.push(h.action);
      if (h.ticker) slot.classes.add(h.ticker);
    }

    // Exits are half of the client's anchor, so an exited position must still
    // occupy a cell. Leaving it out would make a fund that just sold out look
    // identical to one that never held the name.
    for (const e of f.exits) {
      if (!e.issuerId) continue;
      const a = touch(e.issuerId, e.ticker ?? null, e.name);
      let slot = a.byFund.get(f.cik);
      if (!slot) {
        slot = { value: 0, weight: 0, hasWeight: false, dWeightPp: null, actions: [], classes: new Set() };
        a.byFund.set(f.cik, slot);
      }
      slot.actions.push("EXITED");
      if (e.weightPrior != null) slot.dWeightPp = (slot.dWeightPp ?? 0) - e.weightPrior;
      if (e.ticker) slot.classes.add(e.ticker);
    }
  }

  const rows: ConsensusRow[] = [];
  for (const a of acc.values()) {
    const cells: Record<string, Cell> = {};
    let combined = 0;
    let sumWeight = 0;
    /** Holders that actually reported a weight — the honest denominator. */
    let weighted = 0;
    let net = 0;
    let nNew = 0;
    let nExited = 0;
    let held = 0;
    const classes = new Set<string>();

    for (const [cik, slot] of a.byFund) {
      const action = dominantAction(slot.actions);
      // Three states, not two: a real weight, zero, and NOT REPORTED. The last
      // one used to collapse into the second — a fund with no long-equity
      // denominator publishes null on every row, and rendering that as "0.0%"
      // states a measurement where none exists.
      const weight = slot.value > 0 && slot.hasWeight ? slot.weight : null;
      cells[cik] = {
        cik,
        weight,
        value: slot.value,
        action,
        dWeightPp: slot.dWeightPp,
        classes: [...slot.classes],
      };
      combined += slot.value;
      // Sum the SAME number the cell renders, so the column total always
      // reconciles against the row it sits on — and count how many cells
      // contributed, so an unreported weight neither adds a phantom zero to the
      // total nor dilutes the average as though it were one.
      if (weight != null) {
        sumWeight += weight;
        weighted++;
      }
      if (action) net += DIRECTION[action];
      if (action === "NEW") nNew++;
      if (action === "EXITED") nExited++;
      // A fund that exited does NOT count toward "how many funds hold this".
      if (action !== "EXITED") held++;
      slot.classes.forEach((c) => classes.add(c));
    }

    if (held < minFunds && !(includeExitOnly && nExited > 0)) continue;
    rows.push({
      issuerId: a.issuerId,
      ticker: a.ticker,
      name: a.name,
      cells,
      fundCount: held,
      combinedValue: combined,
      // Nobody reported a weight -> the answer is "unknown", which `pct`
      // already renders as an em-dash, not "0.0%".
      sumWeight: weighted > 0 ? sumWeight : null,
      avgWeight: weighted > 0 ? sumWeight / weighted : null,
      netDirection: net,
      nNew,
      nExited,
      shareClasses: Math.max(1, classes.size),
    });
  }

  return rows;
}

export type SortKey = "funds" | "value" | "weight" | "net" | "ticker";

export function sortConsensus(rows: ConsensusRow[], key: SortKey): ConsensusRow[] {
  const out = [...rows];
  switch (key) {
    case "value":
      return out.sort((a, b) => b.combinedValue - a.combinedValue);
    // "Which names is the group most COMMITTED to" — a different question from
    // "which are biggest", and the one dollar value cannot answer. A $40B index
    // sleeve can be 0.4% of the book it sits in; a $900M position can be 9%.
    //
    // An unreported weight sorts BELOW a reported zero: -1 rather than 0, so a
    // row we cannot measure never outranks one we measured at nothing.
    case "weight":
      return out.sort((a, b) => (b.sumWeight ?? -1) - (a.sumWeight ?? -1) || b.fundCount - a.fundCount);
    // Surfaces names the whole group moved the same way — the highest-signal
    // ordering in the product, and the one a per-fund view cannot show.
    case "net":
      return out.sort((a, b) => a.netDirection - b.netDirection || b.fundCount - a.fundCount);
    case "ticker":
      return out.sort((a, b) => (a.ticker ?? a.name).localeCompare(b.ticker ?? b.name));
    case "funds":
    default:
      return out.sort((a, b) => b.fundCount - a.fundCount || b.combinedValue - a.combinedValue);
  }
}

/** Distribution of names by how many funds hold them — doubles as the matrix filter. */
export function overlapDistribution(rows: ConsensusRow[], totalFunds: number) {
  const buckets = Array.from({ length: totalFunds }, (_, i) => ({ funds: i + 1, names: 0, value: 0 }));
  for (const r of rows) {
    const b = buckets[r.fundCount - 1];
    if (b) {
      b.names++;
      b.value += r.combinedValue;
    }
  }
  return buckets.filter((b) => b.funds >= 1);
}

export interface AnchorEntry {
  issuerId: string;
  ticker: string | null;
  name: string;
  funds: { cik: string; code: string; color: string }[];
  value: number;
  weight: number | null;
}

/**
 * New positions and exits across the group — the client's stated "anchor".
 *
 * Funds whose quarter was flagged as a structural event are EXCLUDED and
 * counted separately. Cantillon's 2026-Q2 redemption would otherwise contribute
 * 11 fake exits to a group total, which is precisely the error the per-fund view
 * already refuses to make.
 */
export function buildAnchor(
  funds: FundInput[],
  rows: ConsensusRow[],
): { entries: AnchorEntry[]; exits: AnchorEntry[]; suppressedFunds: string[]; suppressedExits: number } {
  const byCik = new Map(funds.map((f) => [f.cik, f]));
  const suppressedFunds = funds.filter((f) => f.suppressed).map((f) => f.name);
  let suppressedExits = 0;

  const entries: AnchorEntry[] = [];
  const exits: AnchorEntry[] = [];

  for (const r of rows) {
    const newFunds: AnchorEntry["funds"] = [];
    const exitFunds: AnchorEntry["funds"] = [];
    let newValue = 0;
    let exitValue = 0;

    for (const cell of Object.values(r.cells)) {
      const f = byCik.get(cell.cik);
      if (!f) continue;
      if (f.suppressed) {
        if (cell.action === "EXITED" || cell.action === "NEW") suppressedExits++;
        continue;
      }
      const tag = { cik: f.cik, code: f.code, color: f.color };
      if (cell.action === "NEW") {
        newFunds.push(tag);
        newValue += cell.value;
      } else if (cell.action === "EXITED") {
        exitFunds.push(tag);
        exitValue += Math.abs(cell.dWeightPp ?? 0);
      }
    }

    if (newFunds.length) {
      entries.push({ issuerId: r.issuerId, ticker: r.ticker, name: r.name, funds: newFunds, value: newValue, weight: null });
    }
    if (exitFunds.length) {
      exits.push({ issuerId: r.issuerId, ticker: r.ticker, name: r.name, funds: exitFunds, value: 0, weight: exitValue });
    }
  }

  entries.sort((a, b) => b.funds.length - a.funds.length || b.value - a.value);
  exits.sort((a, b) => b.funds.length - a.funds.length || (b.weight ?? 0) - (a.weight ?? 0));
  return { entries, exits, suppressedFunds, suppressedExits };
}
