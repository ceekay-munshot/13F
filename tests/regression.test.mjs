// tests/regression.test.mjs
//
// The gate that would have stopped the 2026-08-20 outage.
//
// That publish passed every check the project had: the index loaded, 9,268
// filers, five quarters, a fresh build, an artifact probe returning 200. And it
// had just deleted the current quarter from all 9,268 fund summaries.
//
// The reason no aggregate caught it is that the loss was UNIFORM. Totals stayed
// perfect while every part got shorter. Only a before-and-after comparison of
// the parts can see that.

import { describe, it, expect } from "vitest";
import { compareFingerprints, fingerprint } from "../shared/regression.mjs";

const fp = (over = {}) => ({
  takenAt: "2026-08-20T16:00:00Z",
  buildId: "126j6p8",
  filers: 9268,
  periods: {
    "2026-06-30": { funds: 10765, filings: 10765 },
    "2026-03-31": { funds: 10648, filings: 10776 },
  },
  funds: {
    "0001279936": { quarters: 5, newest: "2026-06-30" },
    "0001067983": { quarters: 5, newest: "2026-06-30" },
  },
  ...over,
});

describe("the outage this exists to catch", () => {
  it("catches every fund losing its newest quarter while totals look fine", () => {
    // EXACTLY 2026-08-20. Filers unchanged, quarters present, build fresh —
    // and every summary a quarter shorter.
    const after = fp({
      funds: {
        "0001279936": { quarters: 4, newest: "2026-03-31" },
        "0001067983": { quarters: 4, newest: "2026-03-31" },
      },
    });
    const { regressions } = compareFingerprints(fp(), after);
    expect(regressions).toHaveLength(4); // two funds x (lost a quarter + went backwards)
    expect(regressions.join(" ")).toMatch(/0001279936.*lost 1 quarter/);
    expect(regressions.join(" ")).toMatch(/newest quarter went backwards/);
  });

  it("catches the quarter vanishing from the manifest", () => {
    const after = fp({ periods: { "2026-03-31": { funds: 10648, filings: 10776 } } });
    expect(compareFingerprints(fp(), after).regressions.join(" "))
      .toMatch(/2026-06-30 disappeared/);
  });

  it("catches the collapse from 9,396 funds to 8", () => {
    expect(compareFingerprints(fp(), fp({ filers: 8 })).regressions.join(" "))
      .toMatch(/filer count fell from 9268 to 8/);
  });

  it("catches a filings feed shrinking to one row", () => {
    const after = fp({
      periods: { ...fp().periods, "2026-06-30": { funds: 1, filings: 1 } },
    });
    expect(compareFingerprints(fp(), after).regressions.join(" ")).toMatch(/fell from 10765 filings to 1/);
  });

  it("catches a fund disappearing entirely — what prune would have done", () => {
    const after = fp({ funds: { "0001067983": { quarters: 5, newest: "2026-06-30" } } });
    expect(compareFingerprints(fp(), after).regressions.join(" ")).toMatch(/0001279936 vanished/);
  });
});

describe("what it must NOT complain about", () => {
  it("stays quiet when nothing changed", () => {
    expect(compareFingerprints(fp(), fp()).regressions).toEqual([]);
  });

  it("welcomes a new quarter", () => {
    const after = fp({
      periods: { ...fp().periods, "2026-09-30": { funds: 12, filings: 12 } },
    });
    const { regressions, notes } = compareFingerprints(fp(), after);
    expect(regressions).toEqual([]);
    expect(notes.join(" ")).toMatch(/new quarter\(s\): 2026-09-30/);
  });

  it("welcomes growth", () => {
    const after = fp({ filers: 9400, funds: { ...fp().funds, "0001279936": { quarters: 6, newest: "2026-09-30" } } });
    expect(compareFingerprints(fp(), after).regressions).toEqual([]);
  });

  it("tolerates ordinary churn when a quarter is re-ingested", () => {
    // A filer withdraws, an amendment merges two rows into one. Zero tolerance
    // here would cry wolf on every monthly run and train everyone to ignore it.
    const after = fp({
      filers: 9200,
      periods: { ...fp().periods, "2026-03-31": { funds: 10500, filings: 10600 } },
    });
    expect(compareFingerprints(fp(), after).regressions).toEqual([]);
  });

  it("still fails once churn exceeds the allowance", () => {
    const after = fp({ periods: { ...fp().periods, "2026-03-31": { funds: 8000, filings: 10776 } } });
    expect(compareFingerprints(fp(), after).regressions.join(" ")).toMatch(/fell from 10648 funds to 8000/);
  });

  it("says a missing baseline is a first run, not a pass", () => {
    // A missing baseline must never be indistinguishable from a clean result —
    // that is how a broken check goes unnoticed for its whole existence.
    const { regressions, notes } = compareFingerprints(null, fp());
    expect(regressions).toEqual([]);
    expect(notes.join(" ")).toMatch(/no baseline/);
  });
});

describe("fingerprint", () => {
  it("reads the shape the live site actually serves", () => {
    const f = fingerprint(
      { buildId: "b1", counts: { filers: 9268 }, periods: [{ period: "2026-06-30", funds: 10, filings: 11 }] },
      { "0001279936": { data: { series: [{ period: "2026-03-31" }, { period: "2026-06-30" }] } } },
      "now",
    );
    expect(f.filers).toBe(9268);
    expect(f.periods["2026-06-30"]).toEqual({ funds: 10, filings: 11 });
    expect(f.funds["0001279936"]).toEqual({ quarters: 2, newest: "2026-06-30" });
  });

  it("survives a fund whose summary could not be read", () => {
    const f = fingerprint({ periods: [] }, { "0001279936": null }, "now");
    expect(f.funds["0001279936"]).toEqual({ quarters: 0, newest: null });
  });
});

describe("the fund search index — the file this gate was watching around", () => {
  // It was built to enforce "a publish may add and it may correct, it may not
  // subtract", and then looked only at the manifest and a sample of fund
  // summaries. meta/filers.json was subtracting the whole time.
  const idx = (rows) => ({ data: rows });
  const mgr = (over = {}) => ({ cik: "0000000001", periods: 4, latestPeriod: "2026-03-31", ...over });
  const fpOf = (rows) => fingerprint({ buildId: "x", counts: { filers: 1 }, periods: [] }, {}, "t", idx(rows));

  it("catches the regression that was live: managers advertising fewer quarters", () => {
    // 853 of 987 managers the same-day job touched had their quarter count
    // replaced by a two-quarter run's.
    const before = fpOf([mgr({ periods: 4 }), mgr({ cik: "0000000002", periods: 4 })]);
    const after = fpOf([mgr({ periods: 2 }), mgr({ cik: "0000000002", periods: 2 })]);
    const { regressions } = compareFingerprints(before, after);
    expect(regressions.join("\n")).toMatch(/4 fewer quarter\(s\) in total/);
  });

  it("catches the regression due 3 September: newest quarter moving backwards", () => {
    const before = fpOf([mgr({ latestPeriod: "2026-06-30" }), mgr({ cik: "0000000002", latestPeriod: "2026-06-30" })]);
    const after = fpOf([mgr({ latestPeriod: "2026-03-31" }), mgr({ cik: "0000000002", latestPeriod: "2026-03-31" })]);
    const { regressions } = compareFingerprints(before, after);
    expect(regressions.join("\n")).toMatch(/2 manager\(s\) no longer report 2026-06-30/);
    expect(regressions.join("\n")).toMatch(/would say they have not filed/);
  });

  it("catches managers disappearing from search entirely", () => {
    const { regressions } = compareFingerprints(fpOf([mgr(), mgr({ cik: "0000000002" })]), fpOf([mgr()]));
    expect(regressions.join("\n")).toMatch(/lost 1 manager/);
  });

  it("catches the index vanishing", () => {
    const { regressions } = compareFingerprints(fpOf([mgr()]), fpOf([]));
    expect(regressions.join("\n")).toMatch(/search index disappeared/);
  });

  it("allows the index to GROW — adding and correcting are the point", () => {
    const before = fpOf([mgr({ periods: 4, latestPeriod: "2026-03-31" })]);
    const after = fpOf([mgr({ periods: 5, latestPeriod: "2026-06-30" }), mgr({ cik: "0000000009", periods: 1 })]);
    expect(compareFingerprints(before, after).regressions).toEqual([]);
  });

  it("an unreadable index is not the same as an empty one", () => {
    // A failed fetch passes null. Recording that as zero rows would report
    // "every manager vanished" out of a network blip — so it is a third state.
    const before = fpOf([mgr()]);
    const after = fingerprint({ buildId: "x", counts: { filers: 1 }, periods: [] }, {}, "t", null);
    expect(after.index).toBeNull();
    const { regressions, notes } = compareFingerprints(before, after);
    expect(regressions).toEqual([]);
    expect(notes.join("\n")).toMatch(/not counted as a pass/);
  });

  it("but a genuinely EMPTY index is still a regression", () => {
    // Measured-as-empty and not-measured must not collapse into each other.
    const { regressions } = compareFingerprints(fpOf([mgr()]), fpOf([]));
    expect(regressions.join("\n")).toMatch(/disappeared/);
  });
});

describe("named expectations", () => {
  const fp = (funds) => fingerprint(
    { buildId: "x", counts: { filers: 100 }, periods: [{ period: "2026-06-30", funds, filings: 1 }] },
    {}, "t", { data: [] },
  );

  it("a quarter's fund count falling is a regression by default", () => {
    expect(compareFingerprints(fp(10765), fp(8428)).regressions.join()).toMatch(/fell from 10765 funds to 8428/);
  });

  it("...and a note when that exact correction is named", () => {
    // The count was a Math.max ratchet over whatever the feed ever saw. Fixing
    // it makes the number go DOWN, which is indistinguishable from data loss.
    const { regressions, notes } = compareFingerprints(fp(10765), fp(8428), { expect: ["period-funds"] });
    expect(regressions).toEqual([]);
    expect(notes.join()).toMatch(/expected: the count was a ratchet/);
  });

  it("naming it relaxes NOTHING else — a fund losing a quarter still fails", () => {
    const before = fingerprint({ buildId: "x", counts: { filers: 100 }, periods: [] },
      { "0001279936": { data: { series: [{ period: "2026-03-31" }, { period: "2026-06-30" }] } } }, "t", { data: [] });
    const after = fingerprint({ buildId: "x", counts: { filers: 100 }, periods: [] },
      { "0001279936": { data: { series: [{ period: "2026-03-31" }] } } }, "t", { data: [] });
    const { regressions } = compareFingerprints(before, after, { expect: ["period-funds"] });
    expect(regressions.join()).toMatch(/lost 1 quarter/);
  });

  it("an unknown expectation name relaxes nothing", () => {
    expect(compareFingerprints(fp(10765), fp(8428), { expect: ["something-else"] }).regressions).toHaveLength(1);
  });
});
