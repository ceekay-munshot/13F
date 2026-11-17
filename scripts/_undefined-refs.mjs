// scripts/_undefined-refs.mjs
//
// Find identifiers a module USES but that nothing visible from that spot
// declares, imports, or receives as a parameter — the "no-undef" rule, done with
// a real parser and real scopes instead of a regex.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// prune() has now been silently broken TWICE, both times by a name that does not
// resolve at runtime, and both times the failure was invisible because it threw
// inside a try/catch that logged a warning on an otherwise green run:
//
//   1. `const PROTECTED_PREFIXES` was declared BELOW the function that read it,
//      so every call threw from its temporal dead zone. That lasted the entire
//      life of the function.
//   2. The commit that fixed (1) left `XisPrunableKeyX(...)` on the line above —
//      a mangled name that throws ReferenceError. Shipped and pushed.
//
// `node --check` catches neither: both are syntactically perfect. A regex guard
// does not catch them reliably either — the guard written for (1) tested that
// the string "isPrunableKey(" appeared SOMEWHERE in the file, and it did, on the
// next line down, so it passed while the real call site was broken.
//
// This module catches (2) exactly and with no false positives to tune: a name
// that resolves to nothing is unambiguous.
//
// It does NOT catch (1), and cannot — PROTECTED_PREFIXES *is* declared, just
// read too early, which is an ordering fact rather than a naming one. That case
// stays with the declaration-order check in ci-guards.mjs. Two different bugs,
// two different checks; neither subsumes the other.
//
// ---------------------------------------------------------------------------
// WHY IT RESOLVES BY SCOPE, NOT BY FILE
// ---------------------------------------------------------------------------
// The first version hoisted every `let`/`const` it found in any nested block up
// into the enclosing function, so a name declared ANYWHERE in a function counted
// as declared EVERYWHERE in it. That let a third one through (PR #17):
//
//     ranked.forEach(({ fund }, idx) => {
//       …
//       misalignedNames.push(`${cik} ${period}`);   // no `cik` in reach
//     });
//
// `const cik` existed in ingest-dera.mjs — twice, inside two other loops of the
// same function — so the check passed, and the monthly rebuild would have thrown
// "cik is not defined" the first time it met a filing with names on the wrong
// codes. Now a name counts as defined only if a declaration is visible from the
// exact spot it is used: block scope for let/const/class (and for function
// declarations, since every file here is an ES module and so strict), function
// scope for var, hoisting respected because every scope is fully collected
// before anything is resolved.
//
// acorn is a devDependency and is already in the tree via vite. It is declared
// explicitly rather than relied on transitively, so a vite upgrade cannot
// silently take this check away.

import { parse } from "acorn";
import { readFileSync } from "node:fs";

/**
 * Globals a Node ESM module may use without declaring. Deliberately a small,
 * explicit list: anything not here and not declared is reported, which is the
 * behaviour that catches a typo.
 */
const GLOBALS = new Set([
  // language
  "undefined", "NaN", "Infinity", "globalThis",
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
  "Math", "JSON", "Date", "RegExp", "Error", "TypeError", "RangeError",
  "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError",
  "Map", "Set", "WeakMap", "WeakSet", "Promise", "Proxy", "Reflect",
  "Function", "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
  "BigInt64Array", "BigUint64Array", "Intl",
  // node + web platform available in node 20
  "process", "console", "Buffer", "URL", "URLSearchParams", "TextEncoder",
  "TextDecoder", "AbortController", "AbortSignal", "fetch", "Headers",
  "Request", "Response", "FormData", "Blob", "File", "crypto", "performance",
  "structuredClone", "queueMicrotask", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "setImmediate", "clearImmediate",
  "ReadableStream", "WritableStream", "TransformStream", "Event", "EventTarget",
  "__dirname", "__filename", "require", "module", "exports",
]);

/**
 * Walk the tree building the real scope tree, record every Identifier that is
 * READ together with the scope it is read in, and only then resolve each one by
 * walking outwards. Resolving after collecting is what makes hoisting free: a
 * function may call something declared further down, in its own scope or any
 * enclosing one.
 *
 * Property keys (`o.foo`, `{foo: 1}`), labels, and import/export specifiers are
 * not references and are skipped — getting that wrong is what makes naive
 * versions of this noisy.
 *
 * Each problem carries `declaredAt`: the lines where a binding of that name
 * exists somewhere in the file, out of reach. Empty means the name exists
 * nowhere — a typo; non-empty means a scope mistake like PR #17's.
 */
export function undefinedRefs(source, filename = "<source>") {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });

  /** `fn` marks the scopes `var` belongs to: the module, functions, static blocks. */
  const newScope = (parent, fn) => ({ parent, names: new Set(), fn });
  const varScope = (scope) => { let s = scope; while (!s.fn) s = s.parent; return s; };

  const refs = [];           // { id, scope }
  const declLines = new Map(); // name -> [line], file-wide, for the message only
  const declare = (scope, id) => {
    scope.names.add(id.name);
    if (!declLines.has(id.name)) declLines.set(id.name, []);
    declLines.get(id.name).push(id.loc.start.line);
  };
  const use = (id, scope) => refs.push({ id, scope });

  /**
   * A binding pattern: names go into `target`; default values and computed keys
   * are expressions, evaluated in `scope`.
   */
  const bind = (pattern, target, scope) => {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier": declare(target, pattern); return;
      case "ObjectPattern":
        for (const p of pattern.properties) {
          if (p.type === "RestElement") { bind(p.argument, target, scope); continue; }
          if (p.computed) walk(p.key, scope);
          bind(p.value, target, scope);
        }
        return;
      case "ArrayPattern": for (const e of pattern.elements) bind(e, target, scope); return;
      case "AssignmentPattern": bind(pattern.left, target, scope); walk(pattern.right, scope); return;
      case "RestElement": bind(pattern.argument, target, scope); return;
    }
  };

  const fn = (node, outer) => {
    const scope = newScope(outer, true);
    if (node.type !== "ArrowFunctionExpression") scope.names.add("arguments");
    // A function expression's own name is visible only inside it.
    if (node.type === "FunctionExpression" && node.id) declare(scope, node.id);
    for (const p of node.params) bind(p, scope, scope);
    // The body's top-level declarations share the function's scope.
    if (node.body.type === "BlockStatement") for (const s of node.body.body) walk(s, scope);
    else walk(node.body, scope);
  };

  const cls = (node, outer) => {
    const scope = newScope(outer, false);
    if (node.id) declare(scope, node.id); // the inner binding every class has
    walk(node.superClass, scope);
    walk(node.body, scope);
  };

  const walk = (node, scope) => {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "Program": {
        const s = newScope(null, true);
        for (const b of node.body) walk(b, s);
        return;
      }
      case "VariableDeclaration": {
        const target = node.kind === "var" ? varScope(scope) : scope;
        for (const d of node.declarations) { bind(d.id, target, scope); walk(d.init, scope); }
        return;
      }
      case "FunctionDeclaration":
        // Block-scoped: these files are ES modules, so always strict.
        if (node.id) declare(scope, node.id);
        fn(node, scope);
        return;
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        fn(node, scope);
        return;
      case "ClassDeclaration":
        if (node.id) declare(scope, node.id);
        cls(node, scope);
        return;
      case "ClassExpression":
        cls(node, scope);
        return;
      case "StaticBlock": {
        const s = newScope(scope, true);
        for (const b of node.body) walk(b, s);
        return;
      }
      case "BlockStatement": {
        const s = newScope(scope, false);
        for (const b of node.body) walk(b, s);
        return;
      }
      case "CatchClause": {
        const s = newScope(scope, false);
        bind(node.param, s, s);
        walk(node.body, s);
        return;
      }
      case "ForStatement": {
        const s = newScope(scope, false);
        for (const k of ["init", "test", "update", "body"]) walk(node[k], s);
        return;
      }
      case "ForInStatement": case "ForOfStatement": {
        const s = newScope(scope, false);
        for (const k of ["left", "right", "body"]) walk(node[k], s);
        return;
      }
      case "SwitchStatement": {
        walk(node.discriminant, scope);
        const s = newScope(scope, false); // every case shares one block
        for (const c of node.cases) { walk(c.test, s); for (const b of c.consequent) walk(b, s); }
        return;
      }
      case "ImportDeclaration":
        for (const s of node.specifiers) declare(scope, s.local);
        return;
      case "ExportAllDeclaration": return;
      case "ExportNamedDeclaration":
        if (node.source) return; // `export { a } from "./m"` names nothing local
        walk(node.declaration, scope);
        for (const s of node.specifiers) use(s.local, scope);
        return;
      case "MemberExpression":
        walk(node.object, scope);
        if (node.computed) walk(node.property, scope);
        return;
      case "Property":
      case "MethodDefinition":
      case "PropertyDefinition":
        if (node.computed) walk(node.key, scope);
        walk(node.value, scope);
        return;
      case "LabeledStatement": walk(node.body, scope); return;
      case "BreakStatement": case "ContinueStatement": return;
      case "MetaProperty": return;
      case "Identifier": use(node, scope); return;
    }

    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "type") continue;
      const v = node[key];
      if (Array.isArray(v)) for (const c of v) walk(c, scope);
      else if (v && typeof v.type === "string") walk(v, scope);
    }
  };

  walk(ast, null);

  const resolves = (name, scope) => {
    for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true;
    return GLOBALS.has(name);
  };

  // One report per name per line.
  const seen = new Set();
  const problems = [];
  for (const { id, scope } of refs) {
    if (resolves(id.name, scope)) continue;
    const line = id.loc.start.line;
    const k = `${id.name}:${line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    problems.push({ name: id.name, line, file: filename, declaredAt: declLines.get(id.name) ?? [] });
  }
  return problems;
}

export function undefinedRefsInFile(path) {
  return undefinedRefs(readFileSync(path, "utf8"), path);
}
