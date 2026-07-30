// tests/consensus.test.ts
//
// Cross-fund overlap. The two cases below are the ones that produce
// confidently-wrong answers, and both were caught by looking at real data
// rather than by reasoning about the code.

import { describe, it, expect } from "vitest";
import {
  buildConsensus, sortConsensus, overlapDistribution, buildAnchor, dominantAction,
  type FundInput,
} from "../src/lib/consensus";
import type { Holding, Exit } from "../src/lib/data";

const ALPHABET = "i1xxg9gy"; // real issuerId for both GOOG and GOOGL

function h(p: Partial<Holding> & { issuerId: string; value: number }): Holding {
  return {
    ticker: null, name: "ISSUER", issuerId: p.issuerId, cls: null, type: "", unit: "SH",
    value: p.value, shares: p.shares ?? 100, weight: p.weight ?? 1, price: null,
    action: p.action ?? "HELD", dShares: null, dSharesPct: null, dValue: null,
    dValuePct: null, dWeightPp: p.dWeightPp ?? null, flags: null,
    ...p,
  } as Holding;
}

function fund(cik: string, holdings: Holding[], exits: Exit[] = [], opts: Partial<FundInput> = {}): FundInput {
  return {
    cik, name: `Fund ${cik}`, code: cik.slice(-3), color: "#000",
    holdings, exits, suppressed: false, missing: false, ...opts,
  };
}

describe("dominantAction — share classes must not fake a new position", () => {
  // In 2026-Q1 both Berkshire and Bridgewater held Alphabet Class A (ADDED, a
  // large existing position) and opened a small Class C sleeve (NEW). Ranking
  // NEW highest reported that Berkshire newly bought Alphabet, when they
  // already owned $15.6B of it.
  it("does not report NEW when another class was already held", () => {
    expect(dominantAction(["ADDED", "NEW"])).toBe("ADDED");
    expect(dominantAction(["HELD", "NEW"])).toBe("ADDED");
    expect(dominantAction(["TRIMMED", "NEW"])).toBe("HELD");
  });

  it("reports NEW only when every class is new", () => {
    expect(dominantAction(["NEW"])).toBe("NEW");
    expect(dominantAction(["NEW", "NEW"])).toBe("NEW");
  });

  it("reports EXITED only when every class is gone", () => {
    expect(dominantAction(["EXITED", "EXITED"])).toBe("EXITED");
    // Selling one class while keeping another is a reduction, not an exit.
    expect(dominantAction(["EXITED", "HELD"])).toBe("TRIMMED");
  });

  it("returns null when the fund holds nothing", () => {
    expect(dominantAction([])).toBeNull();
    expect(dominantAction([null])).toBeNull();
  });
});

describe("buildConsensus — grouping is per ISSUER, not per share class", () => {
  it("collapses GOOG and GOOGL into one row and sums their value", () => {
    // The failure this prevents: one fund holding GOOG and another holding
    // GOOGL would otherwise show ZERO overlap on Alphabet — the single most
    // misleading answer this widget could give.
    const a = fund("A", [
      h({ issuerId: ALPHABET, ticker: "GOOGL", value: 1000, weight: 6, action: "ADDED" }),
      h({ issuerId: ALPHABET, ticker: "GOOG", value: 200, weight: 1, action: "NEW" }),
    ]);
    const b = fund("B", [h({ issuerId: ALPHABET, ticker: "GOOG", value: 500, weight: 3, action: "HELD" })]);

    const rows = buildConsensus([a, b], { minFunds: 2 });
    expect(rows).toHaveLength(1);
    expect(rows[0].fundCount).toBe(2);
    expect(rows[0].combinedValue).toBe(1700);
    expect(rows[0].shareClasses).toBe(2);
    // Fund A's issuer-level action reflects the existing position, not the sleeve.
    expect(rows[0].cells.A.action).toBe("ADDED");
    expect(rows[0].cells.A.weight).toBe(7);
    expect(rows[0].cells.A.classes.sort()).toEqual(["GOOG", "GOOGL"]);
  });

  it("excludes options from combined value by default", () => {
    // An option row's value is notional. Letting it into a "combined value"
    // would rank a large put alongside real ownership.
    const a = fund("A", [
      h({ issuerId: "x1", value: 100, type: "" }),
      h({ issuerId: "x1", value: 9000, type: "Put" }),
    ]);
    const b = fund("B", [h({ issuerId: "x1", value: 100, type: "" })]);
    expect(buildConsensus([a, b], { minFunds: 2 })[0].combinedValue).toBe(200);
    expect(buildConsensus([a, b], { minFunds: 2, longsOnly: false })[0].combinedValue).toBe(9200);
  });

  it("gives an exited position a cell but does not count it as a holder", () => {
    // Who LEFT is half the anchor, so the cell must render — but a fund that
    // sold out is not a holder.
    const a = fund("A", [h({ issuerId: "x1", value: 100 })]);
    const b = fund("B", [], [{ ticker: "X", name: "X", issuerId: "x1", type: "", valuePrior: 900, weightPrior: 4 }]);
    const rows = buildConsensus([a, b], { minFunds: 1 });
    expect(rows[0].fundCount).toBe(1);
    expect(rows[0].cells.B.action).toBe("EXITED");
    expect(rows[0].nExited).toBe(1);
  });

  it("drops a name nobody holds any more — unless includeExitOnly is set", () => {
    // The bug this pins: when EVERY fund exits a name, the row has zero holders
    // and fails any threshold. That is the single strongest exit signal there
    // is, and it was silently disappearing from the anchor.
    const exit: Exit = { ticker: "Z", name: "Z CORP", issuerId: "gone", type: "", valuePrior: 500, weightPrior: 3 };
    const a = fund("A", [], [exit]);
    const b = fund("B", [], [exit]);

    expect(buildConsensus([a, b], { minFunds: 1 })).toHaveLength(0);

    const kept = buildConsensus([a, b], { minFunds: 1, includeExitOnly: true });
    expect(kept).toHaveLength(1);
    expect(kept[0].fundCount).toBe(0);
    expect(kept[0].nExited).toBe(2);
    expect(buildAnchor([a, b], kept).exits[0].funds).toHaveLength(2);
  });

  it("ignores funds with no filing for the quarter", () => {
    const a = fund("A", [h({ issuerId: "x1", value: 100 })]);
    const b = fund("B", [h({ issuerId: "x1", value: 100 })], [], { missing: true });
    expect(buildConsensus([a, b], { minFunds: 2 })).toHaveLength(0);
  });

  it("honours the minFunds threshold", () => {
    const mk = (cik: string) => fund(cik, [h({ issuerId: "shared", value: 10 })]);
    const solo = fund("D", [h({ issuerId: "solo", value: 10 })]);
    const funds = [mk("A"), mk("B"), mk("C"), solo];
    expect(buildConsensus(funds, { minFunds: 2 }).map((r) => r.issuerId)).toEqual(["shared"]);
    expect(buildConsensus(funds, { minFunds: 4 })).toHaveLength(0);
    expect(buildConsensus(funds, { minFunds: 1 })).toHaveLength(2);
  });
});

describe("sortConsensus", () => {
  const rows = buildConsensus(
    [
      fund("A", [h({ issuerId: "big", value: 1000, action: "TRIMMED" }), h({ issuerId: "small", value: 10, action: "ADDED" })]),
      fund("B", [h({ issuerId: "big", value: 1000, action: "TRIMMED" }), h({ issuerId: "small", value: 10, action: "ADDED" })]),
    ],
    { minFunds: 2 },
  );

  it("sorts by combined value", () => {
    expect(sortConsensus(rows, "value")[0].issuerId).toBe("big");
  });

  it("net-move sort surfaces the most-sold name first", () => {
    // The highest-signal ordering: names the whole group moved the same way.
    // Two funds trimming 'big' is netDirection -2; two adding 'small' is +2.
    expect(sortConsensus(rows, "net")[0].issuerId).toBe("big");
    expect(sortConsensus(rows, "net").at(-1)!.issuerId).toBe("small");
  });
});

describe("buildAnchor — the client's entries and exits", () => {
  it("excludes a fund whose quarter was a structural event, and counts what it withheld", () => {
    // Cantillon's 2026-Q2 pro-rata redemption would otherwise contribute 11
    // fake exits to the group total — precisely the error the per-fund view
    // already refuses to make.
    const normal = fund("A", [h({ issuerId: "x1", value: 100, action: "NEW" })]);
    const flagged = fund(
      "B",
      [h({ issuerId: "x2", value: 5, action: "TRIMMED" })],
      [{ ticker: "Z", name: "Z", issuerId: "x3", type: "", valuePrior: 900, weightPrior: 4 }],
      { suppressed: true },
    );

    // includeExitOnly, as the anchor pass does: 'x3' has zero holders after the
    // exit, so without it the row is filtered out and the withheld move is
    // never even counted.
    const rows = buildConsensus([normal, flagged], { minFunds: 1, includeExitOnly: true });
    const anchor = buildAnchor([normal, flagged], rows);

    expect(anchor.entries.map((e) => e.issuerId)).toEqual(["x1"]);
    expect(anchor.exits).toHaveLength(0);        // the flagged fund's exit is withheld
    expect(anchor.suppressedExits).toBe(1);      // but it is COUNTED, not hidden
    expect(anchor.suppressedFunds).toEqual(["Fund B"]);
  });

  it("ranks entries by how many funds bought the name", () => {
    const mk = (cik: string, id: string) => fund(cik, [h({ issuerId: id, value: 100, action: "NEW" })]);
    const funds = [mk("A", "popular"), mk("B", "popular"), mk("C", "lonely")];
    const rows = buildConsensus(funds, { minFunds: 1 });
    expect(buildAnchor(funds, rows).entries[0].issuerId).toBe("popular");
  });
});

describe("overlapDistribution", () => {
  it("buckets names by holder count", () => {
    const mk = (cik: string, ids: string[]) => fund(cik, ids.map((id) => h({ issuerId: id, value: 10 })));
    const funds = [mk("A", ["all", "two"]), mk("B", ["all", "two"]), mk("C", ["all"])];
    const dist = overlapDistribution(buildConsensus(funds, { minFunds: 1 }), 3);
    expect(dist.find((d) => d.funds === 3)!.names).toBe(1);
    expect(dist.find((d) => d.funds === 2)!.names).toBe(1);
  });
});
