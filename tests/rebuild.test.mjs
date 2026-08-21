// tests/rebuild.test.mjs
//
// Rebuilding a fund's summary from the per-fund artifacts already published.
//
// On 2026-08-20 the monthly run wrote its own summaries over the live ones and
// every fund lost the current quarter. mergeSummary stops that recurring; it
// never repaired the damage. 8,295 managers' pages still say "has not filed for
// Q2 2026" while their Q2 book sits in the bucket with nothing pointing at it.
//
// The repair is possible only because the loss was confined to the INDEX — every
// fact a summary carries is still in fund/{cik}/{period}.json. These tests pin
// the derivation, and two of them exist because a round-trip against the live
// site (derive a quarter that is already correct, diff the result) caught real
// regressions before they shipped.

import { describe, it, expect } from "vitest";
import { seriesEntryFrom, insertPeriods } from "../shared/rebuild.mjs";

const artifact = (meta = {}, over = {}) => ({
  period: "2026-06-30",
  cik: "0001279936",
  acceptedAt: "2026-07-29T17:47:53.000Z",
  pages: 1,
  meta: {
    value_long_usd: 665_113_090,
    value_options_usd: 0,
    value_prn_usd: 0,
    positions_total: 27,
    positions_long: 27,
    positions_options: 0,
    top10_weight_pct: 61.738139900388965,
    reportedTotalUsd: 665_113_090,
    n_new: 0, n_added: 0, n_held: 0, n_trimmed: 27, n_exited: 11,
    turnover_position_pct: 33.84615384615385,
    turnover_value_pct: 183.07179449878376,
    priorState: "PRIOR_OK",
    deltasSuppressed: false,
    structuralEvent: null,
    confidentialOmitted: false,
    ...meta,
  },
  ...over,
});

describe("deriving a summary entry from a fund-period artifact", () => {
  it("maps every field the dashboard renders", () => {
    const e = seriesEntryFrom(artifact());
    expect(e).toMatchObject({
      period: "2026-06-30",
      label: "Q2 2026",
      reportedTotalUsd: 665_113_090,
      valueLongUsd: 665_113_090,
      valueOptionsUsd: 0,
      positions: 27,
      positionsLong: 27,
      positionsOptions: 0,
      priorState: "PRIOR_OK",
      confidentialOmitted: false,
      pages: 1,
      acceptedAt: "2026-07-29T17:47:53.000Z",
    });
  });

  it("computes the filing lag in whole days from the quarter end", () => {
    // 30 June to 29 July.
    expect(seriesEntryFrom(artifact()).filingLagDays).toBe(29);
  });

  it("has no field the dashboard reads left undefined", () => {
    // A missing key renders as a blank cell or NaN rather than an error, which
    // is the worst outcome: wrong and silent.
    const e = seriesEntryFrom(artifact());
    for (const [k, v] of Object.entries(e)) expect(v, k).not.toBeUndefined();
    // 23 as published today, plus valuePrnUsd — which the artifacts already
    // carry and the summaries do not, so the repair adds it as a side effect and
    // clears the "within a band" caveat the SEC cross-check reports for Nuveen.
    expect(Object.keys(e)).toHaveLength(24);
    expect(e).toHaveProperty("valuePrnUsd");
  });

  it("survives an artifact with no meta at all", () => {
    const e = seriesEntryFrom({ period: "2026-06-30", meta: undefined, acceptedAt: null });
    expect(e.period).toBe("2026-06-30");
    expect(e.valueLongUsd).toBeNull();
    expect(e.filingLagDays).toBeNull();
  });
});

describe("turnover on a suppressed quarter", () => {
  // CAUGHT BY THE ROUND TRIP, NOT BY REASONING.
  //
  // The two ingest paths disagree: the same-day path withholds turnover when a
  // structural event has made every per-position delta meaningless, and the
  // monthly path publishes it anyway. Cantillon's 2026-Q2 artifact therefore
  // carries turnover_position_pct 33.8% for a quarter whose whole story is that
  // all 27 positions moved by one identical multiplier.
  const suppressed = artifact({ deltasSuppressed: true, structuralEvent: "PRO_RATA_REDUCTION" });

  it("withholds turnover the artifact wrongly kept", () => {
    const e = seriesEntryFrom(suppressed);
    expect(e.turnover_position_pct).toBeNull();
    expect(e.turnover_value_pct).toBeNull();
  });

  it("still carries the event, so the page can explain itself", () => {
    const e = seriesEntryFrom(suppressed);
    expect(e.structuralEvent).toBe("PRO_RATA_REDUCTION");
    expect(e.deltasSuppressed).toBe(true);
  });

  it("publishes turnover normally when nothing is suppressed", () => {
    expect(seriesEntryFrom(artifact()).turnover_position_pct).toBeCloseTo(33.846, 3);
  });
});

describe("inserting recovered quarters", () => {
  const q = (period, over = {}) => ({ period, valueLongUsd: 1, acceptedAt: "x", ...over });

  it("adds the missing quarter", () => {
    const out = insertPeriods([q("2026-03-31")], [q("2026-06-30")]);
    expect(out.map((x) => x.period)).toEqual(["2026-03-31", "2026-06-30"]);
  });

  it("NEVER overwrites a quarter already published", () => {
    // This is what protects the one field the artifacts get wrong. Cantillon's
    // published summary has the acceptance time EDGAR states (17:47:53Z); its
    // period artifact is four hours early. Only-add means the correct value
    // survives and the wrong one is never copied over it.
    const live = q("2026-06-30", { acceptedAt: "2026-07-29T17:47:53.000Z" });
    const derived = q("2026-06-30", { acceptedAt: "2026-07-29T13:47:53.000Z" });
    const out = insertPeriods([live], [derived]);
    expect(out).toHaveLength(1);
    expect(out[0].acceptedAt).toBe("2026-07-29T17:47:53.000Z");
  });

  it("can only ever grow a series", () => {
    const before = [q("2025-12-31"), q("2026-03-31")];
    const out = insertPeriods(before, [q("2026-06-30"), q("2025-09-30")]);
    expect(out.length).toBeGreaterThanOrEqual(before.length);
    expect(out).toHaveLength(4);
  });

  it("preserves an ascending series as ascending", () => {
    const out = insertPeriods([q("2025-12-31"), q("2026-03-31")], [q("2026-06-30")]);
    expect(out.map((x) => x.period)).toEqual(["2025-12-31", "2026-03-31", "2026-06-30"]);
  });

  it("preserves a descending series as descending", () => {
    // The two ingest paths emit opposite directions and the frontend normalises
    // on load. Rewriting 9,268 files into one order would change files that have
    // nothing wrong with them, and every one of those is an upload.
    const out = insertPeriods([q("2026-03-31"), q("2025-12-31")], [q("2026-06-30")]);
    expect(out.map((x) => x.period)).toEqual(["2026-06-30", "2026-03-31", "2025-12-31"]);
  });

  it("is a no-op when there is nothing to recover", () => {
    const before = [q("2026-03-31")];
    expect(insertPeriods(before, [])).toBe(before);
  });

  it("orders correctly when the existing series has a single entry", () => {
    const out = insertPeriods([q("2026-03-31")], [q("2025-12-31")]);
    expect(out.map((x) => x.period)).toEqual(["2025-12-31", "2026-03-31"]);
  });
});
