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

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CACHE_CONTROL } from "../shared/artifacts.mjs";
import { signRequest } from "./_sigv4.mjs";

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

async function sendSigned(method, key, body, okStatuses = new Set(), query = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Re-sign per attempt: SigV4 embeds a timestamp, and a backed-off retry
    // could otherwise fall outside its validity window. The URL comes FROM the
    // signer so it can never drift from what was signed.
    const { url, headers } = signRequest({
      method, host: HOST, bucket: BUCKET, key, query, body,
      accessKeyId: KEY, secretAccessKey: SECRET, region: REGION,
    });
    const extra = method === "PUT" ? headersFor(key, body) : {};
    try {
      const res = await fetch(url, { method, body, headers: { ...headers, ...extra } });
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

/**
 * List every object under a prefix as key -> size, following continuation tokens.
 *
 * Size is captured so an interrupted publish can resume: a re-run skips objects
 * already present at the same size rather than re-uploading tens of thousands of
 * unchanged files. That turns a retry from ~19 minutes into about one, and makes
 * the monthly refresh upload only what actually changed.
 */
async function listAll(prefix = "") {
  const found = new Map();
  let token = null;
  do {
    // The query MUST go through the signer — it is part of the canonical
    // request. Signing the bare bucket and appending the query afterwards is
    // what produced SignatureDoesNotMatch on every list.
    const query = { "list-type": "2", "max-keys": "1000" };
    if (prefix) query.prefix = prefix;
    if (token) query["continuation-token"] = token;
    const res = await sendSigned("GET", "", null, new Set(), query);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = (/<Key>([^<]*)<\/Key>/.exec(m[1]) ?? [])[1];
      const size = Number((/<Size>(\d+)<\/Size>/.exec(m[1]) ?? [])[1] ?? -1);
      if (key) found.set(key, size);
    }
    token = (/<NextContinuationToken>([^<]+)</.exec(xml) ?? [])[1] ?? null;
  } while (token);
  return found;
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

// The manifest is the ONLY entry point: the dashboard fetches it before
// anything else and treats its absence as a hard error. A bucket full of
// artifacts with no manifest is not a degraded site, it is a dead one — which
// is exactly the state a failed publish left in production. Refuse to start a
// publish that could not finish with one.
if (!existsSync(join(DIR, "manifest.json"))) {
  console.error(`::error::${DIR}/manifest.json is missing — the ingest did not complete.`);
  console.error("Publishing artifacts without a manifest would leave the site unable to load.");
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

// What is already in the bucket? Listing first makes the publish RESUMABLE:
// a run interrupted after uploading 35,000 objects should not upload them again.
// Artifacts are immutable for a given build, so identical size means identical
// content and the upload can be skipped.
let remote = new Map();
try {
  remote = await listAll();
  if (remote.size) console.log(`${remote.size} objects already in the bucket`);
} catch (err) {
  console.log(`::warning::could not list the bucket (${err.message}) — uploading everything.`);
}

// Upload the manifest LAST. Until it lands, readers keep resolving the previous
// build, so a half-finished upload never serves a torn mix of old and new.
const candidates = files.filter((f) => f !== "manifest.json");
const todo = candidates.filter((f) => remote.get(f) !== statSync(join(DIR, f)).size);
const skipped = candidates.length - todo.length;

console.log(`\nuploading ${todo.length} artifacts${skipped ? ` (${skipped} already present, skipped)` : ""}…`);
await pool(todo, CONCURRENCY, async (f) => {
  await put(f, readFileSync(join(DIR, f)));
});

// PUBLISH THE MANIFEST, THEN CLEAN UP. Never the other way round.
//
// The manifest is what makes a build live, and it is the one file whose absence
// takes the whole site down. Pruning is cleanup — it deletes fund-quarters that
// rolled out of the retention window and nothing depends on it succeeding.
//
// Running cleanup first is how production ended up with 35,628 artifacts and no
// manifest: prune threw, and the run died before the one upload that mattered.
// Wrapping prune in a try/catch fixed that particular throw, but the ordering
// was still wrong — anything that can stop the process between "artifacts
// uploaded" and "manifest uploaded" (a timeout, a cancelled job, an OOM) leaves
// a dead site. With the manifest first, the worst case is a few stale objects.
//
// This is safe in the other direction too: prune only ever deletes keys that
// are NOT in the local tree, and the manifest only ever references keys that
// ARE, so a reader following the freshly-published manifest cannot be pointed
// at something prune is about to remove.
await put("manifest.json", readFileSync(join(DIR, "manifest.json")));
console.log(`\nmanifest published — build is now live.`);

if (PRUNE) {
  try {
    await prune();
  } catch (err) {
    console.log(`::warning::prune failed (${err.message}) — the build is already live; stale objects remain.`);
  }
}

/**
 * Prefixes prune must never touch.
 *
 * `state/` holds the same-day job's ingest cursor — which filers EDGAR has
 * published and which of them still need fetching. It is not part of any build,
 * so a diff against the local tree calls it stale every single month. Deleting
 * it does not lose data (the next run rebuilds it by re-reading the daily
 * indexes) but it does throw away a filing season's worth of progress and send
 * the ingest back over ten thousand managers it had already done.
 */
const PROTECTED_PREFIXES = ["state/"];

async function prune() {
  console.log(`\npruning keys no longer in the build…`);
  const current = await listAll();
  const local = new Set(files);
  const stale = [...current.keys()].filter(
    (k) => !local.has(k) && !PROTECTED_PREFIXES.some((p) => k.startsWith(p)),
  );
  console.log(`  ${current.size} remote, ${stale.length} stale`);

  // SAFETY RAIL. Prune decides what to delete by diffing remote keys against
  // local paths, so any mismatch in key FORMAT — a leading slash, a Windows
  // separator, a changed prefix — makes every remote object look stale and
  // wipes the bucket we just spent twenty minutes filling.
  //
  // In normal operation stale objects are the fund-quarters that rolled out of
  // the retention window: a small fraction. A diff proposing to delete most of
  // the bucket is far more likely to be a bug than a real retention event, so
  // refuse and report rather than proceed. Deleting is the one irreversible
  // thing this script does.
  const ratio = current.size ? stale.length / current.size : 0;
  const MAX_PRUNE_RATIO = 0.5;
  if (stale.length > 100 && ratio > MAX_PRUNE_RATIO) {
    console.log(
      `::warning::refusing to prune — ${stale.length} of ${current.size} ` +
      `(${(ratio * 100).toFixed(0)}%) look stale, which suggests a key-format ` +
      `mismatch rather than a retention roll-off. Nothing deleted.`,
    );
    console.log(`  sample remote: ${[...current.keys()].slice(0, 3).join(", ")}`);
    console.log(`  sample local : ${files.slice(0, 3).join(", ")}`);
    return;
  }

  await pool(stale, CONCURRENCY, del);
}
