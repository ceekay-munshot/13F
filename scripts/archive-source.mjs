#!/usr/bin/env node
// scripts/archive-source.mjs
//
// Keep the SEC's own files, instead of downloading them and throwing them away.
//
//   node scripts/archive-source.mjs --sync=.cache      # archive what the run fetched
//   node scripts/archive-source.mjs --list
//   node scripts/archive-source.mjs --verify           # read a filing back out of it
//   node scripts/archive-source.mjs --prune --keep=4
//
// ---------------------------------------------------------------------------
// WHY
// ---------------------------------------------------------------------------
// Until now nothing kept a copy of anything. `.cache/` is gitignored and is not
// persisted between workflow runs, so every monthly build downloaded ~345 MB of
// SEC bulk data, built the dashboard from it, and discarded it. The dashboard's
// own JSON files were therefore the ONLY copy of the data in existence.
//
// That single fact produced every failure this project has had. Because a write
// could destroy the only copy, every write had to hand-preserve what was already
// there — seven bespoke merge functions and counting. Because there was nothing
// to rebuild from, the 2026-08-20 outage could not be repaired for a year. And
// because coverage could not be counted from the data, it was counted from a
// to-do list, and reported "10,765 of 10,765" while 8,295 pages said otherwise.
//
// A window is ~90 MB and there are four. Against an artifact tree that already
// costs 1,225 MB inside a 10 GB allowance, keeping the source is a third the
// price of keeping the output.
//
// ---------------------------------------------------------------------------
// WRITE-ONCE
// ---------------------------------------------------------------------------
// These files are immutable at the source: the SEC publishes a window once and
// does not revise it. So this never overwrites. If a key is already there at a
// different size, that is not a fresher copy to be preferred — it is something
// to look at, and it is reported rather than resolved.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_PREFIX, windowsFrom, windowsToDrop } from "../shared/source-archive.mjs";
import { createR2 } from "./_r2.mjs";
import { createRegister } from "../shared/unfinished.mjs";
import { listEntries } from "./_unzip.mjs";
import { SecFetcher } from "./_sec-fetch.mjs";
import { deraWindowFor } from "../shared/calendar.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const KEEP = Number(args.keep || 4);
const DRY = Boolean(args["dry-run"]);

const ACCOUNT = process.env.R2_ACCOUNT_ID;
const KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET = process.env.R2_SECRET_ACCESS_KEY;

if (!ACCOUNT || !KEY || !SECRET) {
  console.error("::error::R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must all be set.");
  process.exit(1);
}

const unfinished = createRegister();
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

const r2 = createR2({
  accountId: ACCOUNT, accessKeyId: KEY, secretAccessKey: SECRET,
  bucket: process.env.R2_BUCKET || "13f",
  // Archived source is not served to anyone and never changes. No cache policy
  // to get wrong; just say what it is.
  headersFor: () => ({ "content-type": "application/zip" }),
});

const archived = await r2.list(SOURCE_PREFIX);
const windows = windowsFrom(archived);

// --- list ------------------------------------------------------------------
if (args.list || (!args.sync && !args.verify && !args.prune)) {
  if (!windows.size) {
    console.log(`nothing archived yet under ${SOURCE_PREFIX}`);
  } else {
    console.log(`${windows.size} window(s) archived — the SEC would not have to be asked again for these:\n`);
    const ordered = [...windows.entries()].sort((a, b) => b[1].start.localeCompare(a[1].start));
    let total = 0;
    for (const [slug, w] of ordered) {
      total += w.size;
      console.log(`  ${w.start}  ${slug.padEnd(22)} ${mb(w.size).padStart(9)}`);
    }
    console.log(`\n  ${mb(total)} of the 10 GB allowance`);
  }
}

// --- sync ------------------------------------------------------------------
//
// Archive whatever the run has on disk. Called after the ingest, so a window it
// had to fetch is kept and a window it read from the archive is a no-op.
if (args.sync) {
  const dir = args.sync === true ? ".cache" : String(args.sync);
  const local = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith("_form13f.zip"))
    : [];
  console.log(`\n${local.length} window(s) on disk in ${dir}`);

  for (const file of local) {
    const slug = file.replace(/_form13f\.zip$/, "");
    const key = `${SOURCE_PREFIX}${file}`;
    const size = statSync(join(dir, file)).size;
    const have = archived.get(key);

    if (have === size) {
      console.log(`  already archived  ${slug}  ${mb(size)}`);
      continue;
    }
    if (have != null && have !== size) {
      // The SEC publishes a window once and does not revise it, so this is not
      // a fresher copy to prefer. Say so and change nothing.
      console.log(`  SIZE DIFFERS      ${slug}  archived ${mb(have)} vs local ${mb(size)}`);
      unfinished.note(
        `${slug} is already archived at ${mb(have)} but the local copy is ${mb(size)}. The SEC does not ` +
        `revise a published window, so one of the two is not what it claims to be. Nothing was overwritten.`,
      );
      continue;
    }
    if (DRY) {
      console.log(`  would archive     ${slug}  ${mb(size)}`);
      continue;
    }
    const body = readFileSync(join(dir, file));
    await r2.put(key, body);
    console.log(`  archived          ${slug}  ${mb(size)}`);
    archived.set(key, size);
  }
}

// --- fetch -----------------------------------------------------------------
//
// The one-time cost of getting the archive started. After this the monthly build
// reads these windows from R2 and never asks the SEC for them again.
//
// Only windows NOT already archived are downloaded, so re-running is free.
if (args.fetch) {
  const want = Number(args.fetch === true ? 4 : args.fetch);
  const sec = new SecFetcher({
    userAgent: process.env.SEC_USER_AGENT,
    rps: Number(process.env.SEC_RATE_LIMIT_RPS || 5),
    log: (m) => console.log(m),
  });
  const pre = await sec.preflight();
  if (!pre.ok) {
    // Expected weather on a shared runner, not a failure. The next run gets a
    // different IP; nothing is lost because nothing was half-written.
    console.log("\nSEC is not reachable from this runner today — nothing fetched.");
  } else {
    // Walk back month by month collecting distinct windows, the same way the
    // monthly ingest resolves them. Depth is derived: windows are three months
    // wide, the newest is usually not published yet, and a walk starting
    // mid-window covers only part of it.
    const seen = new Map();
    const d = new Date();
    for (let i = 0; i < Math.max(15, want * 3 + 6) && seen.size < want + 2; i++) {
      const w = deraWindowFor(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 15)).toISOString().slice(0, 10));
      if (w && !seen.has(w.slug)) seen.set(w.slug, w);
    }

    let got = 0;
    for (const [slug, w] of seen) {
      if (got >= want) break;
      const key = `${SOURCE_PREFIX}${slug}_form13f.zip`;
      if (archived.has(key)) { console.log(`  already archived  ${slug}`); got++; continue; }
      if (DRY) { console.log(`  would fetch       ${slug}`); got++; continue; }
      try {
        console.log(`  fetching          ${slug}`);
        const res = await sec.get(w.url, { as: "buffer" });
        await r2.put(key, res.body);
        archived.set(key, res.body.length);
        console.log(`  archived          ${slug}  ${mb(res.body.length)}`);
        got++;
      } catch (err) {
        if (err.name === "SecBlockedError") throw err;
        // The newest window routinely 404s because the SEC has not published it
        // yet. That is not a failure; it is the calendar.
        console.log(`  not published yet ${slug} (${err.status ?? err.message})`);
      }
    }
    console.log(`\n${sec.requestCount} SEC request(s) — and none of these windows needs asking for again.`);
  }
}

// --- verify ----------------------------------------------------------------
//
// The archive is only worth having if it can be READ. Downloading a window and
// opening it is the difference between "we kept a copy" and "we kept a copy that
// works" — and it is the whole claim this phase makes.
if (args.verify) {
  const ordered = [...windowsFrom(archived).entries()].sort((a, b) => b[1].start.localeCompare(a[1].start));
  if (!ordered.length) {
    console.log("\n::error::nothing archived, so there is nothing to verify.");
    process.exit(1);
  }
  const [slug, w] = ordered[0];
  console.log(`\nreading ${slug} back out of the archive (${mb(w.size)}) — no SEC request…`);
  const buf = await r2.getBuffer(w.key);
  if (!buf) {
    console.log(`::error::${w.key} listed but could not be read back.`);
    process.exit(1);
  }
  if (buf.length !== w.size) {
    console.log(`::error::${w.key} read back ${mb(buf.length)}, expected ${mb(w.size)}.`);
    process.exit(1);
  }
  const entries = listEntries(buf);
  const names = entries.map((e) => e.name);
  console.log(`  opened: ${names.join(", ")}`);

  // The four tables the build actually needs. A zip that opens but is missing
  // one of these is not a usable copy, and "it downloaded" would not have caught
  // it.
  const REQUIRED = ["SUBMISSION.tsv", "COVERPAGE.tsv", "SUMMARYPAGE.tsv", "INFOTABLE.tsv"];
  const missing = REQUIRED.filter((r) => !names.some((n) => n.toUpperCase().endsWith(r.toUpperCase())));
  if (missing.length) {
    console.log(`::error::archived window is missing ${missing.join(", ")} — it could not rebuild the dashboard.`);
    process.exit(1);
  }
  console.log(`  all four tables the build needs are present.`);
  console.log(`\nthe dashboard could be rebuilt from this without asking the SEC for anything.`);
}

// --- prune -----------------------------------------------------------------
if (args.prune) {
  const drop = windowsToDrop(windowsFrom(archived), KEEP);
  if (!drop.length) {
    console.log(`\nretention: ${windowsFrom(archived).size} window(s), keeping ${KEEP} — nothing to drop.`);
  } else {
    for (const d of drop) {
      if (DRY) { console.log(`  would drop  ${d.slug}  ${mb(d.size)}`); continue; }
      await r2.del(d.key);
      console.log(`  dropped     ${d.slug}  ${mb(d.size)} (older than the ${KEEP} kept)`);
    }
  }
}

process.exit(unfinished.report("The source archive"));
