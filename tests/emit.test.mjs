// tests/emit.test.mjs
//
// One emit layer, shared by the monthly build and the same-day build.
//
// These two carried their own copies of this computation. The copies were
// character-for-character identical when written — including the explanatory
// comments, which were copy-pasted verbatim — and then drifted in four ways that
// reach the screen. A reader cannot tell which path wrote a given artifact, so a
// field that means two things means nothing.
//
// Each test below pins one of those divergences as resolved, in favour of the
// rule that is correct rather than the one that happened to survive.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { artifactRow, exitRow, turnoverFor, fundQuarter, seriesEntry, filingRow, noticeEntry } from "../shared/emit.mjs";
import { PRIOR_STATE } from "../shared/fold.mjs";

const holding = (over = {}) => ({
  cusip: "037833100", put_call: null, ssh_prnamt_type: "SH",
  name_of_issuer: "APPLE INC", title_of_class: "COM", issuerId: "i1owbqtl", ticker: "AAPL",
  value_usd: 1_000_000, ssh_prnamt: 5_000, weight_pct: 12.34567, implied_price: 200.12345,
  ...over,
});

const folded = (over = {}) => ({
  holdings: [holding()],
  summary: { value_long_usd: 1_000_000, value_options_usd: 0, value_prn_usd: 0,
             positions_long: 1, positions_options: 0, top10_weight_pct: 100 },
  value_long_usd: 1_000_000,
  reported_total_usd: 1_000_000,
  acceptance: "2026-07-29T17:47:53.000Z",
  accessions: ["0001279936-26-000005"],
  warnings: [],
  confidentialOmitted: false,
  ...over,
});

describe("one holding row", () => {
  it("rounds exactly as both copies did — this is part of the contract", () => {
    const r = artifactRow(holding(), {
      action: "ADDED", d_shares: 100, d_shares_pct: 2.04081632,
      d_value: 20_000, d_value_pct: 2.0408, d_weight_pp: 0.123456789, flags: null,
    });
    expect(r.weight).toBe(12.3457);       // 4dp
    // 200.1234, not ...5: the binary double for 200.12345 sits just below the
    // decimal, so toFixed rounds down. Both copies used toFixed, so preserving
    // it exactly — quirk included — is what keeps a re-publish byte-identical
    // and stops 44,000 objects re-uploading over a rounding change.
    expect(r.price).toBe(200.1234);       // 4dp
    expect(r.dSharesPct).toBe(2.041);     // 3dp
    expect(r.dValuePct).toBe(2.041);      // 3dp
    expect(r.dWeightPp).toBe(0.1235);     // 4dp
  });

  it("a holding with no matching change carries nulls, not zeroes", () => {
    // Zero is a claim that nothing moved. Null is "we are not comparing".
    const r = artifactRow(holding(), undefined);
    expect(r.action).toBeNull();
    expect(r.dShares).toBeNull();
    expect(r.dValue).toBeNull();
  });

  it("emits exactly the 17 columns the artifact declares", () => {
    expect(Object.keys(artifactRow(holding(), undefined))).toHaveLength(17);
  });
});

describe("an exited position", () => {
  it("carries the unit, so long equity can be told from a bond", () => {
    const e = exitRow({ cusip: "x", name_of_issuer: "N", put_call: null, ssh_prnamt_type: "PRN", value_prior: 5, weight_prior: 1 },
      { securities: {}, issuerIdFor: () => "iX" });
    expect(e.unit).toBe("PRN");
  });

  it("defaults a missing unit to shares", () => {
    const e = exitRow({ cusip: "x", name_of_issuer: "N", put_call: null, value_prior: 5 },
      { securities: {}, issuerIdFor: () => "iX" });
    expect(e.unit).toBe("SH");
  });
});

describe("turnover on a suppressed quarter — divergence 1", () => {
  // The same-day path withheld it; the monthly path published it. So Cantillon's
  // Q2-2026 card reported "TURNOVER 33.8%" a few inches above an Activity widget
  // refusing to draw the same comparison — whenever the monthly job wrote it.
  const cur = { holdings: [holding()], value_long_usd: 1_000_000 };
  const prior = { holdings: [holding({ ssh_prnamt: 10_000 })], value_long_usd: 2_000_000 };

  it("is withheld when deltas are suppressed", () => {
    const t = turnoverFor(PRIOR_STATE.OK, true, cur, prior, []);
    expect(t).toEqual({ turnover_position_pct: null, turnover_value_pct: null });
  });

  it("is withheld — not zeroed", () => {
    // Zero is a confident wrong answer where a dash is the true one. And because
    // computeChanges nulls d_value when it suppresses, a computed turnover was
    // partly zero anyway: wrong in two directions at once.
    const t = turnoverFor(PRIOR_STATE.OK, true, cur, prior, []);
    expect(t.turnover_position_pct).not.toBe(0);
    expect(t.turnover_value_pct).not.toBe(0);
  });

  it("is withheld when there is no comparable prior quarter", () => {
    expect(turnoverFor(PRIOR_STATE.NONE, false, cur, null, []).turnover_position_pct).toBeNull();
    expect(turnoverFor(PRIOR_STATE.IS_NT, false, cur, null, []).turnover_position_pct).toBeNull();
    expect(turnoverFor(PRIOR_STATE.MISSING, false, cur, null, []).turnover_position_pct).toBeNull();
  });

  it("is computed normally when nothing is suppressed", () => {
    const t = turnoverFor(PRIOR_STATE.OK, false, cur, prior, []);
    expect(t.turnover_position_pct).not.toBeNull();
  });
});

describe("the confidential-omission flag — divergence 2", () => {
  // The two paths computed it over different populations: one over foldable
  // filings, the other over every parsed filing including notices. So the flag
  // STORED in the artifact and the flag that decided whether exits were withheld
  // could disagree about the same quarter.
  it("the stored flag and the folding decision come from one value", () => {
    const q = fundQuarter({
      period: "2026-06-30", priorPeriod: "2026-03-31",
      cur: folded({ confidentialOmitted: true }), prior: null,
      priorState: PRIOR_STATE.NONE, issuerIdFor: () => "iX",
    });
    expect(q.meta.confidentialOmitted).toBe(true);
    // ...and the series entry derived from the same record agrees.
    const e = seriesEntry({ period: "2026-06-30", cur: folded({ confidentialOmitted: true }), meta: q.meta, pages: 1, hasHoldings: true });
    expect(e.confidentialOmitted).toBe(true);
  });
});

describe("the filings feed — divergences 3 and 4", () => {
  const filing = {
    accession: "0001279936-26-000005", form: "13F-HR", filing_date: "2026-07-29",
    held: [1, 2, 3], table_entry_total: 27, is_amendment: false, amendment_no: null,
    is_confidential_omitted: false, reconciles: true, quarantined: false, notice: false,
  };

  it("`value` is long equity, matching the column header", () => {
    // One path wrote long equity; the other wrote the sum of EVERY aggregated
    // row, options and bond principal included. Same field, two meanings, merged
    // into one file.
    const r = filingRow({
      cik: "0001279936", name: "CANTILLON", filing,
      summary: { value_long_usd: 665_113_090, value_options_usd: 9, value_prn_usd: 9 },
      acceptedAt: "2026-07-29T17:47:53.000Z",
    });
    expect(r.value).toBe(665_113_090);
  });

  it("`rawRows` is what the filer DECLARED, because the point is to compare it with what we parsed", () => {
    const r = filingRow({ cik: "x", name: "n", filing, summary: {}, acceptedAt: null });
    expect(r.rawRows).toBe(27);        // cover page
    expect(r.positions).toBe(3);       // actually parsed
  });

  it("carries every field the Filings view reads", () => {
    const r = filingRow({ cik: "x", name: "n", filing, summary: {}, acceptedAt: null });
    for (const k of ["cik", "fund", "accession", "form", "accepted", "positions", "value",
                     "amendment", "amendmentNo", "confidentialOmitted", "reconciles", "quarantined", "notice"]) {
      expect(r, k).toHaveProperty(k);
    }
  });
});

describe("a whole fund-quarter", () => {
  it("holdings come out largest first", () => {
    const cur = folded({ holdings: [holding({ value_usd: 1 }), holding({ cusip: "b", value_usd: 99 })] });
    const q = fundQuarter({ period: "2026-06-30", priorPeriod: "2026-03-31", cur, prior: null, priorState: PRIOR_STATE.NONE, issuerIdFor: () => "iX" });
    expect(q.rows.map((r) => r.value)).toEqual([99, 1]);
  });

  it("meta and the series entry never disagree about the same quarter", () => {
    // They were built independently in each copy, from the same inputs, and were
    // free to drift. Now one is derived from the other.
    const cur = folded();
    const q = fundQuarter({ period: "2026-06-30", priorPeriod: "2026-03-31", cur, prior: null, priorState: PRIOR_STATE.NONE, issuerIdFor: () => "iX" });
    const e = seriesEntry({ period: "2026-06-30", cur, meta: q.meta, pages: 1, hasHoldings: true });
    expect(e.turnover_position_pct).toBe(q.meta.turnover_position_pct ?? null);
    expect(e.deltasSuppressed).toBe(q.meta.deltasSuppressed);
    expect(e.structuralEvent).toBe(q.meta.structuralEvent);
    expect(e.n_new).toBe(q.meta.n_new ?? null);
  });

  it("the series entry carries bond principal, so the SEC's total can be reconciled", () => {
    const cur = folded({ summary: { ...folded().summary, value_prn_usd: 432_997_365 } });
    const q = fundQuarter({ period: "2026-06-30", priorPeriod: "2026-03-31", cur, prior: null, priorState: PRIOR_STATE.NONE, issuerIdFor: () => "iX" });
    expect(seriesEntry({ period: "2026-06-30", cur, meta: q.meta, pages: 1, hasHoldings: true }).valuePrnUsd).toBe(432_997_365);
  });
});

describe("both builds actually use it", () => {
  for (const script of ["scripts/ingest-dera.mjs", "scripts/ingest-funds.mjs"]) {
    it(`${script} emits through the shared layer`, () => {
      const src = readFileSync(new URL(`../${script}`, import.meta.url), "utf8");
      expect(src).toContain('from "../shared/emit.mjs"');
      expect(src).toContain("fundQuarter({");
      expect(src).toContain("seriesEntry({");
      // And no longer computes any of it itself.
      expect(src).not.toContain("summarizeActions(changes)");
      expect(src).not.toContain("computeTurnover(changes");
    });
  }
});

describe("the compact series index survives a partial build", () => {
  // Phase 3 exists to DELETE merge functions, and this adds one. It is here
  // because the builder is not yet complete: until the SEC publishes the bulk
  // window covering the Q2 2026 deadline, the archive holds Q2 for only the
  // funds the same-day job fetched directly. A build run before then has a
  // genuinely thinner view than the published index.
  //
  // Prune is already shielded from exactly this by the coverage floor. This file
  // had no protection at all — unlike the fund summaries, which have had
  // mergeSummary since the outage.
  const t = (period, v) => [period, v];
  const idx = (rows) => ({ v: 1, kind: "series", data: rows });

  it("keeps a quarter the incoming build does not have", async () => {
    const { mergeSeriesIndex } = await import("../shared/manifest-merge.mjs");
    const live = idx([{ cik: "0000000001", s: [t("2026-06-30", 9), t("2026-03-31", 8)] }]);
    const build = idx([{ cik: "0000000001", s: [t("2026-03-31", 8)] }]);
    const out = mergeSeriesIndex(live, build);
    expect(out.data[0].s.map((x) => x[0])).toEqual(["2026-06-30", "2026-03-31"]);
  });

  it("the incoming build wins on a quarter it DID re-derive", async () => {
    const { mergeSeriesIndex } = await import("../shared/manifest-merge.mjs");
    const live = idx([{ cik: "0000000001", s: [t("2026-03-31", 8)] }]);
    const build = idx([{ cik: "0000000001", s: [t("2026-03-31", 99)] }]);
    expect(mergeSeriesIndex(live, build).data[0].s[0][1]).toBe(99);
  });

  it("keeps managers the build never saw", async () => {
    const { mergeSeriesIndex } = await import("../shared/manifest-merge.mjs");
    const live = idx([{ cik: "0000000001", s: [t("2026-03-31", 1)] }, { cik: "0000000002", s: [t("2026-03-31", 2)] }]);
    const out = mergeSeriesIndex(live, idx([{ cik: "0000000001", s: [t("2026-03-31", 1)] }]));
    expect(out.data).toHaveLength(2);
  });

  it("refuses an incoming index with no rows", async () => {
    const { mergeSeriesIndex } = await import("../shared/manifest-merge.mjs");
    expect(() => mergeSeriesIndex(idx([{ cik: "1", s: [] }]), idx([]))).toThrow(/no rows/);
  });

  it("quarters come out newest first, as the build emits them", async () => {
    const { mergeSeriesIndex } = await import("../shared/manifest-merge.mjs");
    const live = idx([{ cik: "1", s: [t("2025-12-31", 1)] }]);
    const build = idx([{ cik: "1", s: [t("2026-06-30", 2), t("2026-03-31", 3)] }]);
    expect(mergeSeriesIndex(live, build).data[0].s.map((x) => x[0]))
      .toEqual(["2026-06-30", "2026-03-31", "2025-12-31"]);
  });
});

// ---------------------------------------------------------------------------
// A NOTICE QUARTER
// ---------------------------------------------------------------------------
//
// The absence that is not an absence. A 13F-NT means "another manager reports
// these positions" — the manager filed, on time, and said something specific.
//
// It was dropped from the artifact entirely, because it has no positions and no
// value and so nothing to put in a series entry. That left the fund page with
// two explanations for the gap — "they have not filed" and "we have not read it
// yet" — and a notice is neither. Pershing Square Capital Management filed one
// for 2026-Q2 naming its parent company; the page said we had not read it.
//
// So it is emitted BESIDE the series, never inside it: nothing that counts or
// charts quarters can pick it up, and the one screen that must explain the gap
// can.
describe("a notice quarter", () => {
  const nt = (over = {}) => ({
    notice: true,
    form_type: "13F-NT",
    acceptance_datetime: "2026-08-14T16:05:00.000Z",
    cover_managers: [{ cik: "0002026053", fileNumber: "028-25746", name: "PERSHING SQUARE INC." }],
    additional_information: "Holdings of this reporting manager are now included in the report of its public parent company.",
    ...over,
  });

  it("names the manager who reports the holdings instead", () => {
    const e = noticeEntry({ period: "2026-06-30", filings: [nt()] });
    expect(e.period).toBe("2026-06-30");
    expect(e.label).toBe("Q2 2026");
    expect(e.managers).toEqual([{ cik: "0002026053", name: "PERSHING SQUARE INC." }]);
    expect(e.note).toMatch(/public parent company/);
  });

  it("ignores the holdings reports filed alongside it", () => {
    // A quarter can hold both — a manager may file a notice and an amended
    // holdings report. Only the notices describe a notice.
    const e = noticeEntry({
      period: "2026-06-30",
      filings: [{ notice: false, form_type: "13F-HR", cover_managers: [{ cik: "0000000001", name: "WRONG" }] }, nt()],
    });
    expect(e.managers).toEqual([{ cik: "0002026053", name: "PERSHING SQUARE INC." }]);
  });

  it("lets the LATEST notice win, so an amended one describes the quarter", () => {
    const e = noticeEntry({
      period: "2026-06-30",
      filings: [
        nt({ acceptance_datetime: "2026-08-14T16:05:00.000Z", cover_managers: [{ cik: "0000000009", name: "FIRST ANSWER" }] }),
        nt({ acceptance_datetime: "2026-08-20T10:00:00.000Z", cover_managers: [{ cik: "0002026053", name: "PERSHING SQUARE INC." }] }),
      ],
    });
    expect(e.managers).toEqual([{ cik: "0002026053", name: "PERSHING SQUARE INC." }]);
    expect(e.acceptedAt).toBe("2026-08-20T10:00:00.000Z");
  });

  it("orders by filing date when there is no acceptance time, as the bulk path has", () => {
    // DERA carries a filing DATE and no acceptance timestamp. Both paths reach
    // this function, so both have to order the same way or the same quarter is
    // described differently depending on which build wrote it.
    const e = noticeEntry({
      period: "2026-06-30",
      filings: [
        { notice: true, form: "13F-NT", filing_date: "2026-08-20", cover_managers: [{ cik: "0002026053", name: "PERSHING SQUARE INC." }] },
        { notice: true, form: "13F-NT", filing_date: "2026-08-14", cover_managers: [{ cik: "0000000009", name: "FIRST ANSWER" }] },
      ],
    });
    expect(e.managers).toEqual([{ cik: "0002026053", name: "PERSHING SQUARE INC." }]);
    expect(e.acceptedAt).toBe("2026-08-20T12:00:00.000Z");
  });

  it("survives a notice that names nobody", () => {
    // Common, and it must still render: "they filed a notice" is useful on its
    // own even when the filing does not say where the holdings went.
    const e = noticeEntry({ period: "2026-06-30", filings: [nt({ cover_managers: [], additional_information: null })] });
    expect(e.managers).toEqual([]);
    expect(e.note).toBeNull();
    expect(e.form).toBe("13F-NT");
  });

  it("survives an archived filing written before the cover page was parsed", () => {
    // Records in the source archive predate cover_managers entirely. Empty is
    // the honest answer; undefined would crash the map in the fund view.
    const e = noticeEntry({ period: "2026-06-30", filings: [{ notice: true }] });
    expect(e.managers).toEqual([]);
    expect(e.acceptedAt).toBeNull();
  });

  it("drops a manager entry that identifies nobody, and de-duplicates the rest", () => {
    const e = noticeEntry({
      period: "2026-06-30",
      filings: [nt({ cover_managers: [
        { cik: null, name: null },
        { cik: "0002026053", name: "PERSHING SQUARE INC." },
        { cik: "0002026053", name: "PERSHING SQUARE INC." },
      ] })],
    });
    expect(e.managers).toEqual([{ cik: "0002026053", name: "PERSHING SQUARE INC." }]);
  });
});
