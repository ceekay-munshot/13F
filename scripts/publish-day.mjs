#!/usr/bin/env node
// scripts/publish-day.mjs
//
// Publish a SAME-DAY watchlist ingest to R2, additively.
//
//   node scripts/publish-day.mjs --dir=public/data --ciks=0001067983,0001061165
//   node scripts/publish-day.mjs --dir=public/data --ciks=... --dry-run
//
// WHY NOT publish-r2.mjs
// ----------------------
// That script uploads a whole tree and prunes anything not in it. It is exactly
// right for the monthly universe run, which IS the whole truth, and exactly
// wrong for a run that saw thirteen funds — pointing it at a watchlist build
// would delete 9,000 managers from the bucket.
//
// This one can only add:
//   - it uploads nothing outside fund/{cik}/ for the CIKs it was told about,
//   - it never prunes,
//   - it does not write a manifest, it MERGES one, and the merge is verified
//     against the live copy before it is allowed to leave (shared/manifest-merge.mjs),
//   - it reads that live copy from R2 directly rather than through the CDN,
//     because a 60-second-stale manifest merged forward would silently drop
//     whatever the previous run added.
//
// If anything at all is unclear — the live manifest will not parse, the merge
// loses a period, the fund list is empty — it exits non-zero having written
// NOTHING. A stale dashboard is a bad day; a dashboard that has forgotten the
// universe is an outage.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CACHE_CONTROL } from "../shared/artifacts.mjs";
import { mergeManifest, mergeSummary, verifyMerge, isPublishableDayKey } from "../shared/manifest-merge.mjs";
import { signRequest } from "./_sigv4.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const DIR = args.dir || "public/data";
const DRY = Boolean(args["dry-run"]);
const CIKS = String(args.ciks || "").split(",").map((s) => s.trim()).filter(Boolean);

const ACCOUNT = process.env.R2_ACCOUNT_ID;
const KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET || "13f";
const HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;

const fail = (msg) => { console.error(`::error::${msg}`); process.exit(1); };

if (!CIKS.length) fail("--ciks is required: the funds this run refreshed. Refusing to publish blind.");
if (!DRY && (!ACCOUNT || !KEY || !SECRET)) {
  fail("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must all be set.");
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

async function sendSigned(method, key, body, okStatuses = new Set()) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { url, headers } = signRequest({
      method, host: HOST, bucket: BUCKET, key, query: {}, body,
      accessKeyId: KEY, secretAccessKey: SECRET, region: "auto",
    });
    const extra = method === "PUT"
      ? {
          "content-type": "application/json",
          "content-length": String(body.length),
          "cache-control": key === "manifest.json" ? CACHE_CONTROL.manifest : CACHE_CONTROL.artifact,
        }
      : {};
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

function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

(async () => {
  if (!existsSync(DIR)) fail(`${DIR} does not exist — nothing was built.`);

  // --- what this run is allowed to upload ----------------------------------
  const all = walk(DIR);
  const wanted = new Set(CIKS.map((c) => `fund/${c}/`));
  const uploads = all.filter(
    (k) => isPublishableDayKey(k) && k !== "manifest.json" && [...wanted].some((w) => k.startsWith(w)),
  );
  const skipped = all.filter((k) => !uploads.includes(k) && k !== "manifest.json");

  console.log(`same-day publish · ${CIKS.length} fund(s) · ${uploads.length} artifact(s)`);
  if (skipped.length) {
    console.log(`  not this job's to write (${skipped.length}): ${skipped.slice(0, 4).join(", ")}${skipped.length > 4 ? " …" : ""}`);
  }
  if (!uploads.length) fail("no fund artifacts matched the requested CIKs — refusing to touch the manifest.");

  // --- merge the manifest BEFORE uploading anything -------------------------
  //
  // Order matters. If the merge is going to be rejected, it must be rejected
  // while the bucket is still untouched.
  const localManifestPath = join(DIR, "manifest.json");
  if (!existsSync(localManifestPath)) fail("the run produced no manifest.json — the ingest did not complete.");
  const incoming = JSON.parse(readFileSync(localManifestPath, "utf8"));

  let live;
  if (DRY && process.env.LIVE_MANIFEST_URL) {
    // Dry runs can rehearse the merge against the real published manifest
    // without any credentials at all.
    const r = await fetch(process.env.LIVE_MANIFEST_URL);
    if (!r.ok) fail(`could not read the live manifest for a dry run (${r.status})`);
    live = await r.json();
  } else if (DRY) {
    fail("a dry run needs LIVE_MANIFEST_URL so it has a real base to merge into.");
  } else {
    // Straight from the bucket, not the CDN: a 60s-stale manifest merged
    // forward would silently drop whatever the previous run added.
    let res;
    try {
      res = await sendSigned("GET", "manifest.json", null, new Set([404]));
    } catch (err) {
      fail(`could not read the live manifest from R2 (${err.message}). Refusing to publish.`);
    }
    if (res.status === 404) fail("R2 has no manifest.json. That is an outage, not a starting point — run the universe ingest.");
    try {
      live = JSON.parse(await res.text());
    } catch (err) {
      fail(`the live manifest did not parse (${err.message}). Refusing to overwrite it.`);
    }
  }

  const buildId = incoming.buildId;
  let merged;
  try {
    ({ manifest: merged } = mergeManifest(live, incoming, { buildId, ciks: CIKS }));
  } catch (err) {
    fail(`merge refused: ${err.message}`);
  }

  const problems = verifyMerge(live, merged);
  if (problems.length) {
    console.error("::error::the merged manifest would LOSE data. Nothing has been written.");
    for (const p of problems) console.error(`::error::  - ${p}`);
    process.exit(1);
  }

  const newPeriods = merged.periods
    .map((p) => p.period)
    .filter((p) => !live.periods.some((x) => x.period === p));

  console.log(`  live build ${live.buildId} · ${live.counts?.filers} filers · coverage → ${live.coverage?.to}`);
  console.log(`  merged: ${merged.periods.length} periods, coverage → ${merged.coverage.to}` +
              (newPeriods.length ? `, NEW ${newPeriods.join(", ")}` : ", no new quarter"));
  console.log(`  per-fund cache keys stamped: ${CIKS.length}`);

  if (DRY) {
    console.log("\ndry run — nothing uploaded. Merge verified against the live manifest.");
    return;
  }

  // --- upload the fund artifacts, THEN the manifest --------------------------
  //
  // The manifest is the index; publishing it before the files it points at
  // would advertise artifacts that 404. Last, always.
  let done = 0;
  let mergedSummaries = 0;
  const queue = [...uploads];
  await Promise.all(
    Array.from({ length: Math.min(8, queue.length) }, async () => {
      while (queue.length) {
        const k = queue.shift();
        let body = readFileSync(join(DIR, k));

        // A fund's summary carries the series the Fund view charts, and this
        // run fetched two quarters where the universe may hold four. Writing
        // the shallow one would erase two years of bars, so read what is
        // published and union the two. Same rule as the manifest, one level
        // down: nothing this job writes may shrink.
        if (k.endsWith("/summary.json")) {
          const res = await sendSigned("GET", k, null, new Set([404]));
          if (res.status !== 404) {
            try {
              const liveSummary = JSON.parse(await res.text());
              body = Buffer.from(JSON.stringify(mergeSummary(liveSummary, JSON.parse(body.toString("utf8")))));
              mergedSummaries++;
            } catch (err) {
              fail(`could not merge ${k} (${err.message}). Refusing to truncate a fund's history.`);
            }
          }
        }

        await sendSigned("PUT", k, body);
        if (++done % 25 === 0 || done === uploads.length) console.log(`  uploaded ${done}/${uploads.length}`);
      }
    }),
  );
  if (mergedSummaries) console.log(`  ${mergedSummaries} fund summar${mergedSummaries === 1 ? "y" : "ies"} merged with published history`);

  await sendSigned("PUT", "manifest.json", Buffer.from(JSON.stringify(merged, null, 2)));
  console.log(`\npublished ${uploads.length} artifact(s) + merged manifest.`);
  if (newPeriods.length) console.log(`the dashboard's quarter stepper can now reach ${newPeriods.join(", ")}.`);
})().catch((err) => fail(err.stack || err.message));
