// tests/data-function.test.mjs
//
// The Pages Function is the ONLY Worker in the read path: every artifact the
// dashboard fetches goes through it. It had no test at all, which is how the
// precedence bug documented at the top of that file survived long enough to
// take the site down for a day.
//
// The edge cache is the thing under test here, and specifically the three
// exclusions that are correctness rather than tuning. A 404 means "this manager
// has not filed", and caching that for a year would freeze them as non-filing
// through a re-ingest that added them.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { onRequestGet } from "../functions/data/[[path]].js";

/** Minimal R2 stand-in. */
function bucket(objects) {
  return {
    get: async (key) => {
      if (!(key in objects)) return null;
      const body = objects[key];
      return {
        body,
        text: async () => body,
        httpEtag: `"etag-${key}"`,
        writeHttpMetadata: (h) => {
          h.set("content-type", "application/json");
          h.set(
            "cache-control",
            key === "manifest.json" ? "public, max-age=60, must-revalidate" : "public, max-age=31536000, immutable",
          );
        },
      };
    },
  };
}

/** Cache API stand-in, rebuilt per test in beforeEach so writes are observable. */
let api;
const call = (path, opts = {}) => {
  const key = Array.isArray(path) ? path.join("/") : path;
  return onRequestGet({
    params: { path: key.split("/") },
    env: opts.env ?? { F13F_R2: bucket(opts.objects ?? {}) },
    request: new Request(`https://example.test/data/${key}?b=abc`, { headers: opts.headers ?? {} }),
    next: async () => new Response("static asset", { status: 200 }),
    waitUntil: (p) => { pending.push(p); },
  });
};
let pending = [];

beforeEach(() => {
  pending = [];
  const store = new Map();
  api = { puts: [] };
  api.default = {
    match: async (req) => store.get(req.url),
    put: async (req, res) => { store.set(req.url, res); api.puts.push(req.url); },
  };
  globalThis.caches = api;
});
afterEach(() => { delete globalThis.caches; });

describe("artifact Function — edge cache", () => {
  it("caches an artifact so the next visitor skips R2", async () => {
    const objects = { "fund/0001/2026-03-31.json": '{"ok":true}' };
    const res = await call("fund/0001/2026-03-31.json", { objects });
    expect(res.status).toBe(200);
    await Promise.all(pending);
    expect(api.puts).toEqual(["https://example.test/data/fund/0001/2026-03-31.json?b=abc"]);
  });

  it("serves a cache hit without touching the bucket", async () => {
    const objects = { "fund/0001/2026-03-31.json": '{"ok":true}' };
    await call("fund/0001/2026-03-31.json", { objects });
    await Promise.all(pending);

    // A bucket that throws if asked: a hit must not reach it.
    const exploding = { get: async () => { throw new Error("R2 must not be called on a cache hit"); } };
    const res = await call("fund/0001/2026-03-31.json", { env: { F13F_R2: exploding } });
    expect(res.status).toBe(200);
  });

  it("NEVER caches a 404 — absence is an answer that can change", async () => {
    // A manager who has not filed yet 404s. Pinning that for a year would keep
    // reporting them as non-filing after the next ingest adds them.
    const res = await call("fund/9999/2026-03-31.json", { objects: {} });
    expect(res.status).toBe(404);
    await Promise.all(pending);
    expect(api.puts).toEqual([]);
  });

  it("NEVER caches the static manifest fallback", async () => {
    // Served only when R2 has lost the manifest. It is a deliberately degraded
    // older build and must not outlive the emergency it exists for.
    const env = {
      F13F_R2: bucket({}),
      ASSETS: { fetch: async () => new Response('{"buildId":"old"}', { status: 200 }) },
    };
    const res = await call("manifest.json", { env });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-13f-source")).toBe("static-fallback");
    await Promise.all(pending);
    expect(api.puts).toEqual([]);
  });

  it("does not cache a 304 — it has no body to serve anyone else", async () => {
    const objects = { "fund/0001/2026-03-31.json": '{"ok":true}' };
    const res = await call("fund/0001/2026-03-31.json", {
      objects,
      headers: { "if-none-match": '"etag-fund/0001/2026-03-31.json"' },
    });
    expect(res.status).toBe(304);
    await Promise.all(pending);
    expect(api.puts).toEqual([]);
  });

  it("works unchanged when the runtime has no Cache API", async () => {
    delete globalThis.caches;
    const res = await call("fund/0001/2026-03-31.json", { objects: { "fund/0001/2026-03-31.json": '{"ok":true}' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("survives a cache that throws on read and on write", async () => {
    globalThis.caches = {
      default: {
        match: async () => { throw new Error("cache read exploded"); },
        put: async () => { throw new Error("cache write exploded"); },
      },
    };
    const res = await call("fund/0001/2026-03-31.json", { objects: { "fund/0001/2026-03-31.json": '{"ok":true}' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });
});

describe("artifact Function — behaviour that must not have changed", () => {
  it("hands back to the asset server when the bucket is not bound", async () => {
    const res = await call("manifest.json", { env: {} });
    expect(await res.text()).toBe("static asset");
  });

  it("rejects a traversal attempt", async () => {
    const res = await call("../secrets.json", { objects: {} });
    expect(res.status).toBe(400);
  });

  it("keeps the published cache policy: a year for artifacts, a minute for the manifest", async () => {
    const a = await call("fund/0001/2026-03-31.json", { objects: { "fund/0001/2026-03-31.json": "{}" } });
    expect(a.headers.get("cache-control")).toContain("immutable");
    const m = await call("manifest.json", { objects: { "manifest.json": "{}" } });
    expect(m.headers.get("cache-control")).toContain("max-age=60");
  });
});

describe("artifact Function — meta/periods.json derived from the manifest", () => {
  // The quarter list the MCP reads at /data/meta/periods.json. The standalone
  // object is uploaded immutable and only rewritten monthly, so a reader without
  // ?b= was pinned to a stale copy while manifest.periods advanced every day.
  const manifest = JSON.stringify({
    v: 1,
    buildId: "bld-xyz",
    periods: [
      { period: "2026-09-30", label: "Q3 2026", deadline: "2026-11-14", filings: 3949, funds: 3800 },
      { period: "2026-06-30", label: "Q2 2026", deadline: "2026-08-14", filings: 8500, funds: 8400 },
    ],
  });
  // A deliberately STALE standalone object, as it is in R2 today.
  const stalePeriods = '{"v":1,"kind":"periods","buildId":null,"data":[{"period":"2026-03-31","label":"Q1 2026"}]}';

  it("serves periods from the live manifest, short-cached, not the stale immutable object", async () => {
    const res = await call("meta/periods.json", {
      objects: { "manifest.json": manifest, "meta/periods.json": stalePeriods },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-13f-source")).toBe("derived-from-manifest");
    expect(res.headers.get("cache-control")).toContain("max-age=60"); // never a year
    const body = JSON.parse(await res.text());
    expect(body.kind).toBe("periods");
    expect(body.buildId).toBe("bld-xyz");
    expect(body.data.map((p) => p.period)).toEqual(["2026-09-30", "2026-06-30"]); // the manifest's, not Q1
  });

  it("falls back to the standalone object when the manifest cannot be read", async () => {
    // No manifest.json in the bucket: the branch must fall through, not error.
    const res = await call("meta/periods.json", { objects: { "meta/periods.json": stalePeriods } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-13f-source")).toBe(null); // served the R2 object, not derived
    const body = JSON.parse(await res.text());
    expect(body.data[0].period).toBe("2026-03-31");
  });
});
