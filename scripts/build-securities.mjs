#!/usr/bin/env node
// scripts/build-securities.mjs
//
// Build the CUSIP -> ticker map that turns "APPLE INC" into "AAPL".
//
//   node --env-file=.env scripts/build-securities.mjs
//   node --env-file=.env scripts/build-securities.mjs --months=18
//
// ---------------------------------------------------------------------------
// WHY THE FAILS-TO-DELIVER FILES
// ---------------------------------------------------------------------------
// 13F gives CUSIP and issuer name; it does not give a ticker. The obvious
// sources are all worse than this one:
//
//   company_tickers.json   maps CIK <-> ticker <-> name but carries NO CUSIP,
//                          so joining from a 13F means fuzzy-matching a
//                          filer-typed, abbreviated, uppercase issuer name.
//                          Unreliable at scale, especially across share classes.
//   the <figi> element     free and in-band, but OPTIONAL and post-2023 only —
//                          measured at ~12.6% of rows universe-wide. Joining on
//                          it silently drops the other 87%.
//   OpenFIGI               works, but keyless it is 25 requests/minute x 10
//                          jobs. Citadel alone has 6,733 distinct CUSIPs, so a
//                          single manager is ~28 minutes of rate-limited calls.
//   the 13(f) list         authoritative, and published as PDF ONLY, by
//                          arrangement with the CUSIP licensor.
//
// The fails-to-deliver files are free, official, machine-readable, and contain
// CUSIP and SYMBOL side by side:
//
//   SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE
//   20260415|B38564108|CMBT|284|CMB.TECH NV (BEL)|12.92
//
// Measured: 12,827 unique CUSIP-symbol pairs in ONE half-month file. Unioning
// a year of them covers essentially every liquid US name a 13F can hold, at a
// cost of ~24 requests. OpenFIGI stays as the fallback for the long tail.
//
// Coverage caveat, stated honestly: a security only appears here if it had a
// settlement failure in that window. Very illiquid names may never appear, so
// the map is a high-coverage heuristic and `resolved` counts are reported.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SecFetcher, runJob } from "./_sec-fetch.mjs";
import { extract } from "./_unzip.mjs";
import { issuerIdFor } from "./_sec-parse.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const OUT = args.out || "data/securities.json";
const MONTHS = Number(args.months || 15);
// The files publish on a lag; the most recent month or two 404s. Start back a
// little rather than burning requests on misses.
const LAG_MONTHS = Number(args.lag || 3);

const url = (yyyymm, half) =>
  `https://www.sec.gov/files/data/fails-deliver-data/cnsfails${yyyymm}${half}.zip`;

function monthsBack(n, lag) {
  const out = [];
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - lag);
  for (let i = 0; i < n; i++) {
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

await runJob(async () => {
  const sec = new SecFetcher({
    userAgent: process.env.SEC_USER_AGENT,
    rps: Number(process.env.SEC_RATE_LIMIT_RPS || 5),
    log: (m) => console.log(m),
  });

  const pre = await sec.preflight();
  if (!pre.ok) {
    console.log("SEC preflight blocked — keeping the existing securities map.");
    return;
  }

  // Start from whatever we already have so a blocked or partial run only ever
  // adds coverage; it can never lose it.
  const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { securities: {} };
  const map = new Map(Object.entries(existing.securities ?? {}));
  const before = map.size;

  let files = 0;
  let missing = 0;

  for (const yyyymm of monthsBack(MONTHS, LAG_MONTHS)) {
    for (const half of ["a", "b"]) {
      let res;
      try {
        res = await sec.get(url(yyyymm, half), { as: "buffer" });
      } catch (err) {
        if (err.name === "SecBlockedError") throw err;
        // A 404 is ordinary here: the newest months are not published yet, and
        // the very oldest may have been rolled off.
        missing++;
        continue;
      }

      let body;
      try {
        // Entry naming is inconsistent across the archive's history: recent
        // files contain "cnsfails202604b.txt" while older ones contain
        // "cnsfails202507a" with no extension at all. Matching on ".txt" alone
        // silently skipped 26 of 30 files and cost most of the coverage.
        ({ body } = extract(res.body, (n) => /\.txt$/i.test(n) || /^cnsfails/i.test(n)));
      } catch (err) {
        console.log(`  ${yyyymm}${half}: ${err.message}`);
        continue;
      }

      let added = 0;
      for (const line of body.toString("latin1").split("\n")) {
        const f = line.split("|");
        if (f.length < 5) continue;
        const cusip = f[1]?.trim().toUpperCase();
        const symbol = f[2]?.trim().toUpperCase();
        if (!cusip || cusip === "CUSIP" || !symbol) continue;
        if (map.has(cusip)) continue;
        map.set(cusip, {
          ticker: symbol,
          // The description is the exchange's issuer name, which is materially
          // cleaner than the filer-typed name in a 13F ("APPLE INC" vs
          // "Apple Inc."). Kept as a display fallback.
          name: (f[4] ?? "").trim() || null,
          issuerId: issuerIdFor(cusip),
          source: "sec_fails",
        });
        added++;
      }
      files++;
      console.log(`  ${yyyymm}${half}  +${added} new  (${map.size} total)`);
    }
  }

  const securities = Object.fromEntries(map);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: "SEC fails-to-deliver (cnsfails*.zip)",
        months: MONTHS,
        files,
        count: map.size,
        securities,
      },
      null,
      0,
    ),
  );

  console.log(`\n${"=".repeat(60)}`);
  console.log(`${map.size} CUSIP->ticker pairs (+${map.size - before} this run)`);
  console.log(`${files} files read, ${missing} not published, ${sec.requestCount} SEC requests`);
  console.log(`written to ${OUT}`);
});
