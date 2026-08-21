// tests/witness.test.mjs
//
// The independent witness.
//
// Every other check in this project asks a question about OURSELVES. The
// regression gate now catches the "something got smaller" class. It cannot catch
// the other class: numbers that are simply wrong and were always that wrong — a
// series in the wrong order, a price move counted as buying, a quarter labelled
// with the wrong year. None of those get smaller. They are stable, consistent,
// and incorrect.
//
// The witness compares our sum of a filer's rows against the total that filer
// hand-stated on the cover page of their own filing. Different file, different
// producer, different transport.
//
// Every case below is a real filing.

import { describe, it, expect } from "vitest";
import { judge, coverReadings, FILING_THRESHOLD_USD } from "../shared/witness.mjs";

const HR = (over = {}) => ({ accession: "0001279936-26-000004", form: "13F-HR", accepted: "2026-07-29T17:47:53.000Z", ...over });
const NT = (over = {}) => ({ accession: "0001172661-26-003777", form: "13F-NT", accepted: "2026-08-14T00:00:00.000Z", ...over });

const mine = (over = {}) => ({
  period: "2026-06-30",
  valueLongUsd: 665_113_090,
  valueOptionsUsd: 0,
  reportedTotalUsd: 665_113_090,
  positions: 27,
  ...over,
});

const cover = (over = {}) => ({
  declaredUsd: 665_113_090,
  declaredUnits: "dollars",
  alternateUsd: 665_113_090_000,
  alternateUnits: "thousands",
  declaredIsBelowFilingThreshold: false,
  entries: 27,
  ...over,
});

const run = (over = {}) =>
  judge({
    name: "Cantillon",
    period: "2026-06-30",
    ours: mine(),
    filings: [HR()],
    readCover: async () => cover(),
    ...over,
  });

describe("agreement", () => {
  it("our sum of their rows equals their own declared total", async () => {
    const v = await run();
    expect(v.verdict).toBe("agree");
    expect(v.value).toBe(665_113_090);
  });

  it("counts options toward the cover total, because the cover page does", async () => {
    const v = await run({
      ours: mine({ valueLongUsd: 400_113_090, valueOptionsUsd: 265_000_000 }),
    });
    expect(v.verdict).toBe("agree");
  });

  it("accepts our position count below their entry count — that is aggregation working", async () => {
    // Cantillon's 2026-Q1 is 76 rows over 38 CUSIPs, split by otherManager.
    // Summing them is correct; the counts are meant to differ.
    const v = await run({ ours: mine({ positions: 38 }), readCover: async () => cover({ entries: 76 }) });
    expect(v.verdict).toBe("agree");
  });
});

describe("disagreement", () => {
  it("catches a 1000x unit error and names it as one", async () => {
    const v = await run({ ours: mine({ valueLongUsd: 665_113_090_000 }) });
    expect(v.verdict).toBe("disagree");
    expect(v.what).toContain("factor of 1000");
  });

  it("catches deduping rows that should have been summed, and says so", async () => {
    // Deduping Cantillon's 2026-Q1 understates it by 38.8% — the exact failure
    // this comparison exists to catch.
    const v = await run({ ours: mine({ valueLongUsd: 665_113_090 * 0.612 }) });
    expect(v.verdict).toBe("disagree");
    expect(v.what).toMatch(/38\.8% short/);
    expect(v.what).toContain("dropping duplicate rows");
  });

  it("catches the outage shape — they filed, we show nothing", async () => {
    // Nuveen filed 13F-HR for 2026-06-30 on 2026-08-11 and our dashboard had no
    // 2026-06-30 for them at all. Found by this check on its first real run.
    const v = await run({ ours: undefined });
    expect(v.verdict).toBe("disagree");
    expect(v.what).toContain("our dashboard has no 2026-06-30 at all");
  });

  it("catches showing more positions than the filing has rows", async () => {
    // One-sided and therefore always valid: aggregating can only reduce a count.
    const v = await run({ ours: mine({ positions: 99 }), readCover: async () => cover({ entries: 27 }) });
    expect(v.verdict).toBe("disagree");
    expect(v.what).toContain("can only ever reduce");
  });

  it("catches a portfolio shown for a quarter the manager only filed a notice for", async () => {
    const v = await run({ filings: [NT()] });
    expect(v.verdict).toBe("disagree");
    expect(v.what).toContain("NOTICE");
  });

  it("distinguishes no filing at all from a notice", async () => {
    const v = await run({ filings: [] });
    expect(v.what).toContain("no 13F of any kind");
  });
});

describe("the units the filer got wrong", () => {
  // 3.4% of filers declare the dollars schema and keep writing thousands. Aspex
  // Management filed exactly this for 2026-06-30: schemaVersion X0202, cover
  // total 8,891,270, and billions under management.
  const aspexCover = () =>
    cover({
      declaredUsd: 8_891_270,
      declaredUnits: "dollars",
      alternateUsd: 8_891_270_000,
      alternateUnits: "thousands",
      declaredIsBelowFilingThreshold: true,
      entries: 29,
    });

  it("sides with us when reading the cover as declared puts the fund below the filing threshold", async () => {
    const v = await run({
      name: "Aspex",
      ours: mine({ valueLongUsd: 8_891_270_000, reportedTotalUsd: 8_891_270_000, positions: 27 }),
      readCover: aspexCover,
    });
    expect(v.verdict).toBe("agree");
    expect(v.value).toBe(8_891_270_000);
  });

  it("says out loud that the filer mislabelled it, rather than quietly passing itself", async () => {
    const v = await run({
      name: "Aspex",
      ours: mine({ valueLongUsd: 8_891_270_000, reportedTotalUsd: 8_891_270_000, positions: 27 }),
      readCover: aspexCover,
    });
    expect(v.misdeclaredUnits).toContain("wrote its cover total in thousands");
    expect(v.misdeclaredUnits).toContain("$100M threshold");
  });

  it("does NOT hand us the escape hatch when the fund is comfortably above the threshold", async () => {
    // Otherwise a real 1000x bug in our pipeline would pass by claiming the
    // filer mislabelled. The threshold is the whole reason the exception is safe.
    const v = await run({
      ours: mine({ valueLongUsd: 665_113_090_000 }),
      readCover: async () => cover({ declaredIsBelowFilingThreshold: false }),
    });
    expect(v.verdict).toBe("disagree");
  });

  it("reads the schema declaration, and knows what it implies", () => {
    expect(coverReadings(8_891_270, "X0202").declaredUnits).toBe("dollars");
    expect(coverReadings(8_891_270, "X0202").declaredIsBelowFilingThreshold).toBe(true);
    expect(coverReadings(11_413_760, "X0102").declaredUsd).toBe(11_413_760_000);
    expect(coverReadings(11_413_760, "X0102").declaredIsBelowFilingThreshold).toBe(false);
    expect(coverReadings(NaN, "X0202")).toBeNull();
    expect(FILING_THRESHOLD_USD).toBe(100_000_000);
  });
});

describe("what it refuses to judge", () => {
  it("will not score an amended quarter, because the fold is the thing under test", async () => {
    const v = await run({ filings: [HR(), HR({ accession: "0001279936-26-000009", form: "13F-HR/A" })] });
    expect(v.verdict).toBe("not-comparable");
    expect(v.why).toContain("the thing under test");
  });

  it("a notice with no holdings on our side is correct behaviour, not a finding", async () => {
    const v = await run({ filings: [NT()], ours: undefined });
    expect(v.verdict).toBe("not-comparable");
    expect(v.why).toContain("correctly");
  });

  it("never reads the cover page when there is nothing to compare", async () => {
    // 2 SEC requests per fund is the budget. A refusal must not spend one.
    let reads = 0;
    await run({ filings: [NT()], ours: undefined, readCover: async () => (reads++, cover()) });
    expect(reads).toBe(0);
  });

  it("not-comparable is its own outcome, never folded in with agreement", async () => {
    // "No finding" and "clean" being the same output is how prune stayed
    // invisible for its entire existence.
    const v = await run({ filings: [] , ours: undefined });
    expect(v.verdict).toBe("not-comparable");
    expect(v.verdict).not.toBe("agree");
  });
});

describe("the ingest grace window", () => {
  // During filing season managers file continuously and the same-day job runs
  // daily, so "filed this morning, not on the dashboard yet" is the pipeline
  // working. Making that red every day teaches the owner to ignore red.
  const filedOn = (d) => [HR({ accepted: `${d}T14:00:00.000Z` })];

  it("a filing from this morning is not yet a gap", async () => {
    const v = await run({ ours: undefined, filings: filedOn("2026-08-21"), asOf: new Date("2026-08-21T18:00:00Z") });
    expect(v.verdict).toBe("not-comparable");
    expect(v.why).toContain("not yet a gap");
  });

  it("a filing from ten days ago that we still do not have is a real gap", async () => {
    // Nuveen, 2026-06-30, accepted 2026-08-11. This is the case that found it.
    const v = await run({ ours: undefined, filings: filedOn("2026-08-11"), asOf: new Date("2026-08-21T18:00:00Z") });
    expect(v.verdict).toBe("disagree");
    expect(v.what).toContain("10 days ago");
  });

  it("the window does not stretch to cover a fund that filed before the last quarter closed", async () => {
    const v = await run({ ours: undefined, filings: filedOn("2026-08-18"), asOf: new Date("2026-08-21T18:00:00Z") });
    expect(v.verdict).toBe("disagree");
  });
});
