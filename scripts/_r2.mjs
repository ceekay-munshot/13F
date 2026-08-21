// scripts/_r2.mjs
//
// The one R2 client. Signed requests, retries, and paged listing.
//
// ---------------------------------------------------------------------------
// WHY THERE IS EXACTLY ONE OF THESE
// ---------------------------------------------------------------------------
// This project's whole problem has been the same computation written twice and
// then drifting: two ingest paths that fold amendments by different rules, two
// copies of the artifact-row mapping, two definitions of a filings-feed `value`
// that mean different things. Adding a second hand-rolled SigV4 client for the
// source archive would be the same mistake in a new place, so the plumbing moves
// here and both callers import it.
//
// SigV4 is implemented rather than pulled in as a dependency: ~60 lines in
// _sigv4.mjs against adding the AWS SDK to a project whose entire runtime
// dependency list is one XML parser.

import { signRequest } from "./_sigv4.mjs";

// R2 (like any S3 service) occasionally returns a 500 InternalError under load —
// its own body says "Please try again" — plus the usual 429/502/503/504 and
// transient network drops. Across ~44,000 uploads at least one is near-certain,
// so a single failure must NOT kill the whole publish.
//
// (This is the opposite of the SEC 403 rule, which is terminal and never
// retried. There a retry harms others; here it is exactly what the service
// asks for.)
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

/**
 * Backoff between attempts.
 *
 * Named and exported because the comment above the old inline version said
 * "exponential" and the arithmetic was linear — 0.5s, 1.0s, 1.5s, 2.0s, a 5s
 * ceiling across four retries. That is fine for a blip and useless for a
 * sustained degradation, which at 44,000 objects is the case that matters. It is
 * exponential now, and the comment and the code agree.
 */
export function backoffMs(attempt) {
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);
}

/**
 * A client bound to one bucket.
 *
 * `headersFor(key, body)` supplies the per-object headers on PUT — cache-control
 * and content-type differ between a dashboard artifact and an archived SEC zip,
 * and that is the caller's business, not this file's.
 */
export function createR2({
  accountId = process.env.R2_ACCOUNT_ID,
  accessKeyId = process.env.R2_ACCESS_KEY_ID,
  secretAccessKey = process.env.R2_SECRET_ACCESS_KEY,
  bucket = process.env.R2_BUCKET || "13f",
  region = "auto",
  headersFor = () => ({}),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const host = `${accountId}.r2.cloudflarestorage.com`;

  async function send(method, key, body, okStatuses = new Set(), query = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Re-sign per attempt: SigV4 embeds a timestamp, and a backed-off retry
      // could otherwise fall outside its validity window. The URL comes FROM the
      // signer so it can never drift from what was signed.
      const { url, headers } = signRequest({
        method, host, bucket, key, query, body,
        accessKeyId, secretAccessKey, region,
      });
      const extra = method === "PUT" ? headersFor(key, body) : {};
      try {
        const res = await fetch(url, { method, body, headers: { ...headers, ...extra } });
        if (res.ok || okStatuses.has(res.status)) return res;
        if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          lastErr = new Error(`${method} ${key} -> ${res.status}`);
          continue;
        }
        throw new Error(`${method} ${key} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
      } catch (err) {
        // Network-level failure (reset, timeout): also retryable.
        lastErr = err;
        if (attempt < MAX_ATTEMPTS && !/-> \d{3} /.test(err.message)) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error(`${method} ${key} failed`);
  }

  return {
    bucket,
    send,
    put: (key, body) => send("PUT", key, body),
    /** DELETE is free on R2 and 404 means the same thing as success here. */
    del: (key) => send("DELETE", key, null, new Set([404])),

    /** Body as a Buffer, or null when the object is not there. */
    async getBuffer(key) {
      const res = await send("GET", key, null, new Set([404]));
      if (res.status === 404) return null;
      return Buffer.from(await res.arrayBuffer());
    },

    /** True/false without transferring the body. */
    async head(key) {
      const res = await send("HEAD", key, null, new Set([404]));
      return res.status !== 404 ? { size: Number(res.headers.get("content-length") || 0) } : null;
    },

    /**
     * Every object under a prefix as key -> size, following continuation tokens.
     *
     * Size is captured so an interrupted publish can resume: a re-run skips
     * objects already present at the same size rather than re-uploading tens of
     * thousands of unchanged files.
     */
    async list(prefix = "") {
      const found = new Map();
      let token = null;
      do {
        // The query MUST go through the signer — it is part of the canonical
        // request. Signing the bare bucket and appending the query afterwards is
        // what produced SignatureDoesNotMatch on every list.
        const query = { "list-type": "2", "max-keys": "1000" };
        if (prefix) query.prefix = prefix;
        if (token) query["continuation-token"] = token;
        const res = await send("GET", "", null, new Set(), query);
        const xml = await res.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = (/<Key>([^<]*)<\/Key>/.exec(m[1]) ?? [])[1];
          const size = Number((/<Size>(\d+)<\/Size>/.exec(m[1]) ?? [])[1] ?? -1);
          if (key) found.set(key, size);
        }
        token = (/<NextContinuationToken>([^<]+)</.exec(xml) ?? [])[1] ?? null;
      } while (token);
      return found;
    },
  };
}

/** Run tasks with a bounded worker pool. */
export async function pool(items, n, fn, onProgress = null) {
  let i = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
      done++;
      if (onProgress && done % 500 === 0) onProgress(done, items.length);
    }
  });
  await Promise.all(workers);
}
