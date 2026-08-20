#!/usr/bin/env node
// scripts/build-sectors.mjs
//
// Build the TICKER -> SECTOR map that lets the dashboard answer "what did they
// buy and sell, by sector".
//
//   node --env-file=.env scripts/build-sectors.mjs
//   node --env-file=.env scripts/build-sectors.mjs --quarters=6
//
// ---------------------------------------------------------------------------
// WHY THIS CHAIN, AND WHY IT IS CHEAP
// ---------------------------------------------------------------------------
// A 13F gives CUSIP and a filer-typed issuer name. It does not give a sector,
// and the obvious ways to get one are all worse than this:
//
//   submissions API   authoritative, and ONE REQUEST PER ISSUER. Across the
//                     universe that is thousands of requests for a field that
//                     changes almost never.
//   a paid feed       GICS is licensed; this project costs nothing to run.
//   guessing by name  "APPLE INC" tells you nothing an aggregate can trust.
//
// Two bulk files answer it instead, both free and both already public:
//
//   company_tickers.json    ticker <-> CIK for every SEC registrant.  1 request
//   financial-statement     sub.txt carries cik + sic for every company that
//   data sets               filed a 10-K/10-Q that quarter.           1/quarter
//
// So the whole map costs a handful of requests rather than thousands, and it is
// rebuilt from scratch each run — there is no incremental state to drift.
//
// COVERAGE, STATED HONESTLY. A company only appears in the financial data sets
// if it files financial statements there, so ETFs, foreign issuers filing 20-F
// and some trusts will not resolve. Those land in "Unclassified" or, where the
// SIC says so, "Funds & ETFs" — never silently folded into an operating sector,
// because a misattributed holding is invisible once it is summed.

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { SecFetcher, SEC_URLS, runJob } from "./_sec-fetch.mjs";
import { listEntries, readEntry } from "./_unzip.mjs";
import { sectorForSic } from "../shared/sic.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const OUT = args.out || "data/sectors.json";
const CACHE = args.cache || ".cache";
const QUARTERS = Number(args.quarters || 4);

const log = (m) => console.log(m);

/** Recent calendar quarters as the data sets name them: 2026q1, 2025q4, ... */
function recentDataSetQuarters(n) {
  const out = [];
  const d = new Date();
  // The set for a quarter publishes some weeks after it closes, so start one
  // quarter back rather than burning a request on a guaranteed 404.
  let y = d.getUTCFullYear();
  let q = Math.floor(d.getUTCMonth() / 3); // 0-3, already one behind
  if (q === 0) { y -= 1; q = 4; }
  for (let i = 0; i < n; i++) {
    out.push(`${y}q${q}`);
    q -= 1;
    if (q === 0) { q = 4; y -= 1; }
  }
  return out;
}

await runJob(async () => {
  const sec = new SecFetcher({
    userAgent: process.env.SEC_USER_AGENT,
    rps: Number(process.env.SEC_RATE_LIMIT_RPS || 5),
    log,
  });

  const pre = await sec.preflight();
  if (!pre.ok) { log("SEC preflight blocked — keeping the existing sector map."); return; }

  // ---- 1. ticker -> CIK ----------------------------------------------------
  const tickersRes = await sec.get(SEC_URLS.companyTickers(), { as: "json" });
  const tickerToCik = new Map();
  for (const row of Object.values(tickersRes.body ?? {})) {
    if (row?.ticker && row?.cik_str != null) {
      tickerToCik.set(String(row.ticker).toUpperCase(), Number(row.cik_str));
    }
  }
  log(`ticker->CIK: ${tickerToCik.size} registrants`);

  // ---- 2. CIK -> SIC, from the financial statement data sets ---------------
  const cikToSic = new Map();
  let sets = 0;
  for (const q of recentDataSetQuarters(QUARTERS)) {
    const url = `https://www.sec.gov/files/dera/data/financial-statement-data-sets/${q}.zip`;
    const cached = `${CACHE}/${q}_fsds.zip`;
    let buf;
    if (existsSync(cached)) {
      buf = readFileSync(cached);
      log(`using cached ${cached} (${(statSync(cached).size / 1048576).toFixed(1)} MB)`);
    } else {
      let res;
      try {
        res = await sec.get(url, { as: "buffer" });
      } catch (err) {
        if (err.name === "SecBlockedError") throw err;
        log(`  ${q}: not published (${err.status ?? err.message})`);
        continue;
      }
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(cached, res.body);
      buf = res.body;
      log(`  ${q}: ${(buf.length / 1048576).toFixed(1)} MB`);
    }

    // Layout varies the same way the 13F sets do: root, or one directory down.
    const base = (n) => n.toUpperCase().split("/").pop();
    const entry = listEntries(buf).find((e) => base(e.name) === "SUB.TXT");
    if (!entry) { log(`  ${q}: no sub.txt in the archive`); continue; }

    const text = readEntry(buf, entry).toString("latin1");
    const lines = text.split("\n");
    const head = lines[0].split("\t").map((h) => h.trim().toLowerCase());
    const iCik = head.indexOf("cik");
    const iSic = head.indexOf("sic");
    if (iCik < 0 || iSic < 0) { log(`  ${q}: sub.txt has no cik/sic column`); continue; }

    let added = 0;
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split("\t");
      const cik = Number(c[iCik]);
      const sic = Number(c[iSic]);
      if (!cik || !sic) continue;
      // NEWEST WINS. Quarters are walked newest-first, so only fill a gap —
      // a company that reclassified should keep its most recent SIC.
      if (!cikToSic.has(cik)) { cikToSic.set(cik, sic); added++; }
    }
    sets++;
    log(`  ${q}: +${added} new CIK->SIC (${cikToSic.size} total)`);
  }

  if (!cikToSic.size) {
    log("::warning::no SIC data resolved — sector views will read Unclassified.");
  }

  // ---- 3. join ------------------------------------------------------------
  const sectors = {};
  let resolved = 0;
  for (const [ticker, cik] of tickerToCik) {
    const sic = cikToSic.get(cik);
    if (sic == null) continue;
    sectors[ticker] = { sic, sector: sectorForSic(sic) };
    resolved++;
  }

  const bySector = {};
  for (const v of Object.values(sectors)) bySector[v.sector] = (bySector[v.sector] ?? 0) + 1;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: "SEC company_tickers.json + DERA financial statement data sets (sub.txt)",
    dataSets: sets,
    count: resolved,
    sectors,
  }));

  log(`\n${"=".repeat(60)}`);
  log(`${resolved} tickers classified from ${sets} data set(s), ${sec.requestCount} SEC requests`);
  log(Object.entries(bySector).sort((a, b) => b[1] - a[1]).map(([s, n]) => `  ${String(n).padStart(5)}  ${s}`).join("\n"));
  log(`written to ${OUT}`);
});
