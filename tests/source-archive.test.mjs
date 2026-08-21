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
