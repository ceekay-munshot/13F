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
import { foldFilings, computeChanges, computeTurnover, summarizeActions, PRIOR_STATE } from "../shared/fold.mjs";
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
  "0001067983", // Berkshire Hathaway
  "0001350694", // Bridgewater Associates
  "0001423053", // Citadel Advisors
  "0001037389", // Renaissance Technologies
  "0001167483", // Tiger Global Management
  "0001135730", // Coatue Management
  "0001061165", // Lone Pine Capital
  "0001656456", // Appaloosa
  "0001040273", // Third Point
  "0001061768", // Baupost Group
  "0001649339", // Scion Asset Management
  "0001279936", // Cantillon Capital Management
  "0001273087", // Millennium Management
  "0001791786", // Elliott Investment Management
  "0001536411", // Duquesne Family Office
];
const WATCHSET = new Set(WATCHLIST);
const log = (m) => console.log(m);

const SECURITIES = (() => {
  const p = args.securities || "data/securities.json";
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8")).securities ?? {};
})();

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
  let windows;
  if (args.window) {
    windows = [{ slug: String(args.window), url: `https://www.sec.gov/files/structureddata/data/form-13f-data-sets/${args.window}_form13f.zip` }];
  } else {
    // Walk back through recent windows until one is actually published; the
    // newest is typically not yet available.
    const seen = new Set();
    windows = [];
    for (let i = 0; i < 8; i++) {
      const d = new Date(today);
      d.setUTCMonth(d.getUTCMonth() - i);
      const w = deraWindowFor(d.toISOString().slice(0, 10));
      if (w && !seen.has(w.slug)) { seen.add(w.slug); windows.push(w); }
    }
  }

  const WANT = Number(args.windows || 1);
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

  /** accession -> filing metadata, accumulated ACROSS windows. */
  const filings = new Map();
  let rowCount = 0;

  for (const { w: win, buf: zipBuf } of loaded) {
  const zip = zipBuf;
  log(`\n--- ${win.slug} ---`);
  // ---- read the small tables in full, stream the big one ------------------
  const entries = listEntries(zip);
  log(`\nentries: ${entries.map((e) => `${e.name} ${(e.size / 1048576).toFixed(1)}MB`).join(", ")}`);
  const find = (n) => entries.find((e) => e.name.toUpperCase() === n);

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
    if (!f.rows.length) { f.notice = true; f.rows = null; continue; }
    f.notice = false;
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
  let latestAcceptance = "";
  let holdingsWritten = 0;

  ranked.forEach(({ fund }, idx) => {
    // TWO gates. A fund is stored if it is large enough or on the watchlist; a
    // stored fund keeps line items only for the newest KEEP_Q quarters. Older
    // quarters still contribute to the compact all-time series, which is what
    // keeps history without keeping the weight.
    const fundStored = !META_ONLY && (idx < TOP || WATCHSET.has(fund.cik));
    const periodsAsc = [...fund.periods.keys()].sort();
    const holdingPeriods = new Set(periodsAsc.slice(-KEEP_Q));
    const series = [];

    // Fold each period, then diff against the immediately preceding CALENDAR
    // quarter — never "the previous row", which silently skips gaps.
    const folded = new Map();
    for (const period of periodsAsc) {
      const list = fund.periods.get(period);
      const foldable = list.filter((f) => !f.notice && !f.quarantined);
      if (!foldable.length) { folded.set(period, { noticeOnly: true, holdings: [] }); continue; }
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
      const cur = folded.get(period);
      if (!cur || cur.noticeOnly) continue;
      // Per-period gate: stored fund AND within the retention window.
      const wantHoldings = fundStored && holdingPeriods.has(period);
      const pp = priorPeriod(period);
      const prior = folded.get(pp);
      const priorState = prior && !prior.noticeOnly ? PRIOR_STATE.OK
        : prior?.noticeOnly ? PRIOR_STATE.IS_NT : PRIOR_STATE.NONE;

      const { changes, suppressed, reason, structural } = computeChanges(
        { period_end: period, holdings: cur.holdings, value_long_usd: cur.value_long_usd },
        priorState === PRIOR_STATE.OK
          ? { period_end: pp, accession: prior.accessions?.at(-1) ?? null, holdings: prior.holdings, value_long_usd: prior.value_long_usd }
          : null,
        priorState,
      );
      const acts = summarizeActions(changes);
      const turnover = priorState === PRIOR_STATE.OK
        ? computeTurnover(changes, { holdings: cur.holdings, value_long_usd: cur.value_long_usd },
            { holdings: prior.holdings, value_long_usd: prior.value_long_usd })
        : { turnover_position_pct: null, turnover_value_pct: null };

      if (wantHoldings) {
        const changeByKey = new Map(changes.map((c) => [`${c.cusip}|${c.put_call}`, c]));
        const rows = cur.holdings.map((h) => {
          const ch = changeByKey.get(`${h.cusip}|${h.put_call}`);
          return {
            ticker: h.ticker ?? null, name: h.name_of_issuer, issuerId: h.issuerId,
            cls: h.title_of_class, type: h.put_call, unit: h.ssh_prnamt_type,
            value: h.value_usd, shares: h.ssh_prnamt,
            weight: h.weight_pct == null ? null : Number(h.weight_pct.toFixed(4)),
            price: h.implied_price == null ? null : Number(h.implied_price.toFixed(4)),
            action: ch?.action ?? null, dShares: ch?.d_shares ?? null,
            dSharesPct: ch?.d_shares_pct == null ? null : Number(ch.d_shares_pct.toFixed(3)),
            dValue: ch?.d_value ?? null,
            dValuePct: ch?.d_value_pct == null ? null : Number(ch.d_value_pct.toFixed(3)),
            dWeightPp: ch?.d_weight_pp == null ? null : Number(ch.d_weight_pp.toFixed(4)),
            flags: ch?.flags ?? null,
          };
        }).sort((a, b) => b.value - a.value);

        const exits = changes.filter((c) => c.action === "EXITED").map((c) => ({
          ticker: SECURITIES[c.cusip]?.ticker ?? null, name: c.name_of_issuer,
          issuerId: SECURITIES[c.cusip]?.issuerId ?? issuerIdFor(c.cusip), type: c.put_call,
          valuePrior: c.value_prior, weightPrior: c.weight_prior,
        })).sort((a, b) => (b.valuePrior ?? 0) - (a.valuePrior ?? 0));

        const meta = {
          priorState, priorPeriod: priorState === PRIOR_STATE.OK ? pp : null,
          deltasSuppressed: suppressed, structuralEvent: suppressed ? reason : null,
          structuralDetail: structural?.detail ?? null,
          confidentialOmitted: Boolean(cur.confidentialOmitted),
          foldWarnings: cur.warnings ?? [], accessions: cur.accessions ?? [],
          ...cur.summary, reportedTotalUsd: cur.reported_total_usd, ...acts, ...turnover,
        };
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

      series.push({
        period, label: periodLabel(period),
        reportedTotalUsd: cur.reported_total_usd,
        valueLongUsd: cur.summary.value_long_usd,
        valueOptionsUsd: cur.summary.value_options_usd,
        positions: cur.holdings.length,
        positionsLong: cur.summary.positions_long,
        positionsOptions: cur.summary.positions_options,
        top10WeightPct: cur.summary.top10_weight_pct,
        ...acts, ...turnover, priorState,
        deltasSuppressed: suppressed, structuralEvent: suppressed ? reason : null,
        confidentialOmitted: Boolean(cur.confidentialOmitted),
        pages: wantHoldings ? Math.max(1, Math.ceil(cur.holdings.length / ROWS_PER_PAGE)) : 0,
        acceptedAt: cur.acceptance,
        filingLagDays: cur.acceptance
          ? Math.round((Date.parse(cur.acceptance.slice(0, 10) + "T00:00:00Z") - Date.parse(`${period}T00:00:00Z`)) / 86400000)
          : null,
        hasHoldings: wantHoldings,
      });

      if (!filingsByPeriod.has(period)) filingsByPeriod.set(period, []);
      for (const f of fund.periods.get(period)) {
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
      fields: ["period", "valueLongUsd", "positions", "reportedTotalUsd", "top10WeightPct",
               "n_new", "n_added", "n_trimmed", "n_exited", "turnover_position_pct",
               "priorState", "structuralEvent", "confidentialOmitted", "filingLagDays",
               "valueOptionsUsd", "positionsLong", "positionsOptions", "hasHoldings"],
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
  log(`${s.files + 1} files · ${(s.gzBytes / 1048576).toFixed(1)} MB`);
  log(`${sec.requestCount} SEC requests`);
});
