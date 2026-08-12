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
