// tests/aggregate.test.mjs
//
// Duplicate-row aggregation. Measured universe-wide: 142,765 of 760,433
// (accession, cusip, putCall, sshPrnamtType) keys appear more than once — 18.8%
// of all keys. Getting this wrong understates portfolios by up to ~40%, and it
// looks entirely plausible on screen.

import { describe, it, expect } from "vitest";
import {
  aggregateHoldings,
  summarizeHoldings,
  reconcileTotal,
  decideValueUnits,
} from "../scripts/_sec-parse.mjs";
import {
  CANTILLON_Q1_2026,
  cantillonRows,
  optionsHeavyRows,
  cusipAt,
} from "./fixtures.mjs";

describe("Cantillon 2026-Q1 — the canonical reconciliation fixture", () => {
  const rows = cantillonRows();

  it("has 76 rows over 38 distinct CUSIPs, as filed", () => {
    expect(rows).toHaveLength(76);
    expect(new Set(rows.map((r) => r.cusip)).size).toBe(38);
  });

  it("reconciles to the filing's tableValueTotal exactly", () => {
    const r = reconcileTotal(rows, CANTILLON_Q1_2026.tableValueTotal);
    expect(r.ok).toBe(true);
    expect(r.sum).toBe(15_050_978_966);
  });

  it("aggregates 76 rows into 38 holdings, SUMMING the duplicate pairs", () => {
    const held = aggregateHoldings(rows, "DOLLARS");
    expect(held).toHaveLength(38);
    const total = held.reduce((a, h) => a + h.value_usd, 0);
    expect(total).toBe(15_050_978_966);
    // Every position was assembled from exactly two as-filed rows.
    expect(held.every((h) => h.row_count === 2)).toBe(true);
  });

  it("would understate the fund by 38.8% if duplicates were DEDUPED", () => {
    // The failure mode this fixture exists to prevent. `SELECT DISTINCT` or
    // `MAX(value) GROUP BY cusip` keeps only the larger leg of each pair.
    const byCusip = new Map();
    for (const r of rows) {
      const prev = byCusip.get(r.cusip);
      if (!prev || r.value_raw > prev) byCusip.set(r.cusip, r.value_raw);
    }
    const deduped = [...byCusip.values()].reduce((a, v) => a + v, 0);
    expect(deduped).toBe(CANTILLON_Q1_2026.blankManagerTotal);
    const understatement = 1 - deduped / CANTILLON_Q1_2026.tableValueTotal;
    expect(understatement).toBeGreaterThan(0.38);
    expect(understatement).toBeLessThan(0.39);
  });

  it("would invent 76 phantom holdings if other_manager joined the key", () => {
    // The other failure mode: "fixing" the duplicate-key warning by adding
    // other_manager to the grouping key. ci-guards checks for this too, because
    // it is a natural-looking change that doubles every position count.
    const keys = new Set(
      rows.map((r) => `${r.cusip}|${r.put_call ?? ""}|${r.ssh_prnamt_type}|${r.other_manager ?? ""}`),
    );
    expect(keys.size).toBe(76);
    expect(aggregateHoldings(rows, "DOLLARS")).toHaveLength(38);
  });

  it("passes the full ingest gate end to end", () => {
    const decision = decideValueUnits({
      schemaVersion: CANTILLON_Q1_2026.schemaVersion,
      acceptanceDatetime: CANTILLON_Q1_2026.acceptance_datetime,
      rows,
    });
    expect(decision.units).toBe("DOLLARS");
    expect(decision.quarantine).toBeNull();
    const held = aggregateHoldings(rows, decision.units);
    expect(held.reduce((a, h) => a + h.value_usd, 0)).toBe(CANTILLON_Q1_2026.tableValueTotal);
  });
});

describe("options, PRN and zero-value rows", () => {
  const rows = optionsHeavyRows();
  const held = aggregateHoldings(rows, "DOLLARS");

  it("keeps long, call and put legs of one CUSIP as separate positions", () => {
    // Citadel's 68243Q106 really does appear as both an $80,560 Call and a
    // $172,672 Put. Grouping on cusip alone would merge them into a single
    // meaningless number, and ~47% of that fund's rows are options.
    const legs = held.filter((h) => h.cusip === cusipAt(1));
    expect(legs).toHaveLength(3);
    expect(new Set(legs.map((h) => h.put_call))).toEqual(new Set(["", "Call", "Put"]));
  });

  it("sums the duplicated long leg rather than dropping it", () => {
    const long = held.find((h) => h.cusip === cusipAt(1) && h.put_call === "");
    expect(long.value_usd).toBe(1_500_000);
    expect(long.row_count).toBe(2);
  });

  it("computes weight against LONG EQUITY ONLY, never a mixed denominator", () => {
    // Post-2023 filers are inconsistent about whether an option row's value is
    // fair value or underlying notional, and large filers commonly report
    // notional. A denominator that mixes the two inflates the book and deflates
    // every weight by an amount that varies unpredictably per fund.
    const s = summarizeHoldings(held);
    expect(s.value_long_usd).toBe(1_500_000);          // the SH long leg only
    expect(s.value_options_usd).toBe(80_560 + 172_672);
    expect(s.value_prn_usd).toBe(2_000_000);           // debt, held apart

    const long = held.find((h) => h.cusip === cusipAt(1) && h.put_call === "");
    expect(long.weight_pct).toBeCloseTo(100, 6);
  });

  it("does not compute an implied price for PRN rows", () => {
    // sshPrnamt on a PRN row is dollars of face value. value / face is a price
    // per unit of principal, not a share price, and feeding it to the units
    // detector would poison the median.
    const prn = held.find((h) => h.ssh_prnamt_type === "PRN");
    expect(prn.implied_price).toBeNull();
  });

  it("survives a zero-value row without producing NaN or Infinity", () => {
    // 167 of 315,211 measured rows have value = 0.
    const zero = held.find((h) => h.cusip === cusipAt(3));
    expect(zero.value_usd).toBe(0);
    expect(zero.implied_price).toBeNull();
    expect(Number.isFinite(zero.weight_pct)).toBe(true);
    for (const h of held) {
      expect(Number.isNaN(h.weight_pct)).toBe(false);
    }
  });

  it("excludes options and PRN from the long position count", () => {
    const s = summarizeHoldings(held);
    expect(s.positions_options).toBe(2);
    // Long SH rows: the aggregated cusipAt(1) long plus the zero-value row.
    expect(s.positions_long).toBe(2);
  });
});
