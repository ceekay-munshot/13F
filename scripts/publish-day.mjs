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
import { mergeManifest, mergeSummary, mergePeriodFilings, mergeFilers, verifyMerge, isPublishableDayKey } from "../shared/manifest-merge.mjs";
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
  // Zero-padded to ten, because that is the form every artifact path uses. A
  // hand-dispatched run that typed `1067983` matched no `fund/0001067983/` key
  // and silently published nothing for it.
  return [...new Set(
    raw.split(/[,\s]+/).map((c) => c.replace(/\D/g, "")).filter(Boolean).map((c) => c.padStart(10, "0")),
  )];
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
/** path -> cache key, filled from the live manifest once a dry run has read it. */
let DRY_BUILD = {};

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
        // WITH THE CACHE KEY THE MANIFEST HANDS OUT, not the bare path.
        //
        // Artifacts are served `immutable` for a year, so the un-keyed URL is
        // pinned to whatever was first cached there — for the Q2 feed that was a
        // 13-row copy from before the backfill started. A rehearsal reading it
        // reported the merge as producing 14 rows where the live object had 547,
        // which looks exactly like the data loss this whole file exists to
        // prevent. Real runs read R2 directly and were never affected; only the
        // rehearsal lied, and a rehearsal that lies is worse than none.
        const key2 = DRY_BUILD[key] ? `${key}?b=${DRY_BUILD[key]}` : key;
        const r = await fetch(`${DRY_BASE}/${key2}`, { headers: { "cache-control": "no-cache" } });
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
  /**
   * A fund key this run actually WROTE — not merely one whose CIK it was given.
   *
   * The output tree is a working directory the ingest writes into, and if that
   * directory is a checkout of `public/data` it already holds 2,399 committed
   * artifacts for 397 funds and 74 quarters, last built 2026-07-30. Filtering on
   * the CIK alone happily uploaded every one of those for any discovered manager,
   * overwriting fresher R2 copies with a fortnight-old build and resurrecting
   * quarters the retention prune had deliberately removed. The period feed got
   * this guard when the same problem bit it (`freshPeriods`); the fund branch
   * kept a comment claiming it was owned by the run, which was not true.
   *
   * The workflow now also points --out at a scratch directory, so the tree holds
   * only this run's work. Both together: a wrong --out cannot leak stale files,
   * and a stale file cannot be published even if one appears.
   */
  const isFresh = (k) => {
    const m = /^fund\/(\d{10})\/(?:(\d{4}-\d{2}-\d{2})(?:\.p\d+)?\.json|summary\.json)$/.exec(k);
    if (!m) return false;
    if (!wanted.has(m[1])) return false;
    return m[2] ? freshPeriods.has(m[2]) : true; // summary.json is always this run's
  };

  // Three shapes now, and the distinctions matter. A fund/ key is written by this
  // run and overwritten outright; the period feed and the filer index are SHARED
  // and merged row-by-row below. All must clear isPublishableDayKey first — that
  // allowlist is the thing standing between this job and another shared index
  // nobody remembered was shared.
  const uploads = all.filter(
    (k) =>
      isPublishableDayKey(k) &&
      k !== "manifest.json" &&
      (isFresh(k) || isFeed(k) || k === "meta/filers.json"),
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
    DRY_BUILD = Object.fromEntries(
      Object.entries(live.shared ?? {}).concat(
        CIKS.map((c) => [`fund/${c}/summary.json`, live.funds?.[c]]).filter(([, b]) => b),
      ),
    );
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
  const fundKeys = uploads.filter((k) => !isFeedKey(k) && k !== "meta/filers.json");
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

  // --- merge every fund summary, ALSO before anything is written -------------
  //
  // A fund's summary carries the series the Fund view charts, and this run
  // fetched two quarters where the universe may hold four. Writing the shallow
  // one would erase two years of bars, so read what is published and union the
  // two: nothing this job writes may shrink.
  //
  // WHY IT HAPPENS HERE AND NOT DURING THE UPLOAD. It used to run inside the
  // upload workers, where a single unreadable summary called fail() — an
  // immediate process.exit(1) with seven sibling PUTs in flight, the feeds not
  // yet written, the manifest not written and the cursor not advanced. That
  // leaves artifacts in R2 with nothing pointing at them, which is the exact
  // shape commit 9ab364e fixed for the quarter feed with the rule "fail closed
  // on the FILE, not on the run". With thirteen funds a run it was a remote
  // risk; over eight hundred it is a matter of time.
  //
  // So a fund whose summary cannot be merged is DROPPED FROM THE RUN — its
  // artifacts are not uploaded, it is not counted, and its cursor entry is not
  // advanced, so the next run simply fetches it again. Nothing is lost and
  // nothing half-lands.
  const summaryBodies = new Map();
  const droppedFunds = new Set();
  {
    const summaryKeys = fundKeys.filter((k) => k.endsWith("/summary.json"));
    const queue = [...summaryKeys];
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(8, queue.length)) }, async () => {
        while (queue.length) {
          const k = queue.shift();
          const cik = fundKeyCik(k);
          try {
            const liveSummary = await readJson(k);
            const mineSummary = JSON.parse(readFileSync(join(DIR, k), "utf8"));
            summaryBodies.set(
              k,
              Buffer.from(JSON.stringify(liveSummary ? mergeSummary(liveSummary, mineSummary) : mineSummary)),
            );
          } catch (err) {
            console.log(`::warning::dropping ${cik} from this run — its published summary could not be merged (${err.message}). The next run will fetch it again.`);
            if (cik) droppedFunds.add(cik);
          }
        }
      }),
    );
  }

  const publishing = CIKS.filter((c) => !droppedFunds.has(c));
  if (!publishing.length) fail("every fund in this run failed its summary merge — refusing to publish a manifest that claims them.");
  const keepFund = (k) => {
    const c = fundKeyCik(k);
    return !c || !droppedFunds.has(c);
  };

  // --- merge the fund SEARCH INDEX -------------------------------------------
  //
  // `meta/filers.json` is what the search box reads and what the dashboard picks
  // its opening fund from. It was written only by the monthly universe run, so a
  // manager this path discovered had artifacts in the bucket and no row in the
  // index: unfindable, and — because the dashboard opens on the largest filer
  // whose newest period reaches the current quarter — it fell through to
  // whichever fund happened to be first. Verified live on 2026-08-18: the
  // published index had ZERO rows reaching Q2 2026 while the manifest's newest
  // quarter WAS Q2 2026.
  //
  // Shared, so merged on the same terms as the feed: this run speaks only for
  // its own CIKs and every other row is carried through untouched.
  let filersBody = null;
  const FILERS_KEY = "meta/filers.json";
  if (uploads.includes(FILERS_KEY)) {
    try {
      const liveFilers = await readJson(FILERS_KEY);
      const mineFilers = JSON.parse(readFileSync(join(DIR, FILERS_KEY), "utf8"));
      filersBody = Buffer.from(
        JSON.stringify(liveFilers ? mergeFilers(liveFilers, mineFilers, publishing) : mineFilers),
      );
    } catch (err) {
      // The index is an aid to navigation, not the data. A run that cannot merge
      // it should still publish the holdings it fetched — and say plainly that
      // those managers will not be searchable until the next run repairs it.
      console.log(`::warning::could not merge ${FILERS_KEY} (${err.message}); this run's funds will not appear in fund search until a later run repairs it.`);
    }
  }

  // --- merge the manifest ----------------------------------------------------
  const buildId = incoming.buildId;
  let merged;
  try {
    ({ manifest: merged } = mergeManifest(live, incoming, {
      buildId,
      // Only funds whose artifacts are actually going up get a cache key. A
      // stamp on a fund nothing was written for moves its URL to a build that
      // does not exist for it and grows the manifest on the critical path.
      ciks: publishing,
      periodTotals,
      // Rewriting a shared file has to move its cache key too, or it stays
      // pinned in every returning visitor's cache for a year.
      sharedKeys: [...feedBodies.keys(), ...(filersBody ? [FILERS_KEY] : [])],
    }));
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
  const toUpload = fundKeys.filter(keepFund);
  const total = toUpload.length + feedBodies.size + (filersBody ? 1 : 0);
  const queue = [...toUpload];
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(8, queue.length)) }, async () => {
      while (queue.length) {
        const k = queue.shift();
        // Summaries were merged in the preflight above; everything else goes up
        // exactly as the ingest wrote it.
        const body = summaryBodies.get(k) ?? readFileSync(join(DIR, k));
        await sendSigned("PUT", k, body);
        if (++done % 100 === 0 || done === total) console.log(`  uploaded ${done}/${total}`);
      }
    }),
  );
  for (const [k, body] of feedBodies) {
    await sendSigned("PUT", k, body);
    if (++done % 100 === 0 || done === total) console.log(`  uploaded ${done}/${total}`);
  }
  if (filersBody) {
    await sendSigned("PUT", FILERS_KEY, filersBody);
    if (++done % 100 === 0 || done === total) console.log(`  uploaded ${done}/${total}`);
  }

  if (summaryBodies.size) console.log(`  ${summaryBodies.size} fund summar${summaryBodies.size === 1 ? "y" : "ies"} merged with published history`);
  if (filersBody) console.log(`  fund search index merged (${publishing.length} manager(s) refreshed)`);
  if (droppedFunds.size) console.log(`  ${droppedFunds.size} fund(s) dropped from this run and left for the next: ${[...droppedFunds].slice(0, 5).join(", ")}`);
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
      // REQUEUE ONLY THE FUNDS THIS PUBLISH DROPPED — bank the rest.
      //
      // The commit step already crossed EVERY completed fund off the cursor,
      // including any that then failed their summary merge here (a transient
      // "terminated" R2 read is the usual cause). The first version of this
      // guard reacted to a single drop by discarding the WHOLE advance and
      // re-offering the entire batch next run. That is safe but ruinously slow:
      // at ~555 funds a run a lone transient drop is common, so most runs banked
      // nothing and the next simply re-did all 555 — the cursor crept forward
      // only on the rare drop-free run, roughly quartering real throughput.
      //
      // The correct move is surgical: put just the dropped CIKs back on the
      // pending list (on every day whose index listed them), leave the other
      // ~554 crossed off, and advance. A dropped fund is retried next run; a
      // finished fund is never re-fetched. Still never loses a manager.
      let cursor;
      try {
        cursor = JSON.parse(readFileSync(PUSH_STATE, "utf8"));
      } catch (err) {
        fail(`the cursor at ${PUSH_STATE} did not parse (${err.message}); refusing to publish a broken cursor.`);
      }
      let requeued = 0;
      if (droppedFunds.size && cursor?.days) {
        for (const day of Object.values(cursor.days)) {
          const all = new Set(day.all ?? []);
          const pending = new Set(day.pending ?? []);
          for (const cik of droppedFunds) {
            if (all.has(cik) && !pending.has(cik)) { pending.add(cik); requeued++; }
          }
          day.pending = [...pending];
        }
      }
      await sendSigned("PUT", STATE_KEY, Buffer.from(JSON.stringify(cursor)));
      console.log(
        `ingest cursor advanced (${STATE_KEY})` +
        (droppedFunds.size ? ` · ${droppedFunds.size} dropped fund(s) requeued for the next run` : "") + ".",
      );
    }
  }
})().catch((err) => fail(err.stack || err.message));
