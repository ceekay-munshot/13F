// tests/unfinished.test.mjs
//
// "A step that did nothing must fail, not warn."
//
// prune threw on its very first line — a const read from its temporal dead zone
// — every run, for its entire existence. Every one of those runs was GREEN,
// because the throw was caught and logged as a warning. It was only found the
// day it would finally have worked, at which point it would have deleted 10,765
// fund-quarters.
//
// The manual repair tool had the same shape: dispatched with "0 funds selected",
// every gated step skipped itself, and it reported success having done nothing.
//
// These tests pin the two halves of the rule that replaced them: the run must
// still finish its work, and it must still end red.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRegister } from "../shared/unfinished.mjs";

const capture = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
};

describe("the unfinished-work register", () => {
  it("a run that did everything it set out to do exits 0 and says nothing", () => {
    const { lines, log } = capture();
    const r = createRegister();
    expect(r.report("The publish", log)).toBe(0);
    expect(lines).toEqual([]);
  });

  it("a single step that did not do its job turns the whole run red", () => {
    const { lines, log } = capture();
    const r = createRegister();
    r.note("prune did not run (Cannot access 'PROTECTED_PREFIXES' before initialization).");
    expect(r.report("The publish", log)).toBe(1);
    expect(lines.join("\n")).toContain("::error::prune did not run");
  });

  it("names every step that failed, not just the first", () => {
    const r = createRegister();
    r.note("prune did not run");
    r.note("the fund index was NOT updated");
    r.note("the ingest cursor was NOT advanced");
    const { lines, log } = capture();
    expect(r.report("The publish", log)).toBe(1);
    const errors = lines.filter((l) => l.startsWith("::error::"));
    // three findings plus the closing verdict
    expect(errors).toHaveLength(4);
    expect(errors.at(-1)).toContain("3 step(s) did not do their job");
  });

  it("says plainly that what was published is still fine", () => {
    // The owner is non-technical and a red run is alarming. The verdict has to
    // answer "is the dashboard broken?" before it says anything else.
    const { lines, log } = capture();
    const r = createRegister();
    r.note("prune did not run");
    r.report("The publish", log);
    expect(lines.join("\n")).toMatch(/live and correct/);
  });

  it("report() returns the code rather than exiting, so it can be tested at all", () => {
    // The original failures were invisible precisely because they were
    // unreachable from a test. Keeping process.exit at the call site is what
    // makes this file possible.
    const src = readFileSync(new URL("../shared/unfinished.mjs", import.meta.url), "utf8");
    expect(src).not.toContain("process.exit");
  });
});

describe("the publish scripts actually use it", () => {
  // A guard on the shape, not the wording: both scripts must END on the verdict,
  // so no later code can swallow it.
  for (const script of ["scripts/publish-r2.mjs", "scripts/publish-day.mjs"]) {
    it(`${script} ends by exiting on the register`, () => {
      const src = readFileSync(new URL(`../${script}`, import.meta.url), "utf8");
      expect(src).toContain("createRegister()");
      expect(src.trimEnd()).toMatch(/process\.exit\(unfinished\.report\([^)]*\)\);?[\s\S]{0,80}$/);
    });
  }
});

describe("end to end, in a real process", () => {
  // The point of the whole exercise is the EXIT CODE a CI runner sees. Assert it
  // from outside the process, because that is what GitHub Actions does.
  const run = (body) => {
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", body], { stdio: "pipe" });
      return 0;
    } catch (err) {
      return err.status;
    }
  };
  const preamble = `import { createRegister } from "${new URL("../shared/unfinished.mjs", import.meta.url).href}";`;

  it("exits 0 when nothing was left unfinished", () => {
    expect(run(`${preamble} const r = createRegister(); process.exit(r.report("x"));`)).toBe(0);
  });

  it("exits 1 when a step did not do its job", () => {
    expect(run(`${preamble} const r = createRegister(); r.note("prune did not run"); process.exit(r.report("x"));`)).toBe(1);
  });
});
