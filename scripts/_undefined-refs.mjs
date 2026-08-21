// scripts/_undefined-refs.mjs
//
// Find identifiers a module USES but never declares, imports, or receives as a
// parameter — the "no-undef" rule, done with a real parser instead of a regex.
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

/** Names a node introduces into scope. */
function declaredBy(pattern, out) {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier": out.add(pattern.name); break;
    case "ObjectPattern":
      for (const p of pattern.properties) {
        if (p.type === "RestElement") declaredBy(p.argument, out);
        else declaredBy(p.value, out);
      }
      break;
    case "ArrayPattern": for (const e of pattern.elements) declaredBy(e, out); break;
    case "AssignmentPattern": declaredBy(pattern.left, out); break;
    case "RestElement": declaredBy(pattern.argument, out); break;
  }
}

/**
 * Walk the tree keeping a scope chain, and collect every Identifier that is READ
 * but resolves to nothing.
 *
 * Property keys (`o.foo`, `{foo: 1}`), labels, and import/export specifiers are
 * not references and are skipped — getting that wrong is what makes naive
 * versions of this noisy.
 */
export function undefinedRefs(source, filename = "<source>") {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const problems = [];

  // Hoist every declaration in a scope before walking its body, so a function
  // may legitimately call something declared further down the file.
  const collect = (nodes, scope, fnScope) => {
    for (const n of nodes) hoist(n, scope, fnScope);
  };
  const hoist = (n, scope, fnScope) => {
    if (!n || typeof n.type !== "string") return;
    switch (n.type) {
      case "VariableDeclaration":
        for (const d of n.declarations) declaredBy(d.id, n.kind === "var" ? fnScope : scope);
        return;
      case "FunctionDeclaration": if (n.id) scope.add(n.id.name); return;
      case "ClassDeclaration": if (n.id) scope.add(n.id.name); return;
      case "ImportDeclaration":
        for (const s of n.specifiers) scope.add(s.local.name);
        return;
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
        if (n.declaration) hoist(n.declaration, scope, fnScope);
        return;
      // `var` and function declarations escape blocks; recurse to find them.
      case "IfStatement": hoist(n.consequent, scope, fnScope); hoist(n.alternate, scope, fnScope); return;
      case "ForStatement": case "ForInStatement": case "ForOfStatement":
        hoist(n.body, scope, fnScope); return;
      case "WhileStatement": case "DoWhileStatement": case "LabeledStatement":
        hoist(n.body, scope, fnScope); return;
      case "BlockStatement": collect(n.body, scope, fnScope); return;
      case "TryStatement":
        hoist(n.block, scope, fnScope);
        if (n.handler) hoist(n.handler.body, scope, fnScope);
        hoist(n.finalizer, scope, fnScope);
        return;
      case "SwitchStatement":
        for (const c of n.cases) collect(c.consequent, scope, fnScope);
        return;
    }
  };

  const walk = (node, chain) => {
    if (!node || typeof node.type !== "string") return;
    const resolved = (name) => GLOBALS.has(name) || chain.some((s) => s.has(name));

    const scoped = (bodyNodes, extraNames, isFunction) => {
      const scope = new Set(extraNames);
      const next = [scope, ...chain];
      collect(bodyNodes, scope, isFunction ? scope : next[1] ?? scope);
      for (const b of bodyNodes) walk(b, next);
    };

    switch (node.type) {
      case "Program": {
        const scope = new Set();
        collect(node.body, scope, scope);
        const next = [scope, ...chain];
        for (const b of node.body) walk(b, next);
        return;
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const names = new Set(["arguments", "this"]);
        if (node.id) names.add(node.id.name);
        for (const p of node.params) declaredBy(p, names);
        for (const p of node.params) walk(p.type === "AssignmentPattern" ? p.right : null, [names, ...chain]);
        if (node.body.type === "BlockStatement") scoped(node.body.body, names, true);
        else { const next = [names, ...chain]; walk(node.body, next); }
        return;
      }
      case "BlockStatement": scoped(node.body, [], false); return;
      case "CatchClause": {
        const names = new Set();
        declaredBy(node.param, names);
        scoped(node.body.body, names, false);
        return;
      }
      case "ForStatement": case "ForInStatement": case "ForOfStatement": {
        const names = new Set();
        for (const k of ["init", "left"]) {
          const p = node[k];
          if (p && p.type === "VariableDeclaration") for (const d of p.declarations) declaredBy(d.id, names);
        }
        const next = [names, ...chain];
        for (const k of ["init", "left", "test", "update", "right", "body"]) walk(node[k], next);
        return;
      }
      case "MemberExpression":
        walk(node.object, chain);
        if (node.computed) walk(node.property, chain);
        return;
      case "Property":
        if (node.computed) walk(node.key, chain);
        walk(node.value, chain);
        return;
      case "MethodDefinition": case "PropertyDefinition":
        if (node.computed) walk(node.key, chain);
        walk(node.value, chain);
        return;
      case "ImportDeclaration": case "ExportAllDeclaration": return;
      case "ExportNamedDeclaration":
        // `export { a as b }` names locals, which hoisting already resolved.
        if (node.source) return;
        walk(node.declaration, chain);
        for (const s of node.specifiers) {
          if (!resolved(s.local.name)) {
            problems.push({ name: s.local.name, line: s.local.loc.start.line, file: filename });
          }
        }
        return;
      case "LabeledStatement": walk(node.body, chain); return;
      case "BreakStatement": case "ContinueStatement": return;
      case "MetaProperty": return;
      case "Identifier":
        if (!resolved(node.name)) {
          problems.push({ name: node.name, line: node.loc.start.line, file: filename });
        }
        return;
    }

    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "type") continue;
      const v = node[key];
      if (Array.isArray(v)) for (const c of v) walk(c, chain);
      else if (v && typeof v.type === "string") walk(v, chain);
    }
  };

  walk(ast, []);

  // De-duplicate: one report per name per line.
  const seen = new Set();
  return problems.filter((p) => {
    const k = `${p.name}:${p.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function undefinedRefsInFile(path) {
  return undefinedRefs(readFileSync(path, "utf8"), path);
}
