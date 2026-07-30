// tests/fetch.test.mjs
//
// The SEC fetch layer. These exist because two of its behaviours have already
// broken a production run, and both were behaviours the module was SUPPOSED to
// have — they were documented in a comment and never asserted:
//
//   1. A 403 must be terminal and must stop the run cleanly.
//   2. Everything that is NOT a 403 must not be treated as a block — and a
//      failed liveness probe must not kill a run that has nothing wrong with it.
//
// The second one cost a full universe ingest: the preflight probed
// `cgi-bin/browse-edgar` (the busiest dynamic endpoint on sec.gov), got a 503,
// and exited 1 before the ingest or the R2 publish had run.

import { describe, it, expect, vi, afterEach } from "vitest";
import { SecFetcher, SecBlockedError, SecFetchError, SEC_URLS } from "../scripts/_sec-fetch.mjs";

const UA = "Munshot 13F Pipeline test@muns.io";

/** A fetcher with the waiting taken out, so the retry ladder runs instantly. */
const fetcher = (over = {}) =>
  new SecFetcher({ userAgent: UA, rps: 10000, retryBaseMs: 0, log: () => {}, ...over });

const reply = (status, body = "") => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Map([["etag", null]]),
  text: async () => body,
  json: async () => JSON.parse(body || "{}"),
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});

/** Queue of responses; each call shifts one. Records the requests made. */
function stubFetch(...statuses) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", headers: init?.headers });
    const next = statuses.shift();
    if (next === undefined) throw new Error("stub exhausted");
    if (next instanceof Error) throw next;
    return reply(next);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("the User-Agent contract", () => {
  it("refuses to construct without a contact email", () => {
    // The SEC serves an "Undeclared Automated Tool" page to requests without
    // one, so failing at construction is far better than failing at request 400.
    expect(() => new SecFetcher({ userAgent: "13F Pipeline" })).toThrow(/contact email/);
    expect(() => new SecFetcher({ userAgent: "" })).toThrow(/must be set/);
  });

  it("sends the UA and gzip on every request", async () => {
    const calls = stubFetch(200);
    await fetcher().get("https://www.sec.gov/x");
    expect(calls[0].headers["User-Agent"]).toBe(UA);
    expect(calls[0].headers["Accept-Encoding"]).toBe("gzip, deflate");
  });
});

describe("403 is terminal", () => {
  it("throws SecBlockedError on the FIRST 403 with no retry", async () => {
    const calls = stubFetch(403, 200); // a retry would find the 200
    await expect(fetcher().get("https://www.sec.gov/x")).rejects.toThrow(SecBlockedError);
    expect(calls).toHaveLength(1); // <- the whole point
  });

  it("latches, so a later call cannot burn another request", async () => {
    const calls = stubFetch(403);
    const sec = fetcher();
    await expect(sec.get("https://www.sec.gov/a")).rejects.toThrow(SecBlockedError);
    await expect(sec.get("https://www.sec.gov/b")).rejects.toThrow(SecBlockedError);
    expect(calls).toHaveLength(1);
    expect(sec.blocked).toBe(true);
  });
});

describe("transient statuses retry, permanent ones do not", () => {
  it("retries a 503 and returns the eventual success", async () => {
    const calls = stubFetch(503, 503, 200);
    const res = await fetcher().get("https://www.sec.gov/x");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("gives up after maxAttempts with a SecFetchError, not a block", async () => {
    stubFetch(503, 503, 503, 503);
    await expect(fetcher().get("https://www.sec.gov/x")).rejects.toThrow(SecFetchError);
  });

  it("does NOT retry a 404 — the newest fails-to-deliver file is simply absent", async () => {
    const calls = stubFetch(404, 200);
    await expect(fetcher().get("https://www.sec.gov/x")).rejects.toThrow(SecFetchError);
    expect(calls).toHaveLength(1);
  });

  it("retries a network-level failure", async () => {
    const calls = stubFetch(new Error("ECONNRESET"), 200);
    const res = await fetcher().get("https://www.sec.gov/x");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });
});

describe("preflight — asks exactly one question: is this IP blocked?", () => {
  it("probes a STATIC path over HEAD, never the cgi-bin CGI script", async () => {
    // THE regression. browse-edgar is the busiest, most 503-prone endpoint on
    // sec.gov; probing liveness through it makes the probe less reliable than
    // the work it guards.
    const calls = stubFetch(200);
    await fetcher().preflight();
    expect(calls[0].method).toBe("HEAD");
    expect(calls[0].url).not.toContain("cgi-bin");
    expect(SEC_URLS.probe()).not.toContain("cgi-bin");
  });

  it("reports a 403 as a block", async () => {
    stubFetch(403);
    const sec = fetcher();
    expect(await sec.preflight()).toMatchObject({ ok: false, blocked: true });
  });

  it("treats a persistent 503 as INCONCLUSIVE and lets the run proceed", async () => {
    // The failure this test exists for: the probe threw, runJob exited 1, and a
    // full universe ingest plus R2 publish never ran. A 503 says the SEC is
    // busy — it says nothing about whether we are blocked.
    stubFetch(503, 503, 503, 503);
    const sec = fetcher();
    const pre = await sec.preflight();
    expect(pre.ok).toBe(true);
    expect(pre.degraded).toBe(true);
    // Crucially, nothing is latched — the real work is free to go ahead.
    expect(sec.blocked).toBe(false);
  });

  it("leaves the fetcher usable after an inconclusive probe", async () => {
    stubFetch(503, 503, 503, 503, 200);
    const sec = fetcher();
    await sec.preflight();
    await expect(sec.get("https://www.sec.gov/real-work")).resolves.toMatchObject({ status: 200 });
  });

  it("costs exactly one request and reads no body", async () => {
    stubFetch(200, 200);
    const sec = fetcher();
    await sec.preflight();
    expect(sec.requestCount).toBe(1);
    // HEAD must not attempt to decode a body — the probe target is a ~1 MB
    // file, and downloading it on every job start would be absurd.
    const res = await fetcher().get(SEC_URLS.probe(), { method: "HEAD" });
    expect(res.body).toBeNull();
  });
});

describe("conditional requests", () => {
  it("passes an ETag through and surfaces 304 as notModified", async () => {
    const calls = stubFetch(304);
    const res = await fetcher().get("https://www.sec.gov/x", { etag: 'W/"abc"' });
    expect(calls[0].headers["If-None-Match"]).toBe('W/"abc"');
    expect(res).toMatchObject({ status: 304, notModified: true, etag: 'W/"abc"' });
  });
});

describe("URL builders", () => {
  it("zero-pads CIK to 10 for data.sec.gov and strips them for /Archives/", () => {
    // '002824100' !== '2824100' — the two hosts want opposite forms, and mixing
    // them up 404s in a way that looks like missing data.
    expect(SEC_URLS.submissions("1067983")).toContain("CIK0001067983.json");
    expect(SEC_URLS.filingDir("0001067983", "0000950123-26-000001")).toContain(
      "/data/1067983/000095012326000001",
    );
  });

  it("builds the index-headers path, which is the only reliable infotable selector", () => {
    expect(SEC_URLS.indexHeaders("1067983", "0000950123-26-000001")).toMatch(
      /0000950123-26-000001-index-headers\.html$/,
    );
  });
});
