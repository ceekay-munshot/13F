// tests/determinism.test.mjs
//
// A build must be a pure function of its input.
//
// Every artifact used to carry `generatedAt: new Date().toISOString()`, so two
// builds of identical data produced ~44,000 files that differed in nothing but
// the clock. That makes the claim this project is being rebuilt around — "the
// dashboard can be thrown away and rebuilt from the archived SEC files" —
// impossible to CHECK: a rebuild can never be shown to have reproduced anything
// when every byte of it is stamped with the moment it ran.
//
// Verified live before these were written: the monthly pipeline was run twice
// against the same cached SEC window and 157 of 158 artifacts came out
// byte-identical. The one exception is the manifest, deliberately.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { envelope, manifest } from "../shared/artifacts.mjs";

const sample = () => envelope({
  kind: "fund-period", cik: "0001279936", period: "2026-06-30",
  asOf: "2026-06-30", acceptedAt: "2026-07-29T17:47:53.000Z",
  buildId: null, extra: { page: 0, pages: 1, total: 27 },
  data: { n: 0, cols: [] },
});

describe("artifacts carry no timestamp", () => {
  it("an envelope has no generatedAt at all", () => {
    expect(sample()).not.toHaveProperty("generatedAt");
  });

  it("two envelopes of the same input are byte-identical", () => {
    expect(JSON.stringify(sample())).toBe(JSON.stringify(sample()));
  });

  it("...even across a delay, which is the whole point", async () => {
    const a = JSON.stringify(sample());
    await new Promise((r) => setTimeout(r, 25));
    expect(JSON.stringify(sample())).toBe(a);
  });

  it("still carries the provenance a reader actually needs", () => {
    // Removing the clock must not remove the ability to say when the underlying
    // filing was accepted, or which quarter it is for.
    expect(sample()).toMatchObject({
      period: "2026-06-30", asOf: "2026-06-30", acceptedAt: "2026-07-29T17:47:53.000Z",
    });
  });
});

describe("the manifest keeps its clock, and must", () => {
  it("carries generatedAt", () => {
    const m = manifest({ buildId: "x", periods: [], funds: {}, counts: {}, notes: [] });
    expect(m.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("the staleness alarm grades the site by subtracting it from today", () => {
    // So a data-derived value here would report a healthy build as a week stale
    // the moment filings stopped arriving — exactly backwards. Pinned as a test
    // because "make everything deterministic" is the obvious next step and it
    // would break the one thing that notices the site has stopped updating.
    const src = readFileSync(new URL("../scripts/freshness-check.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/Date\.parse\(mf\.generatedAt\)/);
  });
});

describe("nothing reintroduces a per-artifact clock", () => {
  it("envelope() does not call Date", () => {
    const src = readFileSync(new URL("../shared/artifacts.mjs", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export function envelope("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).not.toMatch(/new Date\(/);
  });
});
