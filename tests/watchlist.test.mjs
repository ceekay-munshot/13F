// tests/watchlist.test.mjs
//
// The client's fund list is now read by BOTH the dashboard and the ingest
// planner, which promoted it from a display constant to something the pipeline
// schedules on. A typo here no longer just mislabels a column — it silently
// drops a fund out of the priority queue, and the symptom is "why is our fund
// missing", days later, from a client.

import { describe, it, expect } from "vitest";
import { CLIENT_WATCHLIST, WATCHLIST_CIKS } from "../shared/watchlist.mjs";

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
