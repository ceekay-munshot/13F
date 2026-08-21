// tests/manifest-merge.test.mjs
//
// The same-day ingest shares a bucket with the monthly universe ingest, and the
// last time those two jobs both wrote manifest.json the live dashboard went
// from 9,268 funds to twelve. Every test here is a rehearsal of that failure.

import { describe, it, expect } from "vitest";
import {
  mergeManifest, mergeSummary, mergePeriodFilings, mergeFilers, verifyMerge,
  isPublishableDayKey, periodOfKey, isPrunableKey, carryForwardPeriods,
} from "../shared/manifest-merge.mjs";

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

  it("blocks every shared index it cannot merge", () => {
    // meta/filers.json used to be here too, and blocking it was right while
    // nothing could merge it — a few-hundred-fund run writing the file wholesale
    // erases a 9,268-row search index. It is allowed now for the same reason the
    // quarter feed is: mergeFilers exists, publish-day.mjs calls it, and CI fails
    // if either of those stops being true. Without it a manager the same-day path
    // discovered has artifacts nobody can navigate to.
    expect(isPublishableDayKey("meta/series.json")).toBe(false);
    expect(isPublishableDayKey("meta/periods.json")).toBe(false);
    expect(isPublishableDayKey("period/2026-06-30/leaderboard.json")).toBe(false);
  });

  it("allows the quarter filing feed, which is merged rather than replaced", () => {
    // This was blocked outright, and that was right while nothing could merge
    // it: a 13-fund run writing the file wholesale truncates a 10,000-row feed.
    // It is allowed now because mergePeriodFilings exists and is exercised
    // below — the file is rebuilt from the published rows plus this run's, and
    // it throws rather than drop a row belonging to anyone else.
    //
    // The reason it must be writable at all: during filing season the feed is
    // the single most-stale thing on the site. The universe data set does not
    // publish the current quarter's window until roughly a month after the
    // deadline, so the Filings view showed 1 filing while 12 tracked managers
    // had already filed.
    expect(isPublishableDayKey("period/2026-06-30/filings.json")).toBe(true);
  });

  it("still blocks the OTHER files under period/", () => {
    // Only the filings feed has a merge. A leaderboard or sector rollup would
    // be replaced wholesale and is therefore still refused.
    expect(isPublishableDayKey("period/2026-06-30/leaderboard.json")).toBe(false);
    expect(isPublishableDayKey("period/2026-06-30/sectors.json")).toBe(false);
    expect(isPublishableDayKey("period/2026-06-30/anything-else.json")).toBe(false);
  });

  it("blocks anything it has not been taught about", () => {
    expect(isPublishableDayKey("meta/some-future-index.json")).toBe(false);
    expect(isPublishableDayKey("securities.json")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mergePeriodFilings
//
// The quarter's filings feed is written by BOTH jobs: the universe run puts
// every manager's rows in it, a same-day run knows about a dozen. This merge is
// what lets the second one keep the feed current without repeating the failure
// that took the site from 9,396 funds to 8.
// ---------------------------------------------------------------------------
describe("mergePeriodFilings", () => {
  const row = (cik, accession, accepted, over = {}) => ({
    cik, accession, accepted, fund: `FUND ${cik}`, form: "13F-HR", filed: accepted.slice(0, 10), ...over,
  });
  const env = (rows) => ({ kind: "period-filings", period: "2026-06-30", data: rows });
  const OURS = ["0001067983", "0001279936"];

  it("adds this run's filings to what is already published", () => {
    const live = env([row("0009999999", "a-1", "2026-08-10T12:00:00Z")]);
    const incoming = env([row("0001067983", "b-1", "2026-08-14T12:00:00Z")]);
    const out = mergePeriodFilings(live, incoming, OURS);
    expect(out.data).toHaveLength(2);
    expect(out.data.map((r) => r.accession).sort()).toEqual(["a-1", "b-1"]);
  });

  it("NEVER drops a filing belonging to a manager it does not speak for", () => {
    // The whole point. A same-day run holds 13 funds; the feed holds thousands.
    const foreign = Array.from({ length: 500 }, (_, i) =>
      row(`00000${String(i).padStart(5, "0")}`, `f-${i}`, "2026-08-10T12:00:00Z"));
    const live = env(foreign);
    const incoming = env([row("0001067983", "b-1", "2026-08-14T12:00:00Z")]);
    const out = mergePeriodFilings(live, incoming, OURS);
    expect(out.data).toHaveLength(501);
    expect(out.data.filter((r) => !OURS.includes(r.cik))).toHaveLength(500);
  });

  it("replaces its own row in place on a re-run rather than duplicating it", () => {
    // The job runs every few hours against the same quarter, so this is the
    // common path, not an edge case.
    const live = env([row("0001067983", "b-1", "2026-08-14T12:00:00Z", { positions: 29 })]);
    const incoming = env([row("0001067983", "b-1", "2026-08-14T12:00:00Z", { positions: 41 })]);
    const out = mergePeriodFilings(live, incoming, OURS);
    expect(out.data).toHaveLength(1);
    expect(out.data[0].positions).toBe(41);
  });

  it("keeps an amendment ALONGSIDE the original — both were really filed", () => {
    const live = env([row("0001067983", "orig", "2026-08-14T12:00:00Z")]);
    const incoming = env([row("0001067983", "amend", "2026-08-20T12:00:00Z", { amendment: "RESTATEMENT" })]);
    const out = mergePeriodFilings(live, incoming, OURS);
    expect(out.data).toHaveLength(2);
  });

  it("sorts newest first, which is what the feed claims to be", () => {
    const live = env([row("0009999999", "old", "2026-08-01T12:00:00Z")]);
    const incoming = env([row("0001067983", "new", "2026-08-14T12:00:00Z")]);
    expect(mergePeriodFilings(live, incoming, OURS).data.map((r) => r.accession)).toEqual(["new", "old"]);
  });

  it("refuses an empty incoming feed instead of publishing it", () => {
    const live = env([row("0009999999", "a-1", "2026-08-10T12:00:00Z")]);
    expect(() => mergePeriodFilings(live, env([]), OURS)).toThrow(/no rows/);
  });

  it("works when the quarter has never been published before", () => {
    // Q2 2026 during filing season: the universe data set has no window for it
    // yet, so the same-day run is the only source there is.
    const out = mergePeriodFilings({ data: [] }, env([row("0001067983", "b-1", "2026-08-14T12:00:00Z")]), OURS);
    expect(out.data).toHaveLength(1);
  });

  it("ignores incoming rows for CIKs it was not asked about", () => {
    // A run only speaks for what it was told to fetch; anything else in its
    // tree is stale by construction and must not overwrite the published row.
    const live = env([row("0009999999", "a-1", "2026-08-10T12:00:00Z", { positions: 10 })]);
    const incoming = env([row("0009999999", "a-1", "2026-08-10T12:00:00Z", { positions: 999 })]);
    const out = mergePeriodFilings(live, incoming, OURS);
    expect(out.data[0].positions).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// COUNTING A QUARTER THAT IS BEING FILLED ONE RUN AT A TIME.
//
// These landed with the fix for the Q2-2026 outage. Before it the same-day job
// ingested thirteen funds and the universe job supplied every real number, so
// "take whichever count is bigger" was right. Once the same-day job became the
// thing that fills a quarter — ten thousand managers, several hundred a run —
// that rule froze the quarter's count at one run's worth for ever, and the
// staleness watchdog grades exactly that number.
// ---------------------------------------------------------------------------
describe("mergePeriodFilings — counting a quarter as it fills", () => {
  const row = (cik, accession, accepted) => ({
    cik, accession, accepted, fund: `FUND ${cik}`, form: "13F-HR", filed: accepted.slice(0, 10),
  });
  const env = (rows, over = {}) => ({ kind: "period-filings", period: "2026-06-30", data: rows, ...over });

  it("counts the whole merged quarter while it still fits under the cap", () => {
    const ours = ["0000000002"];
    const live = env([row("0000000001", "a-1", "2026-08-14T12:00:00Z")], { total: 1, funds: 1 });
    const incoming = env([row("0000000002", "b-1", "2026-08-15T12:00:00Z")]);
    const out = mergePeriodFilings(live, incoming, ours);
    expect(out.total).toBe(2);
    expect(out.funds).toBe(2);
  });

  it("never reports fewer than what was already recorded", () => {
    // The universe run publishes 10,776 filings for a quarter and ships the
    // newest 2,000 of them. A same-day run that merges nine rows into that must
    // not recount the visible list and announce the quarter shrank to 2,009.
    const ours = ["0000000002"];
    const many = Array.from({ length: 20 }, (_, i) =>
      row("0000000001", `a-${i}`, `2026-05-15T12:00:${String(i).padStart(2, "0")}Z`));
    const live = env(many, { total: 10776, funds: 10648 });
    const incoming = env([row("0000000002", "b-1", "2026-05-16T12:00:00Z")]);
    const out = mergePeriodFilings(live, incoming, ours, { cap: 20 });
    expect(out.total).toBe(10776);
    expect(out.funds).toBe(10648);
  });

  it("does not double-count a filing it already published", () => {
    const ours = ["0000000002"];
    const live = env(
      [row("0000000001", "a-1", "2026-08-14T12:00:00Z"), row("0000000002", "b-1", "2026-08-15T12:00:00Z")],
      { total: 450, funds: 450 },
    );
    const incoming = env([row("0000000002", "b-1", "2026-08-15T12:00:00Z")]);
    expect(mergePeriodFilings(live, incoming, ours).total).toBe(450);
  });

  it("caps the rows it ships but never the count it reports", () => {
    // A whole season is ~10,700 filings. Shipping them all to every visitor of
    // the Filings view is megabytes for a list nobody scrolls; the count travels
    // alongside so capping the list never understates the quarter.
    const ours = ["0000000002"];
    const many = Array.from({ length: 30 }, (_, i) =>
      row("0000000001", `a-${i}`, `2026-08-14T12:00:${String(i).padStart(2, "0")}Z`));
    const live = env(many, { total: 30, funds: 1 });
    const incoming = env([row("0000000002", "b-1", "2026-08-15T12:00:00Z")]);
    const out = mergePeriodFilings(live, incoming, ours, { cap: 10 });
    expect(out.data).toHaveLength(10);
    expect(out.shown).toBe(10);
    expect(out.total).toBe(31);
    expect(out.funds).toBe(2);
    // Newest first, so what IS shipped is the part of the feed anyone reads.
    expect(out.data[0].accession).toBe("b-1");
  });

  it("still refuses to drop another manager's row, cap or no cap", () => {
    // The safety property is checked on the full merge, BEFORE the display cap —
    // otherwise capping would look like the very data loss the guard exists for.
    const ours = ["0000000002"];
    const live = env([row("0000000001", "a-1", "2026-08-14T12:00:00Z")], { total: 1, funds: 1 });
    const incoming = env([row("0000000002", "b-1", "2026-08-15T12:00:00Z")]);
    const out = mergePeriodFilings(live, incoming, ours, { cap: 5 });
    expect(out.data.some((r) => r.accession === "a-1")).toBe(true);
  });

  it("carries how many managers EDGAR has published, and keeps it when not re-supplied", () => {
    const ours = ["0000000002"];
    const first = mergePeriodFilings(
      env([row("0000000001", "a-1", "2026-08-14T12:00:00Z")]),
      env([row("0000000002", "b-1", "2026-08-15T12:00:00Z")]),
      ours,
      { known: 10698, knownAsOf: "2026-08-18T05:00:00.000Z" },
    );
    expect(first.known).toBe(10698);

    // A later run that could not draw a plan must not erase the denominator.
    const second = mergePeriodFilings(first, env([row("0000000002", "b-2", "2026-08-16T12:00:00Z")]), ours);
    expect(second.known).toBe(10698);
    expect(second.knownAsOf).toBe("2026-08-18T05:00:00.000Z");
  });
});

describe("mergeManifest — period totals from the merged feed", () => {
  const live = {
    buildId: "abc1234",
    coverage: { from: "2025-06-30", to: "2026-06-30" },
    periods: [{ period: "2026-06-30", label: "Q2 2026", deadline: "2026-08-14", filings: 450, funds: 450 }],
    counts: { filers: 9268, filings: 42340, holdings: 32866 },
    funds: {},
  };
  const incoming = {
    buildId: "def5678",
    periods: [{ period: "2026-06-30", label: "Q2 2026", deadline: "2026-08-14", filings: 450, funds: 450 }],
  };

  it("a partial run adds the managers it gave a quarter to, and no more", () => {
    // The count must still CLIMB through a filing season — freezing at one run's
    // sample was the original bug here. But it may only climb by managers this
    // run actually gave the quarter to, counted while merging their summaries.
    //
    // It used to come from the filings feed's distinct CIKs under Math.max: a
    // feed capped at 2,000 rows, accumulating by accession, monotone. That is
    // how the site came to say "10,765 of 10,765 managers loaded" while 8,295
    // fund pages said the manager had not filed.
    const { manifest } = mergeManifest(live, incoming, {
      buildId: "def5678",
      ciks: ["0001067983"],
      periodTotals: { "2026-06-30": { filings: 900, fundsAdded: 12, known: 10698, knownAsOf: "2026-08-18T05:00:00.000Z" } },
    });
    const row = manifest.periods.find((p) => p.period === "2026-06-30");
    expect(row.funds).toBe(462);      // 450 published + the 12 this run added
    expect(row.filings).toBe(900);
    expect(row.known).toBe(10698);
    expect(row.knownAsOf).toBe("2026-08-18T05:00:00.000Z");
  });

  it("a partial run that gave nobody a new quarter leaves the count alone", () => {
    const { manifest } = mergeManifest(live, incoming, {
      buildId: "def5678", ciks: ["0001067983"],
      periodTotals: { "2026-06-30": { filings: 900 } },
    });
    expect(manifest.periods.find((p) => p.period === "2026-06-30").funds).toBe(450);
  });

  it("a run that rebuilt everything sets the count outright, including downwards", () => {
    // Only something that has seen the whole tree may do this. It is how the
    // fabricated 10,765 was replaced with the 8,428 managers who actually hold
    // Q2 2026 — a correction the ratchet made structurally impossible.
    const { manifest } = mergeManifest(
      { ...live, periods: [{ period: "2026-06-30", filings: 10765, funds: 10765 }] },
      { ...incoming, periods: [{ period: "2026-06-30", filings: 1271, funds: 8428 }] },
      { buildId: "def5678", ciks: ["0001067983"], authoritative: true },
    );
    expect(manifest.periods.find((p) => p.period === "2026-06-30").funds).toBe(8428);
  });

  it("never lets a total go backwards on a PARTIAL run, even if the feed read low", () => {
    const { manifest } = mergeManifest(live, incoming, {
      buildId: "def5678",
      ciks: ["0001067983"],
      periodTotals: { "2026-06-30": { filings: 3, fundsAdded: 0 } },
    });
    const row = manifest.periods.find((p) => p.period === "2026-06-30");
    expect(row.filings).toBe(450);
    expect(row.funds).toBe(450);
    expect(verifyMerge(live, manifest)).toEqual([]);
  });

  it("works with no periodTotals at all — the old callers keep working", () => {
    const { manifest } = mergeManifest(live, incoming, { buildId: "def5678", ciks: ["0001067983"] });
    expect(manifest.periods.find((p) => p.period === "2026-06-30").filings).toBe(450);
  });
});

// ---------------------------------------------------------------------------
// THE TWO SHARED FILES THE SAME-DAY JOB REWRITES IN PLACE.
//
// Both were invisible to anyone who had loaded the site before. Artifacts go out
// `max-age=31536000, immutable` behind `?b={buildId}`, the same-day job may not
// touch buildId, and neither of these files had a key of its own — so a merged
// quarter feed and a merged filer index sat at URLs that never changed.
// ---------------------------------------------------------------------------
describe("cache keys for shared files", () => {
  const live = {
    buildId: "abc1234",
    coverage: { from: "2025-06-30", to: "2026-06-30" },
    periods: [{ period: "2026-06-30", label: "Q2 2026", deadline: "2026-08-14", filings: 13, funds: 13 }],
    counts: { filers: 9268, filings: 42340, holdings: 32866 },
    funds: {},
  };
  const incoming = { buildId: "def5678", periods: live.periods };

  it("stamps a key for each shared file the run rewrote, and leaves buildId alone", () => {
    const { manifest } = mergeManifest(live, incoming, {
      buildId: "def5678",
      ciks: ["0001067983"],
      sharedKeys: ["period/2026-06-30/filings.json", "meta/filers.json"],
    });
    expect(manifest.shared["period/2026-06-30/filings.json"]).toBe("def5678");
    expect(manifest.shared["meta/filers.json"]).toBe("def5678");
    expect(manifest.buildId).toBe("abc1234");
    expect(verifyMerge(live, manifest)).toEqual([]);
  });

  it("keeps keys from earlier runs for files this one did not touch", () => {
    const withShared = { ...live, shared: { "meta/filers.json": "old0000" } };
    const { manifest } = mergeManifest(withShared, incoming, {
      buildId: "def5678",
      ciks: ["0001067983"],
      sharedKeys: ["period/2026-06-30/filings.json"],
    });
    expect(manifest.shared["meta/filers.json"]).toBe("old0000");
  });

  it("carries the ingest's problem notes into the published manifest", () => {
    // They were dropped at the merge, which made the watchdog's "the last ingest
    // recorded N problems" check permanently dead for the path that produces them.
    const { manifest } = mergeManifest(live, { ...incoming, notes: ["0001234567: quarantined"] }, {
      buildId: "def5678",
      ciks: ["0001067983"],
    });
    expect(manifest.notes).toEqual(["0001234567: quarantined"]);
  });

  it("caps a very long note list rather than bloating the critical-path file", () => {
    const many = Array.from({ length: 200 }, (_, i) => `fund-${i}: quarantined`);
    const { manifest } = mergeManifest(live, { ...incoming, notes: many }, {
      buildId: "def5678",
      ciks: ["0001067983"],
    });
    expect(manifest.notes).toHaveLength(51);
    expect(manifest.notes.at(-1)).toMatch(/150 more/);
  });

  it("publishes the UNCAPPED count and what it was measured against", () => {
    // Grading `notes.length` grades the cap, and grading a bare count treats a
    // five-hundred-fund run like a thirteen-fund one. The first universe-scale
    // run produced 61 unreconciled filings out of ~1,300 fund-quarters — 4.7%,
    // every one correctly quarantined — and an absolute threshold of 25 turned
    // that into a daily alert about the world being ordinarily messy.
    const many = Array.from({ length: 200 }, (_, i) => `fund-${i}: quarantined`);
    const { manifest } = mergeManifest(live, { ...incoming, notes: many, notesOf: 1300 }, {
      buildId: "def5678",
      ciks: ["0001067983"],
    });
    expect(manifest.notesTotal).toBe(200);
    expect(manifest.notesOf).toBe(1300);
  });
});

describe("mergeFilers", () => {
  const f = (cik, over = {}) => ({
    cik, name: `FUND ${cik}`, code: null, state: "NY",
    periods: 4, latestPeriod: "2026-03-31", latestValueUsd: 1e9, ...over,
  });

  it("adds a manager the universe build has never seen", () => {
    // The whole point: a fund discovered by the same-day path had artifacts in
    // the bucket and no row in the search index, so nobody could navigate to it.
    const live = { kind: "filers", data: [f("0000000001")] };
    const incoming = { kind: "filers", data: [f("0000000002", { latestPeriod: "2026-06-30" })] };
    const out = mergeFilers(live, incoming, ["0000000002"]);
    expect(out.data).toHaveLength(2);
    expect(out.data.find((x) => x.cik === "0000000002").latestPeriod).toBe("2026-06-30");
  });

  it("moves an existing manager forward without losing what only the universe knows", () => {
    // `watch` and `hasHoldings` come from the full data set; a two-quarter fetch
    // has no opinion on them and must not erase them.
    const live = { kind: "filers", data: [f("0000000001", { watch: true, hasHoldings: true })] };
    const incoming = { kind: "filers", data: [f("0000000001", { latestPeriod: "2026-06-30", latestValueUsd: 2e9 })] };
    const out = mergeFilers(live, incoming, ["0000000001"]);
    expect(out.data[0]).toMatchObject({ watch: true, hasHoldings: true, latestPeriod: "2026-06-30", latestValueUsd: 2e9 });
  });

  it("carries every manager this run did not touch through untouched", () => {
    // The 9,000-funds-to-8 rule, one file over.
    const live = { kind: "filers", data: [f("0000000001"), f("0000000003"), f("0000000004")] };
    const incoming = { kind: "filers", data: [f("0000000002", { latestPeriod: "2026-06-30" })] };
    const out = mergeFilers(live, incoming, ["0000000002"]);
    expect(out.data.map((x) => x.cik).sort()).toEqual(["0000000001", "0000000002", "0000000003", "0000000004"]);
  });

  it("ignores incoming rows for CIKs the run was not asked about", () => {
    const live = { kind: "filers", data: [f("0000000001", { latestValueUsd: 1 })] };
    const incoming = { kind: "filers", data: [f("0000000001", { latestValueUsd: 999 })] };
    const out = mergeFilers(live, incoming, ["0000000002"]);
    expect(out.data[0].latestValueUsd).toBe(1);
  });

  it("refuses an empty incoming index", () => {
    expect(() => mergeFilers({ data: [f("0000000001")] }, { data: [] }, ["0000000001"])).toThrow(/no rows/);
  });
});

describe("the same-day allowlist", () => {
  it("permits the fund search index, because something merges it", () => {
    expect(isPublishableDayKey("meta/filers.json")).toBe(true);
  });

  it("still refuses every other shared index", () => {
    expect(isPublishableDayKey("meta/series.json")).toBe(false);
    expect(isPublishableDayKey("meta/periods.json")).toBe(false);
    expect(isPublishableDayKey("period/2026-06-30/leaderboard.json")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The rule that BOTH writers have to obey.
//
// mergeSummary was written for the same-day job and enforced there from day
// one. The monthly universe job wrote summaries wholesale, and on 2026-08-20 it
// dropped Q2 2026 from all 9,268 of them — so the Fund page told a client that
// Cantillon had not filed for Q2 while their 27-position filing had been on the
// site for weeks. The holdings, the feed and the manifest all still had it.
//
// The direction that bit is the one nobody thought about: the SHORTER history
// belonged to the bigger, more authoritative job, because the SEC's bulk file
// for the current quarter does not exist until about a month after the
// deadline.
// ---------------------------------------------------------------------------
describe("a fund summary may never lose a quarter, whichever job writes it", () => {
  const pt = (period) => ({ period, label: period, valueLongUsd: 1, positions: 1 });
  const sum = (periods) => ({ kind: "fund-summary", cik: "0001279936", data: { series: periods.map(pt) } });

  it("keeps the newest quarter when the incoming run does not know about it", () => {
    // Exactly the universe-vs-same-day case.
    const live = sum(["2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"]);
    const incoming = sum(["2025-09-30", "2025-12-31", "2026-03-31"]);
    const out = mergeSummary(live, incoming);
    expect(out.data.series.map((s) => s.period)).toContain("2026-06-30");
    expect(out.data.series).toHaveLength(4);
  });

  it("keeps OLDER quarters when the incoming run is the shallow one", () => {
    // The direction the same-day job guards, still guarded.
    const live = sum(["2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30"]);
    const incoming = sum(["2025-06-30", "2025-09-30"]);
    expect(mergeSummary(live, incoming).data.series).toHaveLength(4);
  });

  it("lets a fresher run UPDATE a quarter both of them have", () => {
    // Merging must not mean freezing: an amended filing has to be able to
    // correct the numbers for a quarter already published.
    const live = { ...sum(["2026-03-31"]), data: { series: [{ ...pt("2026-03-31"), valueLongUsd: 100 }] } };
    const incoming = { ...sum(["2026-03-31"]), data: { series: [{ ...pt("2026-03-31"), valueLongUsd: 999 }] } };
    const out = mergeSummary(live, incoming);
    expect(out.data.series).toHaveLength(1);
    expect(out.data.series[0].valueLongUsd).toBe(999);
  });

  it("refuses an empty incoming series rather than publishing it", () => {
    expect(() => mergeSummary(sum(["2026-03-31"]), sum([]))).toThrow(/no series/);
  });
});

// ---------------------------------------------------------------------------
// Prune, and the quarter it must not delete.
//
// The monthly job covers only quarters whose SEC bulk window exists. During a
// filing season the CURRENT quarter has no window for about a month after the
// deadline, so that job's tree holds nothing for it — while the same-day job
// has been publishing it for weeks.
//
// Prune deletes what is in the bucket and not in the tree. On 2026-08-20 that
// was the whole of Q2 2026: ~10,765 fund-quarters plus the filings feed. It did
// not happen only because prune was crashing on a const used before its
// declaration. The data survived by accident, and fixing that crash alone would
// have destroyed it. The 50% safety rail would not have helped — the current
// quarter is ~24% of the bucket, comfortably under the threshold.
// ---------------------------------------------------------------------------
describe("prune never deletes a quarter the run did not build", () => {
  const BUILT = new Set(["2026-03-31", "2025-12-31"]);

  it("reads the quarter out of every key shape", () => {
    expect(periodOfKey("fund/0001067983/2026-06-30.json")).toBe("2026-06-30");
    expect(periodOfKey("fund/0001067983/2026-06-30.p2.json")).toBe("2026-06-30");
    expect(periodOfKey("period/2026-06-30/filings.json")).toBe("2026-06-30");
    expect(periodOfKey("period/2026-06-30/sectors.json")).toBe("2026-06-30");
    expect(periodOfKey("fund/0001067983/summary.json")).toBeNull();
    expect(periodOfKey("meta/filers.json")).toBeNull();
    expect(periodOfKey("manifest.json")).toBeNull();
  });

  it("SHIELDS the current quarter when this run has no window for it", () => {
    // THE failure. Every one of these was live and would have been deleted.
    for (const k of [
      "fund/0001279936/2026-06-30.json",
      "fund/0001067983/2026-06-30.p3.json",
      "period/2026-06-30/filings.json",
      "period/2026-06-30/sectors.json",
    ]) {
      expect(isPrunableKey(k, BUILT)).toBe(false);
    }
  });

  it("still cleans up quarters it DID build", () => {
    // Otherwise retention never rolls off and the bucket grows forever.
    expect(isPrunableKey("fund/0001067983/2026-03-31.json", BUILT)).toBe(true);
    expect(isPrunableKey("period/2025-12-31/filings.json", BUILT)).toBe(true);
  });

  it("still cleans up objects that belong to no quarter", () => {
    // A fund that stopped filing entirely, a renamed index — ordinary retention.
    expect(isPrunableKey("fund/0009999999/summary.json", BUILT)).toBe(true);
    expect(isPrunableKey("meta/some-old-index.json", BUILT)).toBe(true);
  });

  it("honours the never-touch prefixes", () => {
    expect(isPrunableKey("state/day-cursor.json", BUILT, ["state/"])).toBe(false);
  });

  it("shields EVERYTHING when the run built no quarters at all", () => {
    // A run that produced nothing must not be able to empty the bucket.
    const nothing = new Set();
    expect(isPrunableKey("fund/0001067983/2026-03-31.json", nothing)).toBe(false);
    expect(isPrunableKey("period/2026-03-31/filings.json", nothing)).toBe(false);
  });
});

describe("carryForwardPeriods — the monthly manifest keeps quarters it cannot see", () => {
  const p = (period, funds) => ({ period, label: period, deadline: period, filings: funds, funds });

  it("keeps the current quarter the monthly run has no window for", () => {
    // THE symptom the client reported: Q2 vanished from the quarter selector
    // while its data sat in the bucket.
    const live = { periods: [p("2026-06-30", 10765), p("2026-03-31", 10648)] };
    const incoming = { buildId: "new", periods: [p("2026-03-31", 10648), p("2025-12-31", 10753)] };
    const { manifest, carried } = carryForwardPeriods(live, incoming);
    expect(carried).toEqual(["2026-06-30"]);
    expect(manifest.periods.map((x) => x.period)).toContain("2026-06-30");
    expect(manifest.buildId).toBe("new"); // the monthly run IS authoritative otherwise
  });

  it("newest first, so the quarter selector opens on the right one", () => {
    const live = { periods: [p("2026-06-30", 1)] };
    const incoming = { buildId: "b", periods: [p("2025-12-31", 2), p("2026-03-31", 3)] };
    expect(carryForwardPeriods(live, incoming).manifest.periods.map((x) => x.period))
      .toEqual(["2026-06-30", "2026-03-31", "2025-12-31"]);
  });

  it("lets the monthly run OVERWRITE a quarter it does cover", () => {
    // Carrying forward must not mean freezing: where this run has real coverage
    // its numbers win, because they are the complete ones.
    const live = { periods: [p("2026-03-31", 13)] };          // a thin same-day count
    const incoming = { buildId: "b", periods: [p("2026-03-31", 10648)] };
    const { manifest, carried } = carryForwardPeriods(live, incoming);
    expect(carried).toEqual([]);
    expect(manifest.periods[0].funds).toBe(10648);
  });

  it("refuses an incoming manifest with no periods at all", () => {
    expect(() => carryForwardPeriods({ periods: [p("2026-03-31", 1)] }, { periods: [] }))
      .toThrow(/no periods/);
  });

  it("works when nothing is published yet", () => {
    const incoming = { buildId: "b", periods: [p("2026-03-31", 1)] };
    expect(carryForwardPeriods(null, incoming).manifest.periods).toHaveLength(1);
  });
});

describe("prune must not delete a manager it never built", () => {
  // The monthly job builds from the SEC's bulk windows. A manager who filed for
  // the first time this season has no window yet, so the same-day job is the
  // only thing that has ever heard of them. Their fund/{cik}/summary.json
  // carries no quarter in its key, so it fell through to "no quarter, ordinary
  // retention" and was deleted outright — leaving a 404 Fund page while their
  // holdings sat in the bucket with nothing pointing at them.
  //
  // It never fired, because prune has never once completed: first a temporal
  // dead zone, then an undefined name. Repairing prune is what made it
  // reachable, which is exactly when it needed the rule.
  const BUILT = new Set(["2026-03-31"]);
  const MINE = new Set(["0000000001"]);          // the only manager this run built
  const NEWCOMER = "fund/0000000002/summary.json"; // discovered by the same-day job

  it("leaves the summary of a manager this run never built", () => {
    expect(isPrunableKey(NEWCOMER, BUILT, ["state/"], MINE)).toBe(false);
  });

  it("leaves that manager's holdings too, not just their summary", () => {
    expect(isPrunableKey("fund/0000000002/2026-03-31.json", BUILT, ["state/"], MINE)).toBe(false);
    expect(isPrunableKey("fund/0000000002/2026-03-31.p2.json", BUILT, ["state/"], MINE)).toBe(false);
  });

  it("still prunes a manager this run DID build, when the run no longer produces the file", () => {
    // Retention has to keep working. Only the unknown are protected.
    expect(isPrunableKey("fund/0000000001/summary.json", BUILT, ["state/"], MINE)).toBe(true);
    expect(isPrunableKey("fund/0000000001/2026-03-31.json", BUILT, ["state/"], MINE)).toBe(true);
  });

  it("still refuses a quarter this run has no window for, however the CIK reads", () => {
    expect(isPrunableKey("fund/0000000001/2025-06-30.json", BUILT, ["state/"], MINE)).toBe(false);
  });

  it("the cursor stays protected regardless", () => {
    expect(isPrunableKey("state/ingest-cursor.json", BUILT, ["state/"], MINE)).toBe(false);
    expect(isPrunableKey("state/ingest-cursor.json", BUILT, ["state/"], null)).toBe(false);
  });

  it("without a CIK set the old behaviour is unchanged", () => {
    // The same-day job calls this with three arguments and must not shift.
    expect(isPrunableKey(NEWCOMER, BUILT, ["state/"])).toBe(true);
  });

  it("the monthly publish passes the CIK set", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../scripts/publish-r2.mjs", import.meta.url), "utf8");
    expect(src).toContain("const builtCiks = new Set(");
    expect(src).toContain("isPrunableKey(k, builtPeriods, PROTECTED_PREFIXES, builtCiks)");
  });
});
