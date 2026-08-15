// tests/defaults.test.ts
//
// What the dashboard opens on. This is not cosmetic: the first screen was an
// empty state reading "VANGUARD GROUP INC has not filed for Q1 2026", because
// the opening fund was `filers[0]` — the filer index is ordered for lookup, not
// for interest, and its first entry stopped filing in 2024.

import { describe, it, expect } from "vitest";
import { defaultFilerCik, defaultPeriod, type Filer, type Manifest } from "../src/lib/data";
import { deadlinePhrase } from "../src/lib/format";

const filer = (over: Partial<Filer> & { cik: string }): Filer => ({
  name: `FUND ${over.cik}`,
  code: null,
  state: null,
  periods: 4,
  latestPeriod: "2026-03-31",
  latestValueUsd: 1e9,
  ...over,
});

const PERIOD = "2026-03-31";

describe("defaultFilerCik", () => {
  it("never opens on a manager who stopped filing before the opening quarter", () => {
    // THE bug, reduced: a dormant filer sorted first.
    const filers = [
      filer({ cik: "0000102909", name: "VANGUARD GROUP INC", latestPeriod: "2024-12-31", latestValueUsd: 5e12 }),
      filer({ cik: "0001067983", name: "BERKSHIRE HATHAWAY INC", latestValueUsd: 3e11, watch: true }),
    ];
    expect(defaultFilerCik(filers, PERIOD)).toBe("0001067983");
  });

  it("prefers the largest CURATED manager, so Fund and Consensus talk about the same funds", () => {
    const filers = [
      filer({ cik: "0000000001", latestValueUsd: 9e12 }), // huge, but not curated
      filer({ cik: "0000000002", latestValueUsd: 2e11, watch: true }),
      filer({ cik: "0000000003", latestValueUsd: 8e11, watch: true }), // largest curated
    ];
    expect(defaultFilerCik(filers, PERIOD)).toBe("0000000003");
  });

  it("falls back to the largest filer when none are curated", () => {
    const filers = [
      filer({ cik: "0000000001", latestValueUsd: 1e9 }),
      filer({ cik: "0000000002", latestValueUsd: 7e11 }),
      filer({ cik: "0000000003", latestValueUsd: 4e10 }),
    ];
    expect(defaultFilerCik(filers, PERIOD)).toBe("0000000002");
  });

  it("skips filers that have metadata but no holdings retained", () => {
    // Holdings are kept for 4 quarters across ~9,300 filers; metadata is kept
    // for all of them, all the way back. A filer with no holdings renders empty.
    const filers = [
      filer({ cik: "0000000001", latestValueUsd: 9e12, hasHoldings: false }),
      filer({ cik: "0000000002", latestValueUsd: 1e9, hasHoldings: true }),
    ];
    expect(defaultFilerCik(filers, PERIOD)).toBe("0000000002");
  });

  it("still returns something rather than null when every filer is stale", () => {
    // A dead-end is worse than a stale-but-labelled fund: the view explains
    // "has not filed", the null case renders nothing at all.
    const filers = [filer({ cik: "0000000009", latestPeriod: "2019-12-31" })];
    expect(defaultFilerCik(filers, PERIOD)).toBe("0000000009");
  });

  it("returns null only when there are no filers", () => {
    expect(defaultFilerCik([], PERIOD)).toBeNull();
  });

  it("treats a null period as no constraint", () => {
    const filers = [filer({ cik: "0000000001", latestPeriod: "2020-12-31", latestValueUsd: 5e11 })];
    expect(defaultFilerCik(filers, null)).toBe("0000000001");
  });

  it("handles a missing reported value without crashing the sort", () => {
    const filers = [
      filer({ cik: "0000000001", latestValueUsd: null }),
      filer({ cik: "0000000002", latestValueUsd: 1 }),
    ];
    expect(defaultFilerCik(filers, PERIOD)).toBe("0000000002");
  });
});

describe("defaultPeriod and defaultFilerCik agree", () => {
  const mf = {
    coverage: { from: "2008-03-31", to: "2026-06-30", holdingsFrom: "2025-06-30" },
    periods: [
      { period: "2025-09-30", label: "Q3 2025", deadline: "2025-11-14", filings: 8500, funds: 8400 },
      { period: "2025-12-31", label: "Q4 2025", deadline: "2026-02-17", filings: 8600, funds: 8500 },
      { period: "2026-03-31", label: "Q1 2026", deadline: "2026-05-15", filings: 8598, funds: 8472 },
      // The just-closed quarter: a handful of early filers, nowhere near quorum.
      { period: "2026-06-30", label: "Q2 2026", deadline: "2026-08-14", filings: 12, funds: 11 },
    ],
  } as unknown as Manifest;

  it("opens on the NEWEST quarter, even when only a few funds have filed", () => {
    // This asserted the opposite until 2026-08-15, when twelve of fourteen
    // tracked funds had filed for Q2 2026 and the dashboard still opened on Q1.
    // The old rule demanded 60% of the busiest quarter's filer count — a
    // threshold computed against 10,753 UNIVERSE filers, for a dashboard that
    // compares thirteen managers. 13 is 0.1% of 10,753, so the quarter the user
    // came to look at could never win.
    expect(defaultPeriod(mf)).toBe("2026-06-30");
  });

  it("cannot open on an empty quarter, because an empty quarter is not listed", () => {
    // What the quorum was really guarding against. A period only enters the
    // manifest once something has been filed for it, so between a quarter
    // ending and its deadline six weeks later the newest entry is still the
    // last complete one. The data shape does the job the threshold was doing.
    const beforeAnyoneFiles = {
      coverage: { from: "2008-03-31", to: "2026-03-31", holdingsFrom: "2025-06-30" },
      periods: [
        { period: "2025-12-31", label: "Q4 2025", deadline: "2026-02-17", filings: 8600, funds: 8500 },
        { period: "2026-03-31", label: "Q1 2026", deadline: "2026-05-15", filings: 8598, funds: 8472 },
      ],
    } as unknown as Manifest;
    expect(defaultPeriod(beforeAnyoneFiles)).toBe("2026-03-31");
  });

  it("opens on a quarter with a single filing rather than skipping it", () => {
    const oneFiler = {
      coverage: { from: "2008-03-31", to: "2026-06-30", holdingsFrom: "2025-06-30" },
      periods: [
        { period: "2026-03-31", label: "Q1 2026", deadline: "2026-05-15", filings: 8598, funds: 8472 },
        { period: "2026-06-30", label: "Q2 2026", deadline: "2026-08-14", filings: 1, funds: 1 },
      ],
    } as unknown as Manifest;
    // Thin, and labelled as thin by the KPI row — but it is the quarter the
    // user is here for, and one click away is one click too many.
    expect(defaultPeriod(oneFiler)).toBe("2026-06-30");
  });

  it("the opening fund has data for the opening quarter", () => {
    // The two defaults are chosen independently, so this asserts they cannot
    // drift into the combination that produced an empty first screen.
    const period = defaultPeriod(mf);
    const filers = [
      filer({ cik: "0000102909", latestPeriod: "2024-12-31", latestValueUsd: 5e12 }),
      filer({ cik: "0001067983", latestPeriod: "2026-06-30", latestValueUsd: 3e11, watch: true }),
    ];
    const cik = defaultFilerCik(filers, period);
    const chosen = filers.find((f) => f.cik === cik)!;
    expect(chosen.latestPeriod! >= period).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Series ordering.
//
// The two ingest paths emit a fund's series in OPPOSITE orders and neither
// records which: scripts/ingest-funds.mjs walks quarters newest->oldest then
// reverses (=> ascending), scripts/ingest-dera.mjs walks them oldest->newest
// then reverses (=> descending). The universe ingest is what serves production,
// so the frontend's "stored oldest-first" assumption was wrong in prod: the
// reported-value bars ran backwards in time, "most recent filing" named the
// OLDEST quarter, and each quarter was diffed against the one AFTER it.
//
// loadFundSummary now sorts on arrival. These assert the consumer contract that
// depends on it, using the real shape observed live for CIK 0001067983.
// ---------------------------------------------------------------------------
describe("series ordering is normalised, not trusted", () => {
  const asc = <T extends { period: string }>(s: T[]): T[] =>
    [...s].sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));

  const DESC = [{ period: "2026-03-31" }, { period: "2025-12-31" }, { period: "2024-12-31" }];
  const ASC = [{ period: "2024-12-31" }, { period: "2025-12-31" }, { period: "2026-03-31" }];

  it("puts a DERA-written (descending) series oldest-first", () => {
    expect(asc(DESC).map((p) => p.period)).toEqual([
      "2024-12-31", "2025-12-31", "2026-03-31",
    ]);
  });

  it("leaves an already-ascending series alone", () => {
    expect(asc(ASC)).toEqual(ASC);
  });

  it("makes both producers converge on the same array", () => {
    expect(asc(DESC)).toEqual(asc(ASC));
  });

  it("makes the LAST element the newest quarter, for either input", () => {
    // latestPoint is read off the end. Off-by-one here is what rendered
    // "most recent filing is Q4 2024" for a manager that filed in Q4 2025.
    for (const input of [DESC, ASC]) {
      expect(asc(input).at(-1)!.period).toBe("2026-03-31");
    }
  });

  it("makes index-1 the genuinely PRIOR quarter", () => {
    // The delta bug: against a descending array, index-1 is the NEWER quarter,
    // so Q4 2025 was being compared with Q1 2026 as though Q1 came first.
    const s = asc(DESC);
    const i = s.findIndex((p) => p.period === "2025-12-31");
    expect(s[i - 1].period).toBe("2024-12-31");
    expect(s[i - 1].period < s[i].period).toBe(true);
  });

  it("is stable for a single-quarter fund", () => {
    expect(asc([{ period: "2026-03-31" }]).at(-1)!.period).toBe("2026-03-31");
    expect(asc([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deadlinePhrase
//
// "Q2 2026 due 14 Aug 2026", shown on 15 August. A date in the past, labelled
// as though it were still coming — which reads as a stale dashboard, the one
// impression this product cannot afford.
// ---------------------------------------------------------------------------
describe("deadlinePhrase", () => {
  const Q = "2026-06-30";
  const D = "2026-08-14";

  it("says 'due' while the deadline is still ahead", () => {
    expect(deadlinePhrase(Q, D, 12)).toBe("Q2 2026 due 14 Aug 2026");
  });

  it("says tomorrow and today rather than making you count", () => {
    expect(deadlinePhrase(Q, D, 1)).toBe("Q2 2026 due tomorrow, 14 Aug 2026");
    expect(deadlinePhrase(Q, D, 0)).toBe("Q2 2026 due today");
  });

  it("switches to the PAST TENSE once the deadline has gone", () => {
    // THE bug. A deadline that has passed is not a deadline.
    expect(deadlinePhrase(Q, D, -1)).toBe("Q2 2026 closed 14 Aug 2026");
    expect(deadlinePhrase(Q, D, -40)).toBe("Q2 2026 closed 14 Aug 2026");
  });

  it("never drops the date", () => {
    // "closed 5 days ago" is worse than a date you can check on a calendar.
    for (const d of [30, 1, 0, -1, -90]) {
      const out = deadlinePhrase(Q, D, d);
      if (d !== 0) expect(out).toContain("14 Aug 2026");
    }
  });
});
