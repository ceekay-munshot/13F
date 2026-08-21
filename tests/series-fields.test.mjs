// tests/series-fields.test.mjs
//
// meta/series.json stores each fund-quarter as a POSITIONAL ARRAY — the key
// names would otherwise repeat once per fund per quarter across nine thousand
// funds. So the names live elsewhere, and they lived in two elsewheres that
// nothing kept in agreement: the `fields` array the ingest publishes, and the
// hardcoded SERIES_FIELDS in src/lib/data.ts that the dashboard actually zips
// against the tuple.
//
// Adding valuePrnUsd to the first and not the second produced twenty names for
// nineteen values — an artifact describing itself wrongly, under which
// positionsLong reads as a dollar figure and every later column shifts by one.
//
// Both now import shared/series-fields.mjs. These tests pin the properties that
// make that safe.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SERIES_FIELDS } from "../shared/series-fields.mjs";

const ingest = readFileSync(new URL("../scripts/ingest-dera.mjs", import.meta.url), "utf8");
const frontend = readFileSync(new URL("../src/lib/data.ts", import.meta.url), "utf8");

describe("the tuple and its column names", () => {
  it("the tuple emits exactly as many values as there are names", () => {
    // Split the tuple on TOP-LEVEL commas only — nested calls carry commas of
    // their own — then drop empty segments so the trailing comma before `]`
    // does not read as a twenty-first value. It did on the first attempt.
    const at = ingest.indexOf("s: series.slice().reverse().map((x) => [");
    expect(at).toBeGreaterThan(-1);
    const open = ingest.indexOf("[", at);
    let depth = 0, inComment = false;
    const segments = [""];
    for (let i = open; i < ingest.length; i++) {
      const c = ingest[i];
      if (inComment) { if (c === "\n") inComment = false; continue; }
      if (ingest.slice(i, i + 2) === "//") { inComment = true; i++; continue; }
      if ("[({".includes(c)) { depth++; if (depth === 1) continue; }
      else if ("])}".includes(c)) { depth--; if (depth === 0) break; }
      else if (c === "," && depth === 1) { segments.push(""); continue; }
      segments[segments.length - 1] += c;
    }
    const values = segments.map((x) => x.trim()).filter(Boolean);
    expect(values).toHaveLength(SERIES_FIELDS.length);
    // And the last one really is the appended field, not something shifted.
    expect(values.at(-1)).toContain("valuePrnUsd");
  });

  it("neither side keeps its own copy of the list any more", () => {
    expect(ingest).toContain("fields: SERIES_FIELDS");
    expect(ingest).toContain('from "../shared/series-fields.mjs"');
    expect(frontend).toContain('from "../../shared/series-fields.mjs"');
    // The literal array must be gone from the frontend, or it can drift again.
    expect(frontend).not.toMatch(/const SERIES_FIELDS = \[/);
  });
});

describe("append, never insert", () => {
  // Artifacts already in the bucket were written against this order. A field
  // added in the MIDDLE re-points every column after it for every build still
  // live — a wrong number on screen with nothing to indicate it. Appended
  // fields are simply absent from older tuples and read as null, which is true.
  const FROZEN = [
    "period", "valueLongUsd", "positions", "reportedTotalUsd", "top10WeightPct",
    "n_new", "n_added", "n_trimmed", "n_exited", "turnover_position_pct",
    "priorState", "structuralEvent", "confidentialOmitted", "filingLagDays",
    "valueOptionsUsd", "positionsLong", "positionsOptions", "hasHoldings",
    "deltasSuppressed",
  ];

  it("the columns published before 2026-08-21 keep their exact positions", () => {
    expect(SERIES_FIELDS.slice(0, FROZEN.length)).toEqual(FROZEN);
  });

  it("a shorter tuple from an older build reads its known columns correctly", () => {
    const old = ["2026-03-31", 1_000, 12, 1_100, 40.5, 1, 2, 3, 4, 10.2,
                 "PRIOR_OK", null, 0, 29, 0, 12, 0, 1, 0];
    const o = {};
    SERIES_FIELDS.forEach((f, i) => { o[f] = old[i] ?? null; });
    expect(o.valueLongUsd).toBe(1_000);
    expect(o.positionsLong).toBe(12);
    expect(o.deltasSuppressed).toBe(0);
    expect(o.valuePrnUsd).toBeNull(); // absent, not misread
  });

  it("has no duplicate names, which would make one column unreachable", () => {
    expect(new Set(SERIES_FIELDS).size).toBe(SERIES_FIELDS.length);
  });
});
