// tests/undefined-refs.test.mjs
//
// prune() has now shipped broken TWICE, on adjacent lines, both times because a
// name did not resolve at runtime, and both times invisibly — it throws inside a
// try/catch that logged a warning on an otherwise green run.
//
//   1. `const PROTECTED_PREFIXES` declared BELOW the function reading it.
//   2. `XisPrunableKeyX(...)` — a mangled identifier. Committed and pushed.
//
// (2) passed `node --check`, because it is syntactically perfect. It also passed
// the regex guard written after (1), which asked only whether the string
// "isPrunableKey(" appeared somewhere in the file — and it did, one line down.
//
// These tests pin the check that catches the class, and, just as importantly,
// pin what it must NOT flag: a noisy check gets switched off.

import { describe, it, expect } from "vitest";
import { undefinedRefs } from "../scripts/_undefined-refs.mjs";

const names = (src) => undefinedRefs(src, "t.mjs").map((p) => p.name);

describe("names that do not exist", () => {
  it("catches the identifier that actually shipped", () => {
    const src = `import { isPrunableKey } from "./m.mjs";
      const current = new Map(), local = new Set(), builtPeriods = new Set(), P = [];
      const stale = [...current.keys()].filter((k) => !local.has(k) && XisPrunableKeyX(k, builtPeriods, P));`;
    expect(names(src)).toContain("XisPrunableKeyX");
  });

  it("reports the line, so the message can point at it", () => {
    const found = undefinedRefs(`const a = 1;\nconst b = missingThing();`, "t.mjs");
    expect(found[0]).toMatchObject({ name: "missingThing", line: 2 });
  });

  it("catches a misspelled import", () => {
    expect(names(`import { mergeSummary } from "./m.mjs";\nmergSummary({}, {});`)).toContain("mergSummary");
  });

  it("catches a rename that missed one call site", () => {
    expect(names(`const builtPeriods = new Set();\nexport const n = buildPeriods.size;`)).toContain("buildPeriods");
  });
});

describe("what it must not flag — a noisy check gets turned off", () => {
  const clean = (src) => expect(names(src)).toEqual([]);

  it("a function called before it is declared, which is legal", () => {
    clean(`foo();\nfunction foo() { return 1; }`);
  });

  it("destructured parameters, defaults, rest, and catch bindings", () => {
    clean(`export function f({ a, b = 2, ...rest }, [c] = [], ...more) {
      try { return a + b + c + rest.x + more.length; } catch (err) { return err.message; }
    }`);
  });

  it("property names, which are not references", () => {
    clean(`const o = { alpha: 1, ["k" + 1]: 2 };\nexport const v = o.alpha + o.beta;`);
  });

  it("loop and block scoping", () => {
    clean(`export function f(xs) {
      let t = 0;
      for (const x of xs) { const y = x * 2; t += y; }
      for (let i = 0; i < xs.length; i++) t += i;
      { const z = 1; t += z; }
      return t;
    }`);
  });

  it("node and web globals available in node 20", () => {
    clean(`export const x = Buffer.from(JSON.stringify({ a: Math.max(1, 2) }));
      export const y = await fetch("https://x", { signal: AbortSignal.timeout(1000) });
      export const z = process.env.HOME ?? new URL("https://x").host;`);
  });

  it("classes, getters, and this", () => {
    clean(`export class A extends Error { #p = 1; get v() { return this.#p; } static make() { return new A(); } }`);
  });

  it("the real pipeline, every module — the only test that proves it is usable", async () => {
    const { readdirSync } = await import("node:fs");
    const { undefinedRefsInFile } = await import("../scripts/_undefined-refs.mjs");
    const problems = [];
    for (const dir of ["scripts", "shared", "tests"]) {
      for (const f of readdirSync(new URL(`../${dir}`, import.meta.url))) {
        if (!f.endsWith(".mjs")) continue;
        for (const p of undefinedRefsInFile(new URL(`../${dir}/${f}`, import.meta.url).pathname)) {
          problems.push(`${dir}/${f}:${p.line} ${p.name}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("what it honestly cannot catch", () => {
  it("does NOT catch the temporal-dead-zone bug, and must not pretend to", () => {
    // PROTECTED_PREFIXES *is* declared — just read too early. That is an
    // ordering fact, not a naming one, and belongs to the declaration-order
    // check in ci-guards.mjs. Two bugs, two checks; neither subsumes the other.
    // Pinned as a test so nobody later assumes this file covers it.
    const src = `async function prune() { return PROTECTED.length; }\nawait prune();\nconst PROTECTED = ["state/"];`;
    expect(names(src)).toEqual([]);
  });
});
