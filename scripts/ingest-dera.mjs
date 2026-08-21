#!/usr/bin/env node
// scripts/ingest-dera.mjs
//
// FULL-UNIVERSE ingest. Every 13F filer for a quarter, from the SEC's own
// structured data set — one download instead of ~28,000 requests.
//
//   node --env-file=.env scripts/ingest-dera.mjs
//   node --env-file=.env scripts/ingest-dera.mjs --window=01mar2026-31may2026
//   node --env-file=.env scripts/ingest-dera.mjs --top=500      # holdings for the largest N
//   node --env-file=.env scripts/ingest-dera.mjs --meta-only    # metadata for everyone
//
// ---------------------------------------------------------------------------
// WHY THIS PATH EXISTS ALONGSIDE ingest-funds.mjs
//
// Per-filing crawling costs three requests each. Across ~9,300 filers that is
// ~28,000 requests — about 1.5 hours at our self-imposed 5/s, and a needless
// amount of load to put on sec.gov. The quarterly Form 13F data set contains the
// same information for every filer in ONE file.
//
// The trade is freshness. Measured: the 01mar2026-31may2026 set has a
// Last-Modified of 2026-06-04, roughly four days after its window closed, and
// windows close a month after the filing deadline. So DERA is the bulk and
// reconciliation path; ingest-funds.mjs stays the day-of path for the watchlist
// during filing season.
//
// One real limitation, worth stating: SUBMISSION.tsv carries FILING_DATE but no
// acceptance timestamp. Amendments filed on the same day therefore cannot be
// strictly ordered from this file alone, so the fold falls back to accession
// order for same-day ties and the watchlist path (which has real acceptance
// times) is authoritative where the two disagree.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { SecFetcher, runJob } from "./_sec-fetch.mjs";
import { listEntries, readEntry, entryLines } from "./_unzip.mjs";
import { decideValueUnits, aggregateHoldings, summarizeHoldings, reconcileTotal, issuerIdFor, normalizeDate } from "./_sec-parse.mjs";
import { foldFilings, PRIOR_STATE } from "../shared/fold.mjs";
import { SERIES_FIELDS } from "../shared/series-fields.mjs";
import { fundQuarter, seriesEntry } from "../shared/emit.mjs";
import { currentPeriod, priorPeriod, recentPeriods, filingDeadline, periodLabel, deraWindowFor } from "../shared/calendar.mjs";
import { paths, envelope, manifest, encodeHoldings, buildIdFrom, ROWS_PER_PAGE } from "../shared/artifacts.mjs";
import { ArtifactWriter, writeHeadersFile } from "./_artifact-writer.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const OUT = args.out || "public/data";
const CACHE = args.cache || ".cache";

/**
 * Read one DERA window out of the source archive in R2.
 *
 * Returns null for every failure — no credentials, not archived yet, unreadable
 * — because the caller's next move is to ask the SEC, which is exactly what it
 * did before this existed. An archive that is down must never cost a build.
 */
async function readArchivedWindow(slug, log) {
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    return null;
  }
  try {
    const { createR2 } = await import("./_r2.mjs");
    const r2 = createR2();
    const buf = await r2.getBuffer(`source/dera/${slug}_form13f.zip`);
    if (!buf) return null;
    log(`using archived ${slug} (${(buf.length / 1048576).toFixed(1)} MB) — no SEC request`);
    return buf;
  } catch (err) {
    log(`  archive unreadable for ${slug} (${err.message}) — asking the SEC instead`);
    return null;
  }
}
const TOP = args.top ? Number(args.top) : Infinity;
const META_ONLY = Boolean(args["meta-only"]);
// Retention: how many recent quarters keep line-item holdings. Older
// quarters keep only the compact series/metadata (kept all-time, cheap),
// so trends survive while the heavy files roll off. Default 4.
const KEEP_Q = Number(args.keep || 4);

/**
 * Curated comparison set: ACTIVE managers, always stored with line items.
 *
 * Ranking by reported value alone selects index complexes — BlackRock, three
 * separate Vanguard entities, State Street, FMR, Geode — which between them hold
 * essentially the entire market. Consensus across those is not a signal, it is a
 * tautology, and it is what the Consensus view was showing.
 *
 * The client's question was always about discretionary managers, so these are
 * pinned into the stored set regardless of size and become the default
 * comparison. Every other filer stays searchable in the Fund view.
 */
const WATCHLIST = [
  // Kept in step with src/lib/favourites.ts, which is what the dashboard
  // actually renders. This copy only sets the `watch` flag in meta/filers.json,
  // used as the fallback comparison set if a user empties their own list.
  "0001067983", // Berkshire Hathaway
  "0001590531", // Foxhaven Asset Management
  "0001061165", // Lone Pine Capital
  "0001336528", // Pershing Square Capital Management (NOT Pershing Square Holdco)
  "0001960830", // SurgoCap Partners
  "0001647251", // TCI Fund Management (NOT TCI Wealth Advisors)
  "0001599383", // WindAcre Partnership
  "0001768375", // Aspex Management (HK)
  "0001798849", // Durable Capital Partners
  "0001358706", // Abrams Capital Management (NOT Abrams Bison)
  "0001609098", // Darsana Capital Partners
  "0002087378", // Avantyr Capital Partners
  "0001279936", // Cantillon Capital Management — its pro-rata quarter keeps the
                //   structural-event detector exercised against live data
];
const WATCHSET = new Set(WATCHLIST);
const log = (m) => console.log(m);

const SECURITIES = (() => {
  const p = args.securities || "data/securities.json";
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8")).securities ?? {};
})();

/**
 * ticker -> { sic, sector }, from scripts/build-sectors.mjs.
 *
 * Enrichment, like the ticker map: absent means every sector reads
 * "Unclassified", which is legible, rather than the run failing.
 */
const SECTOR_MAP = (() => {
  const p = args.sectors || "data/sectors.json";
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8")).sectors ?? {};
})();
const sectorOf = (ticker) =>
  (ticker && SECTOR_MAP[String(ticker).toUpperCase()]?.sector) || "Unclassified";

/** Split a DERA tab-separated line, tolerating trailing empties. */
function tsv(line) {
  return line.split("\t").map((c) => c.trim());
}

/** Build a header-name -> index map so column order changes cannot break us. */
function headerMap(line) {
  const m = new Map();
  tsv(line).forEach((name, i) => m.set(name.toUpperCase(), i));
  return m;
}

const pick = (cols, hm, name) => {
  const i = hm.get(name);
  return i == null ? null : (cols[i] ?? null) || null;
};

await runJob(async () => {
  const sec = new SecFetcher({
    userAgent: process.env.SEC_USER_AGENT,
    rps: Number(process.env.SEC_RATE_LIMIT_RPS || 5),
    log,
  });

  const pre = await sec.preflight();
  if (!pre.ok) { log("SEC preflight blocked — stopping cleanly."); return; }

  // ---- resolve which quarterly window to pull -----------------------------
  const today = new Date().toISOString().slice(0, 10);
  const WANT = Number(args.windows || 1);
  let windows;
  if (args.window) {
    windows = [{ slug: String(args.window), url: `https://www.sec.gov/files/structureddata/data/form-13f-data-sets/${args.window}_form13f.zip` }];
  } else {
    // Walk back month by month, collecting distinct windows, until we have
    // enough candidates to satisfy --windows.
    //
    // The depth is DERIVED, not a magic number. Windows are three months wide,
    // so reaching N of them needs at least 3N months; the newest is typically
    // not yet published (it 404s), and a walk that starts mid-window covers
    // only part of it. Hence 3N + 6 months of slack, floored at 15 so the
    // default is never thinner than a year.
    //
    // It used to be a flat 8 months. That reaches four windows at best — one of
    // which is the unpublished current one — so `--windows=4`, which is what
    // the workflow passes, could never be satisfied and the run quietly
    // delivered two or three quarters while reporting success.
    const depth = Math.max(15, WANT * 3 + 6);
    const seen = new Set();
    windows = [];
    for (let i = 0; i < depth; i++) {
      const d = new Date(today);
      d.setUTCMonth(d.getUTCMonth() - i);
      const w = deraWindowFor(d.toISOString().slice(0, 10));
      if (w && !seen.has(w.slug)) { seen.add(w.slug); windows.push(w); }
    }
    log(`window candidates (${windows.length}, need ${WANT}): ${windows.map((w) => w.slug).join(", ")}`);
  }

  const loaded = [];
  let zip = null;
  let used = null;
  for (const w of windows) {
    if (loaded.length >= WANT) break;
    const cached = `${CACHE}/${w.slug}_form13f.zip`;
    if (existsSync(cached)) {
      log(`using cached ${cached} (${(statSync(cached).size / 1048576).toFixed(1)} MB)`);
      loaded.push({ w, buf: readFileSync(cached) });
      continue;
    }
    // THE ARCHIVE, BEFORE THE SEC.
    //
    // These files are immutable — the SEC publishes a window once and does not
    // revise it — so a copy we already hold is as good as a fresh download and
    // costs the SEC nothing. Until now every monthly run re-fetched ~345 MB and
    // then discarded it, which is why nothing could be rebuilt.
    //
    // Failure here is never fatal: it falls through to the SEC exactly as before.
    const fromArchive = await readArchivedWindow(w.slug, log);
    if (fromArchive) {
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(cached, fromArchive);
      loaded.push({ w, buf: fromArchive });
      continue;
    }

    log(`fetching ${w.url}`);
    try {
      const res = await sec.get(w.url, { as: "buffer" });
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(cached, res.body);
      log(`  ${(res.body.length / 1048576).toFixed(1)} MB -> ${cached}`);
      loaded.push({ w, buf: res.body });
      continue;
    } catch (err) {
      if (err.name === "SecBlockedError") throw err;
      log(`  not published yet (${err.status ?? err.message})`);
    }
  }
  if (!loaded.length) throw new Error("no published Form 13F data set found in the last 8 windows");
  used = loaded[0].w;
  log(`\nmerging ${loaded.length} window(s): ${loaded.map((l) => l.w.slug).join(", ")}`);

  // ---------------------------------------------------------------------------
  // WHICH QUARTERS DO THE LOADED WINDOWS ACTUALLY COVER?
  //
  // DERA windows are keyed by FILING date, not by the quarter being reported.
  // Nearly every filing for a quarter arrives in the window containing that
  // quarter's deadline — so a quarter is fully covered only if THAT window was
  // loaded.
  //
  // A quarter just outside the loaded set is not empty, which is the trap: a
  // handful of stragglers and late amendments for it did land inside our
  // windows. Publishing those produced a "quarter" that is a fragment of the
  // real book. Berkshire's 2025-Q1 shipped as $1.1B across 4 positions against
  // a true book of ~$263B across ~40 — and then 2025-Q2 diffed against that
  // stub, reported a 23,000% move, and was flagged REVIEW. One missing window
  // cost two wrong quarters.
  //
  // So a quarter whose deadline-window was not loaded is DROPPED rather than
  // published thin. Dropping loses nothing real: the fragment was never the
  // quarter, and the quarter after it now correctly resolves to NO_PRIOR —
  // "we cannot compare this" — instead of comparing against a stub.
  // ---------------------------------------------------------------------------
  const loadedSlugs = new Set(loaded.map((l) => l.w.slug));
  const coversPeriod = (period) => {
    const w = deraWindowFor(filingDeadline(period));
    return Boolean(w && loadedSlugs.has(w.slug));
  };
  let droppedPartial = 0;

  /** accession -> filing metadata, accumulated ACROSS windows. */
  const filings = new Map();
  let rowCount = 0;

  for (const { w: win, buf: zipBuf } of loaded) {
  const zip = zipBuf;
  log(`\n--- ${win.slug} ---`);
  // ---- read the small tables in full, stream the big one ------------------
  const entries = listEntries(zip);
  log(`\nentries: ${entries.map((e) => `${e.name} ${(e.size / 1048576).toFixed(1)}MB`).join(", ")}`);
  // Match on the BASENAME. The archive layout is not consistent across windows:
  // recent sets put the tables at the root ("SUBMISSION.tsv") while older ones
  // nest them one level down ("01JUN2025-31AUG2025_form13f/SUBMISSION.tsv").
  // An exact full-path match found nothing in the nested case and the run died
  // with "data set is missing SUBMISSION.tsv or INFOTABLE.tsv" on a file that
  // was plainly listed in the very next log line.
  //
  // This only surfaced once the walk-back fix let the loader reach a fourth,
  // older window for the first time — the layout change had been sitting there
  // the whole time, unreachable behind the other bug.
  const base = (name) => name.toUpperCase().split("/").pop();
  const find = (n) => entries.find((e) => base(e.name) === n);

  const subEntry = find("SUBMISSION.TSV");
  const coverEntry = find("COVERPAGE.TSV");
  const sumEntry = find("SUMMARYPAGE.TSV");
  const infoEntry = find("INFOTABLE.TSV");
  if (!subEntry || !infoEntry) throw new Error("data set is missing SUBMISSION.tsv or INFOTABLE.tsv");

  {
    const lines = readEntry(zip, subEntry).toString("latin1").split(/\r?\n/);
    const hm = headerMap(lines[0]);
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const c = tsv(line);
      const accession = pick(c, hm, "ACCESSION_NUMBER");
      if (!accession) continue;
      const form = (pick(c, hm, "SUBMISSIONTYPE") || "").toUpperCase();
      if (!form.startsWith("13F")) continue;
      filings.set(accession, {
        accession,
        cik: String(pick(c, hm, "CIK") || "").padStart(10, "0"),
        // SUBMISSION.tsv has no manager name; COVERPAGE.tsv supplies it below.
        name: "UNKNOWN",
        state: null,
        form,
        period_end: normalizeDate(pick(c, hm, "PERIODOFREPORT")),
        filing_date: normalizeDate(pick(c, hm, "FILING_DATE")),
        is_amendment: form.includes("/A"),
        amendment_type: null,
        amendment_no: null,
        report_type: null,
        rows: [],
      });
    }
    log(`SUBMISSION: ${filings.size} 13F filings`);
  }

  if (coverEntry) {
    const lines = readEntry(zip, coverEntry).toString("latin1").split(/\r?\n/);
    const hm = headerMap(lines[0]);
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const c = tsv(line);
      const f = filings.get(pick(c, hm, "ACCESSION_NUMBER"));
      if (!f) continue;
      f.report_type = pick(c, hm, "REPORTTYPE");
      f.name = pick(c, hm, "FILINGMANAGER_NAME") || f.name;
      f.state = pick(c, hm, "FILINGMANAGER_STATEORCOUNTRY") || f.state;
      // Amendment classification drives the fold and lives here, not in
      // SUBMISSION.tsv. ISAMENDMENT is Y/N.
      if ((pick(c, hm, "ISAMENDMENT") || "").toUpperCase() === "Y") f.is_amendment = true;
      f.amendment_type = (pick(c, hm, "AMENDMENTTYPE") || "").toUpperCase() || null;
      f.amendment_no = Number(pick(c, hm, "AMENDMENTNO")) || null;
    }
  }

  if (sumEntry) {
    const lines = readEntry(zip, sumEntry).toString("latin1").split(/\r?\n/);
    const hm = headerMap(lines[0]);
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const c = tsv(line);
      const f = filings.get(pick(c, hm, "ACCESSION_NUMBER"));
      if (!f) continue;
      f.table_entry_total = Number(pick(c, hm, "TABLEENTRYTOTAL")) || null;
      f.table_value_total = Number(pick(c, hm, "TABLEVALUETOTAL")) || null;
      f.is_confidential_omitted = (pick(c, hm, "ISCONFIDENTIALOMITTED") || "").toUpperCase() === "Y";
      f.other_managers_count = Number(pick(c, hm, "OTHERINCLUDEDMANAGERSCOUNT")) || 0;
    }
  }

  // INFOTABLE is ~396 MB uncompressed, so it is decoded in chunks and yielded a
  // line at a time rather than turned into one enormous string.
  {
    let hm = null;
    for (const line of entryLines(zip, infoEntry, { encoding: "latin1" })) {
      if (!line) continue;
      if (!hm) { hm = headerMap(line); continue; }
      const c = tsv(line);
      const f = filings.get(pick(c, hm, "ACCESSION_NUMBER"));
      if (!f) continue;
      const putCall = pick(c, hm, "PUTCALL");
      f.rows.push({
        row_seq: f.rows.length + 1,
        name_of_issuer: pick(c, hm, "NAMEOFISSUER") || "",
        title_of_class: pick(c, hm, "TITLEOFCLASS"),
        cusip: (pick(c, hm, "CUSIP") || "").toUpperCase(),
        figi: pick(c, hm, "FIGI"),
        value_raw: Number(pick(c, hm, "VALUE")) || 0,
        ssh_prnamt: Number(pick(c, hm, "SSHPRNAMT")) || 0,
        ssh_prnamt_type: (pick(c, hm, "SSHPRNAMTTYPE") || "SH").toUpperCase(),
        put_call: putCall || null,
        investment_discretion: pick(c, hm, "INVESTMENTDISCRETION"),
        other_manager: pick(c, hm, "OTHERMANAGER"),
        voting_sole: Number(pick(c, hm, "VOTING_AUTH_SOLE")) || 0,
        voting_shared: Number(pick(c, hm, "VOTING_AUTH_SHARED")) || 0,
        voting_none: Number(pick(c, hm, "VOTING_AUTH_NONE")) || 0,
      });
      rowCount++;
      if (rowCount % 500_000 === 0) log(`  INFOTABLE: ${(rowCount / 1e6).toFixed(1)}M rows…`);
    }
    log(`INFOTABLE: ${rowCount.toLocaleString()} rows cumulative`);
  }

  // Aggregate THIS window's filings and release their raw rows before parsing
  // the next window. Holding all quarters' raw rows at once — ~10.6M objects
  // across three windows — is what ran the runner out of memory. Each filing
  // belongs to exactly one window, so aggregating per window bounds the peak to
  // roughly one quarter of raw rows plus the compact aggregates kept so far.
  for (const f of filings.values()) {
    if (f.held !== undefined || f.notice !== undefined) continue; // already done (earlier window)
    // A NOTICE IS DECLARED BY THE FILER, NOT INFERRED FROM AN EMPTY TABLE.
    //
    // This read `if (!f.rows.length) f.notice = true`, so anything that arrived
    // with no rows became a "notice" — including a 13F-HR whose information
    // table we failed to attach. The form type and REPORTTYPE are both right
    // there and were being ignored: the current window carries 9,275
    // "13F HOLDINGS REPORT", 2,045 "13F NOTICE" and 441 "13F COMBINATION
    // REPORT".
    //
    // The distinction is not academic. A notice means "another manager reports
    // my positions", which the UI states as fact to the user; saying that about
    // a manager who filed a full holdings report is a confident, specific lie.
    const declaredNotice =
      /^13F-NT/i.test(f.form ?? "") || /NOTICE/i.test(f.report_type ?? "");
    if (declaredNotice || !f.rows.length) {
      f.notice = declaredNotice;
      // Rows absent but the filer says this IS a holdings report: that is our
      // problem, not theirs. Quarantine it so it neither folds nor masquerades
      // as a notice.
      f.emptyHoldingsReport = !declaredNotice;
      if (f.emptyHoldingsReport) f.quarantined = true;
      f.rows = null;
      continue;
    }
    f.notice = false;
    // A combination report is a partial book by design — the manager reports
    // some positions here and others elsewhere. Flagged so it is never read as
    // a complete portfolio.
    f.combination = /COMBINATION/i.test(f.report_type ?? "");
    const units = decideValueUnits({
      schemaVersion: undefined,
      acceptanceDatetime: f.filing_date ? `${f.filing_date}T12:00:00.000Z` : null,
      rows: f.rows,
    });
    const recon = reconcileTotal(f.rows, f.table_value_total);
    f.units = units.units;
    f.unit_source = units.source;
    f.reconciles = recon.ok;
    f.quarantined = recon.ok === false || Boolean(units.quarantine);
    f.held = aggregateHoldings(f.rows, units.units).map((h) => {
      const s = SECURITIES[h.cusip];
      return { ...h, issuerId: s?.issuerId ?? issuerIdFor(h.cusip), ticker: s?.ticker ?? null };
    });
    f.summary = summarizeHoldings(f.held);
    f.rows = null; // release the as-filed rows; the aggregate is what we publish
  }
  } // end per-window loop

  // Aggregation now happens per-window above; just report the total here.
  const quarantined = [...filings.values()].filter((f) => f.quarantined).length;
  log(`normalized: ${quarantined} quarantined`);

  // ---- group by (cik, period) and fold ------------------------------------
  const byFund = new Map();
  for (const f of filings.values()) {
    if (!f.period_end) continue;
    const key = f.cik;
    if (!byFund.has(key)) byFund.set(key, { cik: f.cik, name: f.name, state: f.state, periods: new Map() });
    const fund = byFund.get(key);
    if (f.name && f.name !== "UNKNOWN") fund.name = f.name;
    if (!fund.periods.has(f.period_end)) fund.periods.set(f.period_end, []);
    fund.periods.get(f.period_end).push(f);
  }
  log(`funds: ${byFund.size}`);

  // Rank by latest reported long value so --top selects the managers anyone is
  // actually likely to open.
  const ranked = [...byFund.values()]
    .map((fund) => {
      let best = 0;
      for (const list of fund.periods.values()) {
        for (const f of list) best = Math.max(best, f.summary?.value_long_usd ?? 0);
      }
      return { fund, rank: best };
    })
    .sort((a, b) => b.rank - a.rank);

  const writer = new ArtifactWriter(OUT, { quiet: true });
  const filerIndex = [];
  const allSeries = [];
  const filingsByPeriod = new Map();
  /** period -> sector -> { bought, sold, held } in USD, across EVERY filer. */
  const sectorFlows = new Map();
  let latestAcceptance = "";
  let holdingsWritten = 0;

  ranked.forEach(({ fund }, idx) => {
    // TWO gates. A fund is stored if it is large enough or on the watchlist; a
    // stored fund keeps line items only for the newest KEEP_Q quarters. Older
    // quarters still contribute to the compact all-time series, which is what
    // keeps history without keeping the weight.
    const fundStored = !META_ONLY && (idx < TOP || WATCHSET.has(fund.cik));
    // Only quarters whose deadline-window we actually loaded. See coversPeriod.
    const allPeriods = [...fund.periods.keys()].sort();
    const periodsAsc = allPeriods.filter(coversPeriod);
    droppedPartial += allPeriods.length - periodsAsc.length;
    const holdingPeriods = new Set(periodsAsc.slice(-KEEP_Q));
    const series = [];

    // Fold each period, then diff against the immediately preceding CALENDAR
    // quarter — never "the previous row", which silently skips gaps.
    const folded = new Map();
    for (const period of periodsAsc) {
      const list = fund.periods.get(period);
      const foldable = list.filter((f) => !f.notice && !f.quarantined);
      if (!foldable.length) {
        // TWO DIFFERENT CAUSES, AND THEY MUST NOT COLLAPSE INTO ONE.
        //
        //   noticeOnly    the manager filed a 13F-NT. Their holdings really are
        //                 reported by someone else. Nothing is wrong.
        //   quarantined   the manager filed a real 13F-HR and WE rejected it —
        //                 it failed the cover-page reconciliation or the units
        //                 ladder. Something is wrong, and it is ours.
        //
        // Both used to be stored as `{ noticeOnly: true }`, so the next quarter
        // resolved to PRIOR_IS_NT and the fund page told the user "the prior
        // quarter was a 13F notice — this manager's holdings were reported by
        // another manager" about a manager who had filed a full report. A
        // confident, specific, wrong explanation, with no hint that data had
        // been withheld by us. 35 filings and 32 reconcile failures in the
        // shipped tree sit behind that sentence.
        const noticeOnly = list.some((f) => f.notice);
        folded.set(period, {
          noticeOnly,
          quarantinedOnly: !noticeOnly,
          quarantineCount: list.filter((f) => f.quarantined).length,
          holdings: [],
        });
        continue;
      }
      const res = foldFilings(foldable.map((f) => ({
        accession_number: f.accession,
        // DERA has no acceptance time, so same-day amendments tie and the fold
        // falls back to accession order. Stated, not hidden.
        acceptance_datetime: f.filing_date ? `${f.filing_date}T12:00:00.000Z` : null,
        is_amendment: f.is_amendment,
        amendment_type: f.amendment_type,
        rows: f.held,
      })));
      const last = foldable[foldable.length - 1];
      const summary = summarizeHoldings(res.rows);
      folded.set(period, {
        noticeOnly: false, holdings: res.rows, accessions: res.accessions,
        warnings: res.warnings, summary, value_long_usd: summary.value_long_usd,
        reported_total_usd: last.table_value_total,
        confidentialOmitted: foldable.some((f) => f.is_confidential_omitted),
        acceptance: last.filing_date ? `${last.filing_date}T12:00:00.000Z` : null,
      });
      if (last.filing_date > latestAcceptance) latestAcceptance = last.filing_date;
    }

    for (const period of periodsAsc) {
      // ---------------------------------------------------------------------
      // THE FILINGS FEED IS RECORDED FIRST, AND UNCONDITIONALLY.
      //
      // It answers "did this manager file for the quarter?", which has nothing
      // to do with whether we could compute holdings from what they filed. A
      // 13F-NT is a filing — it says "another manager reports my positions" —
      // and a quarantined 13F-HR is a filing too.
      //
      // This used to sit at the BOTTOM of the loop, below the
      // `if (!cur || cur.noticeOnly) continue` guard, so every notice-only
      // fund-quarter was dropped before it was ever recorded. Measured on the
      // shipped tree: 0 of 7,714 published rows were notices, against 2,045
      // 13F-NT submissions in the source window — roughly 18% of all real
      // filings invisible, and the per-period filing/fund counts understated
      // by the same amount. A user checking whether a manager had filed saw
      // nothing and concluded they were delinquent.
      // ---------------------------------------------------------------------
      const rawFilings = fund.periods.get(period) ?? [];
      if (rawFilings.length) {
        if (!filingsByPeriod.has(period)) filingsByPeriod.set(period, []);
        for (const f of rawFilings) {
          filingsByPeriod.get(period).push({
            cik: fund.cik, fund: fund.name, code: null, accession: f.accession,
            form: f.form, filed: f.filing_date, accepted: f.filing_date ? `${f.filing_date}T12:00:00.000Z` : null,
            positions: f.held?.length ?? 0, rawRows: f.table_entry_total ?? 0,
            value: f.summary?.value_long_usd ?? null,
            amendment: f.is_amendment ? (f.amendment_type || "AMENDED") : null,
            amendmentNo: f.amendment_no, confidentialOmitted: Boolean(f.is_confidential_omitted),
            reconciles: f.reconciles ?? null, quarantined: Boolean(f.quarantined), notice: Boolean(f.notice),
          });
        }
      }

      const cur = folded.get(period);
      // Skip on "no folded holdings", not on "is a notice". Those were the same
      // condition until noticeOnly and quarantinedOnly were split apart, and
      // testing the narrower one let a quarantined-only period fall through to
      // `cur.summary.value_long_usd` — the same missing-summary crash this
      // guard exists to prevent, reintroduced by making the state more precise.
      // The invariant is about the SHAPE of the record, so test the shape.
      if (!cur || !cur.summary) continue;
      // Per-period gate: stored fund AND within the retention window.
      const wantHoldings = fundStored && holdingPeriods.has(period);
      const pp = priorPeriod(period);
      const prior = folded.get(pp);
      // IS_NT only when the manager actually filed a notice. A prior quarter we
      // quarantined is PRIOR_MISSING — deltas are equally uncomputable, but the
      // reason shown to the user is "we don't have it", not the false and much
      // more specific "another manager reports their holdings".
      const priorState = !prior ? PRIOR_STATE.NONE
        : !prior.noticeOnly && !prior.quarantinedOnly ? PRIOR_STATE.OK
        : prior.noticeOnly ? PRIOR_STATE.IS_NT
        : PRIOR_STATE.MISSING;

      // ONE EMIT LAYER, shared with the same-day build. This block used to be a
      // second copy of it, and the copies had drifted: turnover was published
      // here on quarters whose deltas were withheld, and the confidential-
      // omission flag was computed over a different population than the one
      // stored in the artifact.
      const q = fundQuarter({
        period, priorPeriod: pp, cur, prior, priorState,
        securities: SECURITIES, issuerIdFor,
      });
      const { changes, suppressed, structuralEvent, acts, turnover, rows: allRows, exits: allExits, meta } = q;

      if (wantHoldings) {
        const rows = allRows;
        const exits = allExits;

        // ---- universe-wide sector flows ---------------------------------
        //
        // TRADED value, not change in value. dValue moves when the PRICE moves,
        // so summing it reports a manager who touched nothing as a buyer:
        // measured on this quarter's tracked funds, Computers & Hardware showed
        // +$8.11B by value and exactly $0 of trading. Shares times the
        // period-end price isolates the decision from the market.
        //
        // A fund whose deltas were suppressed contributes nothing — a structural
        // event is not trading, and letting one through would put a whole book's
        // worth of phantom flow into a sector.
        if (!suppressed) {
          let bucket = sectorFlows.get(period);
          if (!bucket) { bucket = new Map(); sectorFlows.set(period, bucket); }
          const bump = (ticker, traded, value) => {
            const k = sectorOf(ticker);
            const e = bucket.get(k) ?? { bought: 0, sold: 0, held: 0 };
            if (traded > 0) e.bought += traded;
            else if (traded < 0) e.sold += -traded;
            e.held += value ?? 0;
            bucket.set(k, e);
          };
          for (const r of rows) {
            if (r.type || r.unit !== "SH") continue;   // long equity only
            // A NEW position carries d_shares = null — there is no prior
            // holding to subtract from — so reading the share delta alone
            // counts a brand-new stake as zero buying while still counting
            // every full exit. That asymmetry made EVERY sector net-negative
            // across all 13F filers, which is not a thing that can happen.
            // A new position is, by definition, entirely a purchase.
            const traded = r.action === "NEW"
              ? (r.value ?? 0)
              : (r.dShares != null && r.price != null ? r.dShares * r.price : 0);
            bump(r.ticker, traded, r.value);
          }
          // A position sold out entirely leaves the holdings table, so it is only
          // in `exits`. Omitting these would count every buy and no complete sale —
          // the easiest way to make a quarter look bullish when it was not.
          for (const e of exits) {
            if (e.unit && e.unit !== "SH") continue;
            bump(e.ticker, -(e.valuePrior ?? 0), 0);
          }
        }
        
        const pages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
        for (let p = 0; p < pages; p++) {
          writer.write(paths.fundPeriod(fund.cik, period, p), envelope({
            kind: "fund-period", cik: fund.cik, period, asOf: period,
            acceptedAt: cur.acceptance, buildId: null,
            extra: { page: p, pages, total: rows.length, exits: p === 0 ? exits : undefined, meta },
            data: encodeHoldings(rows.slice(p * ROWS_PER_PAGE, (p + 1) * ROWS_PER_PAGE)),
          }));
        }
        holdingsWritten++;
      }

      series.push(seriesEntry({
        period, cur, meta,
        pages: wantHoldings ? Math.max(1, Math.ceil(cur.holdings.length / ROWS_PER_PAGE)) : 0,
        hasHoldings: wantHoldings,
        positions: cur.holdings.length,
      }));

    }

    if (series.length) {
      // Per-fund summary file ONLY where we also carry line items. For everyone
      // else the shared series index below covers it, at a fraction of the size.
      if (fundStored) {
        writer.write(paths.fundSummary(fund.cik), envelope({
          kind: "fund-summary", cik: fund.cik, buildId: null,
          extra: { name: fund.name, code: null, formerNames: [], state: fund.state },
          data: { series: series.slice().reverse() },
        }));
      }
      allSeries.push({
        cik: fund.cik, name: fund.name, state: fund.state ?? null,
        hasHoldings: fundStored,
        watch: WATCHSET.has(fund.cik) ? 1 : 0,
        // Compact tuples, not objects: the key names would otherwise repeat once
        // per fund per quarter across the whole universe.
        s: series.slice().reverse().map((x) => [
          x.period, x.valueLongUsd, x.positions, x.reportedTotalUsd,
          x.top10WeightPct == null ? null : Number(x.top10WeightPct.toFixed(2)),
          x.n_new, x.n_added, x.n_trimmed, x.n_exited,
          x.turnover_position_pct == null ? null : Number(x.turnover_position_pct.toFixed(2)),
          x.priorState, x.structuralEvent, x.confidentialOmitted ? 1 : 0,
          x.filingLagDays, x.valueOptionsUsd, x.positionsLong, x.positionsOptions,
          fundStored && holdingPeriods.has(x.period) ? 1 : 0,
          // Published rather than re-derived downstream. The frontend used to
          // infer it as Boolean(structuralEvent), which is not the rule applied
          // here — a REVIEW-flagged quarter keeps its deltas — so this file and a
          // fund's own summary.json disagreed about the same quarter.
          x.deltasSuppressed ? 1 : 0,
          // APPENDED, never inserted — see shared/series-fields.mjs. Tuples
          // already in the bucket end one element earlier and read this as null.
          x.valuePrnUsd ?? 0,
        ]),
      });
      const latest = series.at(-1);
      filerIndex.push({
        cik: fund.cik, name: fund.name, code: null, state: fund.state ?? null,
        periods: series.length, latestPeriod: latest?.period ?? null,
        latestValueUsd: latest?.valueLongUsd ?? null,
        hasHoldings: fundStored,
        watch: WATCHSET.has(fund.cik),
      });
    }
  });

  // ---- shared indexes -----------------------------------------------------
  writer.write(paths.series(), envelope({
    kind: "series", buildId: null,
    extra: {
      // From shared/series-fields.mjs, so this list and the one the dashboard
      // zips against the tuple cannot drift apart again.
      fields: SERIES_FIELDS,
    },
    data: allSeries,
  }));

  // Assign UNIQUE short codes. Naive first-three-letters collided badly across
  // the universe — Vanguard files under several entities and all of them became
  // "VAN", making the matrix columns indistinguishable.
  {
    const used = new Set();
    for (const f of filerIndex) {
      const words = f.name.toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/).filter(Boolean);
      const candidates = [
        words[0]?.slice(0, 3),
        words[0]?.slice(0, 2) + (words[1]?.[0] ?? ""),
        words[0]?.[0] + (words[1]?.slice(0, 2) ?? ""),
        words.map((w) => w[0]).join("").slice(0, 3),
      ].filter((c) => c && c.length === 3);
      let code = candidates.find((c) => !used.has(c));
      if (!code) {
        // Base36 suffix, not a 1..99 counter: with ~9,400 filers many share a
        // two-letter stem ("FIRST ...", "AMERICAN ..."), and a 99-slot fallback
        // exhausted and left ~280 duplicates. This cannot run out.
        const base = (candidates[0] ?? "FND").slice(0, 2);
        let n = 0;
        do { code = base + (n++).toString(36).toUpperCase(); } while (used.has(code) && n < 1e6);
      }
      f.code = code;
      used.add(code);
    }
  }

  writer.write(paths.filers(), envelope({
    kind: "filers", buildId: null,
    data: filerIndex.sort((a, b) => (b.latestValueUsd ?? 0) - (a.latestValueUsd ?? 0)),
  }));

  const reported = [...filingsByPeriod.keys()].sort().reverse();
  const periodMeta = reported.map((p) => ({
    period: p, label: periodLabel(p), deadline: filingDeadline(p),
    filings: filingsByPeriod.get(p).length,
    funds: new Set(filingsByPeriod.get(p).map((f) => f.cik)).size,
  }));
  writer.write(paths.periods(), envelope({ kind: "periods", buildId: null, data: periodMeta }));

  // The ticker -> sector map, so the browser can bucket the comparison set's
  // own holdings without a second request per fund. Small: one short string per
  // listed company, and it is the same map the universe aggregate below used,
  // so the two scopes can never disagree about what sector a name is in.
  writer.write(paths.sectorMap(), envelope({
    kind: "sector-map", buildId: null,
    data: Object.fromEntries(Object.entries(SECTOR_MAP).map(([t, v]) => [t, v.sector])),
  }));

  // Universe-wide sector flows. Precomputed because the browser cannot load
  // 9,000 funds to work it out, which is the same reason the leaderboard is
  // precomputed. Sorted by net so the biggest moves are first in the file.
  for (const [period, bucket] of sectorFlows) {
    const rows = [...bucket.entries()]
      .map(([sector, e]) => ({
        sector,
        bought: Math.round(e.bought),
        sold: Math.round(e.sold),
        net: Math.round(e.bought - e.sold),
        held: Math.round(e.held),
      }))
      .sort((a, b) => b.net - a.net);
    writer.write(paths.periodSectors(period), envelope({
      kind: "period-sectors", period, buildId: null, data: rows,
    }));
  }

  for (const p of reported) {
    // The global feed is ordered by arrival and capped: nobody scrolls past a
    // few hundred rows, and shipping 9,000 to every visitor is pure weight.
    const rows = filingsByPeriod.get(p)
      .sort((a, b) => String(b.accepted).localeCompare(String(a.accepted)) || (b.value ?? 0) - (a.value ?? 0))
      .slice(0, 2000);
    writer.write(paths.periodFilings(p), envelope({
      kind: "period-filings", period: p, buildId: null,
      extra: { total: filingsByPeriod.get(p).length, shown: rows.length },
      data: rows,
    }));
  }

  const buildId = buildIdFrom(latestAcceptance, used.slug);
  writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest({
    buildId, periods: periodMeta, funds: {},
    coverage: { from: reported.at(-1), to: reported[0], holdingsFrom: reported.at(-1) },
    counts: { filers: filerIndex.length, filings: [...filingsByPeriod.values()].reduce((a, v) => a + v.length, 0), holdings: holdingsWritten },
    notes: [],
  }), null, 2));
  writeHeadersFile("public");

  const s = writer.summary();
  log(`\n${"=".repeat(64)}`);
  log(`window ${used.slug} · build ${buildId}`);
  log(`${filerIndex.length} filers · ${holdingsWritten} fund-quarters with holdings`);
  // Say what was dropped. A silent truncation reads as "that is all there was",
  // which is the same class of wrong answer as publishing the fragment.
  if (droppedPartial) {
    log(`${droppedPartial} fund-quarters dropped: their filing window was not loaded, so only stragglers were present`);
  }
  log(`${s.files + 1} files · ${(s.gzBytes / 1048576).toFixed(1)} MB`);
  log(`${sec.requestCount} SEC requests`);
});
