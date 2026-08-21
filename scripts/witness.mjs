#!/usr/bin/env node
// scripts/witness.mjs
//
// Ask the SEC whether our numbers are right.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// Every other check in this project asks a question about OURSELVES: does the
// tree look sane, did anything get smaller, did a step run. All of them passed
// on the day the dashboard told a client their fund had not filed when it had.
//
// The regression gate now catches the "something got smaller" class. It cannot
// catch the other class: numbers that are simply WRONG and were always that
// wrong. A series in the wrong order, a price move counted as buying, a quarter
// labelled with the wrong year, a fabricated exit — none of those get smaller.
// They are consistent, stable, and incorrect.
//
// The only way to catch that is to compare against something that is not us.
//
// ---------------------------------------------------------------------------
// WHAT MAKES THIS AN INDEPENDENT WITNESS
// ---------------------------------------------------------------------------
// Our holdings come from the SEC's quarterly DERA data set — a machine-built
// TSV of every filer's rows, which we sum ourselves.
//
// The witness reads something else entirely: the COVER PAGE of the fund's own
// filing (primary_doc.xml), where the manager states the total value and entry
// count by hand. Different file, different producer, different transport.
//
// If our sum of their rows equals their declared total, then our units, our
// aggregation of duplicate rows, our amendment fold, and our quarter mapping
// are all correct at once. That single equality is the cheapest control this
// project has, and it is exactly the one the reference sites fail.
//
// It deliberately does NOT import anything from _sec-parse.mjs. A witness that
// shares the code under test is not a witness — if our cover-page reader had a
// bug, reusing it would make the comparison agree with itself.
//
// ---------------------------------------------------------------------------
// WHAT IT REFUSES TO JUDGE
// ---------------------------------------------------------------------------
// An amended quarter's true total is the fold of several filings, and folding is
// the thing being tested. So amended quarters are reported NOT COMPARABLE and
// counted separately. They are never silently counted as agreement — "no
// finding" and "clean" being the same output is precisely how prune stayed
// invisible for its whole existence.
//
// Usage:
//   node --env-file=.env scripts/witness.mjs
//   node --env-file=.env scripts/witness.mjs --period=2026-06-30
//   node --env-file=.env scripts/witness.mjs --ciks=0001279936,0001067983
//
// Costs 2 SEC requests per fund. The default set is the client watchlist: 26.

import { XMLParser } from "fast-xml-parser";
import { SecFetcher, SEC_URLS, padCik, runJob } from "./_sec-fetch.mjs";
import { WATCHLIST_CIKS } from "../shared/watchlist.mjs";
import { judge, coverReadings, chooseComparisonPeriod } from "../shared/witness.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const ORIGIN = (args.origin || process.env.SITE_URL || "https://13f-eo2.pages.dev").replace(/\/$/, "");
const CIKS = (args.ciks ? String(args.ciks).split(",").map((c) => c.trim()) : WATCHLIST_CIKS).map(padCik);

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", removeNSPrefix: true });

async function ours(cik) {
  const url = `${ORIGIN}/data/fund/${cik}/summary.json?witness=${process.pid}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const body = await res.json();
  return { name: body.name, series: body.data?.series ?? [] };
}

/**
 * Every 13F this fund filed for the period, oldest first.
 *
 * `filings.recent` truncates around 1,000 entries. The watchlist funds are far
 * inside that, and a fund that was not would surface here as "no filing found",
 * which the witness reports rather than passing over.
 */
function allFilings(subs) {
  const r = subs.filings?.recent ?? {};
  const out = [];
  for (let i = 0; i < (r.accessionNumber?.length ?? 0); i++) {
    if (!String(r.form[i]).startsWith("13F")) continue;
    out.push({
      accession: r.accessionNumber[i],
      form: r.form[i],
      period: r.reportDate[i],
      accepted: r.acceptanceDateTime?.[i] ?? r.filingDate[i],
    });
  }
  return out.sort((a, b) => String(a.accepted).localeCompare(String(b.accepted)));
}

/** Read the manager's own hand-stated totals off the cover page. */
async function readCover(sec, cik, accession) {
  // `get` returns an envelope ({status, body, etag, ...}), not the payload.
  const { body } = await sec.get(SEC_URLS.primaryDoc(cik, accession));
  const doc = xml.parse(body);
  const form = doc.edgarSubmission ?? doc;
  const summary = form.formData?.summaryPage ?? form.summaryPage ?? {};
  const readings = coverReadings(
    Number(summary.tableValueTotal),
    form.schemaVersion ?? form.headerData?.schemaVersion,
  );
  return readings && { ...readings, entries: Number(summary.tableEntryTotal) || null };
}

await runJob(async () => {
  const sec = new SecFetcher({
    userAgent: process.env.SEC_USER_AGENT,
    rps: Number(process.env.SEC_RATE_LIMIT_RPS || 5),
    log: (m) => console.log(m),
  });

  const pre = await sec.preflight();
  if (!pre.ok) {
    // A blocked runner is expected weather, not a finding. Say so plainly and
    // leave the run green — runJob exits 0 for a block by design.
    console.log("SEC is not reachable from this runner today, so the witness has no testimony to give.");
    return;
  }

  // No global quarter. Each fund is asked about its own newest — see
  // chooseComparisonPeriod for why a single manifest-wide period breaks every
  // October. --period still forces one, for investigating a specific quarter.
  const forced = args.period || null;
  console.log(
    `witness · ${forced || "each fund's newest quarter"} · ${CIKS.length} fund(s) · ` +
    `reading ${ORIGIN} against sec.gov\n`,
  );

  const agree = [], disagree = [], notComparable = [], misdeclared = [];

  for (const cik of CIKS) {
    // A fund we have never ingested 404s here. That must NOT end the comparison
    // — "we have no file for them" and "they never filed" are different answers,
    // and only EDGAR can tell them apart. Carry on with nothing on our side and
    // let the judgement see it.
    let series = [], name = cik, unreadable = null;
    try {
      const s = await ours(cik);
      name = s.name || cik;
      series = s.series ?? [];
    } catch (err) {
      unreadable = err.message;
    }

    const { body: subs } = await sec.get(SEC_URLS.submissions(cik), { as: "json" });
    const filings = allFilings(subs);
    const choice = chooseComparisonPeriod(series.map((x) => x.period), filings, new Date());

    // A quarter EDGAR has, we do not, and the ingest window has passed. Reported
    // whether or not there is anything left to compare — this is the Nuveen
    // case, and it is the finding a client notices first.
    if (choice.missing) {
      disagree.push({
        name,
        what: `EDGAR has a 13F-HR for ${choice.missing.period} (accepted ` +
              `${String(choice.missing.accepted).slice(0, 10)}, ${Math.floor(choice.missing.daysOld)} days ago), ` +
              `but our newest for this manager is ${choice.ourNewest ?? "nothing at all"}.` +
              (unreadable ? ` (our summary does not exist: ${unreadable})` : ""),
      });
    }

    const period = forced || choice.compare;
    if (!period) {
      if (!choice.missing) {
        notComparable.push({
          name,
          why: choice.theirNewest
            ? `no quarter in common yet — EDGAR's newest is ${choice.theirNewest}, ours is ${choice.ourNewest ?? "none"}`
            : "EDGAR has no 13F-HR for this manager at all",
        });
      }
      continue;
    }

    const verdict = await judge({
      name,
      period,
      ours: series.find((x) => x.period === period),
      filings: filings.filter((f) => f.period === period),
      readCover: (accession) => readCover(sec, cik, accession),
    });

    if (unreadable && verdict.verdict === "disagree") {
      verdict.what = `${verdict.what} (our summary for this fund does not exist at all: ${unreadable})`;
    }
    if (verdict.verdict === "agree") {
      agree.push(verdict);
      if (verdict.misdeclaredUnits) misdeclared.push(verdict.misdeclaredUnits);
    } else if (verdict.verdict === "disagree") disagree.push(verdict);
    else notComparable.push(verdict);
  }

  // --- testimony -------------------------------------------------------------
  const b = (n) => `$${(n / 1e9).toFixed(3)}B`;
  for (const a of agree) {
    console.log(
      `  agrees    ${a.period}  ${a.name} — ${b(a.value)}, ${a.positions} positions of ${a.entries ?? "?"} rows` +
      (a.exact ? "" : ` (within ${b(a.shortfallUsd)}; this fund's artifact predates valuePrnUsd, so bonds cannot be added back exactly)`),
    );
  }
  for (const n of notComparable) console.log(`  no view   ${n.name} — ${n.why}`);
  for (const m of misdeclared) console.log(`  note      ${m}`);
  for (const d of disagree) console.log(`  DISAGREES ${d.name} — ${d.what}`);

  console.log(
    `\n${agree.length} agree · ${disagree.length} disagree · ${notComparable.length} not comparable` +
    (misdeclared.length ? ` · ${misdeclared.length} filer(s) mislabelled their own units` : "") +
    ` · ${sec.requestCount} SEC request(s)`,
  );

  if (disagree.length) {
    console.log("");
    for (const d of disagree) console.log(`::error::${d.name}: ${d.what}`);
    console.log(`::error::The SEC's own filings disagree with ${disagree.length} of our numbers.`);
    process.exit(1);
  }

  // "Nothing to compare" is NOT a pass. A witness with no view produces the same
  // output as a broken witness, which is exactly how a check stays green while
  // measuring nothing at all.
  if (!agree.length) {
    console.log("");
    console.log("::error::The witness could not compare a single fund, so this run proves nothing about our numbers.");
    process.exit(1);
  }

  const approx = agree.filter((a) => !a.exact).length;
  console.log(
    `the SEC's own filings agree with every number we could check` +
    (approx ? ` (${agree.length - approx} to the dollar, ${approx} within a band pending re-ingest).` : ", to the dollar."),
  );
});
