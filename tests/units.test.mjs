// tests/units.test.mjs
//
// The value-units ladder. This is the highest-impact correctness gate in the
// project: getting it wrong is a silent 1000x error on every dollar figure a
// client sees, and it looks completely plausible on screen.

import { describe, it, expect } from "vitest";
import { decideValueUnits, toUsd, reconcileTotal } from "../scripts/_sec-parse.mjs";
import { JEFFERIES_2021Q1, bookRows, mkRow, cusipAt } from "./fixtures.mjs";

describe("Jefferies 2021-Q1 — the same quarter filed in both units", () => {
  const { original, amendment } = JEFFERIES_2021Q1;

  it("reads the 2021 original as THOUSANDS", () => {
    const rows = bookRows(original.tableValueTotal, "THOUSANDS");
    const d = decideValueUnits({
      schemaVersion: original.schemaVersion,
      acceptanceDatetime: original.acceptance_datetime,
      rows,
    });
    expect(d.units).toBe("THOUSANDS");
  });

  it("reads the 2023 restatement of the SAME period as DOLLARS", () => {
    const rows = bookRows(amendment.tableValueTotal, "DOLLARS");
    const d = decideValueUnits({
      schemaVersion: amendment.schemaVersion,
      acceptanceDatetime: amendment.acceptance_datetime,
      rows,
    });
    expect(d.units).toBe("DOLLARS");
    expect(d.source).toBe("schema_x0202");
  });

  it("normalizes both filings to the same ~$11.41B book", () => {
    const a = toUsd(original.tableValueTotal, "THOUSANDS");
    const b = toUsd(amendment.tableValueTotal, "DOLLARS");
    // 11,413,760,000 vs 11,411,017,784 — within 0.03% of each other.
    expect(Math.abs(a - b) / b).toBeLessThan(0.001);
  });

  it("would be 1000x wrong if units were inferred from the PERIOD", () => {
    // Both filings report period 2021-03-31. A period-based rule would call
    // both THOUSANDS and inflate the restatement to $11.4 trillion.
    const wrong = toUsd(amendment.tableValueTotal, "THOUSANDS");
    expect(wrong / toUsd(amendment.tableValueTotal, "DOLLARS")).toBe(1000);
  });
});

describe("implied-price override — the 3.4% the date rule misses", () => {
  // Measured across the current DERA quarterly set (315,211 rows / 2,395
  // filings): 82 filings (3.42%) have a median implied price below $1.00 —
  // they kept reporting in thousands after the 2023-01-03 cutover. Confirmed
  // suspects included medians of $0.057, $0.091 and $0.124.
  it("overrides X0202 to THOUSANDS when the implied price is ~1/1000 of plausible", () => {
    const rows = bookRows(11_413_760, "THOUSANDS", 100);
    const d = decideValueUnits({
      schemaVersion: "X0202",            // the filing CLAIMS dollars
      acceptanceDatetime: "2026-05-15T20:00:00.000Z",
      rows,
    });
    expect(d.units).toBe("THOUSANDS");   // the data says otherwise, and wins
    expect(d.source).toBe("implied_price");
    expect(d.medianImpliedPrice).toBeLessThan(1);
  });

  it("leaves a healthy book alone (measured universe median is $76.39)", () => {
    const rows = bookRows(11_411_017_784, "DOLLARS", 76.39);
    const d = decideValueUnits({
      schemaVersion: "X0202",
      acceptanceDatetime: "2026-05-15T20:00:00.000Z",
      rows,
    });
    expect(d.units).toBe("DOLLARS");
    expect(d.source).toBe("schema_x0202");
    expect(d.medianImpliedPrice).toBeGreaterThan(1);
    expect(d.medianImpliedPrice).toBeLessThan(5000);
    expect(d.quarantine).toBeNull();
  });

  it("quarantines an implausibly high median rather than guessing", () => {
    // A single Berkshire Class A row near $700k is legitimate, so the test is
    // on the MEDIAN across the book, not on any one row.
    const rows = bookRows(1_000_000_000, "DOLLARS", 50_000);
    const d = decideValueUnits({
      schemaVersion: "X0202",
      acceptanceDatetime: "2026-05-15T20:00:00.000Z",
      rows,
    });
    expect(d.quarantine).not.toBeNull();
    expect(d.quarantine.code).toBe("implied_price_implausible");
    // The hypothesis is retained so the data stays usable if a human clears it.
    expect(d.units).toBe("DOLLARS");
  });

  it("falls back to the documented rule when no row can be priced", () => {
    // An all-options or all-PRN book gives the detector nothing to measure.
    const rows = [
      mkRow({ seq: 1, cusip: cusipAt(1), value: 500_000, shares: 5_000, putCall: "Call" }),
      mkRow({ seq: 2, cusip: cusipAt(2), value: 400_000, shares: 4_000, putCall: "Put" }),
    ];
    const d = decideValueUnits({
      schemaVersion: "X0202",
      acceptanceDatetime: "2026-05-15T20:00:00.000Z",
      rows,
    });
    expect(d.medianImpliedPrice).toBeNull();
    expect(d.units).toBe("DOLLARS");
    expect(d.source).toBe("schema_x0202");
  });

  it("treats a pre-cutover filing with no schemaVersion as THOUSANDS", () => {
    const rows = bookRows(330_952_724, "THOUSANDS", 120);
    const d = decideValueUnits({
      schemaVersion: undefined,
      acceptanceDatetime: "2022-02-14T18:00:00.000Z",
      rows,
    });
    expect(d.units).toBe("THOUSANDS");
  });
});

describe("reconcileTotal — parse completeness, NOT units", () => {
  it("passes when the rows sum to the cover page total", () => {
    const rows = bookRows(11_411_017_784, "DOLLARS");
    const r = reconcileTotal(rows, 11_411_017_784);
    expect(r.ok).toBe(true);
    expect(r.delta).toBe(0);
  });

  it("fails on a truncated information table", () => {
    const rows = bookRows(11_411_017_784, "DOLLARS");
    const r = reconcileTotal(rows.slice(0, -1), 11_411_017_784);
    expect(r.ok).toBe(false);
    expect(r.delta).toBeLessThan(0);
  });

  it("CANNOT detect a units error — both sides are in the same units", () => {
    // Documenting the limit deliberately: this assertion catches truncated
    // downloads and namespace mishandling, and it is the implied-price rung
    // that catches a 1000x scale error. Conflating the two would leave a real
    // gap.
    const rows = bookRows(11_413_760, "THOUSANDS");
    expect(reconcileTotal(rows, 11_413_760).ok).toBe(true);
  });

  it("returns ok=null when the filing has no summary total", () => {
    expect(reconcileTotal(bookRows(1000, "DOLLARS"), null).ok).toBeNull();
  });
});
