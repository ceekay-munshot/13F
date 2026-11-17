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

describe("names declared, but not anywhere the line can see — PR #17", () => {
  // The first version counted a name as declared everywhere in a function if it
  // was declared anywhere in it. PR #17 added `${cik}` inside a forEach whose
  // fund is `fund`; `const cik` existed only inside two OTHER loops of the same
  // function, so the check passed and the monthly rebuild would have thrown
  // "cik is not defined" on the first filing with names on the wrong codes.

  it("catches the shape that shipped: declared in one block, used in a sibling", () => {
    const src = `export function rebuild(rows, ranked) {
      const misalignedNames = [];
      for (const c of rows) {
        const cik = c.cik.trim();
        if (!cik) continue;
      }
      ranked.forEach(({ fund }, idx) => {
        misalignedNames.push(\`\${cik} \${idx}\`);
      });
      return misalignedNames;
    }`;
    const found = undefinedRefs(src, "t.mjs");
    expect(found).toHaveLength(1);
    // declaredAt says it exists, out of reach — a scope mistake, not a typo.
    expect(found[0]).toMatchObject({ name: "cik", line: 8, declaredAt: [4] });
  });

  it("a let/const from an if-block, read after the block", () => {
    expect(names(`export function f(x) { if (x) { const y = 1; } return y; }`)).toEqual(["y"]);
  });

  it("a loop variable, read after the loop", () => {
    expect(names(`export function f(xs) { for (let i = 0; i < xs.length; i++) {} return i; }`)).toEqual(["i"]);
  });

  it("a catch binding, read after the catch", () => {
    expect(names(`export function f() { try { g(); } catch (err) {} return err; }\nfunction g() {}`)).toEqual(["err"]);
  });

  it("one function's parameter, read in a sibling function", () => {
    expect(names(`export function a(fund) { return fund; }\nexport function b() { return fund.cik; }`)).toEqual(["fund"]);
  });

  it("a var inside a nested function, read in the outer one", () => {
    expect(names(`export function f() { const g = () => { var v = 1; return v; }; return g() + v; }`)).toEqual(["v"]);
  });

  it("a function declared in a block, called outside it (modules are strict)", () => {
    expect(names(`export function f(x) { if (x) { function h() { return 1; } } return h(); }`)).toEqual(["h"]);
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

  it("a var declared in a block is visible to the whole function", () => {
    clean(`export function f(xs) { for (const x of xs) { if (x) { var last = x; } } return last; }`);
  });

  it("a closure reading a name its enclosing scope declares further down", () => {
    clean(`export function f(xs) {
      const pick = (k) => byKey.get(k) ?? fallback(k);
      const byKey = new Map(xs);
      return pick("a");
      function fallback(k) { return k; }
    }`);
  });

  it("a block's own names, read from closures inside that block", () => {
    clean(`export function f(rows) {
      for (const r of rows) { const cik = r.cik; rows.forEach(({ fund }) => fund.push(cik)); }
      for (let i = 0; i < rows.length; i++) setTimeout(() => rows[i]);
    }`);
  });

  it("a function or class expression's own name, inside itself", () => {
    clean(`export const fact = function f(n) { return n < 2 ? 1 : n * f(n - 1); };
      export const K = class Self { static make() { return new Self(); } };`);
  });

  it("switch cases share one block; labels are not names", () => {
    clean(`export function f(k) {
      outer: for (const x of [1]) {
        switch (k) { case 1: { const a = x; return a; } default: continue outer; }
      }
    }`);
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
