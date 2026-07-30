#!/usr/bin/env node
// scripts/verify-filing.mjs
//
// End-to-end verification of the parse + correctness pipeline against a REAL
// filing on sec.gov. The vitest fixtures pin the invariants using synthesized
// rows that hit measured totals; this proves the same code survives actual
// EDGAR bytes — real namespace prefixes, real SGML headers, real filer-agent
// filename choices.
//
// Usage:
//   node --env-file=.env scripts/verify-filing.mjs                 # default set
//   node --env-file=.env scripts/verify-filing.mjs <CIK> <ACCESSION>
//
// Costs 3 SEC requests per filing, at 5 req/s with a declared User-Agent.

import { SecFetcher, SEC_URLS, runJob } from "./_sec-fetch.mjs";
import {
  parseIndexHeaders,
  parsePrimaryDoc,
  parseInfoTable,
  decideValueUnits,
  aggregateHoldings,
  summarizeHoldings,
  reconcileTotal,
} from "./_sec-parse.mjs";

// Filings chosen because each one breaks a different naive implementation.
const DEFAULTS = [
  {
    label: "Cantillon Capital Management LLC 2026-Q1",
    cik: "0001279936",
    accession: "0001279936-26-000004",
    why: "76 rows over 38 CUSIPs, duplicated by otherManager. Must SUM to $15,050,978,966.",
    expect: { rows: 76, cusips: 38, totalUsd: 15_050_978_966 },
  },
  {
    label: "Berkshire Hathaway (latest 13F-HR)",
    cik: "0001067983",
    accession: null, // discovered via the submissions API
    why: "Information table is named like `53405.xml`, so a *informationtable*.xml glob finds nothing.",
    expect: {},
  },
  {
    label: "Citadel Advisors LLC (latest 13F-HR)",
    cik: "0001423053",
    accession: null,
    why: "~47% of rows are options; long/put/call legs of one CUSIP must stay separate.",
    expect: {},
  },
];

const fmtUsd = (n) =>
  n == null ? "n/a" : `$${(n / 1e9).toFixed(3)}B`;

async function latestHr(sec, cik) {
  const { body } = await sec.get(SEC_URLS.submissions(cik), { as: "json" });
  const recent = body?.filings?.recent ?? {};
  for (let i = 0; i < (recent.form?.length ?? 0); i++) {
    if (recent.form[i] === "13F-HR") {
      return {
        accession: recent.accessionNumber[i],
        period: recent.reportDate[i],
        acceptance: recent.acceptanceDateTime?.[i] ?? null,
      };
    }
  }
  return null;
}

async function verify(sec, spec) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(spec.label);
  console.log(`  ${spec.why}`);
  console.log("=".repeat(72));

  let accession = spec.accession;
  let acceptance = null;
  if (!accession) {
    const found = await latestHr(sec, spec.cik);
    if (!found) throw new Error(`no 13F-HR found for CIK ${spec.cik}`);
    accession = found.accession;
    acceptance = found.acceptance;
    console.log(`  discovered ${accession} (period ${found.period})`);
  }

  // 1. SGML header -> the authoritative information-table filename.
  const headers = await sec.get(SEC_URLS.indexHeaders(spec.cik, accession));
  const hdr = parseIndexHeaders(headers.body);
  acceptance = acceptance ?? hdr.acceptanceDatetime;

  console.log(`  info table file  : ${hdr.infoTableFilename}`);
  console.log(`  documents        : ${hdr.documents.map((d) => d.type).filter(Boolean).join(", ")}`);
  console.log(`  period / accepted: ${hdr.periodOfReport} / ${acceptance}`);
  console.log(`  CIKs on filing   : ${hdr.ciks.join(", ") || "(none parsed)"}`);

  if (!hdr.infoTableFilename) throw new Error("FAILED: no INFORMATION TABLE document in the SGML header");
  const globWouldMatch = /informationtable/i.test(hdr.infoTableFilename);
  console.log(`  *informationtable*.xml glob would match: ${globWouldMatch ? "yes" : "NO  <-- why the SGML selector exists"}`);

  // 2. Cover page.
  const primary = await sec.get(SEC_URLS.primaryDoc(spec.cik, accession));
  const cover = parsePrimaryDoc(primary.body);
  console.log(`  schemaVersion    : ${cover.schemaVersion ?? "(absent -> pre-2023 -> THOUSANDS)"}`);
  console.log(`  reportType       : ${cover.reportType}`);
  console.log(`  tableEntryTotal  : ${cover.tableEntryTotal}`);
  console.log(`  tableValueTotal  : ${cover.tableValueTotal?.toLocaleString()}`);
  console.log(`  confidential omitted: ${cover.isConfidentialOmitted}`);
  if (cover.otherManagers.length) {
    console.log(`  other managers   : ${cover.otherManagers.map((m) => `${m.name ?? m.fileNumber}`).join(" | ")}`);
  }

  // 3. Information table + the full correctness ladder.
  const table = await sec.get(SEC_URLS.doc(spec.cik, accession, hdr.infoTableFilename));
  const rows = parseInfoTable(table.body);

  const decision = decideValueUnits({
    schemaVersion: cover.schemaVersion,
    acceptanceDatetime: acceptance,
    rows,
  });
  const recon = reconcileTotal(rows, cover.tableValueTotal);
  const held = aggregateHoldings(rows, decision.units);
  const summary = summarizeHoldings(held);

  const distinctCusips = new Set(rows.map((r) => r.cusip)).size;
  const dupKeys = rows.length - new Set(rows.map((r) => `${r.cusip}|${r.put_call ?? ""}|${r.ssh_prnamt_type}`)).size;
  const putCall = rows.reduce((a, r) => ((a[r.put_call ?? "long"] = (a[r.put_call ?? "long"] ?? 0) + 1), a), {});
  const prnCount = rows.filter((r) => r.ssh_prnamt_type === "PRN").length;

  console.log(`  ---`);
  console.log(`  rows as filed    : ${rows.length}   distinct CUSIPs: ${distinctCusips}   duplicate keys: ${dupKeys}`);
  console.log(`  putCall split    : ${JSON.stringify(putCall)}   PRN rows: ${prnCount}`);
  console.log(`  units decision   : ${decision.units} via ${decision.source}` +
    (decision.medianImpliedPrice != null ? `  (median implied price $${decision.medianImpliedPrice.toFixed(2)})` : ""));
  console.log(`  reconciles       : ${recon.ok === null ? "n/a" : recon.ok}  (delta ${recon.delta})`);
  console.log(`  aggregated       : ${held.length} positions`);
  console.log(`  long / options   : ${fmtUsd(summary.value_long_usd)} / ${fmtUsd(summary.value_options_usd)}`);
  console.log(`  top-10 weight    : ${summary.top10_weight_pct?.toFixed(2)}%`);

  // Assertions.
  const problems = [];
  if (recon.ok === false) problems.push(`reconciliation FAILED (delta ${recon.delta})`);
  if (decision.quarantine) problems.push(`quarantined: ${decision.quarantine.code} — ${decision.quarantine.detail}`);
  if (cover.tableEntryTotal != null && cover.tableEntryTotal !== rows.length) {
    problems.push(`tableEntryTotal ${cover.tableEntryTotal} != parsed rows ${rows.length}`);
  }
  if (spec.expect.rows && rows.length !== spec.expect.rows) problems.push(`expected ${spec.expect.rows} rows, got ${rows.length}`);
  if (spec.expect.cusips && distinctCusips !== spec.expect.cusips) problems.push(`expected ${spec.expect.cusips} CUSIPs, got ${distinctCusips}`);
  if (spec.expect.totalUsd) {
    const total = held.reduce((a, h) => a + h.value_usd, 0);
    if (total !== spec.expect.totalUsd) problems.push(`expected total ${spec.expect.totalUsd.toLocaleString()}, got ${total.toLocaleString()}`);
    else console.log(`  EXACT MATCH      : $${total.toLocaleString()}`);
  }

  if (problems.length) {
    console.log(`  RESULT: FAIL`);
    problems.forEach((p) => console.log(`    - ${p}`));
    return false;
  }
  console.log(`  RESULT: ok`);
  return true;
}

await runJob(async () => {
  const sec = new SecFetcher({
    userAgent: process.env.SEC_USER_AGENT,
    rps: Number(process.env.SEC_RATE_LIMIT_RPS || 5),
    log: (m) => console.log(m),
  });

  const pre = await sec.preflight();
  if (!pre.ok) {
    console.log("SEC preflight blocked; nothing to do this run.");
    return;
  }

  const [cikArg, accArg] = process.argv.slice(2);
  const specs = cikArg
    ? [{ label: `${cikArg} ${accArg ?? "(latest 13F-HR)"}`, cik: cikArg, accession: accArg ?? null, why: "ad hoc", expect: {} }]
    : DEFAULTS;

  let ok = true;
  for (const spec of specs) {
    try {
      ok = (await verify(sec, spec)) && ok;
    } catch (err) {
      if (err.name === "SecBlockedError") throw err;
      console.log(`  RESULT: ERROR — ${err.message}`);
      ok = false;
    }
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`${sec.requestCount} SEC requests. ${ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
  if (!ok) throw new Error("verification failed");
});
