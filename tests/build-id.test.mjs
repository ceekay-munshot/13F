// tests/build-id.test.mjs
//
// The cache key must change when the content does.
//
// buildId was `buildIdFrom(latestAcceptance, windowSlug)` — a function of the
// INPUT. Rebuilding the same windows therefore produced the same id, and since
// artifacts are served `immutable, max-age=31536000` and busted only by the
// `?b={buildId}` the manifest hands out, a returning visitor was served whatever
// had been cached at that key a year earlier.
//
// Caught in production, not in review: a build ran after the 8,295-fund repair,
// the id went BACKWARDS to a value used before it, and a fund whose R2 object
// correctly held five quarters was served the four-quarter copy cached under the
// old id. Fetching the same object with a novel query string returned the right
// answer; fetching it the way the dashboard does returned the stale one.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactWriter } from "../scripts/_artifact-writer.mjs";

const withWriter = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "13f-buildid-"));
  try { return fn(new ArtifactWriter(dir, { quiet: true }), dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};

describe("a build id derived from what was built", () => {
  it("the same tree gives the same id — determinism is preserved", () => {
    const a = withWriter((w) => { w.write("a.json", { x: 1 }); w.write("b.json", { y: 2 }); return w.contentId(); });
    const b = withWriter((w) => { w.write("a.json", { x: 1 }); w.write("b.json", { y: 2 }); return w.contentId(); });
    expect(a).toBe(b);
  });

  it("changing ONE value anywhere changes the id", () => {
    const a = withWriter((w) => { w.write("a.json", { x: 1 }); w.write("b.json", { y: 2 }); return w.contentId(); });
    const b = withWriter((w) => { w.write("a.json", { x: 1 }); w.write("b.json", { y: 3 }); return w.contentId(); });
    expect(a).not.toBe(b);
  });

  it("adding a quarter to one fund of thousands changes the id", () => {
    // The case that was live: the repair added Q2 2026 to 7,449 summaries and
    // the id did not move, so nobody saw it.
    const base = (w, quarters) => {
      for (let i = 0; i < 50; i++) w.write(`fund/${i}/summary.json`, { series: [{ period: "2026-03-31" }] });
      w.write("fund/7/summary.json", { series: quarters.map((p) => ({ period: p })) });
      return w.contentId();
    };
    const before = withWriter((w) => base(w, ["2026-03-31"]));
    const after = withWriter((w) => base(w, ["2026-03-31", "2026-06-30"]));
    expect(before).not.toBe(after);
  });

  it("write ORDER does not change it, only bytes do", () => {
    const a = withWriter((w) => { w.write("a.json", { x: 1 }); w.write("b.json", { y: 2 }); return w.contentId(); });
    const b = withWriter((w) => { w.write("b.json", { y: 2 }); w.write("a.json", { x: 1 }); return w.contentId(); });
    expect(a).toBe(b);
  });

  it("renaming a file changes it, even with identical content", () => {
    const a = withWriter((w) => { w.write("a.json", { x: 1 }); return w.contentId(); });
    const b = withWriter((w) => { w.write("c.json", { x: 1 }); return w.contentId(); });
    expect(a).not.toBe(b);
  });
});

describe("both builds derive it from the output", () => {
  for (const script of ["scripts/ingest-dera.mjs", "scripts/ingest-funds.mjs"]) {
    it(`${script} hashes the tree, and does so after the last write`, async () => {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(new URL(`../${script}`, import.meta.url), "utf8");
      expect(src).toContain("writer.contentId()");
      // Every artifact must be in the hash. Taking it early would leave the
      // filings feed out, so a change only there would not bust the cache.
      expect(src.lastIndexOf("writer.write(")).toBeLessThan(src.indexOf("writer.contentId()"));
    });
  }
});
