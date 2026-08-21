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
import { mergeSummary, mergeFilers, mergeSeriesIndex, isPrunableKey, periodOfKey, carryForwardPeriods } from "../shared/manifest-merge.mjs";
import { createRegister } from "../shared/unfinished.mjs";
import { createR2, pool } from "./_r2.mjs";

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

// The one R2 client — signing, retries and paged listing live in _r2.mjs so the
// source archive cannot end up with a second, subtly different copy of them.
const r2 = createR2({
  accountId: ACCOUNT, accessKeyId: KEY, secretAccessKey: SECRET,
  bucket: BUCKET, region: REGION, headersFor,
});
const sendSigned = r2.send;

// Declared HERE, above every use. It previously sat below prune(), so the
// first thing prune did was read a const still in its temporal dead zone and
// throw — silently, every single run, for as long as it had existed.
//
// `source/` holds the SEC's own bulk files — the copy the dashboard is rebuilt
// from. isPrunableKey treats a key with no quarter in it as ordinary retention,
// so without this line the monthly prune would delete the entire store of
// record: 345 MB that costs a day of SEC downloads to replace, and whose whole
// purpose is to survive a bad publish.
const PROTECTED_PREFIXES = ["state/", "source/"];

// Work this run was supposed to do and did not. See shared/unfinished.mjs for
// why this is deferred to the end of the run rather than thrown immediately.
const unfinished = createRegister();

const put = r2.put;
const del = r2.del;

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
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
  remote = await r2.list();
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
/**
 * Read a published object and parse it, retrying request AND body together.
 *
 * sendSigned retries the request; the body is streamed and read afterwards, so
 * a mid-stream failure lands outside its retry entirely. Returns null for 404 —
 * "not published yet" is an answer, not a failure.
 */
async function readJson(key, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
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

let mergedSummaries = 0;
let mergedFilers = 0;
let mergedSeries = false;
let keptSeries = null;
let keptFilers = null;
const keptSummaries = [];

await pool(todo, CONCURRENCY, async (f) => {
  let body = readFileSync(join(DIR, f));

  // ---------------------------------------------------------------------------
  // A FUND SUMMARY MAY NEVER LOSE A QUARTER, WHOEVER IS WRITING IT.
  //
  // This job covers only the quarters whose SEC bulk window has been published.
  // During a filing season the CURRENT quarter has no window for about a month
  // after the deadline, so this run legitimately knows nothing about it — while
  // the same-day job has been publishing it for weeks.
  //
  // Writing summaries wholesale therefore deleted the newest quarter from every
  // fund. Observed: on 2026-08-20 this run dropped Q2 2026 from all 9,268
  // summaries, and the Fund page — which reads the summary to decide whether a
  // manager has filed — told a client that Cantillon had not filed for Q2 when
  // their 27-position filing had been on the site for weeks. The holdings, the
  // feed and the manifest all still had it; only this file lost it.
  //
  // publish-day.mjs has enforced exactly this rule since it was written. The
  // invariant was simply never applied to the other writer, which is the one
  // that rewrites all of them.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // THE SAME RULE, ONE FILE OVER.
  //
  // meta/filers.json is the fund search index — the only way to reach a
  // manager's page by name. The same-day job has always merged it row by row.
  // This job did not: it wrote its own copy over the top, so every manager the
  // same-day job had discovered, and every quarter it had added, was reset to
  // whatever this run happened to build.
  //
  // That is the 2026-08-20 outage exactly, in the file next door. It has not
  // fired yet only because the monthly job has not run since the same-day job
  // started reaching Q2 2026. On its next scheduled run — 3 September — it
  // would have moved 987 managers' newest quarter backwards from Q2 to Q1.
  // ---------------------------------------------------------------------------
  // The compact series index — written only by a full build, and until now
  // replaced outright. See mergeSeriesIndex for why this is temporary.
  if (f === "meta/series.json") {
    try {
      const live = await readJson(f);
      if (live) {
        body = Buffer.from(JSON.stringify(mergeSeriesIndex(live, JSON.parse(body.toString("utf8")))));
        mergedSeries = true;
      }
    } catch (err) {
      keptSeries = err.message;
      return;
    }
  }

  if (f === "meta/filers.json") {
    try {
      const live = await readJson(f);
      if (live) {
        const mine = JSON.parse(body.toString("utf8"));
        // This run speaks for every fund it built, and for no others.
        const ciks = (mine.data ?? []).map((r) => r.cik);
        body = Buffer.from(JSON.stringify(mergeFilers(live, mine, ciks)));
        mergedFilers = ciks.length;
      }
    } catch (err) {
      // Same contract as the summaries: unable to prove the write is safe, so
      // leave the published index alone rather than shorten it.
      keptFilers = err.message;
      return;
    }
  }

  if (f.endsWith("/summary.json")) {
    try {
      const live = await readJson(f);
      if (live) {
        body = Buffer.from(JSON.stringify(mergeSummary(live, JSON.parse(body.toString("utf8")))));
        mergedSummaries++;
      }
    } catch (err) {
      // Could not read what is published, so cannot prove the write is safe.
      // Leave the published summary alone: stale by a quarter beats silently
      // shorter, and every other artifact for this fund still lands.
      keptSummaries.push(f);
      return;
    }
  }

  await put(f, body);
}, (d, n) => console.log(`  ${d}/${n}`));
if (mergedSeries) console.log(`  series index merged with published quarters`);
if (keptSeries) {
  console.log(`series index left as published — could not be read to merge safely (${keptSeries}).`);
  unfinished.note(
    `the compact series index was NOT updated (${keptSeries}). Funds without their own summary file keep ` +
    `whatever it already said. Nothing was lost; nothing was added either.`,
  );
}
if (mergedFilers) console.log(`  fund search index merged — ${mergedFilers} manager(s) from this run folded into what is published`);
if (keptFilers) {
  console.log(`fund search index left as published — could not be read to merge safely (${keptFilers}).`);
  unfinished.note(
    `the fund search index was NOT updated (${keptFilers}). Managers this run discovered cannot be found ` +
    `by name until a later run repairs it. Nothing was lost; nothing was added either.`,
  );
}
if (mergedSummaries) console.log(`  ${mergedSummaries} fund summaries merged with published history`);
if (keptSummaries.length) {
  console.log(`${keptSummaries.length} summar(y|ies) left as published — could not be read to merge safely.`);
  unfinished.note(
    `${keptSummaries.length} fund summar(y|ies) were NOT updated because the published copy could not be read: ` +
    `${keptSummaries.slice(0, 5).join(", ")}${keptSummaries.length > 5 ? " …" : ""}. Those funds are stale, not wrong.`,
  );
}

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
// THE MANIFEST, WITH QUARTERS THIS RUN DOES NOT KNOW ABOUT LEFT INTACT.
//
// This run is authoritative about every quarter it covers and silent about
// every quarter it does not. Publishing its manifest as-is removed the current
// quarter from the dashboard's quarter selector during a filing season — while
// the data for that quarter was still in the bucket, published by the same-day
// job. The site could not reach data it definitely had.
let manifestBody = readFileSync(join(DIR, "manifest.json"));
try {
  const live = await readJson("manifest.json");
  if (live) {
    const { manifest: merged, carried } = carryForwardPeriods(live, JSON.parse(manifestBody.toString("utf8")));
    if (carried.length) {
      manifestBody = Buffer.from(JSON.stringify(merged, null, 2));
      console.log(`  carried forward ${carried.length} quarter(s) this run has no window for: ${carried.join(", ")}`);
    }
  }
} catch (err) {
  // The manifest MUST be published — without it the dashboard is a dead page,
  // which is far worse than a quarter briefly missing from the stepper. So
  // publish what this run built and say what could not be checked.
  console.log(`could not read the live manifest to carry quarters forward (${err.message}); publishing this run's own.`);
  unfinished.note(
    `the live manifest could not be read (${err.message}), so quarters this run has no window for may have dropped ` +
    `out of the quarter selector. The data is still in the bucket; the index is what lost them.`,
  );
}
await put("manifest.json", manifestBody);
console.log(`\nmanifest published — build is now live.`);

if (PRUNE) {
  try {
    await prune();
  } catch (err) {
    console.log(`prune failed (${err.message}) — the build is already live; stale objects remain.`);
    unfinished.note(`prune did not run (${err.message}). Nothing was deleted, so nothing is lost — but retention is not being applied and the failure would go unnoticed on a green run.`);
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
async function prune() {
  console.log(`\npruning keys no longer in the build…`);
  const current = await r2.list();
  const local = new Set(files);
  // Quarters this run actually produced. Anything belonging to a quarter NOT in
  // here is outside what this run knows about — see isPrunableKey.
  const builtPeriods = new Set(
    files.map((f) => periodOfKey(f)).filter((p) => p !== null),
  );
  // Managers this run actually built. Anything under fund/{cik}/ for a manager
  // NOT in here belongs to a first-time filer the same-day job discovered and
  // the bulk windows have never seen — see isPrunableKey.
  const builtCiks = new Set(
    files.map((f) => (/^fund\/(\d{10})\//.exec(f) ?? [])[1]).filter(Boolean),
  );
  // -------------------------------------------------------------------------
  // A QUARTER'S COVERAGE MAY NOT SHRINK.
  // -------------------------------------------------------------------------
  // `builtPeriods` asks "did this run produce anything for that quarter?" —
  // which is far too generous. On 3 September the monthly job runs before the
  // SEC publishes the bulk window covering the Q2 2026 deadline, so it will hold
  // Q2 for only the handful of funds the same-day job archived directly. Every
  // other manager's Q2 came from the repair and lives in artifacts, not in the
  // source archive. The quarter is therefore "built", and every one of the 8,428
  // managers holding it would have had that quarter deleted.
  //
  // That is the 2026-08-20 outage exactly, rescheduled — and prune works now, so
  // it would actually have happened.
  //
  // Producing three fund-quarters where the site has 8,428 is not a retention
  // roll-off. It is a partial build, and the difference is measurable: compare
  // what this run produced for each quarter against what is published, and
  // refuse to prune any quarter it covers less well.
  const COVERAGE_FLOOR = 0.98;
  const countByPeriod = (keys) => {
    const out = new Map();
    for (const k of keys) {
      const p = periodOfKey(k);
      if (p) out.set(p, (out.get(p) ?? 0) + 1);
    }
    return out;
  };
  const remoteCounts = countByPeriod(current.keys());
  const localCounts = countByPeriod(files);
  const thin = [];
  for (const [period, remoteN] of remoteCounts) {
    if (!builtPeriods.has(period)) continue;      // already shielded
    const localN = localCounts.get(period) ?? 0;
    if (localN < remoteN * COVERAGE_FLOOR) {
      builtPeriods.delete(period);
      thin.push({ period, localN, remoteN });
    }
  }
  // A THIN QUARTER IS ONLY A FAULT IF THE SOURCE FOR IT EXISTS.
  //
  // The SEC publishes a bulk window about a month after it closes, and a
  // quarter's filings land in the window containing its DEADLINE. So for roughly
  // six weeks after each deadline the archive genuinely cannot cover that
  // quarter, and a thin build is the calendar rather than a fault.
  //
  // Reported either way — nothing is pruned either way — but only the case where
  // the source SHOULD have been there ends the run red. An alarm that fires for
  // six weeks out of every thirteen is one nobody reads by December.
  let archivedWindows = new Map();
  if (thin.length) {
    try {
      const { windowsFrom } = await import("../shared/source-archive.mjs");
      archivedWindows = windowsFrom(await r2.list("source/dera/"));
    } catch (err) {
      console.log(`  could not read the source archive to explain thin quarters (${err.message})`);
    }
  }
  const { edgarQuartersSupersededBy } = thin.length
    ? await import("../shared/source-archive.mjs")
    : { edgarQuartersSupersededBy: () => new Set() };
  const { filingDeadline } = thin.length
    ? await import("../shared/calendar.mjs")
    : { filingDeadline: () => null };

  const deadlines = Object.fromEntries(thin.map((t) => [t.period, filingDeadline(t.period)]));
  const sourced = edgarQuartersSupersededBy(archivedWindows, deadlines);

  for (const t of thin) {
    const expected = !sourced.has(t.period);
    console.log(
      `  not pruning ${t.period}: this run produced ${t.localN} object(s) for it against ` +
      `${t.remoteN} published. ` +
      (expected
        ? `No archived bulk window covers its ${deadlines[t.period]} deadline yet, so a thin build is the calendar.`
        : `A partial build, not a retention roll-off.`),
    );
    if (expected) continue;
    unfinished.note(
      `${t.period} was covered by only ${t.localN} of the ${t.remoteN} objects published for it, and the bulk ` +
      `window covering its ${deadlines[t.period]} deadline IS archived — so the build should have had this data ` +
      `and did not. Nothing was pruned, so nothing is lost, but a run that pruned here would have deleted it.`,
    );
  }

  const stale = [...current.keys()].filter(
    (k) => !local.has(k) && isPrunableKey(k, builtPeriods, PROTECTED_PREFIXES, builtCiks),
  );
  const shielded = [...current.keys()].filter(
    (k) => !local.has(k) && !isPrunableKey(k, builtPeriods, PROTECTED_PREFIXES, builtCiks),
  ).length;
  console.log(`  ${current.size} remote · ${stale.length} stale · covering ${[...builtPeriods].sort().join(", ") || "no quarters"}`);
  if (shielded) {
    console.log(`  ${shielded} object(s) left alone — they belong to quarters this run did not build.`);
  }

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
      `refusing to prune — ${stale.length} of ${current.size} ` +
      `(${(ratio * 100).toFixed(0)}%) look stale, which suggests a key-format ` +
      `mismatch rather than a retention roll-off. Nothing deleted.`,
    );
    console.log(`  sample remote: ${[...current.keys()].slice(0, 3).join(", ")}`);
    console.log(`  sample local : ${files.slice(0, 3).join(", ")}`);
    unfinished.note(
      `prune refused: ${stale.length} of ${current.size} objects looked stale, which is far more than a ` +
      `retention roll-off. Nothing was deleted. Something about the key format or the build is wrong.`,
    );
    return;
  }

  await pool(stale, CONCURRENCY, del, (d, n) => console.log(`  ${d}/${n}`));
}

// The verdict. Everything above has already been published, so this cannot cost
// a build — it only decides what colour the run is.
process.exit(unfinished.report("The publish"));
