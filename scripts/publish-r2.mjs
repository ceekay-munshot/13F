#!/usr/bin/env node
// scripts/publish-r2.mjs
//
// Upload the artifact tree to Cloudflare R2, and prune anything outside the
// retention window.
//
//   node --env-file=.env scripts/publish-r2.mjs --dir=public/data
//   node --env-file=.env scripts/publish-r2.mjs --dir=public/data --prune
//   node --env-file=.env scripts/publish-r2.mjs --dir=public/data --dry-run
//
// R2 is the right home for the holdings: 10 GB free, and egress is free too, so
// serving a fund's book costs nothing however often it is read. Git is the wrong
// home — it keeps every version forever, so a quarterly refresh of a few hundred
// megabytes compounds into gigabytes of history that every clone pays for.
//
// SigV4 is implemented here rather than pulled in as a dependency. It is ~60
// lines against the alternative of adding the AWS SDK to a project whose entire
// runtime dependency list is currently one XML parser.

import { createHash, createHmac } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CACHE_CONTROL } from "../shared/artifacts.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const DIR = args.dir || "public/data";
const DRY = Boolean(args["dry-run"]);
const PRUNE = Boolean(args.prune);
const CONCURRENCY = Number(args.concurrency || 24);

const ACCOUNT = process.env.R2_ACCOUNT_ID;
const KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET || "13f";
const REGION = "auto";
const HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;

if (!DRY && (!ACCOUNT || !KEY || !SECRET)) {
  console.error("::error::R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must all be set.");
  console.error("Create an R2 API token with Object Read & Write. See DEPLOY.md.");
  process.exit(1);
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const hmac = (k, d) => createHmac("sha256", k).update(d).digest();

/** Minimal AWS SigV4 for a single S3-compatible request. */
function sign({ method, key, body, headers }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = body ? sha256(body) : sha256("");

  const h = {
    host: HOST,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...headers,
  };
  const signedHeaders = Object.keys(h).map((x) => x.toLowerCase()).sort();
  const canonicalHeaders = signedHeaders.map((n) => `${n}:${String(h[Object.keys(h).find((k) => k.toLowerCase() === n)]).trim()}\n`).join("");

  // Each path segment is encoded individually so the slashes survive.
  const canonicalUri = `/${BUCKET}/${key}`.split("/").map(encodeURIComponent).join("/").replace(/%2F/g, "/");
  const canonicalRequest = [
    method, canonicalUri, "", canonicalHeaders, signedHeaders.join(";"), payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = ["AWS4" + SECRET, dateStamp, REGION, "s3", "aws4_request"]
    .reduce((k, v) => hmac(k, v));
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    url: `https://${HOST}${canonicalUri}`,
    headers: {
      ...h,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${KEY}/${scope}, ` +
        `SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`,
    },
  };
}

/**
 * Cache policy, restated here because R2 stores it per object rather than in a
 * _headers file. Two classes and no third: the manifest is the only file that
 * ever changes in place, so it is short-cached; everything else is immutable for
 * a given build id and the manifest hands out ?b= to bust it.
 */
function headersFor(key, body) {
  return {
    "content-type": "application/json",
    "content-length": String(body.length),
    "cache-control": key === "manifest.json" ? CACHE_CONTROL.manifest : CACHE_CONTROL.artifact,
  };
}

// R2 (like any S3 service) occasionally returns a 500 InternalError under load —
// its own body says "Please try again" — plus the usual 429/502/503/504 and
// transient network drops. Across ~35,000 uploads at least one is near-certain,
// so a single failure must NOT kill the whole publish. Retry those with
// exponential backoff. Each attempt is RE-SIGNED, because SigV4 embeds a
// timestamp that a backed-off retry could otherwise push outside its window.
//
// (This is the opposite of the SEC 403 rule, which is terminal and never
// retried. There a retry harms others; here it is exactly what the service
// asks for.)
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

async function sendSigned(method, key, body, okStatuses = new Set()) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { url, headers } = sign({ method, key, body, headers: method === "PUT" ? headersFor(key, body) : {} });
    try {
      const res = await fetch(url, { method, body, headers });
      if (res.ok || okStatuses.has(res.status)) return res;
      if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, attempt * 500 + Math.floor(Math.random() * 400)));
        lastErr = new Error(`${method} ${key} -> ${res.status}`);
        continue;
      }
      throw new Error(`${method} ${key} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      // Network-level failure (reset, timeout): also retryable.
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && !/-> \d{3} /.test(err.message)) {
        await new Promise((r) => setTimeout(r, attempt * 500 + Math.floor(Math.random() * 400)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error(`${method} ${key} failed`);
}

const put = (key, body) => sendSigned("PUT", key, body);
const del = (key) => sendSigned("DELETE", key, null, new Set([404]));

/** List every key under a prefix, following continuation tokens. */
async function listAll(prefix = "") {
  const keys = [];
  let token = null;
  do {
    const qs = new URLSearchParams({ "list-type": "2", "max-keys": "1000" });
    if (prefix) qs.set("prefix", prefix);
    if (token) qs.set("continuation-token", token);
    // The query string is not part of the canonical path for this simple case;
    // sign the bucket root and append.
    const { url, headers } = sign({ method: "GET", key: "", body: null, headers: {} });
    const res = await fetch(`${url.replace(/\/$/, "")}?${qs}`, { headers });
    if (!res.ok) throw new Error(`LIST -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    token = (/<NextContinuationToken>([^<]+)</.exec(xml) ?? [])[1] ?? null;
  } while (token);
  return keys;
}

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

/** Run tasks with a bounded worker pool. */
async function pool(items, n, fn) {
  let i = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
      if (++done % 500 === 0) console.log(`  ${done}/${items.length}`);
    }
  });
  await Promise.all(workers);
}

if (!existsSync(DIR)) {
  console.error(`::error::${DIR} does not exist — run an ingest first.`);
  process.exit(1);
}

const files = walk(DIR);
const totalBytes = files.reduce((a, f) => a + statSync(join(DIR, f)).size, 0);
console.log(`${files.length} objects, ${(totalBytes / 1048576).toFixed(1)} MB from ${DIR}`);
console.log(`bucket: ${BUCKET}${DRY ? "  (DRY RUN — nothing will be written)" : ""}`);

if (DRY) {
  console.log(files.slice(0, 8).map((f) => `  ${f}`).join("\n"));
  console.log(`  … and ${Math.max(0, files.length - 8)} more`);
  process.exit(0);
}

// Upload the manifest LAST. Until it lands, readers keep resolving the previous
// build, so a half-finished upload never serves a torn mix of old and new.
const manifestFirst = files.filter((f) => f !== "manifest.json");
console.log(`\nuploading ${manifestFirst.length} artifacts…`);
await pool(manifestFirst, CONCURRENCY, async (f) => {
  await put(f, readFileSync(join(DIR, f)));
});

if (PRUNE) {
  console.log(`\npruning keys no longer in the build…`);
  const remote = await listAll();
  const local = new Set(files);
  const stale = remote.filter((k) => !local.has(k));
  console.log(`  ${remote.length} remote, ${stale.length} stale`);
  await pool(stale, CONCURRENCY, del);
}

await put("manifest.json", readFileSync(join(DIR, "manifest.json")));
console.log(`\nmanifest published — build is now live.`);
