// tests/new-holdings.test.mjs
//
// A "new holdings" amendment that is really a full re-filing, and what the fold
// does when two filings genuinely do combine into one quarter.
//
// ---------------------------------------------------------------------------
// THE BUG THIS PINS
// ---------------------------------------------------------------------------
// Arbiter Partners Capital Management (CIK 0001513193) filed its 2026-Q2 13F
// three times: the original on 10 Aug, then two amendments on 19 Aug and 15 Sep,
// each ticked "adds new holdings". Read from EDGAR, each one is the whole book
// again — 42, 42 and 44 entries worth $189.9M, $189.8M and $196.5M.
//
// The fold trusted the label and added them together, so the dashboard's Q2
// showed 127 positions worth $576M, and when Arbiter sold OSISKO DEVELOPMENT in
// Q3 its "Exited" list showed it three times — weights 2.947%, 2.949% and
// 2.843%, each a share of a different filing's total. Measured on the live site
// on 17 Nov 2026: 46 funds' Q3 exit lists appeared to repeat a position, and 19
// of them trace to this, every one confirmed against EDGAR. (Of the other 27,
// 26 are different securities that share an issuer code and a prior value, and
// one filed its puts as shares; neither is a fold problem.)
//
// The fixture below is that filing set, rebuilt with synthetic CUSIPs to the
// real totals and entry counts. The OSISKO position is the real one.

import { describe, it, expect } from "vitest";
import { foldFilings, mergeHoldings, repeatedShare, weighHoldings, RELISTED_BOOK_SHARE, PRIOR_STATE } from "../shared/fold.mjs";
import { fundQuarter } from "../shared/emit.mjs";
import { aggregateHoldings, summarizeHoldings } from "../scripts/_sec-parse.mjs";
import { holding, cusipAt, distribute } from "./fixtures.mjs";

// The real position, and the two real put positions every copy carries — they
// sit in the cover total but not in the long-equity book weights are taken of.
const ODV = { cusip: "68828E809", value: 5_319_740, shares: 2_162_496 };
const PUTS = [{ cusip: "038923108", value: 735_494, shares: 135_700 }, { cusip: "88160R101", value: 8_664_360, shares: 20_600 }];
const PUTS_VALUE = PUTS.reduce((a, p) => a + p.value, 0);

/** One filing's book: `n` positions — OSISKO, the two puts, and others — summing to `total`. */
function book(total, n) {
  const row = (cusip, value, shares, put_call = "") =>
    ({ cusip, value_raw: value, ssh_prnamt: shares, put_call, ssh_prnamt_type: "SH", title_of_class: "COM" });
  const rows = [row(ODV.cusip, ODV.value, ODV.shares), ...PUTS.map((p) => row(p.cusip, p.value, p.shares, "Put"))];
  distribute(total - ODV.value - PUTS_VALUE, n - 3).forEach((v, i) => rows.push(row(cusipAt(i), v, 1000 + i)));
  // Through the real aggregation, so each filing's weights are what the parser
  // gives it — shares of that filing's own total.
  return aggregateHoldings(rows, "dollars");
}

// 41, 42 and 44 distinct positions: each copy is the one before plus a new name
// or two, exactly as on EDGAR.
const ARBITER_Q2 = [
  { accession_number: "0001062993-26-004109", acceptance_datetime: "2026-08-10T16:01:00.000Z", is_amendment: false, amendment_type: null, table_value_total: 189_907_562, rows: book(189_907_562, 41) },
  { accession_number: "0001062993-26-004507", acceptance_datetime: "2026-08-19T16:49:00.000Z", is_amendment: true, amendment_type: "NEW HOLDINGS", table_value_total: 189_801_476, rows: book(189_801_476, 42) },
  { accession_number: "0001062993-26-004959", acceptance_datetime: "2026-09-15T16:30:00.000Z", is_amendment: true, amendment_type: "NEW HOLDINGS", table_value_total: 196_546_873, rows: book(196_546_873, 44) },
];
// The 15 Sep filing's long equity: its cover total less the two puts.
const LONG_BOOK = 196_546_873 - PUTS_VALUE; // 187,147,019

describe("a NEW HOLDINGS amendment that re-lists the whole book", () => {
  it("is folded as the full re-filing it is — one row per position, not three", () => {
    const { rows, accessions } = foldFilings(ARBITER_Q2);
    expect(rows).toHaveLength(44);
    expect(new Set(rows.map((h) => h.cusip)).size).toBe(44);
    // All three filings are still recorded as making up the quarter.
    expect(accessions).toHaveLength(3);
  });

  it("takes the latest filing's book, total and weights", () => {
    const { rows, reportedTotalUsd } = foldFilings(ARBITER_Q2);
    // Was $548,056,349 of long equity — three copies of the book.
    expect(summarizeHoldings(rows).value_long_usd).toBe(LONG_BOOK);
    // Was $576,255,911 — the three cover totals added together.
    expect(reportedTotalUsd).toBe(196_546_873);
    const odv = rows.find((h) => h.cusip === ODV.cusip);
    // Was three rows, one per copy.
    expect(odv.ssh_prnamt).toBe(ODV.shares);
    expect(odv.weight_pct).toBeCloseTo((ODV.value / LONG_BOOK) * 100, 10);
  });

  it("says so, once per amendment it overrode", () => {
    const { warnings } = foldFilings(ARBITER_Q2);
    const relisted = warnings.filter((w) => w.code === "new_holdings_relists_book");
    expect(relisted).toHaveLength(2);
    expect(relisted[0].detail).toMatch(/0001062993-26-004507.*repeats 41 of the 41 positions/);
    expect(relisted[1].detail).toMatch(/0001062993-26-004959.*repeats 42 of the 42 positions/);
  });

  it("lists a position sold the next quarter ONCE, with the latest filing's weight", () => {
    // The symptom as the dashboard showed it: Q3 drops OSISKO.
    const q2 = foldFilings(ARBITER_Q2);
    const q2Summary = summarizeHoldings(q2.rows);
    const q3Rows = q2.rows.filter((h) => h.cusip !== ODV.cusip).map((h) => ({ ...h }));
    weighHoldings(q3Rows);
    const q3Summary = summarizeHoldings(q3Rows);

    const q = fundQuarter({
      period: "2026-09-30",
      priorPeriod: "2026-06-30",
      cur: { holdings: q3Rows, summary: q3Summary, value_long_usd: q3Summary.value_long_usd, accessions: ["0001062993-26-005905"], warnings: [] },
      prior: { holdings: q2.rows, summary: q2Summary, value_long_usd: q2Summary.value_long_usd, accessions: q2.accessions },
      priorState: PRIOR_STATE.OK,
      issuerIdFor: (c) => `i${c}`,
    });

    expect(q.exits).toHaveLength(1);
    expect(q.meta.n_exited).toBe(1);
    expect(q.exits[0].valuePrior).toBe(ODV.value);
    // ODV's share of the 15 Sep filing, the book in force for Q2. The live file
    // showed 2.947 / 2.949 / 2.843: shares of $180.5M, $180.4M and $187.1M of
    // long equity, one per copy. The last is the right one.
    expect(q.exits[0].weightPrior.toFixed(4)).toBe("2.8425");
  });
});

describe("where the line between a re-filing and an addition sits", () => {
  const base = [holding({ cusip: "A", value: 100, shares: 10 }), holding({ cusip: "B", value: 100, shares: 10 }),
    holding({ cusip: "C", value: 100, shares: 10 }), holding({ cusip: "D", value: 100, shares: 10 })];
  const fold = (amendment) =>
    foldFilings([
      { accession_number: "o", acceptance_datetime: "2026-08-10T00:00:00Z", is_amendment: false, rows: base },
      { accession_number: "a", acceptance_datetime: "2026-08-20T00:00:00Z", is_amendment: true, amendment_type: "NEW HOLDINGS", rows: amendment },
    ]);

  it("is half of the positions already reported", () => {
    expect(RELISTED_BOOK_SHARE).toBe(0.5);
  });

  it("an amendment repeating half the book or more replaces it", () => {
    const { rows } = fold([holding({ cusip: "A", value: 100, shares: 10 }), holding({ cusip: "B", value: 100, shares: 10 })]);
    expect(rows.map((h) => h.cusip)).toEqual(["A", "B"]);
  });

  it("an amendment repeating less than half adds to it", () => {
    const { rows, warnings } = fold([holding({ cusip: "A", value: 50, shares: 5 }), holding({ cusip: "E", value: 100, shares: 10 })]);
    expect(rows.map((h) => h.cusip).sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(warnings.map((w) => w.code)).not.toContain("new_holdings_relists_book");
  });

  it("measures against the BOOK, not the amendment", () => {
    // Five rows that all name securities the book already holds are 100%
    // repeated by the amendment's own measure. Against a book of forty they are
    // an eighth, and an eighth is an addition: the withheld parts of five
    // partly confidential positions.
    const big = Array.from({ length: 40 }, (_, i) => holding({ cusip: cusipAt(i), value: 100, shares: 10 }));
    const add = big.slice(0, 5).map((h) => holding({ cusip: h.cusip, value: 30, shares: 3 }));
    expect(repeatedShare(big, add)).toEqual({ repeated: 5, of: 40, share: 0.125, sameSharesValueShare: 0 });
    const { rows } = foldFilings([
      { accession_number: "o", acceptance_datetime: "2026-08-10T00:00:00Z", is_amendment: false, rows: big },
      { accession_number: "a", acceptance_datetime: "2026-08-20T00:00:00Z", is_amendment: true, amendment_type: "NEW HOLDINGS", rows: add },
    ]);
    expect(rows).toHaveLength(40);
    expect(rows.find((h) => h.cusip === cusipAt(0)).ssh_prnamt).toBe(13);
  });

  // The three cases nearest the line, as measured on EDGAR.

  it("re-filing the largest positions share for share replaces the book, though they are few", () => {
    // CIK 0001032814, 2026-Q2: a book of 53 positions worth $3.78B, then a "new
    // holdings" amendment naming only the 17 largest — at identical share counts
    // and values, $3.75B between them. A third of the positions, 99% of the
    // book. Adding it would have doubled the quarter.
    const values = [...Array(17).fill(220), ...Array(36).fill(1)];
    const book53 = values.map((v, i) => holding({ cusip: cusipAt(i), value: v, shares: v * 10 }));
    const top17 = book53.slice(0, 17).map((h) => holding({ cusip: h.cusip, value: h.value_usd, shares: h.ssh_prnamt }));
    const r = repeatedShare(book53, top17);
    expect(r.share).toBeLessThan(0.5);
    expect(r.sameSharesValueShare).toBeGreaterThan(0.99);
    const { rows, warnings } = foldFilings([
      { accession_number: "o", acceptance_datetime: "2026-08-10T00:00:00Z", is_amendment: false, rows: book53 },
      { accession_number: "a", acceptance_datetime: "2026-08-20T00:00:00Z", is_amendment: true, amendment_type: "NEW HOLDINGS", rows: top17 },
    ]);
    expect(rows).toHaveLength(17);
    expect(warnings[0].detail).toMatch(/repeats 17 of the 53 positions already reported, 99% of the book by value/);
  });

  it("adding to the largest positions is still an addition", () => {
    // CIK 0001582681, 2026-Q2: an eight-position book, then a small amendment
    // naming its two largest holdings — 79% of its value — at different share
    // counts. That is the withheld part of two positions, not a re-filing.
    const book8 = [500, 290, 60, 50, 40, 30, 20, 10].map((v, i) => holding({ cusip: cusipAt(i), value: v, shares: v }));
    const topUp = [holding({ cusip: cusipAt(0), value: 4, shares: 4 }), holding({ cusip: cusipAt(1), value: 2, shares: 2 })];
    const { rows } = foldFilings([
      { accession_number: "o", acceptance_datetime: "2026-08-10T00:00:00Z", is_amendment: false, rows: book8 },
      { accession_number: "a", acceptance_datetime: "2026-08-20T00:00:00Z", is_amendment: true, amendment_type: "NEW HOLDINGS", rows: topUp },
    ]);
    expect(rows).toHaveLength(8);
    expect(rows.find((h) => h.cusip === cusipAt(0)).ssh_prnamt).toBe(504);
  });

  it("naming a third of the positions at new sizes is still an addition", () => {
    // CIK 0001616034, 2025-Q4: the closest genuine addition on positions — 258
    // of 695 named again (37%), not one at the same share count.
    const book = Array.from({ length: 30 }, (_, i) => holding({ cusip: cusipAt(i), value: 100, shares: 100 }));
    const add = book.slice(0, 11).map((h) => holding({ cusip: h.cusip, value: 40, shares: 40 }));
    expect(repeatedShare(book, add).share).toBeCloseTo(11 / 30, 10);
    const { rows } = foldFilings([
      { accession_number: "o", acceptance_datetime: "2026-08-10T00:00:00Z", is_amendment: false, rows: book },
      { accession_number: "a", acceptance_datetime: "2026-08-20T00:00:00Z", is_amendment: true, amendment_type: "NEW HOLDINGS", rows: add },
    ]);
    expect(rows).toHaveLength(30);
    expect(rows.find((h) => h.cusip === cusipAt(0)).ssh_prnamt).toBe(140);
  });

  it("keys on put/call and unit too, so a call on a held stock is not a repeat of it", () => {
    const calls = base.map((h) => holding({ cusip: h.cusip, value: 5, shares: 1, putCall: "Call" }));
    const { rows } = fold(calls);
    expect(rows).toHaveLength(8);
  });

  it("an amendment with nothing before it repeats nothing", () => {
    expect(repeatedShare([], base).share).toBe(0);
  });
});

describe("when two filings really do combine", () => {
  const fold = (original, addition) =>
    foldFilings([
      { accession_number: "o", acceptance_datetime: "2026-08-10T00:00:00Z", is_amendment: false, table_value_total: 1000, rows: original },
      { accession_number: "a", acceptance_datetime: "2026-08-20T00:00:00Z", is_amendment: true, amendment_type: "NEW HOLDINGS", table_value_total: 250, rows: addition },
    ]);

  it("sums the two parts of one position into one row", () => {
    const original = [holding({ cusip: "X", value: 600, shares: 60 }), holding({ cusip: "Y", value: 400, shares: 40 }),
      holding({ cusip: "Z", value: 0, shares: 0 })];
    const { rows, reportedTotalUsd } = fold(original, [holding({ cusip: "X", value: 250, shares: 25 })]);
    expect(rows).toHaveLength(3);
    const x = rows.find((h) => h.cusip === "X");
    expect(x.value_usd).toBe(850);
    expect(x.ssh_prnamt).toBe(85);
    expect(x.row_count).toBe(2);
    expect(reportedTotalUsd).toBe(1250);
  });

  it("weighs every row against the whole quarter, not the filing it came from", () => {
    // Each filing's weights were shares of its own total. A one-row addition
    // therefore arrived weighted at 100% of itself.
    const original = weighHoldings([holding({ cusip: "X", value: 750, shares: 75 }), holding({ cusip: "Y", value: 250, shares: 25 })]);
    const addition = weighHoldings([holding({ cusip: "W", value: 1000, shares: 10 })]);
    expect(addition[0].weight_pct).toBe(100);

    const { rows } = fold(original, addition);
    const w = Object.fromEntries(rows.map((h) => [h.cusip, h.weight_pct]));
    expect(w).toEqual({ X: 37.5, Y: 12.5, W: 50 });
    expect(rows.reduce((a, h) => a + h.weight_pct, 0)).toBeCloseTo(100, 10);
  });

  it("does not touch the filings' own rows, which also feed the filings list", () => {
    const original = [holding({ cusip: "X", value: 600, shares: 60, weight: 60 })];
    const addition = [holding({ cusip: "X", value: 250, shares: 25, weight: 100 })];
    fold(original, addition);
    expect(original[0].value_usd).toBe(600);
    expect(original[0].weight_pct).toBe(60);
    expect(addition[0].weight_pct).toBe(100);
  });

  it("a genuine addition after a re-filing adds to the re-filing", () => {
    const four = ["A", "B", "C", "D"].map((c) => holding({ cusip: c, value: 100, shares: 10 }));
    const { rows, reportedTotalUsd, warnings } = foldFilings([
      { accession_number: "o", acceptance_datetime: "2026-08-10T00:00:00Z", is_amendment: false, table_value_total: 400, rows: four },
      { accession_number: "a1", acceptance_datetime: "2026-08-20T00:00:00Z", is_amendment: true, amendment_type: "NEW HOLDINGS", table_value_total: 400, rows: four },
      { accession_number: "a2", acceptance_datetime: "2026-09-01T00:00:00Z", is_amendment: true, amendment_type: "NEW HOLDINGS", table_value_total: 50, rows: [holding({ cusip: "E", value: 50, shares: 5 })] },
    ]);
    expect(rows.map((h) => h.cusip).sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(reportedTotalUsd).toBe(450);
    expect(warnings.filter((w) => w.code === "new_holdings_relists_book")).toHaveLength(1);
  });
});

describe("a quarter with nothing combined is left exactly as the parser made it", () => {
  // Every artifact that never had an addition must come out byte-for-byte the
  // same, or this change would rewrite tens of thousands of files for nothing.
  const rows = [holding({ cusip: "X", value: 600, shares: 60, weight: 60 })];

  it("an original alone", () => {
    const out = foldFilings([{ accession_number: "o", acceptance_datetime: "2026-08-10T00:00:00Z", is_amendment: false, rows }]);
    expect(out.rows[0]).toBe(rows[0]);
  });

  it("an original replaced by a restatement", () => {
    const restated = [holding({ cusip: "Y", value: 1, shares: 1, weight: 100 })];
    const out = foldFilings([
      { accession_number: "o", acceptance_datetime: "2026-08-10T00:00:00Z", is_amendment: false, rows },
      { accession_number: "r", acceptance_datetime: "2026-08-20T00:00:00Z", is_amendment: true, amendment_type: "RESTATEMENT", rows: restated },
    ]);
    expect(out.rows[0]).toBe(restated[0]);
  });

  it("an addition with no original before it", () => {
    const out = foldFilings([{ accession_number: "a", acceptance_datetime: "2026-08-20T00:00:00Z", is_amendment: true, amendment_type: "NEW HOLDINGS", rows }]);
    expect(out.rows[0]).toBe(rows[0]);
  });
});

describe("one weight formula", () => {
  it("merging a single filing's rows changes nothing about them", () => {
    const parsed = aggregateHoldings(
      [
        { cusip: "X", value_raw: 700, ssh_prnamt: 7, put_call: "", ssh_prnamt_type: "SH" },
        { cusip: "X", value_raw: 300, ssh_prnamt: 3, put_call: "", ssh_prnamt_type: "SH" },
        { cusip: "Y", value_raw: 250, ssh_prnamt: 5, put_call: "Call", ssh_prnamt_type: "SH" },
        { cusip: "Z", value_raw: 1000, ssh_prnamt: 1000, put_call: "", ssh_prnamt_type: "PRN" },
      ],
      "dollars",
    );
    expect(mergeHoldings(parsed)).toEqual(parsed);
  });
});
