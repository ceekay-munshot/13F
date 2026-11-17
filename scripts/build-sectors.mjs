#!/usr/bin/env node
// scripts/build-sectors.mjs
//
// Build the TICKER -> SECTOR map that lets the dashboard answer "what did they
// buy and sell, by sector".
//
//   node --env-file=.env scripts/build-sectors.mjs
//   node --env-file=.env scripts/build-sectors.mjs --quarters=6
//   node --env-file=.env scripts/build-sectors.mjs --previous=<url|file> --publish
//
//   --previous   last build's state (movers/sectors.state.json): its SIC
//                look-ups are reused, so only companies new since then are asked.
//   --fresh-days with --previous, do nothing if that build is younger than this.
//   --publish    upload movers/sectors.json (what the dashboard reads) and
//                movers/sectors.state.json (the look-up memory) to R2.
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
// COVERAGE. A company only appears in the financial data sets if it files
// financial statements there. On 17 Nov 2026 that left out a quarter of all
// the money focused managers traded: every ETF, foreign filers (HDFC, Teva),
// new listings (SpaceX, SK Hynix), and — for reasons the data sets do not say —
// Exxon, Electronic Arts and Equity Residential. So two more sources fill in:
//
//   company_tickers_mf.json  every fund and ETF ticker.                1 request
//   submissions API          the SIC on the company's own record, for
//                            ONLY the companies still missing, and each
//                            answer is remembered for the next build.  ~1/company
//
// A company that still cannot be placed stays "Unclassified" — never folded
// into an operating sector, because a misattributed holding is invisible once
// it is summed.

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { SecFetcher, SEC_URLS, runJob } from "./_sec-fetch.mjs";
import { listEntries, readEntry } from "./_unzip.mjs";
import { sectorForSic } from "../shared/sic.mjs";
import { assembleSectorMap, looksLikeFund } from "../shared/sectors.mjs";
import { CACHE_CONTROL } from "../shared/artifacts.mjs";
import { createR2 } from "./_r2.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const OUT = args.out || "data/sectors.json";
const CACHE = args.cache || ".cache";
const QUARTERS = Number(args.quarters || 4);
const PREVIOUS = typeof args.previous === "string" ? args.previous : null;
const FRESH_DAYS = args["fresh-days"] ? Number(args["fresh-days"]) : null;
// A ceiling, not a target: a normal build asks a few dozen. The first build
// with no memory asks about two thousand, which at 3 a second is ~12 minutes.
const MAX_LOOKUPS = Number(args["max-lookups"] || 4000);
const PUBLISH = Boolean(args.publish);

/** Last build's state, from a URL or a file. null if there is none yet. */
async function readPrevious(where) {
  if (!where) return null;
  try {
    if (/^https?:/.test(where)) {
      const res = await fetch(`${where}${where.includes("?") ? "&" : "?"}fresh=${Date.now()}`, { signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(String(res.status));
      return await res.json();
    }
    return existsSync(where) ? JSON.parse(readFileSync(where, "utf8")) : null;
  } catch (err) {
    log(`previous build unreadable (${err.message}) — asking about every gap again.`);
    return null;
  }
}

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
  const previous = await readPrevious(PREVIOUS);
  if (previous?.builtAt && FRESH_DAYS != null) {
    const ageDays = (Date.now() - Date.parse(previous.builtAt)) / 86_400_000;
    if (ageDays < FRESH_DAYS) {
      log(`sector list built ${ageDays.toFixed(1)} days ago — fresh, nothing to do.`);
      return;
    }
  }

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
  const tickers = new Map();
  for (const row of Object.values(tickersRes.body ?? {})) {
    if (row?.ticker && row?.cik_str != null) {
      const t = String(row.ticker).toUpperCase();
      tickerToCik.set(t, Number(row.cik_str));
      tickers.set(t, { cik: Number(row.cik_str), title: row.title ?? "" });
    }
  }
  log(`ticker->CIK: ${tickerToCik.size} registrants`);

  // ---- 1b. every fund and ETF ticker ----------------------------------------
  // Optional: without it ETFs still resolve by name, just less completely.
  const fundSymbols = new Set();
  try {
    const mf = await sec.get(SEC_URLS.companyTickersMf(), { as: "json" });
    const fields = mf.body?.fields ?? [];
    const iSym = fields.indexOf("symbol");
    for (const r of mf.body?.data ?? []) if (iSym >= 0 && r[iSym]) fundSymbols.add(String(r[iSym]).toUpperCase());
    log(`fund and ETF tickers: ${fundSymbols.size}`);
  } catch (err) {
    if (err.name === "SecBlockedError") throw err;
    log(`::warning::fund ticker list unavailable (${err.status ?? err.message}) — funds resolve by name only.`);
  }

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

  // ---- 2b. the companies the data sets missed --------------------------------
  // Asked one at a time, from the company's own record, and remembered: a
  // company asked once is never asked again, whether it had a code or not.
  const asked = new Map(Object.entries(previous?.sicByCik ?? {}).map(([k, v]) => [Number(k), Number(v) || 0]));
  const sicOf = new Map(cikToSic);
  for (const [cik, sic] of asked) if (!sicOf.has(cik) && sic) sicOf.set(cik, sic);

  const gaps = [...new Set(
    [...tickers.entries()]
      .filter(([t, { cik, title }]) =>
        !sicOf.has(cik) && !asked.has(cik) && !fundSymbols.has(t) && !looksLikeFund(title))
      .map(([, { cik }]) => cik),
  )];
  const toAsk = gaps.slice(0, MAX_LOOKUPS);
  log(`still missing: ${gaps.length} companies — asking about ${toAsk.length}` +
      (asked.size ? ` (${asked.size} remembered from the last build)` : ""));
  let found = 0;
  for (const [i, cik] of toAsk.entries()) {
    try {
      const res = await sec.get(SEC_URLS.submissions(cik), { as: "json", mayNotExist: true });
      const sic = Number(res.body?.sic) || 0;
      asked.set(cik, sic);
      if (sic) { sicOf.set(cik, sic); found++; }
    } catch (err) {
      if (err.name === "SecBlockedError") throw err;
      // Not remembered: a failure is not an answer, so it is asked again next time.
      if (err.status === 404 || err.name === "SecMissingError") asked.set(cik, 0);
    }
    if ((i + 1) % 250 === 0) log(`  asked ${i + 1}/${toAsk.length}, ${found} placed`);
  }
  log(`  ${found} of ${toAsk.length} placed from their own SEC record`);

  // ---- 3. join ------------------------------------------------------------
  const { sectors, names } = assembleSectorMap({ tickers, fundSymbols, sicOf, sectorForSic });
  const resolved = Object.keys(sectors).length;

  const bySector = {};
  for (const v of Object.values(sectors)) bySector[v.sector] = (bySector[v.sector] ?? 0) + 1;

  const builtAt = new Date().toISOString();
  const sicByCik = Object.fromEntries([...asked.entries()].map(([k, v]) => [k, v]));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    generatedAt: builtAt,
    source: "SEC company_tickers.json + company_tickers_mf.json + DERA financial statement data sets (sub.txt) + submissions API for the rest",
    dataSets: sets,
    count: resolved,
    sectors,
    names,
    sicByCik,
  }));

  if (PUBLISH) {
    // Both short-cached: they are rewritten in place each week.
    const r2 = createR2({
      headersFor: (key, body) => ({
        "content-type": "application/json",
        "content-length": String(body.length),
        "cache-control": CACHE_CONTROL.manifest,
      }),
    });
    // The list the dashboard reads — the same shape as meta/sectors.json, so
    // either can stand in for the other.
    await r2.put("movers/sectors.json", Buffer.from(JSON.stringify({
      v: 1, kind: "sector-map", builtAt,
      data: Object.fromEntries(Object.entries(sectors).map(([t, v]) => [t, v.sector])),
    })));
    // The pipeline's memory: names for holdings with no ticker, and every
    // company already asked about.
    await r2.put("movers/sectors.state.json", Buffer.from(JSON.stringify({ v: 1, builtAt, names, sicByCik })));
    log("published movers/sectors.json and movers/sectors.state.json");
  }

  log(`\n${"=".repeat(60)}`);
  log(`${resolved} tickers classified from ${sets} data set(s), ${sec.requestCount} SEC requests`);
  log(Object.entries(bySector).sort((a, b) => b[1] - a[1]).map(([s, n]) => `  ${String(n).padStart(5)}  ${s}`).join("\n"));
  log(`written to ${OUT}`);
});
