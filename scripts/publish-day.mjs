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

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { CACHE_CONTROL } from "../shared/artifacts.mjs";
import { mergeManifest, mergeSummary, mergePeriodFilings, verifyMerge, isPublishableDayKey } from "../shared/manifest-merge.mjs";
import { signRequest } from "./_sigv4.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const DIR = args.dir || "public/data";
const DRY = Boolean(args["dry-run"]);
const str = (v) => (typeof v === "string" && v ? v : null);

/**
 * The ingest cursor's home in the bucket.
 *
 * `state/` is deliberately outside the artifact tree. publish-r2.mjs --prune
 * deletes any remote key the local build does not contain, and the cursor is
 * never part of a build — so the prefix is excluded there by name. Losing the
 * cursor costs a re-scan, not data, but there is no reason to lose it monthly.
 */
const STATE_KEY = str(args["state-key"]) || "state/day-cursor.json";
/** Download the cursor and exit. Run before the planner. */
const PULL_STATE = str(args["pull-state"]);
/** Upload this file as the cursor, but only once the publish has succeeded. */
const PUSH_STATE = str(args.state);

/**
 * The funds this run finished. A file, not a flag, once a run can cover a whole
 * filing season: eight hundred CIKs is a nine-kilobyte command line.
 */
const CIKS = (() => {
  const path = str(args["ciks-file"]);
  const raw = path ? (existsSync(path) ? readFileSync(path, "utf8") : "") : String(args.ciks || "");
  return [...new Set(raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];
})();

/** Coverage measured from EDGAR's daily indexes, written by the planner. */
const PLAN = (() => {
  const path = str(args.plan);
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
})();

const ACCOUNT = process.env.R2_ACCOUNT_ID;
const KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET || "13f";
const HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;

const fail = (msg) => { console.error(`::error::${msg}`); process.exit(1); };

if (!PULL_STATE && !CIKS.length) fail("--ciks or --ciks-file is required: the funds this run refreshed. Refusing to publish blind.");
if (!DRY && (!ACCOUNT || !KEY || !SECRET)) {
  fail("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must all be set.");
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

/** Where a dry run reads published artifacts from — the directory holding the manifest. */
const DRY_BASE = (process.env.LIVE_MANIFEST_URL || "").replace(/\/manifest\.json.*$/, "");

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

/**
 * GET a key and read its body, retrying the WHOLE thing.
 *
 * sendSigned retries the request, but the body is streamed and read afterwards,
 * so a mid-stream failure lands outside its retry entirely. Node's fetch
 * surfaces that as a bare `terminated`, which is what aborted a publish after
 * 125 of 132 uploads: the request had succeeded, the read had not.
 *
 * Returns null for 404 — "not published yet" is an answer, not a failure.
 */
async function readJson(key, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      // A dry run has no credentials by design, so it reads the published copy
      // over HTTPS instead. That is not a lesser rehearsal: the feed merge is
      // the step most worth rehearsing, and reading it through the CDN exercises
      // exactly the bytes a real run would merge into.
      if (DRY) {
        const r = await fetch(`${DRY_BASE}/${key}`, { headers: { "cache-control": "no-cache" } });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`GET ${key} -> ${r.status}`);
        return await r.json();
      }
      const res = await sendSigned("GET", key, null, new Set([404]));
      if (res.status === 404) return null;
      return JSON.parse(await res.text());
    } catch (err) {
      last = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, i * 400));
    }
  }
  throw last;
}

(async () => {
  // --- pull the ingest cursor and stop ---------------------------------------
  //
  // Run before the planner. This is a read of the one piece of state the same-day
  // job owns, kept in the same script as the write so all of this job's R2 access
  // stays behind one surface.
  if (PULL_STATE) {
    let body = "{}";
    try {
      const res = await sendSigned("GET", STATE_KEY, null, new Set([404]));
      if (res.status !== 404) body = await res.text();
      else console.log(`no ingest cursor yet at ${STATE_KEY} — the planner will start a fresh one.`);
    } catch (err) {
      // A cursor we cannot read is a re-scan, not a data loss. Say so and carry
      // on rather than failing the run over an optimisation.
      console.log(`::warning::could not read the ingest cursor (${err.message}); starting from a fresh one this run.`);
    }
    mkdirSync(dirname(PULL_STATE), { recursive: true });
    writeFileSync(PULL_STATE, body);
    return;
  }

  if (!existsSync(DIR)) fail(`${DIR} does not exist — nothing was built.`);

  // --- what this run is allowed to upload ----------------------------------
  const all = walk(DIR);
  // Membership, not prefix scanning. With thirteen CIKs a `some(startsWith)` over
  // every key was free; with eight hundred it is 800 x 3,600 string compares.
  const wanted = new Set(CIKS);
  const fundKeyCik = (k) => (/^fund\/(\d{10})\//.exec(k) ?? [])[1] ?? null;
  // ONLY the quarters this run actually re-ingested.
  //
  // walk(DIR) sees the whole checked-out tree, which carries a filings feed for
  // every quarter back to 2008 — 74 of them. Uploading all of them merged 73
  // files nobody asked about, pushed this run's rows into quarters it had not
  // refreshed, and put enough load on the connection that the read for the one
  // quarter that mattered was terminated mid-stream. Fewer, newer, correct.
  const localManifest = (() => {
    try {
      return JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  const freshPeriods = new Set((localManifest?.periods ?? []).map((x) => x.period));
  const isFeed = (k) => {
    const m = /^period\/(\d{4}-\d{2}-\d{2})\/filings\.json$/.exec(k);
    return Boolean(m) && freshPeriods.has(m[1]);
  };
  // Two shapes, and the distinction matters. A fund/ key is OWNED by this run
  // and overwritten outright; a period feed is SHARED and merged row-by-row
  // below. Both must clear isPublishableDayKey first — that allowlist is the
  // thing standing between this job and another shared index nobody remembered
  // was shared.
  const uploads = all.filter(
    (k) =>
      isPublishableDayKey(k) &&
      k !== "manifest.json" &&
      (wanted.has(fundKeyCik(k)) || isFeed(k)),
  );
  const uploadSet = new Set(uploads);
  const skipped = all.filter((k) => !uploadSet.has(k) && k !== "manifest.json");

  console.log(`same-day publish · ${CIKS.length} fund(s) · ${uploads.length} artifact(s)`);
  if (skipped.length) {
    console.log(`  not this job's to write (${skipped.length}): ${skipped.slice(0, 4).join(", ")}${skipped.length > 4 ? " …" : ""}`);
  }
  if (!uploads.length) fail("no fund artifacts matched the requested CIKs — refusing to touch the manifest.");

  // --- read the live manifest FIRST -----------------------------------------
  //
  // Everything below merges INTO what is published, and the merge has to be
  // rejectable while the bucket is still untouched.
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

  // --- merge the quarter filing feeds, BEFORE the manifest -------------------
  //
  // The feed is SHARED — the universe run writes every manager's rows into it —
  // so it is merged by accession and never replaced. Replacing it would be the
  // 9,000-funds-to-8 failure again, one file over.
  //
  // It happens here, ahead of the manifest, because the merged feed is the only
  // place the ACCUMULATED size of a quarter is known. The manifest used to take
  // `max(published, this run's sample)`, which is right when the universe holds
  // 10,648 and a same-day run sees 13 — and badly wrong once the same-day job is
  // the thing filling a quarter. Run after run publishing 450 filings into a
  // quarter that already held 450 would report 450 for ever: the dashboard's
  // count of the quarter would freeze, and so would the staleness watchdog's,
  // because that is the number it grades.
  const isFeedKey = (k) => /^period\/\d{4}-\d{2}-\d{2}\/filings\.json$/.test(k);
  const feedKeys = uploads.filter(isFeedKey);
  const fundKeys = uploads.filter((k) => !isFeedKey(k));
  /** key -> the exact bytes to upload */
  const feedBodies = new Map();
  /** period -> { filings, funds, known, knownAsOf }, for the manifest */
  const periodTotals = {};
  const skippedFeeds = [];
  const repairedFeeds = [];
  let mergedFeeds = 0;

  // Coverage measured from EDGAR's daily indexes: how many managers have
  // actually filed for the quarter, whatever we happen to hold. Attached only to
  // the period the plan was drawn for — it says nothing about any other.
  const planned = (period) =>
    PLAN && PLAN.period === period && Number.isFinite(PLAN.filersKnown) && PLAN.filersKnown > 0;

  const knownFor = (period) =>
    planned(period) ? { known: PLAN.filersKnown, knownAsOf: PLAN.generatedAt ?? null } : {};

  for (const k of feedKeys) {
    const period = k.split("/")[1];
    const mineEnvelope = JSON.parse(readFileSync(join(DIR, k), "utf8"));
    let liveFeed = null;
    try {
      liveFeed = await readJson(k);
    } catch (err) {
      // The live feed could not be READ. That is not the same as knowing a write
      // would truncate it — and the manifest already records how many filings
      // each quarter has, so the question can be answered without the file.
      const liveCount = (live?.periods ?? []).find((x) => x.period === period)?.filings ?? Infinity;
      const mineCount = mineEnvelope.data?.length ?? 0;
      if (mineCount >= liveCount) {
        console.log(
          `::warning::could not read ${k} (${err.message}); publishing this run's ${mineCount} rows, ` +
            `which is not fewer than the ${liveCount} the manifest records.`,
        );
        repairedFeeds.push(k);
      } else {
        console.log(
          `::warning::could not merge ${k} (${err.message}); this run holds ${mineCount} rows against ` +
            `${liveCount} published, so the feed is left alone rather than shortened.`,
        );
        skippedFeeds.push(k);
        continue;
      }
    }

    let out;
    try {
      out = liveFeed
        ? mergePeriodFilings(liveFeed, mineEnvelope, CIKS, knownFor(period))
        : {
            // Nothing published for this quarter yet — ours IS the feed.
            ...mineEnvelope,
            total: mineEnvelope.data?.length ?? 0,
            funds: new Set((mineEnvelope.data ?? []).map((r) => r.cik)).size,
            shown: mineEnvelope.data?.length ?? 0,
            ...knownFor(period),
          };
    } catch (err) {
      fail(`could not merge ${k} (${err.message}). Refusing to shorten a shared feed.`);
    }
    if (liveFeed) mergedFeeds++;
    feedBodies.set(k, Buffer.from(JSON.stringify(out)));

    // THE CURSOR IS THE AUTHORITY ON HOW MUCH OF A QUARTER IS IN.
    //
    // The feed's own count stops climbing once a quarter passes the display cap,
    // because a capped list cannot count what was dropped from it. The ingest
    // cursor can: it holds every filer EDGAR published for the season and every
    // one still owed a fetch, so `known - pending` is exactly how many managers
    // have been through, however large the quarter gets.
    const ingested = planned(period) && Number.isFinite(PLAN.filersIngested) ? PLAN.filersIngested : 0;
    periodTotals[period] = {
      filings: Math.max(out.total ?? 0, ingested),
      funds: Math.max(out.funds ?? 0, ingested),
      ...(out.known != null ? { known: out.known, knownAsOf: out.knownAsOf ?? null } : {}),
    };
  }

  // --- merge the manifest ----------------------------------------------------
  const buildId = incoming.buildId;
  let merged;
  try {
    ({ manifest: merged } = mergeManifest(live, incoming, { buildId, ciks: CIKS, periodTotals }));
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
  for (const [period, t] of Object.entries(periodTotals)) {
    console.log(
      `  ${period}: ${t.filings} filing(s) from ${t.funds} manager(s)` +
      (t.known
        ? ` · EDGAR has published ${t.known} for this quarter — ${Math.round((t.funds / t.known) * 100)}% ingested`
        : ""),
    );
  }
  console.log(`  per-fund cache keys stamped: ${CIKS.length}`);

  if (DRY) {
    console.log("\ndry run — nothing uploaded. Merge verified against the live manifest.");
    return;
  }

  // --- upload the fund artifacts, THEN the feeds, THEN the manifest ----------
  //
  // The manifest is the index; publishing it before the files it points at would
  // advertise artifacts that 404. Last, always.
  let done = 0;
  let mergedSummaries = 0;
  const total = fundKeys.length + feedBodies.size;
  const queue = [...fundKeys];
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(8, queue.length)) }, async () => {
      while (queue.length) {
        const k = queue.shift();
        let body = readFileSync(join(DIR, k));

        // A fund's summary carries the series the Fund view charts, and this
        // run fetched two quarters where the universe may hold four. Writing
        // the shallow one would erase two years of bars, so read what is
        // published and union the two. Same rule as the manifest, one level
        // down: nothing this job writes may shrink.
        if (k.endsWith("/summary.json")) {
          try {
            const liveSummary = await readJson(k);
            if (liveSummary) {
              body = Buffer.from(JSON.stringify(mergeSummary(liveSummary, JSON.parse(body.toString("utf8")))));
              mergedSummaries++;
            }
          } catch (err) {
            fail(`could not merge ${k} (${err.message}). Refusing to truncate a fund's history.`);
          }
        }

        await sendSigned("PUT", k, body);
        if (++done % 100 === 0 || done === total) console.log(`  uploaded ${done}/${total}`);
      }
    }),
  );
  for (const [k, body] of feedBodies) {
    await sendSigned("PUT", k, body);
    if (++done % 100 === 0 || done === total) console.log(`  uploaded ${done}/${total}`);
  }

  if (mergedSummaries) console.log(`  ${mergedSummaries} fund summar${mergedSummaries === 1 ? "y" : "ies"} merged with published history`);
  if (mergedFeeds) console.log(`  ${mergedFeeds} quarter filing feed(s) merged with published rows`);
  if (repairedFeeds.length) console.log(`  ${repairedFeeds.length} feed(s) rewritten whole (unreadable, but no rows lost): ${repairedFeeds.join(", ")}`);
  if (skippedFeeds.length) console.log(`  ${skippedFeeds.length} feed(s) left untouched: ${skippedFeeds.join(", ")}`);

  await sendSigned("PUT", "manifest.json", Buffer.from(JSON.stringify(merged, null, 2)));
  console.log(`\npublished ${total} artifact(s) + merged manifest.`);
  if (newPeriods.length) console.log(`the dashboard's quarter stepper can now reach ${newPeriods.join(", ")}.`);

  // --- advance the ingest cursor, LAST ---------------------------------------
  //
  // Only now. The cursor records which filers no longer need fetching, so writing
  // it before the artifacts landed would mark work done that a failed upload
  // never did — and nothing would ever go back for it.
  if (PUSH_STATE) {
    if (!existsSync(PUSH_STATE)) {
      console.log(`::warning::${PUSH_STATE} does not exist — the cursor was not advanced, so the next run re-offers these filers.`);
    } else {
      await sendSigned("PUT", STATE_KEY, readFileSync(PUSH_STATE));
      console.log(`ingest cursor advanced (${STATE_KEY}).`);
    }
  }
})().catch((err) => fail(err.stack || err.message));
