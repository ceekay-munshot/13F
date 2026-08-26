// tests/fold.test.mjs
//
// The amendment fold and quarter-on-quarter change detection.

import { describe, it, expect } from "vitest";
import {
  foldFilings,
  computeChanges,
  detectStructuralEvent,
  computeTurnover,
  summarizeActions,
  PRIOR_STATE,
} from "../shared/fold.mjs";
import { holding, cusipAt } from "./fixtures.mjs";

const r = (cusip, value, shares) => holding({ cusip, value, shares });

describe("foldFilings", () => {
  it("seeds from the original when there are no amendments", () => {
    const { rows, accessions } = foldFilings([
      { accession_number: "A", acceptance_datetime: "2026-05-01T10:00:00Z", is_amendment: false, rows: [r("X", 100, 1)] },
    ]);
    expect(rows).toHaveLength(1);
    expect(accessions).toEqual(["A"]);
  });

  it("NEW HOLDINGS appends — it does not replace", () => {
    // Additive by design: these are entries previously withheld, usually when
    // confidential treatment expires or is denied.
    const { rows } = foldFilings([
      { accession_number: "A", acceptance_datetime: "2026-05-01T10:00:00Z", is_amendment: false, rows: [r("X", 100, 1)] },
      { accession_number: "B", acceptance_datetime: "2026-06-01T10:00:00Z", is_amendment: true, amendment_type: "NEW HOLDINGS", rows: [r("Y", 50, 1)] },
    ]);
    expect(rows.map((h) => h.cusip).sort()).toEqual(["X", "Y"]);
  });

  it("RESTATEMENT replaces the whole set", () => {
    const { rows } = foldFilings([
      { accession_number: "A", acceptance_datetime: "2026-05-01T10:00:00Z", is_amendment: false, rows: [r("X", 100, 1), r("Y", 100, 1)] },
      { accession_number: "B", acceptance_datetime: "2026-06-01T10:00:00Z", is_amendment: true, amendment_type: "RESTATEMENT", rows: [r("Z", 42, 1)] },
    ]);
    expect(rows.map((h) => h.cusip)).toEqual(["Z"]);
  });

  it("a RESTATEMENT arriving AFTER a NEW HOLDINGS wipes it", () => {
    // The reason the fold must be an ordered left fold rather than a
    // per-amendment classification: you cannot decide what a single amendment
    // means without knowing what came after it.
    const { rows } = foldFilings([
      { accession_number: "A", acceptance_datetime: "2026-05-01T10:00:00Z", is_amendment: false, rows: [r("X", 100, 1)] },
      { accession_number: "B", acceptance_datetime: "2026-06-01T10:00:00Z", is_amendment: true, amendment_type: "NEW HOLDINGS", rows: [r("Y", 50, 1)] },
      { accession_number: "C", acceptance_datetime: "2026-07-01T10:00:00Z", is_amendment: true, amendment_type: "RESTATEMENT", rows: [r("Z", 42, 1)] },
    ]);
    expect(rows.map((h) => h.cusip)).toEqual(["Z"]);
  });

  it("orders by acceptance time, not by input order", () => {
    // Amendments arrive arbitrarily late — Jefferies amended 2021-Q1 in
    // September 2023, ~29 months on — so input order means nothing.
    const { rows } = foldFilings([
      { accession_number: "C", acceptance_datetime: "2026-07-01T10:00:00Z", is_amendment: true, amendment_type: "RESTATEMENT", rows: [r("Z", 42, 1)] },
      { accession_number: "A", acceptance_datetime: "2026-05-01T10:00:00Z", is_amendment: false, rows: [r("X", 100, 1)] },
      { accession_number: "B", acceptance_datetime: "2026-06-01T10:00:00Z", is_amendment: true, amendment_type: "NEW HOLDINGS", rows: [r("Y", 50, 1)] },
    ]);
    expect(rows.map((h) => h.cusip)).toEqual(["Z"]);
  });

  it("warns when two filings share an acceptance timestamp", () => {
    // Cantillon filed three restatements on one day (2026-02-17), so same-day
    // amendments are real. The DERA bulk set has FILING_DATE but no acceptance
    // time at all, which is why ordering must come from the submissions API.
    const { warnings } = foldFilings([
      { accession_number: "A", acceptance_datetime: "2026-02-17T15:00:00Z", is_amendment: false, rows: [] },
      { accession_number: "B", acceptance_datetime: "2026-02-17T15:00:00Z", is_amendment: true, amendment_type: "RESTATEMENT", rows: [] },
    ]);
    expect(warnings.map((w) => w.code)).toContain("fold_tie");
  });

  it("warns, and assumes RESTATEMENT, when amendment_type is missing", () => {
    const { rows, warnings } = foldFilings([
      { accession_number: "A", acceptance_datetime: "2026-05-01T10:00:00Z", is_amendment: false, rows: [r("X", 100, 1)] },
      { accession_number: "B", acceptance_datetime: "2026-06-01T10:00:00Z", is_amendment: true, amendment_type: null, rows: [r("Y", 50, 1)] },
    ]);
    expect(rows.map((h) => h.cusip)).toEqual(["Y"]);
    expect(warnings.map((w) => w.code)).toContain("amendment_type_missing");
  });

  it("warns when the earliest filing for a period is an amendment", () => {
    const { warnings } = foldFilings([
      { accession_number: "B", acceptance_datetime: "2026-06-01T10:00:00Z", is_amendment: true, amendment_type: "NEW HOLDINGS", rows: [r("Y", 50, 1)] },
    ]);
    expect(warnings.map((w) => w.code)).toContain("origin_missing");
  });
});

// ---------------------------------------------------------------------------
// The Cantillon case — the reference site rendered "-95.40%" on 22 of 27 rows
// as 22 independent sells. Computed from the primary filings, the share ratio
// Q2/Q1 for 22 of the 27 retained positions falls in [0.04600, 0.04605] —
// identical to four significant figures, 16 of them at exactly 0.04605.
// ---------------------------------------------------------------------------
describe("PRO_RATA_REDUCTION — the trust-defining detector", () => {
  const RATIO = 0.04605;

  function cantillonPair() {
    const priorHoldings = [];
    for (let i = 0; i < 38; i++) priorHoldings.push(holding({ cusip: cusipAt(i), value: 400_000_000, shares: 4_000_000, weight: 100 / 38 }));

    const currentHoldings = [];
    for (let i = 0; i < 22; i++) {
      currentHoldings.push(holding({ cusip: cusipAt(i), value: Math.round(400_000_000 * RATIO), shares: Math.round(4_000_000 * RATIO), weight: 100 / 27 }));
    }
    // Five positions that moved differently — the detector must survive them.
    [0.2, 0.5, 0.8, 1.0, 1.5].forEach((f, k) => {
      const i = 22 + k;
      currentHoldings.push(holding({ cusip: cusipAt(i), value: Math.round(400_000_000 * f), shares: Math.round(4_000_000 * f), weight: 100 / 27 }));
    });

    return {
      prior: { period_end: "2026-03-31", accession: "0001279936-26-000004", holdings: priorHoldings, value_long_usd: 15_050_978_966 },
      current: { period_end: "2026-06-30", holdings: currentHoldings, value_long_usd: 665_113_090 },
    };
  }

  it("fires on a uniform multiplier across retained positions", () => {
    const { current, prior } = cantillonPair();
    const s = detectStructuralEvent(current, prior);
    expect(s.event).toBe("PRO_RATA_REDUCTION");
    expect(s.detail.retained).toBe(27);
    expect(s.detail.reductionPct).toBeCloseTo(95.4, 1);
    expect(s.detail.message).toMatch(/not 27 separate trades/);
  });

  it("uses IQR, so five genuine outliers do not mask the pattern", () => {
    // Standard deviation would be dragged upward by the 1.5x position and the
    // detector would miss. IQR ignores the tails, which is the whole point.
    const { current, prior } = cantillonPair();
    const s = detectStructuralEvent(current, prior);
    expect(s.detail.iqr).toBeLessThan(0.02 * s.detail.medianRatio);
  });

  it("SUPPRESSES every per-row delta rather than showing -95.40%", () => {
    const { current, prior } = cantillonPair();
    const { changes, suppressed, reason } = computeChanges(current, prior, PRIOR_STATE.OK);
    expect(suppressed).toBe(true);
    expect(reason).toBe("PRO_RATA_REDUCTION");
    expect(changes.every((c) => c.d_shares_pct === null)).toBe(true);
    expect(changes.every((c) => c.d_weight_pp === null)).toBe(true);
    expect(changes.every((c) => c.d_value_pct === null)).toBe(true);
    // The holdings themselves are still reported — only the misleading deltas
    // are withheld.
    expect(changes.filter((c) => c.action !== "EXITED")).toHaveLength(27);
  });

  it("withholds the ABSOLUTE deltas too, not just the percentages", () => {
    // Only the three percentage fields were nulled, so `d_value` and `d_shares`
    // were published beside them — and the Position changes card's "Δ Value"
    // toggle ranked by exactly those. The same misleading comparison the
    // percentage was hidden for, in dollars instead: the whole 95.4% redemption
    // laid out as 27 individual sells.
    const { current, prior } = cantillonPair();
    const { changes } = computeChanges(current, prior, PRIOR_STATE.OK);
    const retained = changes.filter((c) => c.action !== "EXITED");
    expect(retained.every((c) => c.d_value === null)).toBe(true);
    expect(retained.every((c) => c.d_shares === null)).toBe(true);
  });

  it("but an EXIT keeps its size, because -100% of a gone position is exact", () => {
    // The suppression is about a MULTIPLIER applied to positions that survived:
    // "-95.4%" reads as a decision about that holding when it was one event
    // across the book. A position absent from the new filing is simply gone, and
    // "sold out of" is the client's stated anchor — withholding it would hide a
    // fact rather than a misleading inference.
    const { current, prior } = cantillonPair();
    const { changes } = computeChanges(current, prior, PRIOR_STATE.OK);
    const exits = changes.filter((c) => c.action === "EXITED");
    expect(exits.length).toBeGreaterThan(0);
    expect(exits.every((c) => c.d_value === -c.value_prior)).toBe(true);
  });

  it("keeps the DIRECTION, because that part is a fact", () => {
    // A position genuinely was trimmed; what is unsound is the size of the move,
    // not that it happened. Nulling the action too would hide the event itself.
    const { current, prior } = cantillonPair();
    const { changes } = computeChanges(current, prior, PRIOR_STATE.OK);
    expect(changes.filter((c) => c.action === "TRIMMED").length).toBeGreaterThan(0);
    expect(changes.every((c) => c.value_now != null)).toBe(true);
  });

  it("does NOT fire when positions moved independently", () => {
    // False positives would be their own kind of wrong. A book where every
    // position moved by a different amount is ordinary trading.
    const priorHoldings = [];
    const currentHoldings = [];
    for (let i = 0; i < 20; i++) {
      priorHoldings.push(holding({ cusip: cusipAt(i), value: 1_000_000, shares: 10_000, weight: 5 }));
      const f = 0.5 + i * 0.05;
      currentHoldings.push(holding({ cusip: cusipAt(i), value: Math.round(1_000_000 * f), shares: Math.round(10_000 * f), weight: 5 }));
    }
    const s = detectStructuralEvent(
      { period_end: "2026-06-30", holdings: currentHoldings, value_long_usd: 20_000_000 },
      { period_end: "2026-03-31", holdings: priorHoldings, value_long_usd: 20_000_000 },
    );
    expect(s.event).toBeNull();
  });
});

describe("UNIT_SCALE_CHANGE", () => {
  it("catches a late amendment that restated thousands into dollars", () => {
    const mk = (v) => ({ period_end: "x", holdings: [holding({ cusip: "A", value: v, shares: 100 })], value_long_usd: v });
    const s = detectStructuralEvent(mk(11_411_017_784), mk(11_413_760));
    expect(s.event).toBe("UNIT_SCALE_CHANGE");
    expect(s.detail.message).toMatch(/not a trade/);
  });
});

describe("prior-quarter states", () => {
  const current = { period_end: "2026-06-30", holdings: [holding({ cusip: "A", value: 100, shares: 1 })], value_long_usd: 100 };

  // 29% of all 13F filings are notices with no information table at all —
  // 740 of the 2,552 filed on 2026-05-15. "We can't compute changes because
  // this manager filed a 13F Notice last quarter" is a correct answer;
  // "1 new position" is not.
  for (const state of [PRIOR_STATE.IS_NT, PRIOR_STATE.MISSING, PRIOR_STATE.NONE]) {
    it(`emits no deltas for ${state}`, () => {
      const out = computeChanges(current, null, state);
      expect(out.changes).toHaveLength(0);
      expect(out.suppressed).toBe(true);
      expect(out.reason).toBe(state);
    });

    // --------------------------------------------------------------------
    // ...and does NOT call that a structural event.
    //
    // These are two different questions sharing one answer slot until now:
    // "why are there no deltas?" (reason — may be a coverage fact) versus
    // "is something wrong with this portfolio's numbers?" (structuralEvent —
    // always a warning). Both ingest paths published `suppressed ? reason`
    // into structuralEvent, so an ordinary first-covered quarter shipped
    // structuralEvent: "NO_PRIOR" and the Fund view painted it amber.
    // Measured on the live tree: 16,414 NO_PRIOR + 169 PRIOR_IS_NT against
    // 41 real PRO_RATA_REDUCTIONs — a warning channel that was 99.8% noise.
    // --------------------------------------------------------------------
    it(`does not report ${state} as a structural event`, () => {
      const out = computeChanges(current, null, state);
      expect(out.structuralEvent).toBeNull();
      expect(out.structural).toBeNull();
    });
  }
});

describe("structuralEvent has a closed domain", () => {
  // Anything published in this field must be a structural finding. If a new
  // PRIOR_STATE code is added and leaks in, this fails.
  const STRUCTURAL_CODES = new Set(["PRO_RATA_REDUCTION", "UNIT_SCALE_CHANGE", "REVIEW"]);

  const mk = (holdings, value) => ({ period_end: "2026-06-30", accession: "a", holdings, value_long_usd: value });
  // ssh_prnamt_type MUST be "SH": the uniform-ratio detector only counts share
  // rows, because a PRN row is a principal amount and its ratio means something
  // else entirely. Omitting it makes the pro-rata branch see zero ratios and
  // fall through to the magnitude catch-all.
  const h = (cusip, shares, value) => ({
    cusip, put_call: null, ssh_prnamt: shares, ssh_prnamt_type: "SH", value_usd: value, weight_pct: 1,
  });

  it("is null when nothing structural happened", () => {
    const prior = mk([h("A", 100, 1000), h("B", 200, 2000)], 3000);
    const current = mk([h("A", 110, 1100), h("B", 190, 1900)], 3000);
    const out = computeChanges(current, prior, PRIOR_STATE.OK);
    expect(out.structuralEvent).toBeNull();
    expect(out.suppressed).toBe(false);
  });

  it("emits PRO_RATA_REDUCTION and suppresses on a uniform multiplier", () => {
    // The Cantillon signature and the reason this detector exists: every
    // retained position moved by an identical ratio.
    const prior = mk(Array.from({ length: 8 }, (_, i) => h(`C${i}`, 1000, 10000)), 80000);
    const current = mk(Array.from({ length: 8 }, (_, i) => h(`C${i}`, 46, 460)), 3680);
    const out = computeChanges(current, prior, PRIOR_STATE.OK);
    expect(out.structuralEvent).toBe("PRO_RATA_REDUCTION");
    expect(STRUCTURAL_CODES.has(out.structuralEvent)).toBe(true);
    expect(out.suppressed).toBe(true);
  });

  it("publishes REVIEW even though it does not suppress deltas", () => {
    // REVIEW means "this book changed shape too much for position-level deltas
    // to describe" — a genuine warning worth amber. It was previously
    // unreachable in the published field, because that field was written as
    // `suppressed ? reason : null` and REVIEW deliberately does not suppress.
    const prior = mk([h("A", 100, 100000), h("B", 100, 100000)], 200000);
    const current = mk([h("A", 100, 1000)], 1000); // -99.5% value, half the positions
    const out = computeChanges(current, prior, PRIOR_STATE.OK);
    expect(out.structuralEvent).toBe("REVIEW");
    expect(out.suppressed).toBe(false);
  });

  for (const state of [PRIOR_STATE.IS_NT, PRIOR_STATE.MISSING, PRIOR_STATE.NONE, PRIOR_STATE.OK]) {
    it(`never publishes the PRIOR_STATE token ${state}`, () => {
      const out = computeChanges(mk([h("A", 1, 1)], 1), null, state === PRIOR_STATE.OK ? PRIOR_STATE.NONE : state);
      expect(out.structuralEvent).not.toBe(state);
      if (out.structuralEvent !== null) expect(STRUCTURAL_CODES.has(out.structuralEvent)).toBe(true);
    });
  }
});

describe("computeChanges", () => {
  const prior = {
    period_end: "2026-03-31",
    accession: "0000000000-26-000001",
    value_long_usd: 300,
    holdings: [
      holding({ cusip: "A", value: 100, shares: 100, weight: 33.33 }),
      holding({ cusip: "B", value: 100, shares: 100, weight: 33.33 }),
      holding({ cusip: "C", value: 100, shares: 100, weight: 33.33 }),
    ],
  };
  const current = {
    period_end: "2026-06-30",
    value_long_usd: 340,
    holdings: [
      holding({ cusip: "A", value: 150, shares: 150, weight: 44.1 }),  // added
      holding({ cusip: "B", value: 90, shares: 90, weight: 26.5 }),    // trimmed
      holding({ cusip: "D", value: 100, shares: 100, weight: 29.4 }),  // new
    ],
  };

  const { changes } = computeChanges(current, prior, PRIOR_STATE.OK);
  const by = (c) => changes.find((x) => x.cusip === c);

  it("classifies added / trimmed / new / exited", () => {
    expect(by("A").action).toBe("ADDED");
    expect(by("B").action).toBe("TRIMMED");
    expect(by("D").action).toBe("NEW");
    expect(by("C").action).toBe("EXITED");
  });

  it("reports weight change in PERCENTAGE POINTS", () => {
    // +10.77pp, not "+32%". The unit does the work the label can't.
    expect(by("A").d_weight_pp).toBeCloseTo(44.1 - 33.33, 2);
  });

  it("carries the prior filing's identity on EVERY row — the provenance lock", () => {
    // This is what makes it structurally impossible to show a header stat and a
    // row delta computed against different quarters, which is exactly the bug
    // that put Q1's position count next to Q4's portfolio value on a reference
    // site's Cantillon page.
    for (const c of changes) {
      expect(c.prior_period).toBe("2026-03-31");
      expect(c.prior_accession).toBe("0000000000-26-000001");
    }
  });

  it("marks an exit as a full -100% with zero current value", () => {
    expect(by("C").value_now).toBe(0);
    expect(by("C").d_value_pct).toBe(-100);
    expect(by("C").d_weight_pp).toBeCloseTo(-33.33, 2);
  });
});

describe("SUSPECTED_SPLIT", () => {
  it("suppresses the share delta on a 4:1 split rather than showing +300%", () => {
    const prior = { period_end: "2026-03-31", value_long_usd: 1000, holdings: [holding({ cusip: "A", value: 1000, shares: 1000, weight: 100 })] };
    const current = { period_end: "2026-06-30", value_long_usd: 1020, holdings: [holding({ cusip: "A", value: 1020, shares: 4000, weight: 100 })] };
    const { changes } = computeChanges(current, prior, PRIOR_STATE.OK);
    // Shares quadrupled while value barely moved — that is a split, not a buy.
    expect(changes[0].flags).toContain("SUSPECTED_SPLIT");
    expect(changes[0].d_shares_pct).toBeNull();
    // The value delta is still meaningful and is NOT suppressed.
    expect(changes[0].d_value_pct).toBeCloseTo(2, 5);
  });

  it("does not fire when shares AND value both quadruple (a real purchase)", () => {
    const prior = { period_end: "2026-03-31", value_long_usd: 1000, holdings: [holding({ cusip: "A", value: 1000, shares: 1000, weight: 100 })] };
    const current = { period_end: "2026-06-30", value_long_usd: 4000, holdings: [holding({ cusip: "A", value: 4000, shares: 4000, weight: 100 })] };
    const { changes } = computeChanges(current, prior, PRIOR_STATE.OK);
    expect(changes[0].flags).toBeNull();
    expect(changes[0].d_shares_pct).toBeCloseTo(300, 5);
  });
});

describe("turnover — both definitions, because they legitimately disagree", () => {
  it("computes position and value turnover separately", () => {
    const prior = { period_end: "2026-03-31", value_long_usd: 300, holdings: [holding({ cusip: "A", value: 100, shares: 100 }), holding({ cusip: "B", value: 100, shares: 100 }), holding({ cusip: "C", value: 100, shares: 100 })] };
    const current = { period_end: "2026-06-30", value_long_usd: 340, holdings: [holding({ cusip: "A", value: 150, shares: 150 }), holding({ cusip: "B", value: 90, shares: 90 }), holding({ cusip: "D", value: 100, shares: 100 })] };
    const { changes } = computeChanges(current, prior, PRIOR_STATE.OK);

    const t = computeTurnover(changes, current, prior);
    // 1 entry + 1 exit over 3 + 3 positions.
    expect(t.turnover_position_pct).toBeCloseTo((2 / 6) * 200, 5);
    expect(t.turnover_value_pct).toBeGreaterThan(0);
    // The two numbers differ — which is precisely why the UI must label each
    // and never render an unexplained "Turnover: 34%".
    expect(t.turnover_position_pct).not.toBeCloseTo(t.turnover_value_pct, 1);

    expect(summarizeActions(changes)).toEqual({ n_new: 1, n_added: 1, n_held: 0, n_trimmed: 1, n_exited: 1 });
  });
});

describe("PRO_RATA_REDUCTION — magnitude must not gate the detector", () => {
  // Found from a real screenshot: Cantillon's 2026-Q1 filing shows an identical
  // -11.9% across ~30 of 38 positions. An earlier version required
  // `median < 0.5` — tuned to the dramatic ~95% case — and so rendered this as
  // 30 independent sells. Thirty positions do not move by the same percentage
  // to four significant figures by coincidence, at ANY magnitude.
  const uniform = (ratio, n) => {
    const prior = [];
    const current = [];
    for (let i = 0; i < n; i++) {
      prior.push(holding({ cusip: cusipAt(i), value: 1_000_000, shares: 100_000, weight: 100 / n }));
      current.push(holding({
        cusip: cusipAt(i),
        value: Math.round(1_000_000 * ratio),
        shares: Math.round(100_000 * ratio),
        weight: 100 / n,
      }));
    }
    return {
      current: { period_end: "2026-03-31", holdings: current, value_long_usd: 1_000_000 * n * ratio },
      prior: { period_end: "2025-12-31", holdings: prior, value_long_usd: 1_000_000 * n },
    };
  };

  it("fires on a modest uniform reduction (-11.9%), not just a drastic one", () => {
    const { current, prior } = uniform(0.881, 30);
    const s = detectStructuralEvent(current, prior);
    expect(s.event).toBe("PRO_RATA_REDUCTION");
    expect(s.detail.reductionPct).toBeCloseTo(11.9, 1);
    expect(s.detail.message).toMatch(/reduced by an identical/);
  });

  it("fires on a uniform INCREASE too — a subscription is also not N trades", () => {
    const { current, prior } = uniform(1.15, 20);
    const s = detectStructuralEvent(current, prior);
    expect(s.event).toBe("PRO_RATA_REDUCTION");
    expect(s.detail.message).toMatch(/increased by an identical/);
  });

  it("still fires on the drastic case", () => {
    const { current, prior } = uniform(0.04605, 27);
    expect(detectStructuralEvent(current, prior).event).toBe("PRO_RATA_REDUCTION");
  });

  it("does NOT fire when nothing moved — a flat book is not a structural event", () => {
    const { current, prior } = uniform(1.0, 30);
    expect(detectStructuralEvent(current, prior).event).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Confidential omission.
//
// This was the one gate on the plan's list with LITERALLY zero coverage: the
// flag was parsed on both ingest paths and carried into meta, the rule was
// written out in a comment in _sec-parse.mjs, and nothing implemented it. Nine
// fund-periods in the shipped tree set the flag.
//
// The rule: a manager may request confidential treatment for positions they are
// still building and file without them. Those positions are absent from the
// filing and present in the portfolio. An exit is INFERRED FROM ABSENCE, so on
// such a quarter the inference is unsound — reporting "EXITED, -100%" asserts
// as fact the very thing the filing declines to say.
// ---------------------------------------------------------------------------
describe("confidential omission suppresses inferred exits", () => {
  const h = (cusip, shares, value, weight) => ({
    cusip, put_call: null, ssh_prnamt: shares, ssh_prnamt_type: "SH",
    value_usd: value, weight_pct: weight, name_of_issuer: `ISSUER ${cusip}`,
  });
  const prior = {
    period_end: "2026-03-31", accession: "0000000000-26-000001",
    holdings: [h("A", 100, 1000, 50), h("B", 100, 1000, 50)],
    value_long_usd: 2000,
  };
  // B is gone. Sold, or withheld? The filing alone cannot say.
  const current = { period_end: "2026-06-30", holdings: [h("A", 100, 1000, 100)], value_long_usd: 1000 };

  it("reports the exit normally on an ordinary complete filing", () => {
    const out = computeChanges(current, prior, PRIOR_STATE.OK);
    const exits = out.changes.filter((c) => c.action === "EXITED");
    expect(exits).toHaveLength(1);
    expect(exits[0].cusip).toBe("B");
    expect(exits[0].d_value_pct).toBe(-100);
    expect(out.exitsWithheld).toBe(0);
  });

  it("emits NO exit rows when the filing withholds positions", () => {
    const out = computeChanges(current, prior, PRIOR_STATE.OK, { confidentialOmitted: true });
    expect(out.changes.filter((c) => c.action === "EXITED")).toHaveLength(0);
  });

  it("counts what it withheld, so the UI can say so rather than show a short list", () => {
    // Silence is its own wrong answer: an empty exits card reads as "they sold
    // nothing", which is no more true than "they sold everything".
    const out = computeChanges(current, prior, PRIOR_STATE.OK, { confidentialOmitted: true });
    expect(out.exitsWithheld).toBe(1);
  });

  it("still reports positions that ARE disclosed", () => {
    // Suppression is scoped to the unsound inference. A position present in
    // both filings is reported honestly.
    const grew = { period_end: "2026-06-30", holdings: [h("A", 150, 1500, 100)], value_long_usd: 1500 };
    const out = computeChanges(grew, prior, PRIOR_STATE.OK, { confidentialOmitted: true });
    const a = out.changes.find((c) => c.cusip === "A");
    expect(a.action).toBe("ADDED");
    expect(a.d_shares).toBe(50);
  });

  it("does not invent exits to withhold when nothing left the book", () => {
    const same = { period_end: "2026-06-30", holdings: prior.holdings, value_long_usd: 2000 };
    const out = computeChanges(same, prior, PRIOR_STATE.OK, { confidentialOmitted: true });
    expect(out.exitsWithheld).toBe(0);
  });

  it("defaults to reporting exits when the flag is absent", () => {
    // Back-compat: every existing caller passes three arguments.
    expect(computeChanges(current, prior, PRIOR_STATE.OK).exitsWithheld).toBe(0);
    expect(computeChanges(current, prior, PRIOR_STATE.OK, {}).changes.some((c) => c.action === "EXITED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// An exit record has to carry enough to tell a share from a bond. put_call is
// empty for BOTH exited common stock and an exited convertible note, so a view
// filtered to long equity kept the note — 1.3% of the corpus is PRN, so this is
// a real population rather than a hypothetical.
// ---------------------------------------------------------------------------
describe("exits carry the reporting unit", () => {
  const row = (cusip, unit) => ({
    cusip, put_call: "", ssh_prnamt: 100, ssh_prnamt_type: unit,
    value_usd: 1000, weight_pct: 25, name_of_issuer: `ISSUER ${cusip}`,
  });
  const prior = {
    period_end: "2026-03-31", accession: "0000000000-26-000001",
    holdings: [row("EQ", "SH"), row("BOND", "PRN"), row("KEEP", "SH")],
    value_long_usd: 3000,
  };
  const current = { period_end: "2026-06-30", holdings: [row("KEEP", "SH")], value_long_usd: 1000 };

  it("distinguishes an exited bond from an exited share", () => {
    const exits = computeChanges(current, prior, PRIOR_STATE.OK).changes.filter((c) => c.action === "EXITED");
    expect(exits.map((e) => e.cusip).sort()).toEqual(["BOND", "EQ"]);
    expect(exits.find((e) => e.cusip === "EQ").ssh_prnamt_type).toBe("SH");
    expect(exits.find((e) => e.cusip === "BOND").ssh_prnamt_type).toBe("PRN");
    // Both look identical on put_call alone — which is exactly why the unit
    // has to travel with the record.
    expect(exits.every((e) => e.put_call === "")).toBe(true);
  });

  it("emits null rather than guessing when the prior row has no unit", () => {
    const noUnit = {
      ...prior,
      holdings: [{ ...row("EQ", "SH"), ssh_prnamt_type: undefined }, row("KEEP", "SH")],
    };
    const exits = computeChanges(current, noUnit, PRIOR_STATE.OK).changes.filter((c) => c.action === "EXITED");
    expect(exits[0].ssh_prnamt_type).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE REPORTED TOTAL IS FOLDED TOO.
//
// It used to be read off `foldable[foldable.length - 1]` in the caller — the
// last element of the INPUT array. The submissions API returns filings
// newest-first, so for every amended period that picked the OLDEST filing: the
// original the amendment exists to supersede. Verified live against Berkshire's
// 2025-03-31 and Cantillon's three 2026-02-17 restatements.
// ---------------------------------------------------------------------------
describe("foldFilings — the cover-page total", () => {
  const f = (accession, accepted, over = {}) => ({
    accession_number: accession,
    acceptance_datetime: accepted,
    is_amendment: false,
    amendment_type: null,
    table_value_total: 100,
    rows: [],
    ...over,
  });

  it("takes the restatement's total, whatever order the array arrived in", () => {
    // Newest-first, exactly as the submissions API hands them over.
    const filings = [
      f("a-2", "2026-02-17T12:00:00Z", { is_amendment: true, amendment_type: "RESTATEMENT", table_value_total: 250 }),
      f("a-1", "2025-10-30T12:00:00Z", { table_value_total: 999 }),
    ];
    expect(foldFilings(filings).reportedTotalUsd).toBe(250);
  });

  it("adds a NEW HOLDINGS amendment rather than replacing with it", () => {
    // Its cover total covers only the entries it adds, so the period's total is
    // the original plus the addition — the same rule the rows follow.
    const filings = [
      f("a-2", "2026-02-17T12:00:00Z", { is_amendment: true, amendment_type: "NEW HOLDINGS", table_value_total: 40 }),
      f("a-1", "2025-10-30T12:00:00Z", { table_value_total: 1000 }),
    ];
    expect(foldFilings(filings).reportedTotalUsd).toBe(1040);
  });

  it("lets a later restatement wipe an earlier addition, as the rows do", () => {
    const filings = [
      f("a-1", "2025-10-30T12:00:00Z", { table_value_total: 1000 }),
      f("a-2", "2025-11-30T12:00:00Z", { is_amendment: true, amendment_type: "NEW HOLDINGS", table_value_total: 40 }),
      f("a-3", "2026-02-17T12:00:00Z", { is_amendment: true, amendment_type: "RESTATEMENT", table_value_total: 900 }),
    ];
    expect(foldFilings(filings).reportedTotalUsd).toBe(900);
  });

  it("ignores a filing with no cover total instead of nulling the period", () => {
    const filings = [
      f("a-2", "2026-02-17T12:00:00Z", { is_amendment: true, amendment_type: "RESTATEMENT", table_value_total: null }),
      f("a-1", "2025-10-30T12:00:00Z", { table_value_total: 1000 }),
    ];
    expect(foldFilings(filings).reportedTotalUsd).toBe(1000);
  });

  it("is null when nothing reported one", () => {
    expect(foldFilings([f("a-1", "2025-10-30T12:00:00Z", { table_value_total: null })]).reportedTotalUsd).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE FORM CHANGED, NOT THE PORTFOLIO
// ---------------------------------------------------------------------------
//
// The second piece of evidence the pro-rata detector was missing. A cover page
// lists the other managers whose positions are included in the filing; when that
// list moves, the book moves with it, and nobody traded.
//
// Measured case, and the reason this exists: Pershing Square Inc. filed one
// position worth $0.57B for 2026-Q1 naming no other managers, then fourteen
// positions worth $19.47B for 2026-Q2 naming six — its operating manager among
// them, which filed a notice that quarter pointing back at it. Read as trading
// that is "13 bought, 173% turnover". Nothing was bought.
describe("a change in the managers included on the filing", () => {
  const mgr = (cik, name) => ({ cik, name });
  const book = (n, each) =>
    Array.from({ length: n }, (_, i) => holding({ cusip: cusipAt(i), value: each, shares: 10_000, weight: 100 / n }));

  // Q1: one position, no other managers. Q2: fourteen, six managers.
  const priorQ = {
    period_end: "2026-03-31",
    holdings: book(1, 569_340_000),
    value_long_usd: 569_340_000,
    includedManagers: [],
  };
  const currentQ = {
    period_end: "2026-06-30",
    holdings: book(14, 1_390_406_626),
    value_long_usd: 19_465_692_772,
    includedManagers: [
      mgr("0001336528", "Pershing Square Capital Management, L.P."),
      mgr("0001336477", "PSCM GP, LLC"),
      mgr("0002129159", "Pershing Square Partner Group LLC"),
      mgr("0002027456", "Pershing Square Management, LLC"),
      mgr("0002129160", "Pershing Square PSUS Holdings, LLC"),
      mgr("0002131683", "Pershing Square HHH Holdings, LLC"),
    ],
  };

  it("is named specifically, rather than falling through to the vague catch-all", () => {
    // Without this rule the magnitude check fires and says only "the book moved
    // 3319%, changes may not reflect trading" — true, unhelpful, and it keeps
    // the deltas.
    const s = detectStructuralEvent(currentQ, priorQ);
    expect(s.event).toBe("MANAGER_SET_CHANGED");
    expect(s.detail.direction).toBe("gained");
    expect(s.detail.managersGained).toBe(6);
    expect(s.detail.message).toMatch(/not purchases/);
  });

  it("withholds the BUY/SELL LABEL, not only the numbers", () => {
    // The distinction from a pro-rata reduction. There the direction is true and
    // only the magnitude misleads, so TRIMMED stays. Here "NEW" is itself the
    // false claim — it is the word this dashboard uses for "they bought it".
    const { changes, suppressed, structuralEvent } = computeChanges(currentQ, priorQ, PRIOR_STATE.OK);
    expect(structuralEvent).toBe("MANAGER_SET_CHANGED");
    expect(suppressed).toBe(true);
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) {
      expect(c.action).toBeNull();
      expect(c.d_shares).toBeNull();
      expect(c.d_value).toBeNull();
      expect(c.d_value_pct).toBeNull();
      expect(c.d_weight_pp).toBeNull();
    }
    // And therefore the quarter counts none of them as purchases.
    expect(summarizeActions(changes)).toEqual({ n_new: 0, n_added: 0, n_held: 0, n_trimmed: 0, n_exited: 0 });
  });

  it("withholds exits when managers were dropped, and counts them instead", () => {
    // The same inference failing from the other end: a position absent from this
    // form may simply be on somebody else's now. "EXITED, -100%" is the same
    // fabricated sell, arriving backwards.
    const before = { ...currentQ, period_end: "2026-03-31" };
    const after = {
      period_end: "2026-06-30",
      holdings: book(1, 569_340_000),
      value_long_usd: 569_340_000,
      includedManagers: [],
    };
    const { changes, exitsWithheld, structuralEvent } = computeChanges(after, before, PRIOR_STATE.OK);
    expect(structuralEvent).toBe("MANAGER_SET_CHANGED");
    expect(exitsWithheld).toBe(13);
    expect(changes.filter((c) => c.action === "EXITED")).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The guards. A detector that fires too easily is worse than none: it hides
  // real trading behind "cannot be compared".
  // -------------------------------------------------------------------------

  it("does NOT fire when the manager list changed but the book did not", () => {
    // Routine churn in a large family's filings. Nothing about the portfolio
    // changed, so there is nothing to withhold.
    const s = detectStructuralEvent(
      { ...currentQ, holdings: book(14, 1_000_000), value_long_usd: 14_000_000 },
      { ...priorQ, holdings: book(14, 1_000_000), value_long_usd: 14_000_000, includedManagers: [mgr("0000000001", "A")] },
    );
    expect(s.event).toBeNull();
  });

  it("does NOT fire when the book jumped but the managers are the same", () => {
    // A genuinely huge trading quarter. Still flagged by the catch-all, which
    // keeps its deltas — that is the difference between the two rules.
    const same = [mgr("0001336528", "Pershing Square Capital Management, L.P.")];
    const s = detectStructuralEvent(
      { ...currentQ, includedManagers: same },
      { ...priorQ, includedManagers: same },
    );
    expect(s.event).toBe("REVIEW");
  });

  it("sits out entirely when the manager list was never recorded", () => {
    // Artifacts archived before this was parsed carry null, and guessing from an
    // absent list is how a detector starts inventing events. Falls through to
    // the catch-all, exactly as it did before this rule existed.
    const s = detectStructuralEvent(
      { ...currentQ, includedManagers: undefined },
      { ...priorQ, includedManagers: undefined },
    );
    expect(s.event).toBe("REVIEW");
  });

  it("tells a filing that named nobody apart from one nobody read", () => {
    // `[]` is an ANSWER — the filer listed no other managers. `null` is silence.
    // Collapsing them would make every unparsed quarter look like a change.
    const s = detectStructuralEvent(currentQ, { ...priorQ, includedManagers: null });
    expect(s.event).toBe("REVIEW");
    expect(detectStructuralEvent(currentQ, priorQ).event).toBe("MANAGER_SET_CHANGED");
  });

  it("does not let Cantillon's redemption be relabelled a manager change", () => {
    // The pro-rata case must keep its own explanation: its manager list did not
    // move, and the uniform multiplier is the whole story.
    const priorH = [], curH = [];
    for (let i = 0; i < 38; i++) priorH.push(holding({ cusip: cusipAt(i), value: 400_000_000, shares: 4_000_000, weight: 100 / 38 }));
    for (let i = 0; i < 27; i++) curH.push(holding({ cusip: cusipAt(i), value: 18_420_000, shares: 184_200, weight: 100 / 27 }));
    const same = [mgr("0000000001", "A")];
    const s = detectStructuralEvent(
      { period_end: "2026-06-30", holdings: curH, value_long_usd: 665_113_090, includedManagers: same },
      { period_end: "2026-03-31", holdings: priorH, value_long_usd: 15_050_978_966, includedManagers: same },
    );
    expect(s.event).toBe("PRO_RATA_REDUCTION");
  });
});
