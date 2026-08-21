// tests/filer-index.test.mjs
//
// meta/filers.json is the fund search index — the only way to reach a manager's
// page by name, and where the site states which quarter each manager last filed.
//
// Both writers touch it and each knows something the other does not:
//   - the same-day job fetches TWO quarters, so it knows the newest quarter and
//     nothing about history;
//   - the monthly job rebuilds every fund from whatever DERA windows exist that
//     day, so it knows history and may not yet know the newest quarter.
//
// `{ ...prev, ...next }` let whichever ran last erase the other's knowledge.
// Measured on the live index before this fix: 853 of the 987 managers the
// same-day job had touched were advertising fewer quarters than they held.

import { describe, it, expect } from "vitest";
import { mergeFilerRow, mergeFilers } from "../shared/manifest-merge.mjs";

const row = (over = {}) => ({
  cik: "0001279936", name: "CANTILLON CAPITAL MANAGEMENT LLC", code: null, state: "NY",
  periods: 4, latestPeriod: "2026-03-31", latestValueUsd: 755_000_000,
  hasHoldings: true, watch: 1, ...over,
});

describe("a publish may add and it may correct — it may not subtract", () => {
  it("a two-quarter run does not shrink a four-quarter manager", () => {
    // The bug that was live: 1ST SOURCE BANK held 4 quarters and its search
    // entry said 2, because the same-day run only ever fetches 2.
    const merged = mergeFilerRow(row({ periods: 4 }), row({ periods: 2, latestPeriod: "2026-06-30" }));
    expect(merged.periods).toBe(4);
    expect(merged.latestPeriod).toBe("2026-06-30");
  });

  it("a monthly rebuild missing the newest window does not move the quarter backwards", () => {
    // Due 3 September: the universe job runs before the DERA window covering
    // the Q2 deadline publishes, rebuilds every fund without Q2, and writes its
    // own index over the top.
    const live = row({ periods: 5, latestPeriod: "2026-06-30", latestValueUsd: 665_113_090 });
    const rebuild = row({ periods: 4, latestPeriod: "2026-03-31", latestValueUsd: 755_000_000 });
    const merged = mergeFilerRow(live, rebuild);
    expect(merged.latestPeriod).toBe("2026-06-30");
    expect(merged.periods).toBe(5);
  });

  it("the newest quarter drags its own value with it", () => {
    // Taking the period from one side and the value from the other is how a
    // reference site shows one quarter's total under another quarter's label.
    const live = row({ latestPeriod: "2026-06-30", latestValueUsd: 665_113_090 });
    const older = row({ latestPeriod: "2026-03-31", latestValueUsd: 755_000_000 });
    expect(mergeFilerRow(live, older)).toMatchObject({
      latestPeriod: "2026-06-30", latestValueUsd: 665_113_090,
    });
    // and the same when the fresher side is the incoming one
    expect(mergeFilerRow(older, live)).toMatchObject({
      latestPeriod: "2026-06-30", latestValueUsd: 665_113_090,
    });
  });

  it("a genuinely newer run still corrects the value for the same quarter", () => {
    // Correcting is allowed. Only subtracting is not.
    const merged = mergeFilerRow(
      row({ latestPeriod: "2026-06-30", latestValueUsd: 1 }),
      row({ latestPeriod: "2026-06-30", latestValueUsd: 665_113_090 }),
    );
    expect(merged.latestValueUsd).toBe(665_113_090);
  });
});

describe("fields each writer alone can see", () => {
  it("a two-quarter fetch cannot clear watchlist membership it never knew about", () => {
    expect(mergeFilerRow(row({ watch: true }), row({ watch: false })).watch).toBe(true);
    expect(mergeFilerRow(row({ watch: true }), row({ watch: undefined })).watch).toBe(true);
  });

  it("whichever side wins keeps its own type", () => {
    // The published index holds booleans for 9,268 managers and leaves the field
    // undefined for the 14 the same-day job found. Coercing to 1/0 would rewrite
    // the shape of a file the dashboard already reads.
    expect(mergeFilerRow(row({ watch: false }), row({ watch: false })).watch).toBe(false);
    expect(mergeFilerRow(row({ watch: 1 }), row({ watch: 0 })).watch).toBe(1);
  });

  it("hasHoldings follows the incoming run and is NOT or-ed", () => {
    // It promises fund/{cik}/{period} line items exist. prune deletes those when
    // a rebuild stops storing them, so a carried-over `true` advertises a 404.
    expect(mergeFilerRow(row({ hasHoldings: true }), row({ hasHoldings: false })).hasHoldings).toBe(false);
  });

  it("a fresher name and state win", () => {
    const merged = mergeFilerRow(row({ name: "OLD NAME", state: "XX" }), row({ name: "NEW NAME", state: "NY" }));
    expect(merged).toMatchObject({ name: "NEW NAME", state: "NY" });
  });

  it("either side missing is not a merge", () => {
    expect(mergeFilerRow(null, row({ periods: 2 })).periods).toBe(2);
    expect(mergeFilerRow(row({ periods: 7 }), null).periods).toBe(7);
  });
});

describe("the whole index", () => {
  const idx = (rows) => ({ v: 1, kind: "filers", data: rows });

  it("keeps managers this run never spoke for", () => {
    const live = idx([row({ cik: "0000000001" }), row({ cik: "0000000002" })]);
    const mine = idx([row({ cik: "0000000001", periods: 9 })]);
    const out = mergeFilers(live, mine, ["0000000001"]);
    expect(out.data).toHaveLength(2);
    expect(out.data.find((r) => r.cik === "0000000001").periods).toBe(9);
  });

  it("ignores rows for managers this run does not speak for", () => {
    const live = idx([row({ cik: "0000000001", periods: 4 })]);
    const mine = idx([row({ cik: "0000000001", periods: 1 }), row({ cik: "0000000009" })]);
    const out = mergeFilers(live, mine, ["0000000009"]);
    expect(out.data.find((r) => r.cik === "0000000001").periods).toBe(4);
    expect(out.data.find((r) => r.cik === "0000000009")).toBeTruthy();
  });

  it("refuses to publish an index that would shrink", () => {
    const live = idx([row({ cik: "0000000001" }), row({ cik: "0000000002" })]);
    expect(() => mergeFilers(live, idx([]), ["0000000001"])).toThrow(/no rows/);
  });

  it("refuses an incoming index with no rows at all", () => {
    expect(() => mergeFilers(idx([row()]), idx([]), [])).toThrow(/refusing to publish/);
  });
});

describe("both publishers actually use it", () => {
  it("the monthly job merges the search index rather than overwriting it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../scripts/publish-r2.mjs", import.meta.url), "utf8");
    expect(src).toContain('f === "meta/filers.json"');
    expect(src).toContain("mergeFilers(live, mine, ciks)");
  });

  it("the same-day job still does too", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../scripts/publish-day.mjs", import.meta.url), "utf8");
    expect(src).toContain("mergeFilers(liveFilers, mineFilers, publishing)");
  });
});
