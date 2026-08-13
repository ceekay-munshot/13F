// tests/manifest-merge.test.mjs
//
// The same-day ingest shares a bucket with the monthly universe ingest, and the
// last time those two jobs both wrote manifest.json the live dashboard went
// from 9,268 funds to twelve. Every test here is a rehearsal of that failure.

import { describe, it, expect } from "vitest";
import { mergeManifest, mergeSummary, verifyMerge, isPublishableDayKey } from "../shared/manifest-merge.mjs";

/** Shaped like the real published manifest (checked against the live one). */
const live = () => ({
  buildId: "126j6p8",
  generatedAt: "2026-08-03T10:17:22.581Z",
  funds: {},
  periods: [
    { period: "2026-03-31", label: "Q1 2026", deadline: "2026-05-15", filings: 10776, funds: 10648 },
    { period: "2025-12-31", label: "Q4 2025", deadline: "2026-02-17", filings: 11025, funds: 10753 },
  ],
  coverage: { from: "2025-12-31", to: "2026-03-31", holdingsFrom: "2025-12-31" },
  counts: { filers: 9268, filings: 42340, holdings: 32866 },
});

/** What a same-day run of the 13-fund watchlist produces locally. */
const incoming = () => ({
  buildId: "day-xyz",
  generatedAt: "2026-08-14T21:30:00.000Z",
  funds: {},
  periods: [
    { period: "2026-06-30", label: "Q2 2026", deadline: "2026-08-14", filings: 9, funds: 9 },
    { period: "2026-03-31", label: "Q1 2026", deadline: "2026-05-15", filings: 13, funds: 13 },
  ],
  coverage: { from: "2026-03-31", to: "2026-06-30", holdingsFrom: "2026-03-31" },
  counts: { filers: 13, filings: 22, holdings: 26 },
});

const CIKS = ["0001067983", "0001061165"];

describe("mergeManifest — the universe must survive a 13-fund run", () => {
  it("keeps the universe filer count, not the watchlist's", () => {
    // THE bug. A same-day run knows about 13 filers and has no opinion about
    // the other 9,255.
    const { manifest } = mergeManifest(live(), incoming(), { buildId: "day-xyz", ciks: CIKS });
    expect(manifest.counts.filers).toBe(9268);
    expect(manifest.counts.filings).toBe(42340);
  });

  it("does not shrink a period the universe has fully covered", () => {
    const { manifest } = mergeManifest(live(), incoming(), { buildId: "day-xyz", ciks: CIKS });
    const q1 = manifest.periods.find((p) => p.period === "2026-03-31");
    expect(q1.filings).toBe(10776); // not 13
    expect(q1.funds).toBe(10648);
  });

  it("ADDS the newly filed quarter so the stepper can reach it", () => {
    const { manifest, newPeriods } = mergeManifest(live(), incoming(), { buildId: "day-xyz", ciks: CIKS });
    expect(newPeriods).toEqual(["2026-06-30"]);
    const q2 = manifest.periods.find((p) => p.period === "2026-06-30");
    expect(q2).toMatchObject({ label: "Q2 2026", filings: 9 });
    // Newest first, as the frontend's period list expects.
    expect(manifest.periods[0].period).toBe("2026-06-30");
    expect(manifest.coverage.to).toBe("2026-06-30");
  });

  it("leaves the global build id alone and stamps only the refreshed funds", () => {
    // Bumping the global id would bust the cache for 9,300 funds to publish an
    // update to two. The per-fund map exists precisely so it does not have to.
    const { manifest } = mergeManifest(live(), incoming(), { buildId: "day-xyz", ciks: CIKS });
    expect(manifest.buildId).toBe("126j6p8");
    expect(manifest.funds).toEqual({ "0001067983": "day-xyz", "0001061165": "day-xyz" });
  });

  it("keeps per-fund stamps from earlier same-day runs", () => {
    const base = { ...live(), funds: { "0000000001": "day-older" } };
    const { manifest } = mergeManifest(base, incoming(), { buildId: "day-new", ciks: ["0001067983"] });
    expect(manifest.funds["0000000001"]).toBe("day-older");
    expect(manifest.funds["0001067983"]).toBe("day-new");
  });

  it("never widens coverage backwards", () => {
    const older = { ...incoming(), periods: [{ period: "2024-03-31", label: "Q1 2024", filings: 1, funds: 1 }] };
    const { manifest } = mergeManifest(live(), older, { buildId: "d", ciks: CIKS });
    expect(manifest.coverage.to).toBe("2026-03-31");
    expect(manifest.coverage.from).toBe("2024-03-31");
  });

  it("refuses to run without a live manifest — a missing read is not an empty base", () => {
    // If R2 cannot be read, publishing "what we have" would BE the incident.
    expect(() => mergeManifest(null, incoming(), { buildId: "d", ciks: CIKS })).toThrow(/live manifest/i);
    expect(() => mergeManifest({}, incoming(), { buildId: "d", ciks: CIKS })).toThrow(/live manifest/i);
  });

  it("refuses to publish when the run ingested nothing", () => {
    expect(() => mergeManifest(live(), incoming(), { buildId: "d", ciks: [] })).toThrow(/no funds/i);
  });
});

describe("verifyMerge — the last line of defence", () => {
  it("passes a correct merge", () => {
    const { manifest } = mergeManifest(live(), incoming(), { buildId: "day-xyz", ciks: CIKS });
    expect(verifyMerge(live(), manifest)).toEqual([]);
  });

  it("catches the exact regression that took the site down", () => {
    // Simulate the old behaviour: publish the incoming manifest wholesale.
    const problems = verifyMerge(live(), incoming());
    expect(problems.join(" ")).toMatch(/counts\.filers would drop from 9268 to 13/);
  });

  it("catches a disappearing period", () => {
    const merged = { ...live(), periods: live().periods.slice(0, 1) };
    expect(verifyMerge(live(), merged).join(" ")).toMatch(/2025-12-31 would disappear|period count would drop/);
  });

  it("catches a shrunken period even when totals look fine", () => {
    const merged = live();
    merged.periods = merged.periods.map((p) => (p.period === "2026-03-31" ? { ...p, funds: 13 } : p));
    expect(verifyMerge(live(), merged).join(" ")).toMatch(/2026-03-31 funds would drop from 10648 to 13/);
  });

  it("catches a global build id bump", () => {
    const merged = { ...live(), buildId: "something-new" };
    expect(verifyMerge(live(), merged).join(" ")).toMatch(/global buildId changed/);
  });

  it("catches coverage moving backwards", () => {
    const merged = { ...live(), coverage: { ...live().coverage, to: "2025-12-31" } };
    expect(verifyMerge(live(), merged).join(" ")).toMatch(/coverage\.to would move backwards/);
  });
});

describe("mergeSummary — a shallow run must not truncate a fund's history", () => {
  const sum = (periods, extra = {}) => ({
    kind: "fund-summary", cik: "0001067983", name: "BERKSHIRE HATHAWAY INC", ...extra,
    data: { series: periods.map((p) => ({ period: p, valueLongUsd: 1, positions: 1 })) },
  });

  it("keeps quarters the same-day run never fetched", () => {
    // The universe holds four quarters; today's run fetched two. Writing the
    // shallow one wholesale would erase two years of bars from the chart.
    const live = sum(["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"]);
    const incoming = sum(["2026-03-31", "2026-06-30"]);
    const out = mergeSummary(live, incoming);
    expect(out.data.series.map((s) => s.period)).toEqual([
      "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30",
    ]);
  });

  it("prefers today's figures for a quarter both know about", () => {
    // Amendments land in the gap between the data set and today.
    const live = sum(["2026-03-31"]);
    live.data.series[0].valueLongUsd = 100;
    const incoming = sum(["2026-03-31"]);
    incoming.data.series[0].valueLongUsd = 250;
    expect(mergeSummary(live, incoming).data.series[0].valueLongUsd).toBe(250);
  });

  it("works for a fund the universe has never seen", () => {
    const out = mergeSummary(null, sum(["2026-06-30"]));
    expect(out.data.series).toHaveLength(1);
  });

  it("refuses an incoming summary with no series at all", () => {
    expect(() => mergeSummary(sum(["2026-03-31"]), { data: { series: [] } })).toThrow(/no series/i);
  });
});

describe("isPublishableDayKey — an allowlist, so a future shared index is excluded by default", () => {
  it("allows this run's own fund artifacts and the merged manifest", () => {
    expect(isPublishableDayKey("fund/0001067983/2026-06-30.json")).toBe(true);
    expect(isPublishableDayKey("fund/0001067983/summary.json")).toBe(true);
    expect(isPublishableDayKey("manifest.json")).toBe(true);
  });

  it("blocks every shared index", () => {
    // meta/filers.json is the one that was clobbered. period/* is the Filings
    // feed, which a 13-fund run would equally truncate.
    expect(isPublishableDayKey("meta/filers.json")).toBe(false);
    expect(isPublishableDayKey("meta/series.json")).toBe(false);
    expect(isPublishableDayKey("meta/periods.json")).toBe(false);
    expect(isPublishableDayKey("period/2026-06-30/filings.json")).toBe(false);
  });

  it("blocks anything it has not been taught about", () => {
    expect(isPublishableDayKey("meta/some-future-index.json")).toBe(false);
    expect(isPublishableDayKey("securities.json")).toBe(false);
  });
});
