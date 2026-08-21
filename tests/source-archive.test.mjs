// tests/source-archive.test.mjs
//
// Keeping the SEC's own files instead of downloading them and throwing them away.
//
// Nothing kept a copy of anything until now: `.cache/` is gitignored and is not
// persisted between workflow runs, so every monthly build downloaded ~345 MB of
// SEC bulk data, built the dashboard from it, and discarded it. The dashboard's
// own JSON files were the only copy of the data in existence, and that one fact
// produced every failure this project has had.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SOURCE_PREFIX, windowsFrom, windowsToDrop } from "../shared/source-archive.mjs";
import { deraWindowStart } from "../shared/calendar.mjs";

const keys = (...slugs) => new Map(slugs.map((s, i) => [`${SOURCE_PREFIX}${s}_form13f.zip`, 90_000_000 + i]));

describe("reading the window name", () => {
  it("parses the start date out of a slug", () => {
    expect(deraWindowStart("01mar2026-31may2026")).toBe("2026-03-01");
    expect(deraWindowStart("01dec2025-28feb2026")).toBe("2025-12-01");
    expect(deraWindowStart("01sep2025-30nov2025")).toBe("2025-09-01");
    expect(deraWindowStart("01jun2026-31aug2026")).toBe("2026-06-01");
  });

  it("returns null rather than a wrong date for anything else", () => {
    expect(deraWindowStart("garbage")).toBeNull();
    expect(deraWindowStart("01xyz2026-31may2026")).toBeNull();
    expect(deraWindowStart("")).toBeNull();
    expect(deraWindowStart(undefined)).toBeNull();
  });
});

describe("what is archived", () => {
  it("recognises archived windows and ignores everything else in the bucket", () => {
    const all = new Map([
      ...keys("01mar2026-31may2026", "01dec2025-28feb2026"),
      ["fund/0001279936/summary.json", 3000],
      ["manifest.json", 38018],
      ["state/ingest-cursor.json", 900],
      ["source/dera/not-a-window.txt", 12],
    ]);
    const w = windowsFrom(all);
    expect([...w.keys()].sort()).toEqual(["01dec2025-28feb2026", "01mar2026-31may2026"]);
  });

  it("carries the size and the real start date", () => {
    const w = windowsFrom(keys("01mar2026-31may2026"));
    expect(w.get("01mar2026-31may2026")).toMatchObject({ start: "2026-03-01", size: 90_000_000 });
  });
});

describe("retention", () => {
  // THE ORDERING TRAP. Slugs use month abbreviations, so they do not sort
  // lexically: "01sep2025-30nov2025" sorts AFTER "01mar2026-31may2026" by name.
  // Keeping "the last four by name" would delete the newest window and keep the
  // oldest — verified against the real four in .cache before this was written.
  const FIVE = keys(
    "01mar2026-31may2026",   // 2026-03-01, newest but one
    "01dec2025-28feb2026",   // 2025-12-01
    "01sep2025-30nov2025",   // 2025-09-01
    "01dec2024-28feb2025",   // 2024-12-01, oldest
    "01jun2026-31aug2026",   // 2026-06-01, newest
  );

  it("keeps the most recent four by DATE, not by name", () => {
    const dropped = windowsToDrop(windowsFrom(FIVE), 4).map((d) => d.slug);
    expect(dropped).toEqual(["01dec2024-28feb2025"]);
  });

  it("a lexical sort would have dropped the wrong one", () => {
    // Pinned so nobody 'simplifies' the comparator back to a string sort.
    const byName = [...windowsFrom(FIVE).keys()].sort();
    expect(byName[0]).toBe("01dec2024-28feb2025");
    expect(byName.at(-1)).toBe("01sep2025-30nov2025"); // the SECOND OLDEST, sorted last
  });

  it("drops nothing when there are fewer than the keep count", () => {
    expect(windowsToDrop(windowsFrom(keys("01mar2026-31may2026")), 4)).toEqual([]);
  });

  it("drops in oldest-first order", () => {
    const dropped = windowsToDrop(windowsFrom(FIVE), 2).map((d) => d.slug);
    expect(dropped).toEqual(["01dec2025-28feb2026", "01sep2025-30nov2025", "01dec2024-28feb2025"]);
  });

  it("keeping zero drops everything, rather than silently keeping all", () => {
    expect(windowsToDrop(windowsFrom(FIVE), 0)).toHaveLength(5);
  });
});

describe("the archive must survive the thing that deletes", () => {
  it("prune protects source/", () => {
    // isPrunableKey treats a key with no quarter in it as ordinary retention, so
    // without this the monthly prune deletes the entire store of record: 345 MB
    // that costs a day of SEC downloads to replace, and whose whole purpose is
    // to survive a bad publish.
    const src = readFileSync(new URL("../scripts/publish-r2.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/PROTECTED_PREFIXES = \[[^\]]*"source\/"/);
  });

  it("and isPrunableKey honours it", async () => {
    const { isPrunableKey } = await import("../shared/manifest-merge.mjs");
    const built = new Set(["2026-06-30"]);
    expect(isPrunableKey("source/dera/01mar2026-31may2026_form13f.zip", built, ["state/", "source/"])).toBe(false);
    // ...and would have deleted it without the prefix, which is the whole point.
    expect(isPrunableKey("source/dera/01mar2026-31may2026_form13f.zip", built, ["state/"])).toBe(true);
  });
});

describe("the monthly build reads the archive before asking the SEC", () => {
  const src = readFileSync(new URL("../scripts/ingest-dera.mjs", import.meta.url), "utf8");

  it("tries the archive first", () => {
    expect(src).toContain("readArchivedWindow(");
    expect(src.indexOf("readArchivedWindow(w.slug")).toBeLessThan(src.indexOf("log(`fetching ${w.url}`)"));
  });

  it("an archive failure falls through to the SEC rather than failing the build", () => {
    // The archive being down must never cost a build — before it existed, the
    // next move was always "ask the SEC", and that stays true.
    const fn = src.slice(src.indexOf("async function readArchivedWindow"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toMatch(/catch \(err\)[\s\S]*return null/);
  });
});

describe("filings fetched directly from EDGAR", () => {
  it("are keyed by quarter and accession", async () => {
    const { edgarSourceKey } = await import("../shared/source-archive.mjs");
    expect(edgarSourceKey("2026-06-30", "0001279936-26-000005"))
      .toBe("source/edgar/2026-06-30/0001279936-26-000005.json.gz");
  });

  it("a quarter is superseded only once a window covering its DEADLINE is archived", async () => {
    const { edgarQuartersSupersededBy } = await import("../shared/source-archive.mjs");
    // A DERA window is keyed by FILING date, and a quarter's filings land in the
    // window containing its deadline — Q2 2026 is due 14 Aug, so it is covered
    // by 01jun2026-31aug2026 and by nothing earlier. Getting this wrong in the
    // permissive direction deletes the only copy of a quarter.
    const deadlines = { "2026-03-31": "2026-05-15", "2026-06-30": "2026-08-14", "2026-09-30": "2026-11-16" };
    const covered = edgarQuartersSupersededBy(
      new Map([["01mar2026-31may2026", { start: "2026-03-01" }], ["01jun2026-31aug2026", { start: "2026-06-01" }]]),
      deadlines,
    );
    expect([...covered].sort()).toEqual(["2026-03-31", "2026-06-30"]);
  });

  it("the CURRENT quarter is not superseded before its window is published", async () => {
    const { edgarQuartersSupersededBy } = await import("../shared/source-archive.mjs");
    // This is the case that matters: for about six weeks after a deadline, the
    // directly-fetched records are the only copy of the quarter that exists.
    const covered = edgarQuartersSupersededBy(
      new Map([["01mar2026-31may2026", { start: "2026-03-01" }]]),
      { "2026-06-30": "2026-08-14" },
    );
    expect(covered.has("2026-06-30")).toBe(false);
  });

  it("nothing archived supersedes nothing", async () => {
    const { edgarQuartersSupersededBy } = await import("../shared/source-archive.mjs");
    expect(edgarQuartersSupersededBy(new Map(), { "2026-06-30": "2026-08-14" }).size).toBe(0);
  });

  it("the same-day ingest keeps the as-filed rows for the archive, then releases them", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../scripts/ingest-funds.mjs", import.meta.url), "utf8");
    // Aggregation drops other_manager, per-row class, voting authority and FIGI.
    // A store of record holding only the aggregate could not survive a parser
    // fix — it could only be re-downloaded.
    expect(src).toContain("raw: rows,");
    expect(src).toContain("writeSourceRecord(period, full);");
    // ...and then lets them go, or the monthly build would hold every filer's
    // raw table in memory at once.
    expect(src).toContain("delete full.raw;");
    expect(src.indexOf("writeSourceRecord(period, full);")).toBeLessThan(src.indexOf("delete full.raw;"));
  });
});

describe("a quarter's coverage may not shrink — the 3 September event", () => {
  // On 3 Sept the monthly job runs BEFORE the SEC publishes the bulk window
  // covering the Q2 2026 deadline. It will hold Q2 for only the handful of funds
  // the same-day job archived directly; every other manager's Q2 came from the
  // repair and lives in artifacts, not in the source archive.
  //
  // `builtPeriods` asks only "did this run produce anything for that quarter?",
  // so the quarter counts as built and all 8,428 managers holding it would have
  // had it deleted. That is the 2026-08-20 outage rescheduled — and prune works
  // now, so it would actually have happened.
  const src = readFileSync(new URL("../scripts/publish-r2.mjs", import.meta.url), "utf8");

  it("prune compares what the run produced for a quarter against what is published", () => {
    expect(src).toContain("COVERAGE_FLOOR");
    expect(src).toContain("builtPeriods.delete(period)");
  });

  it("the comparison happens BEFORE anything is selected for deletion", () => {
    expect(src.indexOf("builtPeriods.delete(period)"))
      .toBeLessThan(src.indexOf("const stale = [...current.keys()].filter("));
  });

  it("a thin quarter is reported, not silently skipped", () => {
    // "Nothing was deleted" and "nothing needed deleting" must not look the
    // same — that is how prune stayed invisible for its whole existence.
    const at = src.indexOf("not pruning ${t.period}");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 900)).toContain("unfinished.note(");
  });

  it("the floor admits ordinary churn but not a partial build", () => {
    // 8,428 published against 3 produced is 0.04%. A retention roll-off moves a
    // whole quarter out at once, which `builtPeriods` already shields.
    const m = /const COVERAGE_FLOOR = ([\d.]+);/.exec(src);
    expect(m).toBeTruthy();
    const floor = Number(m[1]);
    expect(3 / 8428).toBeLessThan(floor);
    expect(floor).toBeGreaterThan(0.9);
    expect(floor).toBeLessThanOrEqual(1);
  });
});
