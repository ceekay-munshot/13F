// tests/monthly-quarter.test.mjs
//
// One fund-quarter as the MONTHLY build folds it (foldQuarter, used by
// scripts/ingest-dera.mjs).
//
// ---------------------------------------------------------------------------
// THE BUG THIS PINS
// ---------------------------------------------------------------------------
// The monthly build published a quarter's cover-page total as
// `foldable[foldable.length - 1].table_value_total` — whichever filing happened
// to be loaded last. Filings are loaded bulk window by bulk window, line by line,
// then archived copies; none of that is the order the SEC accepted them in. So
// a fund that filed a report and then restated it could show the ORIGINAL's
// total beside holdings taken from the restatement, and a fund that later added
// withheld positions showed one filing's total instead of the two together.
// The same-day build had already been fixed to take the total from the fold;
// the monthly build, which rebuilds every fund on the 3rd, had not, so each
// month it would have put the wrong figure back.
//
// The date it showed for the quarter was read the same way, and the real
// acceptance times archived copies carry were thrown away before the fold could
// use them to order same-day amendments.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { foldQuarter } from "../scripts/_source-load.mjs";
import { holding } from "./fixtures.mjs";

/** A filing in the builder's shape — what the bulk loader and normalizeEdgarFiling produce. */
const filing = (over) => ({
  accession: "0000000000-26-000001", cik: "0001234567", period_end: "2026-06-30",
  filing_date: "2026-08-14", is_amendment: false, amendment_type: null,
  is_confidential_omitted: false, notice: false, quarantined: false,
  ...over,
});

const book = (...pairs) => pairs.map(([cusip, value]) => holding({ cusip, value, shares: value / 10 }));

const ORIGINAL = filing({
  accession: "0000000000-26-000100", filing_date: "2026-08-14",
  table_value_total: 1_000, held: book(["A", 600], ["B", 400]),
});
const RESTATEMENT = filing({
  accession: "0000000000-26-000200", filing_date: "2026-09-02",
  is_amendment: true, amendment_type: "RESTATEMENT",
  table_value_total: 1_300, held: book(["A", 700], ["B", 400], ["C", 200]),
});
// Withheld positions disclosed later: names nothing the book already holds.
const ADDITION = filing({
  accession: "0000000000-26-000300", filing_date: "2026-09-02",
  is_amendment: true, amendment_type: "NEW HOLDINGS",
  table_value_total: 250, held: book(["W", 250]),
});
// The whole report sent again, ticked "adds new holdings". Same positions at
// the same share counts, plus one.
const RESENT = filing({
  accession: "0000000000-26-000400", filing_date: "2026-09-02",
  is_amendment: true, amendment_type: "NEW HOLDINGS",
  table_value_total: 1_050, held: book(["A", 600], ["B", 400], ["D", 50]),
});

/** Both orders a quarter's filings can be loaded in. */
const bothOrders = (...fs) => [fs, [...fs].reverse()];

describe("the cover total a monthly-built quarter reports", () => {
  it("an original and its restatement report the restatement's total, in either order", () => {
    for (const order of bothOrders(ORIGINAL, RESTATEMENT)) {
      const q = foldQuarter(order);
      expect(q.reported_total_usd).toBe(1_300);
      // The total and the holdings come from the same filing.
      expect(q.holdings.map((h) => h.cusip).sort()).toEqual(["A", "B", "C"]);
      expect(q.value_long_usd).toBe(1_300);
    }
  });

  it("with the original loaded last — the order that used to publish the original's total", () => {
    // The old line read this array's last element: the ORIGINAL, $1,000.
    expect(foldQuarter([RESTATEMENT, ORIGINAL]).reported_total_usd).toBe(1_300);
  });

  it("a genuine NEW HOLDINGS addition reports the original plus the addition, in either order", () => {
    for (const order of bothOrders(ORIGINAL, ADDITION)) {
      const q = foldQuarter(order);
      // Not 1,000 or 250: the addition's cover page counts only what it adds.
      expect(q.reported_total_usd).toBe(1_250);
      expect(q.holdings.map((h) => h.cusip).sort()).toEqual(["A", "B", "W"]);
      expect(q.value_long_usd).toBe(1_250);
    }
  });

  it("a whole report sent again under a NEW HOLDINGS label reports the re-sent total, not the two added", () => {
    for (const order of bothOrders(ORIGINAL, RESENT)) {
      const q = foldQuarter(order);
      // Not 2,050: that is the book counted twice.
      expect(q.reported_total_usd).toBe(1_050);
      expect(q.holdings).toHaveLength(3);
      expect(q.warnings.map((w) => w.code)).toContain("new_holdings_relists_book");
    }
  });

  it("a restatement after an addition wipes the addition from the total too", () => {
    const restated = { ...RESTATEMENT, filing_date: "2026-09-20" };
    for (const order of [[ORIGINAL, ADDITION, restated], [restated, ADDITION, ORIGINAL], [ADDITION, restated, ORIGINAL]]) {
      expect(foldQuarter(order).reported_total_usd).toBe(1_300);
    }
  });

  it("a quarter whose filer left the total blank reports none rather than inventing one", () => {
    expect(foldQuarter([{ ...ORIGINAL, table_value_total: null }]).reported_total_usd).toBeNull();
  });
});

describe("when the quarter was filed", () => {
  it("is the latest filing's date, whatever order they were loaded in", () => {
    for (const order of bothOrders(ORIGINAL, RESTATEMENT)) {
      // The bulk file has a date and no time; noon UTC stands in, as everywhere.
      expect(foldQuarter(order).acceptance).toBe("2026-09-02T12:00:00.000Z");
    }
  });

  it("is the real acceptance time where an archived copy carries one", () => {
    const archived = { ...RESTATEMENT, acceptance_datetime: "2026-09-02T20:14:07.000Z" };
    expect(foldQuarter([archived, ORIGINAL]).acceptance).toBe("2026-09-02T20:14:07.000Z");
  });
});

describe("two filings made on the same day", () => {
  // Different filing agents, so the restatement's accession number sorts FIRST.
  // Accession order is what a tie falls back to, so a tie makes the original —
  // the filing the restatement exists to replace — the one that sticks.
  const original = { ...ORIGINAL, accession: "0001104659-26-090001", filing_date: "2026-08-14" };
  const restatement = { ...RESTATEMENT, accession: "0000950170-26-010001", filing_date: "2026-08-14" };

  it("are ordered by their real times when both archived copies have one", () => {
    const q = foldQuarter([
      { ...original, acceptance_datetime: "2026-08-14T14:02:11.000Z" },
      { ...restatement, acceptance_datetime: "2026-08-14T19:40:52.000Z" },
    ]);
    expect(q.reported_total_usd).toBe(1_300);
    expect(q.holdings.map((h) => h.cusip).sort()).toEqual(["A", "B", "C"]);
    expect(q.warnings.map((w) => w.code)).not.toContain("fold_tie");
  });

  it("stay a tie, said out loud, when one of them has only a date", () => {
    // A real 19:40 against a stand-in noon would be a guess dressed as a fact.
    // The bulk-only filing could have been accepted at any time that day.
    const q = foldQuarter([
      original,
      { ...restatement, acceptance_datetime: "2026-08-14T19:40:52.000Z" },
    ]);
    expect(q.warnings.map((w) => w.code)).toContain("fold_tie");
  });
});

describe("the monthly build folds through it", () => {
  const src = readFileSync(new URL("../scripts/ingest-dera.mjs", import.meta.url), "utf8");

  it("calls foldQuarter for every quarter with filings to fold", () => {
    expect(src).toContain("folded.set(period, foldQuarter(foldable))");
  });

  it("never reads a quarter's figures off the last filing loaded", () => {
    expect(src).not.toMatch(/foldable\[foldable\.length\s*-\s*1\]/);
    expect(src).not.toContain("last.table_value_total");
    expect(src).not.toContain("last.filing_date");
  });
});
