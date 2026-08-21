#!/usr/bin/env node
// scripts/ingest-funds.mjs
//
// Fetch, parse and publish artifacts for a set of funds.
//
//   node --env-file=.env scripts/ingest-funds.mjs
//   node --env-file=.env scripts/ingest-funds.mjs --periods=8 --out=public/data
//   node --env-file=.env scripts/ingest-funds.mjs --funds=0001067983,0001279936
//
// Per-fund path: submissions API -> per-filing documents -> parse -> units ->
// aggregate -> amendment fold -> QoQ changes -> artifacts. This is the
// low-volume path used for watchlist freshness during filing season; the
// full-universe path (Phase 3) reads the DERA quarterly ZIP instead, one
// request per quarter rather than three per filing.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SecFetcher, SEC_URLS, runJob, padCik } from "./_sec-fetch.mjs";
import {
  parseIndexHeaders, parsePrimaryDoc, parseInfoTable, parseSubmissions,
  decideValueUnits, aggregateHoldings, summarizeHoldings, reconcileTotal, issuerIdFor,
} from "./_sec-parse.mjs";
import {
  foldFilings, computeChanges, computeTurnover, summarizeActions, PRIOR_STATE,
} from "../shared/fold.mjs";
import {
  currentPeriod, priorPeriod, recentPeriods, filingDeadline, periodLabel,
} from "../shared/calendar.mjs";
import { paths, envelope, manifest, encodeHoldings, buildIdFrom, ROWS_PER_PAGE } from "../shared/artifacts.mjs";
import { ArtifactWriter, writeHeadersFile } from "./_artifact-writer.mjs";

// Seed watchlist. Every CIK here was resolved live and confirmed to be the
// entity that actually files 13F-HR — name search is unreliable for this asset
// class ("Point72" returns 8+ CIKs; "Duquesne" returns 2, one dead since 2010).
const SEED_FUNDS = [
  { cik: "0001067983", name: "Berkshire Hathaway", code: "BRK" },
  { cik: "0001350694", name: "Bridgewater Associates", code: "BRW" },
  { cik: "0001423053", name: "Citadel Advisors", code: "CIT" },
  { cik: "0001037389", name: "Renaissance Technologies", code: "REN" },
  { cik: "0001167483", name: "Tiger Global Management", code: "TIG" },
  { cik: "0001135730", name: "Coatue Management", code: "COA" },
  { cik: "0001061165", name: "Lone Pine Capital", code: "LON" },
  // Included on purpose: its 2026-Q2 filing is the pro-rata reduction that a
  // reference site published as 22 independent "-95.40%" sells. Keeping it in
  // the seed set means the detector is exercised against live data on every run.
  { cik: "0001279936", name: "Cantillon Capital Management", code: "CAN" },
];

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const OUT = args.out || "public/data";
const N_PERIODS = Number(args.periods || 8);

/**
 * WHICH FUNDS. `--funds-file` wins, then `--funds`, then the seed list.
 *
 * The file form exists because this now runs over the whole filing season's
 * backlog: eight hundred CIKs is a nine-kilobyte command line, which survives
 * argv but turns every workflow log into an unreadable wall and is one shell
 * quoting mistake away from silently ingesting nothing.
 */
const fundsArg = (() => {
  const path = typeof args["funds-file"] === "string" ? args["funds-file"] : null;
  if (path) {
    if (!existsSync(path)) {
      console.error(`::error::--funds-file=${path} does not exist. Refusing to fall back to the seed list.`);
      process.exit(1);
    }
    return readFileSync(path, "utf8");
  }
  return args.funds ? String(args.funds) : null;
})();

const FUNDS = fundsArg !== null
  ? [...new Set(fundsArg.split(/[,\s]+/).map((c) => c.trim()).filter(Boolean).map(padCik))]
      .map((cik) => ({ cik, name: null, code: null }))
  : SEED_FUNDS;

/**
 * Wall-clock budget for the fund loop, in seconds. 0 disables it.
 *
 * The same-day job used to see thirteen funds and finish in a minute. It now
 * drains a filing season — ten thousand managers filed for Q2 2026 — so it has
 * to stop on its own terms rather than be killed by the job timeout half way
 * through writing an artifact tree. It checks the clock BETWEEN funds, never
 * inside one, so every fund it reports is complete.
 *
 * What it stops short of is not lost: the caller publishes exactly the funds
 * listed in `--out-completed`, and the ingest cursor advances only for those. The
 * rest are offered again by the next run.
 */
const BUDGET_S = Math.max(0, Number(args["budget-seconds"] || 0));
const OUT_COMPLETED = typeof args["out-completed"] === "string" ? args["out-completed"] : null;

const log = (m) => console.log(m);

/**
 * CUSIP -> ticker, built by scripts/build-securities.mjs from the SEC's
 * fails-to-deliver files. Loaded once here so the resolution happens at INGEST:
 * the artifacts then carry ticker and issuerId, and the CUSIP is dropped before
 * anything is published.
 *
 * Missing entries are expected, not fatal — a name only appears in the
 * fails data if it had a settlement failure in the window, so the illiquid tail
 * stays unresolved and falls back to the issuer name as filed.
 */
const SECURITIES = (() => {
  const path = args.securities || "data/securities.json";
  if (!existsSync(path)) {
    log(`  (no ${path} — run scripts/build-securities.mjs for tickers)`);
    return {};
  }
  return JSON.parse(readFileSync(path, "utf8")).securities ?? {};
})();

let resolvedCount = 0;
let unresolvedCount = 0;
const unresolvedNames = new Map();

function resolveSecurity(h) {
  const s = SECURITIES[h.cusip];
  if (s?.ticker) {
    resolvedCount++;
    return { ...h, ticker: s.ticker, issuerId: s.issuerId ?? h.issuerId };
  }
  unresolvedCount++;
  unresolvedNames.set(h.name_of_issuer, (unresolvedNames.get(h.name_of_issuer) ?? 0) + 1);
  return h;
}

/** Fetch and fully parse one filing. Three SEC requests. */
async function loadFiling(sec, cik, f) {
  const hdr = parseIndexHeaders((await sec.get(SEC_URLS.indexHeaders(cik, f.accession_number))).body);
  if (!hdr.infoTableFilename) {
    // 13F-NT notices legitimately have no information table — the manager is
    // declaring that another manager reports its holdings. Not an error.
    return { ...f, notice: true, rows: [], cover: null, headers: hdr };
  }

  const cover = parsePrimaryDoc((await sec.get(SEC_URLS.primaryDoc(cik, f.accession_number))).body);
  const rows = parseInfoTable(
    (await sec.get(SEC_URLS.doc(cik, f.accession_number, hdr.infoTableFilename))).body,
  );

  // Acceptance time from the submissions API is explicit UTC; the SGML header
  // is Eastern and needs conversion. Prefer the API value.
  const acceptance = f.acceptance_datetime || hdr.acceptanceDatetime;

  const units = decideValueUnits({
    schemaVersion: cover.schemaVersion,
    acceptanceDatetime: acceptance,
    rows,
  });
  const recon = reconcileTotal(rows, cover.tableValueTotal);

  // A filing whose rows do not sum to its own cover-page total has been
  // truncated or mis-parsed. Keep the evidence, but keep it out of the fold —
  // silently folding it in would corrupt the client's anchor metric.
  const quarantined = recon.ok === false || Boolean(units.quarantine);

  const held = aggregateHoldings(rows, units.units).map((h) =>
    resolveSecurity({ ...h, issuerId: issuerIdFor(h.cusip) }),
  );

  return {
    ...f,
    notice: false,
    quarantined,
    quarantineCode: units.quarantine?.code ?? (recon.ok === false ? "value_total_mismatch" : null),
    acceptance_datetime: acceptance,
    is_amendment: cover.isAmendment,
    amendment_type: cover.amendmentType,
    amendment_no: cover.amendmentNo,
    is_confidential_omitted: cover.isConfidentialOmitted,
    report_type: cover.reportType,
    manager_name: cover.filingManagerName,
    table_value_total: cover.tableValueTotal,
    units: units.units,
    unit_source: units.source,
    median_implied_price: units.medianImpliedPrice,
    reconciles: recon.ok,
    rawRowCount: rows.length,
    rows: held,
  };
}

/** Shape one aggregated holding + its QoQ change into an artifact row. */
function toArtifactRow(h, change) {
  return {
    // No `cusip` field. Ever. It is a licensed identifier and an internal join
    // key; artifacts carry issuerId and ticker instead.
    ticker: h.ticker ?? null,
    name: h.name_of_issuer,
    issuerId: h.issuerId,
    cls: h.title_of_class,
    type: h.put_call,
    unit: h.ssh_prnamt_type,
    value: h.value_usd,
    shares: h.ssh_prnamt,
    weight: h.weight_pct == null ? null : Number(h.weight_pct.toFixed(4)),
    price: h.implied_price == null ? null : Number(h.implied_price.toFixed(4)),
    action: change?.action ?? null,
    dShares: change?.d_shares ?? null,
    dSharesPct: change?.d_shares_pct == null ? null : Number(change.d_shares_pct.toFixed(3)),
    dValue: change?.d_value ?? null,
    dValuePct: change?.d_value_pct == null ? null : Number(change.d_value_pct.toFixed(3)),
    dWeightPp: change?.d_weight_pp == null ? null : Number(change.d_weight_pp.toFixed(4)),
    flags: change?.flags ?? null,
  };
}

await runJob(async () => {
  const sec = new SecFetcher({
    userAgent: process.env.SEC_USER_AGENT,
    rps: Number(process.env.SEC_RATE_LIMIT_RPS || 5),
    log,
  });

  const pre = await sec.preflight();
  if (!pre.ok) {
    // Expected weather on shared runners: someone else's abuse got this IP
    // blocked. Stop clean, spend nothing, let the next slot try a fresh IP.
    log("SEC preflight blocked — stopping cleanly, cursor untouched.");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  // INGEST from the most recently CLOSED quarter, not the most recently DUE
  // one. Those differ for six weeks of every quarter, and the difference is the
  // freshest data in the product: Cantillon filed for Q2 2026 on 2026-07-29,
  // sixteen days before that quarter was due, and ~3,200 other managers had
  // already filed too. Anchoring ingest on the deadline would silently skip all
  // of it and leave the dashboard a quarter stale during the exact window when
  // new filings are arriving daily.
  //
  // The FRONTEND still defaults its view to whichever period actually has data
  // (read off the manifest), so an empty just-closed quarter never shows a blank
  // screen. Ingest fetches wide; display chooses.
  const newest = currentPeriod(today);
  // One extra quarter beyond the window so the OLDEST reported quarter still
  // has a real prior to diff against, instead of reporting every position as a
  // new entry.
  const wanted = recentPeriods(newest, N_PERIODS + 1);
  const reported = wanted.slice(0, N_PERIODS);

  log(`Ingesting ${FUNDS.length} funds x ${N_PERIODS} periods (newest ${periodLabel(newest)})`);
  log(`Periods: ${reported.map(periodLabel).join(", ")}\n`);

  const writer = new ArtifactWriter(OUT);
  const filerIndex = [];
  const filingsByPeriod = new Map(reported.map((p) => [p, []]));
  let latestAcceptance = "";
  const problems = [];

  // Funds this run finished end to end. ONLY these may be published, and only
  // these may advance the ingest cursor — so a run cut short by its budget, a
  // block, or a crash never marks work done that it did not do.
  const completed = [];
  const startedAt = Date.now();
  const elapsed = () => (Date.now() - startedAt) / 1000;
  let stoppedEarly = false;

  // Per-fund lines are useful for thirteen funds and unreadable for eight
  // hundred. Above a threshold, report progress instead of narrating.
  const VERBOSE = FUNDS.length <= 40;
  let done = 0;

  for (const fund of FUNDS) {
    if (BUDGET_S && elapsed() > BUDGET_S) {
      stoppedEarly = true;
      log(
        `\nbudget reached after ${Math.round(elapsed())}s — stopping cleanly with ${completed.length} ` +
        `of ${FUNDS.length} fund(s) done. The rest stay queued for the next run.`,
      );
      break;
    }
    const cik = padCik(fund.cik);
    if (VERBOSE) log(`${fund.name || cik} (${cik})`);
    else if (++done % 50 === 0) {
      log(`  … ${done}/${FUNDS.length} funds, ${Math.round(elapsed())}s, ${sec.requestCount} SEC requests`);
    }

    // ONE BAD FUND MUST NOT COST THE OTHER EIGHT HUNDRED.
    //
    // This loop used to run over thirteen hand-picked CIKs that were known to be
    // well behaved. It now runs over whoever EDGAR says filed, which includes
    // managers with a malformed information table, a submissions record that
    // 404s, and filing agents who put something unparseable in the header. A
    // throw here aborted the whole run and published NOTHING — losing hundreds of
    // good funds to one bad one.
    //
    // A block is still terminal: it is about this machine, not this fund, and
    // carrying on would only deepen it.
    try {
      const subs = parseSubmissions((await sec.get(SEC_URLS.submissions(cik), { as: "json" })).body);
      const displayName = fund.name || subs.name || cik;

      // Amendments are frequently filed under a FILER AGENT's accession prefix —
      // Cantillon's three restatements are 0000899140-, not its own 0001279936-.
      // The submissions API returns them regardless of who submitted, which is
      // exactly why discovery must use it rather than scanning accession prefixes.
      const relevant = subs.filings.filter((f) => wanted.includes(f.period_end));

      const byPeriod = new Map();
      for (const f of relevant) {
        if (!byPeriod.has(f.period_end)) byPeriod.set(f.period_end, []);
        byPeriod.get(f.period_end).push(f);
      }

      const loaded = new Map();
      for (const period of wanted) {
        const filings = byPeriod.get(period) || [];
        if (!filings.length) continue;

        const parsed = [];
        for (const f of filings) {
          try {
            const full = await loadFiling(sec, cik, f);
            parsed.push(full);
            if (full.acceptance_datetime > latestAcceptance) latestAcceptance = full.acceptance_datetime;
            if (full.quarantined) {
              problems.push(`${displayName} ${period} ${f.accession_number}: ${full.quarantineCode}`);
            }
          } catch (err) {
            if (err.name === "SecBlockedError") throw err;
            problems.push(`${displayName} ${period} ${f.accession_number}: ${err.message}`);
          }
        }

        // Fold amendments in acceptance order: an original seeds the set, a
        // RESTATEMENT resets it, NEW HOLDINGS appends. Quarantined filings are
        // excluded from the fold but were still parsed and counted.
        const foldable = parsed.filter((p) => !p.notice && !p.quarantined);
        const notices = parsed.filter((p) => p.notice);

        for (const p of parsed) {
          const bucket = filingsByPeriod.get(period);
          if (!bucket) continue;
          bucket.push({
            cik, fund: displayName, code: fund.code,
            accession: p.accession_number, form: p.form_type,
            filed: p.filing_date, accepted: p.acceptance_datetime,
            positions: p.notice ? 0 : p.rows.length, rawRows: p.rawRowCount ?? 0,
            value: p.notice ? null : p.rows.reduce((a, h) => a + h.value_usd, 0),
            amendment: p.is_amendment ? (p.amendment_type || "AMENDED") : null,
            amendmentNo: p.amendment_no ?? null,
            confidentialOmitted: Boolean(p.is_confidential_omitted),
            reconciles: p.reconciles ?? null,
            quarantined: Boolean(p.quarantined),
            notice: p.notice,
          });
        }

        if (!foldable.length) {
          // A period with only notices is a real, reportable state — not an
          // absence. It means another manager reports these holdings.
          //
          // `summary: null` is written EXPLICITLY rather than left off. The key
          // used to be simply absent, so a consumer that forgot to check
          // noticeOnly read `cur.summary.value_long_usd` and died on a missing
          // property instead of on an honest null. Same shape for every period,
          // whatever its state.
          loaded.set(period, {
            noticeOnly: notices.length > 0,
            holdings: [],
            summary: null,
            value_long_usd: null,
            reported_total_usd: null,
            filings: parsed,
          });
          continue;
        }

        const folded = foldFilings(
          foldable.map((p) => ({
            accession_number: p.accession_number,
            acceptance_datetime: p.acceptance_datetime,
            is_amendment: p.is_amendment,
            amendment_type: p.amendment_type,
            table_value_total: p.table_value_total,
            rows: p.rows,
          })),
        );

        const summary = summarizeHoldings(folded.rows);
        loaded.set(period, {
          noticeOnly: false,
          holdings: folded.rows,
          accessions: folded.accessions,
          warnings: folded.warnings,
          value_long_usd: summary.value_long_usd,
          summary,
          // From the FOLD, not from the last element of the input array. The
          // submissions API returns filings newest-first, so array-last was the
          // OLDEST filing — the original an amendment exists to supersede. See
          // foldReportedTotal in shared/fold.mjs.
          reported_total_usd: folded.reportedTotalUsd,
          confidentialOmitted: foldable.some((p) => p.is_confidential_omitted),
          acceptance: foldable.map((p) => p.acceptance_datetime).sort().pop(),
          filings: parsed,
        });
      }

      // ---- changes, then artifacts -------------------------------------------
      const series = [];

      for (const period of reported) {
        const cur = loaded.get(period);
        if (!cur) continue;

        // A NOTICE-ONLY QUARTER HAS NO SUMMARY. Skip it here.
        //
        // When nothing is foldable the period is stored as
        // `{ noticeOnly: true, holdings: [], summary: null }` — correct, because
        // a 13F-NT reports no positions. But this loop then read
        // `cur.summary.value_long_usd` and threw TypeError, after having already
        // written an empty fund-period artifact. The daily watchlist ingest
        // aborted for every fund after the first one to file a notice, and
        // published a zero-holdings quarter for the one that did.
        //
        // Notices are routine, not exotic: the current DERA window holds 2,045
        // 13F-NT submissions. The filings feed already recorded this quarter
        // during parsing, so nothing is lost by skipping the holdings work — and
        // the NEXT quarter still resolves to PRIOR_IS_NT off `prior.noticeOnly`,
        // which is what stops it reporting every position as newly bought.
        //
        // TEST `summary`, NOT `noticeOnly`. A notice is not the only way a
        // quarter ends up with nothing foldable: a filing whose rows do not sum
        // to its own cover-page total is QUARANTINED, and a quarter whose only
        // filing was quarantined lands here with `noticeOnly: false` and
        // `summary: null`. That fell straight through this guard and threw
        // "Cannot read properties of null (reading 'value_long_usd')" — which,
        // before the per-fund try/catch below, ended the whole run and published
        // nothing at all. Caught in the wild on the first backlog run: Adelante
        // Capital's Q2-2026 filing fails reconciliation.
        if (!cur.summary) continue;

        const priorP = priorPeriod(period);
        const prior = loaded.get(priorP);

        // Resolve prior state explicitly. Three of the four states mean no deltas
        // may be rendered at all — "this manager filed a notice last quarter" is a
        // correct answer; "every position is new" is not.
        let priorState = PRIOR_STATE.NONE;
        if (cur.noticeOnly) priorState = PRIOR_STATE.NONE;
        else if (!prior) priorState = wanted.includes(priorP) ? PRIOR_STATE.MISSING : PRIOR_STATE.NONE;
        else if (prior.noticeOnly) priorState = PRIOR_STATE.IS_NT;
        // A prior quarter we could not fold — every filing for it quarantined —
        // has an EMPTY holdings array, and an empty prior read as PRIOR_OK makes
        // every position this quarter look newly bought. "We could not read last
        // quarter" is a different answer from "they held nothing", and only one
        // of them is true.
        else if (!prior.summary) priorState = PRIOR_STATE.MISSING;
        else priorState = PRIOR_STATE.OK;

        const { changes, suppressed, reason, structuralEvent, structural, exitsWithheld } = computeChanges(
          { period_end: period, holdings: cur.holdings, value_long_usd: cur.value_long_usd },
          priorState === PRIOR_STATE.OK
            ? {
                period_end: priorP,
                accession: prior.accessions?.[prior.accessions.length - 1] ?? null,
                holdings: prior.holdings,
                value_long_usd: prior.value_long_usd,
              }
            : null,
          priorState,
          // The filer declared this book incomplete, so an absent position is not
          // evidence of a sale. Exits are withheld and counted, not fabricated.
          { confidentialOmitted: cur.filings?.some((f) => f.is_confidential_omitted) },
        );

        const changeByKey = new Map(changes.map((c) => [`${c.cusip}|${c.put_call}`, c]));
        const rows = cur.holdings
          .map((h) => toArtifactRow(h, changeByKey.get(`${h.cusip}|${h.put_call}`)))
          .sort((a, b) => b.value - a.value);

        const exits = changes
          .filter((c) => c.action === "EXITED")
          .map((c) => ({
            ticker: SECURITIES[c.cusip]?.ticker ?? null,
            name: c.name_of_issuer,
            issuerId: SECURITIES[c.cusip]?.issuerId ?? issuerIdFor(c.cusip),
            type: c.put_call,
            // SH or PRN. Without it a client filtering to long equity cannot tell
            // an exited share position from an exited bond.
            unit: c.ssh_prnamt_type ?? "SH",
            valuePrior: c.value_prior, weightPrior: c.weight_prior,
          }))
          .sort((a, b) => (b.valuePrior ?? 0) - (a.valuePrior ?? 0));

        const acts = summarizeActions(changes);
        // NO TURNOVER FOR A QUARTER WHOSE DELTAS ARE WITHHELD.
        //
        // Turnover is a delta measure — (entries + exits) over positions, and
        // traded value over average book — so a quarter where per-row changes are
        // too misleading to publish cannot have a meaningful one either. It was
        // computed anyway: Cantillon's Q2-2026 card reported "TURNOVER 33.8%" a
        // few inches above an Activity widget refusing to draw the same
        // comparison, and a value turnover of 183% derived entirely from the one
        // redemption. Withheld, not zeroed — zero would be a confident wrong
        // answer where a dash is the true one.
        const turnover = priorState === PRIOR_STATE.OK && !suppressed
          ? computeTurnover(changes, { holdings: cur.holdings, value_long_usd: cur.value_long_usd },
              { holdings: prior.holdings, value_long_usd: prior.value_long_usd })
          : { turnover_position_pct: null, turnover_value_pct: null };

        const meta = {
          priorState,
          priorPeriod: priorState === PRIOR_STATE.OK ? priorP : null,
          deltasSuppressed: suppressed,
          structuralEvent,
          structuralDetail: structural?.detail ?? null,
          confidentialOmitted: Boolean(cur.confidentialOmitted),
          foldWarnings: cur.warnings ?? [],
          // How many exits were NOT emitted because the filer withheld positions.
          // Shown, not swallowed: a shorter list with no explanation reads as
          // 'they sold nothing', which is a different wrong answer.
          exitsWithheld,
          accessions: cur.accessions ?? [],
          ...cur.summary,
          reportedTotalUsd: cur.reported_total_usd,
          ...acts,
          ...turnover,
        };

        // Page only what needs paging. Citadel aggregates to ~12,900 positions;
        // the rest of the universe fits comfortably in one file.
        const pages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
        for (let p = 0; p < pages; p++) {
          writer.write(
            paths.fundPeriod(cik, period, p),
            envelope({
              kind: "fund-period", cik, period,
              asOf: period, acceptedAt: cur.acceptance,
              buildId: null,
              extra: { page: p, pages, total: rows.length, exits: p === 0 ? exits : undefined, meta },
              data: encodeHoldings(rows.slice(p * ROWS_PER_PAGE, (p + 1) * ROWS_PER_PAGE)),
            }),
          );
        }

        series.push({
          period,
          label: periodLabel(period),
          reportedTotalUsd: cur.reported_total_usd,
          valueLongUsd: cur.summary.value_long_usd,
          valueOptionsUsd: cur.summary.value_options_usd,
        // Principal-amount rows: bonds and notes, whose "shares" figure is a
        // face value. They are excluded from every share sum and from the
        // long-equity denominator by design — but the filer's own cover page
        // totals them in with everything else, so without this the two can
        // never be reconciled. Nuveen's 2026-06-30 has 28 of them, $433M
        // against a $419B book, and it read as a 0.1% shortfall in our
        // aggregation until this field existed.
        valuePrnUsd: cur.summary.value_prn_usd ?? 0,
          positions: rows.length,
          positionsLong: cur.summary.positions_long,
          positionsOptions: cur.summary.positions_options,
          top10WeightPct: cur.summary.top10_weight_pct,
          ...acts,
          ...turnover,
          priorState,
          deltasSuppressed: suppressed,
          structuralEvent,
          confidentialOmitted: Boolean(cur.confidentialOmitted),
          pages,
          acceptedAt: cur.acceptance,
          // Calendar days, not a timestamp difference: a filing accepted at
          // 20:06 on day 45 is on day 45, and rounding the fraction up made every
          // punctual filer look one day late against the 45-day deadline.
          filingLagDays: cur.acceptance
            ? Math.round(
                (Date.parse(`${cur.acceptance.slice(0, 10)}T00:00:00Z`) - Date.parse(`${period}T00:00:00Z`)) / 86400000,
              )
            : null,
        });

        const flagNote = suppressed ? `  [${reason}]` : "";
        if (VERBOSE) {
          log(
            `  ${periodLabel(period)}  ${String(rows.length).padStart(5)} pos  ` +
            `$${(cur.summary.value_long_usd / 1e9).toFixed(2)}B long  ` +
            `new ${acts.n_new} exit ${acts.n_exited}${flagNote}`,
          );
        }
      }

      if (series.length) {
        writer.write(
          paths.fundSummary(cik),
          envelope({
            kind: "fund-summary", cik, buildId: null,
            extra: { name: displayName, code: fund.code, formerNames: subs.formerNames?.slice(0, 5) ?? [],
                     state: subs.businessState },
            data: { series: series.slice().reverse() },
          }),
        );
        filerIndex.push({
          cik, name: displayName, code: fund.code,
          state: subs.businessState ?? null,
          periods: series.length,
          latestPeriod: series[0]?.period ?? null,
          latestValueUsd: series[0]?.valueLongUsd ?? null,
        });
      }
    } catch (err) {
      if (err.name === "SecBlockedError") throw err;
      problems.push(`${cik}: ${err.message}`);
      if (VERBOSE) log(`  skipped — ${err.message}`);
      continue;
    }
    completed.push(cik);
  }

  // ---- shared indexes ------------------------------------------------------
  writer.write(
    paths.filers(),
    envelope({ kind: "filers", buildId: null, data: filerIndex.sort((a, b) => a.name.localeCompare(b.name)) }),
  );

  // ONLY COMPLETED FUNDS COUNT. A fund that threw half way through may already
  // have pushed rows into filingsByPeriod, and publishing those would claim
  // coverage this run does not have — and would let the ingest cursor advance
  // past a manager whose artifacts were never written.
  const finished = new Set(completed);
  const rowsFor = (p) => (filingsByPeriod.get(p) || []).filter((f) => finished.has(f.cik));

  const periodMeta = reported.map((p) => ({
    period: p,
    label: periodLabel(p),
    deadline: filingDeadline(p),
    filings: rowsFor(p).length,
    funds: new Set(rowsFor(p).map((f) => f.cik)).size,
  }));
  writer.write(paths.periods(), envelope({ kind: "periods", buildId: null, data: periodMeta }));

  for (const p of reported) {
    const rowsForPeriod = rowsFor(p).sort((a, b) =>
      String(b.accepted).localeCompare(String(a.accepted)),
    );
    writer.write(
      paths.periodFilings(p),
      envelope({ kind: "period-filings", period: p, buildId: null, data: rowsForPeriod }),
    );
  }

  // The salt is the set of funds this run refreshed, not just how many of them.
  //
  // The build id becomes each refreshed fund's cache key, so two runs that touch
  // DIFFERENT funds must not produce the SAME id — otherwise a fund republished
  // by the second run keeps serving the first run's copy from cache forever.
  // Counting alone collided exactly like that once the run size stopped varying.
  const buildId = buildIdFrom(latestAcceptance, `${completed.length}|${completed.join(",")}`);
  const mf = manifest({
    buildId,
    periods: periodMeta,
    funds: {},
    coverage: { from: reported[reported.length - 1], to: reported[0], holdingsFrom: reported[reported.length - 1] },
    counts: {
      filers: filerIndex.length,
      filings: reported.reduce((a, p) => a + rowsFor(p).length, 0),
      holdings: writer.written.filter((w) => w.path.startsWith("fund/")).length,
    },
    notes: problems,
    // Fund-quarters actually examined, so the watchdog can grade a RATE. A
    // handful of filings that do not reconcile against their own cover page is
    // the ordinary state of the world at universe scale — the question is what
    // share of the run they are, not how many there are.
    notesOf: completed.length * reported.length,
  });
  writeFileSync(`${OUT}/manifest.json`, JSON.stringify(mf, null, 2));

  // The receipt. The publisher uploads exactly these funds and the ingest cursor
  // advances for exactly these funds — so a run stopped by its budget, a block,
  // or a crash can never mark work done that it did not finish.
  if (OUT_COMPLETED) {
    mkdirSync(dirname(OUT_COMPLETED), { recursive: true });
    writeFileSync(OUT_COMPLETED, completed.join(","));
  }
  writeHeadersFile("public");

  const s = writer.summary();
  log(`\n${"=".repeat(64)}`);
  log(`build ${buildId} · ${s.files + 1} files · ${(s.gzBytes / 1024 / 1024).toFixed(2)} MB gz ` +
      `(${(s.rawBytes / 1024 / 1024).toFixed(1)} MB raw, ${(s.ratio * 100).toFixed(0)}%)`);
  log(
    `${completed.length}/${FUNDS.length} fund(s) completed in ${Math.round(elapsed())}s` +
    (stoppedEarly ? ` (budget ${BUDGET_S}s reached — the rest are queued for the next run)` : "") +
    (problems.length ? ` · ${problems.length} skipped or flagged` : ""),
  );
  log(`${sec.requestCount} SEC requests` + (sec.missingCount ? ` · ${sec.missingCount} path(s) absent (403-as-404)` : ""));
  const totalRes = resolvedCount + unresolvedCount;
  if (totalRes > 0) {
    log(
      `tickers resolved: ${resolvedCount}/${totalRes} ` +
      `(${((resolvedCount / totalRes) * 100).toFixed(1)}%) · ${unresolvedNames.size} distinct unresolved issuers`,
    );
    // Surface the biggest gaps rather than reporting a bare percentage — a
    // resolution rate is only actionable if you can see WHICH names are missing.
    const worst = [...unresolvedNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [name, n] of worst) log(`  unresolved: ${name} (${n} fund-quarters)`);
  }
  for (const l of s.largest) log(`  largest: ${l.path} ${(l.bytes / 1024).toFixed(0)}KB`);
  if (problems.length) {
    log(`\n${problems.length} problem(s):`);
    problems.forEach((p) => log(`  - ${p}`));
  }
});
