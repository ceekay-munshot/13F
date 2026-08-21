#!/usr/bin/env node
// scripts/regression-gate.mjs
//
// A publish may add and it may correct. It may not subtract.
//
//   node scripts/regression-gate.mjs --snapshot --origin=https://…  --out=.cache/before.json
//   node scripts/regression-gate.mjs --compare=.cache/before.json --origin=https://…
//
// Take a fingerprint of the LIVE site before publishing; compare after. Fail the
// run if anything came out smaller than it went in.
//
// It reads the live origin rather than the local build on purpose. The question
// is not "is my tree self-consistent" — it is "is the thing the client loads
// worse than it was", and only the served copy can answer that.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { compareFingerprints, fingerprint } from "../shared/regression.mjs";
import { CLIENT_WATCHLIST } from "../shared/watchlist.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const ORIGIN = String(args.origin || "https://13f-eo2.pages.dev").replace(/\/+$/, "");
const OUT = args.out || ".cache/fingerprint.json";
const COMPARE = args.compare;

/**
 * Which funds to sample.
 *
 * The client's own managers, because those are the ones somebody will look at
 * and notice. Sampling every fund would be 9,268 requests to answer a question
 * a dozen answers reliably: the failure this catches was UNIFORM — it hit every
 * summary at once — so a dozen is as good a detector as nine thousand.
 */
const SAMPLE = CLIENT_WATCHLIST.map((f) => f.cik);

const bust = () => `?gate=${Date.now()}`;

async function getJson(path, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(`${ORIGIN}${path}${bust()}`, { headers: { "cache-control": "no-cache" } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status}`);
      const ct = res.headers.get("content-type") ?? "";
      // A single-page app answers 200 with HTML for an unknown path. Parsing
      // that gives a syntax error inside a <!doctype>, which reads as corrupt
      // data rather than as a missing file.
      if (!ct.includes("json")) throw new Error(`content-type ${ct} — that is the SPA fallback, not JSON`);
      return await res.json();
    } catch (err) {
      last = err;
      if (i < tries) await new Promise((r) => setTimeout(r, i * 400));
    }
  }
  throw new Error(`${path}: ${last?.message ?? "unreadable"}`);
}

async function takeFingerprint() {
  const manifest = await getJson("/data/manifest.json");
  if (!manifest) throw new Error("the live site has no manifest — nothing to compare");

  const summaries = {};
  await Promise.all(
    SAMPLE.map(async (cik) => {
      try {
        summaries[cik] = await getJson(`/data/fund/${cik}/summary.json`);
      } catch {
        // Unreadable is NOT recorded as zero quarters — that would manufacture a
        // regression out of a network blip and cry wolf. Left out of the sample.
        delete summaries[cik];
      }
    }),
  );
  return fingerprint(manifest, summaries, new Date().toISOString());
}

const fp = await takeFingerprint();

if (!COMPARE) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(fp, null, 2));
  console.log(
    `fingerprint taken: ${fp.filers} filers · ${Object.keys(fp.periods).length} quarters · ` +
      `${Object.keys(fp.funds).length} sampled funds -> ${OUT}`,
  );
  process.exit(0);
}

const before = existsSync(COMPARE) ? JSON.parse(readFileSync(COMPARE, "utf8")) : null;
const { regressions, notes } = compareFingerprints(before, fp);

for (const n of notes) console.log(`  ${n}`);
console.log(
  `after: ${fp.filers} filers · ${Object.keys(fp.periods).length} quarters · ` +
    `${Object.keys(fp.funds).length} sampled funds`,
);

if (!regressions.length) {
  console.log("nothing got smaller.");
  process.exit(0);
}

console.log("");
for (const r of regressions) console.log(`::error::${r}`);
console.log("");
console.log(`::error::This publish made the site SMALLER in ${regressions.length} way(s).`);
console.log("The data that was there is still in the bucket; what changed is what the site points at.");
console.log("Do not paper over this by re-running — find what shrank and why.");
process.exit(1);
