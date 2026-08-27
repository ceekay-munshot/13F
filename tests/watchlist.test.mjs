// tests/watchlist.test.mjs
//
// The client's fund list is now read by BOTH the dashboard and the ingest
// planner, which promoted it from a display constant to something the pipeline
// schedules on. A typo here no longer just mislabels a column — it silently
// drops a fund out of the priority queue, and the symptom is "why is our fund
// missing", days later, from a client.

import { describe, it, expect } from "vitest";
import { CLIENT_WATCHLIST, WATCHLIST_CIKS, SUCCEEDED_BY, migrateCiks } from "../shared/watchlist.mjs";

describe("the client watchlist", () => {
  it("uses ten-digit zero-padded CIKs, the form every artifact path uses", () => {
    // `1067983` matches no `fund/0001067983/` key, so an unpadded entry is
    // prioritised, fetched, and then published nowhere.
    for (const f of CLIENT_WATCHLIST) {
      expect(f.cik, `${f.label} (${f.code})`).toMatch(/^\d{10}$/);
    }
  });

  it("has no duplicate CIKs", () => {
    expect(new Set(WATCHLIST_CIKS).size).toBe(WATCHLIST_CIKS.length);
  });

  it("has unique short codes, because they are the matrix column headings", () => {
    // Two funds sharing a code makes two columns indistinguishable — the exact
    // problem the universe build's code assignment was rewritten to avoid.
    const codes = CLIENT_WATCHLIST.map((f) => f.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("gives every fund a label and a code", () => {
    for (const f of CLIENT_WATCHLIST) {
      expect(f.label?.length, f.cik).toBeGreaterThan(0);
      expect(f.code?.length, f.cik).toBeGreaterThan(0);
    }
  });

  it("is not empty — an empty list silently disables prioritisation", () => {
    expect(CLIENT_WATCHLIST.length).toBeGreaterThan(0);
  });

  it("exports the CIKs in the same order as the funds", () => {
    // The planner takes them in order, so this IS the fetch order.
    expect(WATCHLIST_CIKS).toEqual(CLIENT_WATCHLIST.map((f) => f.cik));
  });
});

// ---------------------------------------------------------------------------
// FOLLOWING A MANAGER WHOSE REPORTING MOVED
// ---------------------------------------------------------------------------
//
// Editing the list above only changes what a NEW visitor sees. The per-user set
// lives in localStorage, written the first time that browser loaded the page,
// and it keeps whatever CIK was current that day.
//
// So when Pershing Square's book moved to its parent, repointing the list
// reached nobody who had ever used the dashboard: they kept a struck-through
// empty column headed "PER" — the list no longer had a short code for that CIK,
// so it fell back to the first three letters of the filed name — and the page
// said "no filing this quarter" about a manager that had filed on the deadline.
describe("migrating a saved fund list", () => {
  it("moves a superseded manager to the entity that reports its holdings now", () => {
    expect(migrateCiks(["0001067983", "0001336528", "0001960830"]))
      .toEqual(["0001067983", "0002026053", "0001960830"]);
  });

  it("keeps the successor in the OLD entry's place, never appended", () => {
    // The order is the client's own ranking of their funds. Moving a manager to
    // the end of the list is a silent re-ranking they did not ask for.
    const out = migrateCiks(["0001336528", "0001067983"]);
    expect(out[0]).toBe("0002026053");
  });

  it("collapses a list that already holds both into one column", () => {
    // Two columns for one book is worse than the stale column this removes.
    expect(migrateCiks(["0002026053", "0001336528"])).toEqual(["0002026053"]);
    expect(migrateCiks(["0001336528", "0002026053"])).toEqual(["0002026053"]);
  });

  it("leaves a list with nothing superseded exactly as it was", () => {
    // The common case by far, and it must be byte-identical or every browser
    // rewrites its storage on every load.
    const same = ["0001067983", "0001061165", "0001279936"];
    expect(migrateCiks(same)).toEqual(same);
  });

  it("never resurrects a fund the user deliberately removed", () => {
    // Only entries actually present are rewritten. A user who dropped Pershing
    // Square gets a list without it, not one with its parent put back.
    expect(migrateCiks(["0001067983"])).toEqual(["0001067983"]);
    expect(migrateCiks([])).toEqual([]);
  });

  it("survives a corrupted saved value rather than breaking the page it loads on", () => {
    expect(migrateCiks(null)).toEqual([]);
    expect(migrateCiks("0001336528")).toEqual([]);
    expect(migrateCiks(["0001067983", 42, null, undefined])).toEqual(["0001067983"]);
  });

  it("only maps to CIKs in the ten-digit form every artifact path uses", () => {
    for (const [from, to] of Object.entries(SUCCEEDED_BY)) {
      expect(from).toMatch(/^\d{10}$/);
      expect(to).toMatch(/^\d{10}$/);
    }
  });

  it("never points a successor at something itself superseded", () => {
    // A chain would need repeated application to settle, and migrateCiks passes
    // once. Kept flat instead: resolve the chain here, in the map.
    for (const to of Object.values(SUCCEEDED_BY)) {
      expect(SUCCEEDED_BY[to]).toBeUndefined();
    }
  });

  it("does not strand the live list on a CIK it has already superseded", () => {
    // The map and the list have to agree, or a new visitor is seeded with an
    // entity we already know stopped reporting.
    for (const f of CLIENT_WATCHLIST) {
      expect(SUCCEEDED_BY[f.cik], `${f.label} is superseded but still seeded`).toBeUndefined();
    }
  });
});
