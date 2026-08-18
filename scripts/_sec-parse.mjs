#!/usr/bin/env node
// scripts/_sec-parse.mjs
//
// Parsing and normalization for SEC Form 13F. This is the correctness core of
// the project: every known way 13F data produces confidently-wrong numbers is
// handled here, at ingest, before anything reaches D1.
//
// All parsing runs on the RUNNER, never in a Worker. The DERA quarterly ZIP is
// ~99 MB compressed and ~402 MB uncompressed (INFOTABLE.tsv alone is 396 MB);
// a Worker isolate has 128 MB. Functions only ever receive pre-normalized JSON.

import { XMLParser } from "fast-xml-parser";

// removeNSPrefix is the whole reason this dependency exists. Namespace prefixes
// are NOT stable across filers: Bridgewater emits <ns1:infoTable> while Citadel
// emits a bare <infoTable> in a default namespace, and some older hand-rolled
// filings declare no namespace at all. Matching on local-name is the only sound
// approach, and regex parsing of XML this irregular is not.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,   // keep everything as strings: CUSIPs have leading zeros
  parseAttributeValue: false,
  trimValues: true,
});

// ---------------------------------------------------------------------------
// Date normalization. A single filing mixes three formats:
//   primary_doc.xml periodOfReport / signatureDate  MM-DD-YYYY
//   submissions API reportDate / filingDate         YYYY-MM-DD
//   SGML header                                     YYYYMMDD / YYYYMMDDHHMMSS
// Normalize at the boundary so nothing downstream has to know.
// ---------------------------------------------------------------------------

const MONTHS = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/**
 * Normalize the FOUR date shapes the SEC uses for 13F.
 *
 *   2026-03-31    submissions API (ISO)
 *   03-31-2026    primary_doc.xml periodOfReport (MM-DD-YYYY)
 *   20260331      SGML header
 *   31-MAR-2026   the DERA quarterly data set (DD-MON-YYYY)
 *
 * The last one is easy to miss because it only appears in the bulk data set. It
 * silently returned null for every row, which made every period_end null, which
 * made the full-universe loader produce zero funds while otherwise appearing to
 * work perfectly.
 */
export function normalizeDate(s) {
  if (!s) return null;
  const v = String(s).trim().toUpperCase();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})-([A-Z]{3})-(\d{4})$/.exec(v);
  if (m && MONTHS[m[2]]) return `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, "0")}`;
  return null;
}

/**
 * The SGML header's ACCEPTANCE-DATETIME is YYYYMMDDHHMMSS in EASTERN time,
 * while the submissions API gives the same instant as explicit UTC
 * (Bridgewater 0001350694-26-000002: header 20260515160656, API
 * 2026-05-15T20:06:56Z). Mixing the two unconverted would corrupt the amendment
 * fold's ordering, so convert here.
 *
 * PREFER the submissions API value when available — it needs no conversion and
 * carries no DST ambiguity.
 */
export function etStampToUtcISO(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(stamp || "").trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  // Treat the wall-clock as UTC, then measure how far America/New_York was from
  // UTC at that instant and subtract it.
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetMin = easternOffsetMinutes(new Date(asUtc));
  return new Date(asUtc - offsetMin * 60_000).toISOString();
}

function easternOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asIfUtc - date.getTime()) / 60_000);
}

// ---------------------------------------------------------------------------
// SGML index-headers — the authoritative document selector.
// ---------------------------------------------------------------------------

/**
 * Find the information table filename and the header metadata in one request.
 *
 * The filename is entirely filer-agent dependent. Real examples from the SAME
 * quarter (2026-Q1): Bridgewater `infotable.xml`, Citadel `infotable.xml`,
 * Berkshire `53405.xml`. A `*informationtable*.xml` glob matches NONE of them.
 * The only deterministic selector is the SGML <DOCUMENT> block whose <TYPE> is
 * exactly "INFORMATION TABLE".
 *
 * Also note: there is no `{accession}-index.json` (404) and 13F filings contain
 * no FilingSummary.xml (404) — 13F is not XBRL. Do not build a resolver around
 * either.
 */
function unescapeHtml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // last, so "&amp;lt;" does not become "<"
}

export function parseIndexHeaders(html) {
  // The SGML lives inside a <PRE> block with every tag HTML-ESCAPED
  // (&lt;DOCUMENT&gt;), so it must be unescaped before any tag matching. There
  // is also an unescaped copy of the SEC-HEADER inside an HTML comment at the
  // top of the file, but that copy contains NO <DOCUMENT> blocks — parsing only
  // the comment finds no information table at all.
  const text = unescapeHtml(html);

  const documents = [];
  // Tolerate a missing </DOCUMENT>: stop at the next <DOCUMENT>, </SEC-DOCUMENT>
  // or end of input. Some older filings omit the close tag.
  const docRe = /<DOCUMENT>([\s\S]*?)(?=<\/DOCUMENT>|<DOCUMENT>|<\/SEC-DOCUMENT>|$)/gi;
  let m;
  while ((m = docRe.exec(text))) {
    const block = m[1];
    const pick = (tag) => {
      // Anchor to line start so the <a href> links that follow <TEXT> inside
      // each block cannot be mistaken for SGML fields.
      const r = new RegExp(`^<${tag}>[ \\t]*([^<\\r\\n]*)`, "im").exec(block);
      return r && r[1].trim() ? r[1].trim() : null;
    };
    documents.push({
      type: pick("TYPE"),
      sequence: pick("SEQUENCE"),
      filename: pick("FILENAME"),
      description: pick("DESCRIPTION"),
    });
  }

  // Two shapes coexist in this file: tag form (<ACCEPTANCE-DATETIME>2026...)
  // and label form (CONFORMED PERIOD OF REPORT:\t\t20260331). Try both.
  const headerField = (label) => {
    const tag = new RegExp(`<${label}>[ \\t]*([^<\\r\\n]+)`, "i").exec(text);
    if (tag) return tag[1].trim();
    const lab = new RegExp(`^\\s*${label}:\\s*([^\\r\\n<]+)`, "im").exec(text);
    return lab ? lab[1].trim() : null;
  };

  const infoTable = documents.find(
    (d) => (d.type || "").toUpperCase() === "INFORMATION TABLE",
  );

  const acceptanceRaw = headerField("ACCEPTANCE-DATETIME");

  return {
    documents,
    infoTableFilename: infoTable ? infoTable.filename : null,
    acceptanceDatetime: acceptanceRaw ? etStampToUtcISO(acceptanceRaw) : null,
    acceptanceRawEastern: acceptanceRaw,
    periodOfReport: normalizeDate(headerField("CONFORMED PERIOD OF REPORT")),
    filedAsOfDate: normalizeDate(headerField("FILED AS OF DATE")),
    formType: headerField("CONFORMED SUBMISSION TYPE"),
    // One accession is served under EVERY filer on the submission. Capturing
    // all of them is what stops two watchlist funds on a co-filed 13F from
    // double-counting into 100% "overlap".
    ciks: [...text.matchAll(/CENTRAL INDEX KEY:\s*(\d+)/gi)].map((x) => x[1].padStart(10, "0")),
    formerNames: [...text.matchAll(/FORMER CONFORMED NAME:\s*([^\r\n<]+)/gi)].map((x) => x[1].trim()),
  };
}

/**
 * `primaryDocument` from the submissions API is an XSL VIEWER path, e.g.
 * "xslForm13F_X02/primary_doc.xml". Fetching it returns styled HTML, not XML.
 */
export function stripXslPrefix(primaryDocument) {
  return String(primaryDocument || "").split("/").pop();
}

// ---------------------------------------------------------------------------
// Cover page (primary_doc.xml)
// ---------------------------------------------------------------------------

function first(node, ...path) {
  let cur = node;
  for (const key of path) {
    if (cur == null) return null;
    cur = Array.isArray(cur) ? cur[0]?.[key] : cur[key];
  }
  if (cur == null) return null;
  return Array.isArray(cur) ? cur[0] : cur;
}

function asInt(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[, ]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function parsePrimaryDoc(xml) {
  const doc = parser.parse(xml);
  const sub = doc.edgarSubmission ?? doc;

  const header = sub.headerData ?? {};
  const form = sub.formData ?? {};
  const cover = form.coverPage ?? {};
  const summary = form.summaryPage ?? {};
  const amendInfo = cover.amendmentInfo ?? {};

  const isAmendment = String(cover.isAmendment ?? "").toLowerCase() === "true";
  const amendmentType = amendInfo.amendmentType ? String(amendInfo.amendmentType).toUpperCase() : null;

  // otherManagers2Info is the COVER-PAGE list of included managers, each with
  // its own cik / form13FFileNumber / name. Distinct from the holding-level
  // `otherManager` element, which is only an INDEX STRING into this list.
  const om2 = summary.otherManagers2Info?.otherManager2;
  const otherManagers = (Array.isArray(om2) ? om2 : om2 ? [om2] : []).map((x) => ({
    sequence: x.sequenceNumber ?? null,
    cik: x.otherManager?.cik ? String(x.otherManager.cik).padStart(10, "0") : null,
    fileNumber: x.otherManager?.form13FFileNumber ?? null,
    name: x.otherManager?.name ?? null,
  }));

  return {
    // Present from EDGAR release 22.4.1 (2023-01-03) onward. The PRIMARY value-
    // units discriminator: X0202 means the Value column is in DOLLARS, absent
    // means THOUSANDS.
    schemaVersion: sub.schemaVersion ?? null,
    submissionType: first(header, "submissionType") ?? cover.submissionType ?? null,
    periodOfReport: normalizeDate(first(header, "filerInfo", "periodOfReport") ?? cover.reportCalendarOrQuarter),
    reportType: cover.reportType ?? null,
    filingManagerName: first(cover, "filingManager", "name") ?? null,
    form13FFileNumber: cover.form13FFileNumber ?? null,
    isAmendment,
    amendmentNo: asInt(cover.amendmentNo),
    amendmentType,
    // Sometimes absent entirely (CenturyLink 2026-Q2) — default rather than require.
    confDeniedExpired:
      amendInfo.confDeniedExpired == null
        ? null
        : String(amendInfo.confDeniedExpired).toLowerCase() === "true",
    // A filing flagged here is INCOMPLETE BY DESIGN: holdings were withheld
    // pending a confidential-treatment request. Its value total is a floor, not
    // the manager's book, and its "exits" cannot be distinguished from
    // omissions.
    isConfidentialOmitted: String(summary.isConfidentialOmitted ?? "").toLowerCase() === "true",
    tableEntryTotal: asInt(summary.tableEntryTotal),
    tableValueTotal: asInt(summary.tableValueTotal),
    otherIncludedManagersCount: asInt(summary.otherIncludedManagersCount),
    otherManagers,
  };
}

// ---------------------------------------------------------------------------
// Information table
// ---------------------------------------------------------------------------

export function parseInfoTable(xml) {
  const doc = parser.parse(xml);
  const table = doc.informationTable ?? doc;
  const raw = table.infoTable ?? [];
  const rows = Array.isArray(raw) ? raw : [raw];

  return rows.filter(Boolean).map((r, i) => {
    const shrs = r.shrsOrPrnAmt ?? {};
    const voting = r.votingAuthority ?? {};
    return {
      row_seq: i + 1,
      name_of_issuer: String(r.nameOfIssuer ?? "").trim(),
      title_of_class: r.titleOfClass ? String(r.titleOfClass).trim() : null,
      // ALWAYS a string. "002824100" (Abbott) becomes 2824100 the instant it
      // touches a numeric type, and then never joins to anything again.
      cusip: String(r.cusip ?? "").trim().toUpperCase(),
      figi: r.figi ? String(r.figi).trim() : null,
      value_raw: asInt(r.value),
      ssh_prnamt: asInt(shrs.sshPrnamt),
      // SH = shares. PRN = principal amount of a debt instrument, i.e. dollars
      // of face value. Summing the two is meaningless.
      ssh_prnamt_type: shrs.sshPrnamtType ? String(shrs.sshPrnamtType).trim().toUpperCase() : null,
      // ABSENT for ordinary long equity. Present as Put/Call for options, which
      // are ~47% of rows for a manager like Citadel.
      put_call: r.putCall ? String(r.putCall).trim() : null,
      investment_discretion: r.investmentDiscretion ? String(r.investmentDiscretion).trim() : null,
      // An index string ("1", "1,2") into the cover page's otherManagers2Info —
      // NOT a CIK. Treating it as one produces nonsense.
      other_manager: r.otherManager != null ? String(r.otherManager).trim() : null,
      // Capitalized Sole/Shared/None, unlike every other element in the schema.
      voting_sole: asInt(voting.Sole) ?? 0,
      voting_shared: asInt(voting.Shared) ?? 0,
      voting_none: asInt(voting.None) ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Issuer identity
// ---------------------------------------------------------------------------

/**
 * Opaque, stable issuer id derived from the CUSIP's 6-character issuer prefix.
 *
 * Two jobs at once:
 *
 *  1. CORRECTNESS. Overlap must be computed per ISSUER, not per share class.
 *     GOOG (02079K305) and GOOGL (02079K107) are two CUSIPs of one company —
 *     comparing on the full CUSIP means a fund holding GOOG and a fund holding
 *     GOOGL show zero overlap on Alphabet. Both share the prefix 02079K, so
 *     both map to one issuer id. (The prefix is a strong heuristic, not a rule;
 *     curated exceptions override it.)
 *
 *  2. LICENSING. The prefix is itself part of a CUSIP, and CUSIPs are
 *     proprietary (ABA, licensed via CGS/S&P). Hashing means the published
 *     artifacts carry an identifier that groups share classes correctly while
 *     containing no CUSIP data at all. FIGI and ticker are the identifiers we
 *     actually display.
 *
 * FNV-1a — not cryptographic, and does not need to be. It needs to be
 * deterministic across runs so yesterday's artifacts and today's agree.
 */
export function issuerIdFor(cusip) {
  const prefix = String(cusip || "").trim().toUpperCase().slice(0, 6);
  if (!prefix) return null;
  let h = 2166136261;
  for (let i = 0; i < prefix.length; i++) {
    h ^= prefix.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `i${h.toString(36).padStart(7, "0")}`;
}

// ---------------------------------------------------------------------------
// THE VALUE-UNITS LADDER — the highest-impact correctness gate in the project.
// ---------------------------------------------------------------------------

export const UNIT_CUTOVER_ISO = "2023-01-03"; // EDGAR release 22.4.1

/** Rows eligible for the implied-price test: long equity, share-denominated. */
function pricedRows(rows) {
  return rows.filter(
    (r) =>
      r.put_call == null &&
      r.ssh_prnamt_type === "SH" &&
      r.ssh_prnamt > 0 &&
      r.value_raw > 0,
  );
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Decide whether `value` is in dollars or thousands, and record HOW we decided.
 *
 * Why this is not simply "filings after 2023-01-03 are in dollars":
 *
 *  (a) The cutover keys on FILING date, not period. Jefferies (CIK 1084580)
 *      reported period 2021-03-31 twice — the original in 2021 at 11,413,760
 *      (thousands) and a RESTATEMENT filed 2023-09-21 at 11,411,017,784
 *      (dollars). Same quarter, same manager, 1000x apart. Any pipeline that
 *      infers units from the PERIOD gets a 1000x error on every backfilled
 *      amendment.
 *
 *  (b) Even the filing-date rule is insufficient. Measured across the current
 *      DERA quarterly set (315,211 rows, 2,395 filings): 82 filings (3.42%)
 *      have a median implied price under $1.00 — they kept reporting in
 *      thousands after the cutover. Healthy distribution for comparison:
 *      p1 $0.072, p50 $76.39, p99 $302.24.
 *
 * So the empirical test OVERRIDES the date rule. `unit_source` records which
 * rung decided, and `medianImpliedPrice` preserves the evidence, so a future
 * correction is a re-derivation rather than a re-download.
 */
export function decideValueUnits({ schemaVersion, acceptanceDatetime, rows }) {
  // Rungs 1-2: the documented rule gives us a hypothesis.
  let units;
  let source;
  if (schemaVersion && String(schemaVersion).toUpperCase() === "X0202") {
    units = "DOLLARS";
    source = "schema_x0202";
  } else if (acceptanceDatetime && acceptanceDatetime.slice(0, 10) >= UNIT_CUTOVER_ISO) {
    units = "DOLLARS";
    source = "acceptance_date";
  } else {
    units = "THOUSANDS";
    source = schemaVersion === undefined ? "acceptance_date" : "schema_absent";
  }

  // Rung 3: the empirical override. Implied price is computed AS IF the value
  // were dollars, so a filing genuinely in thousands lands ~1000x low. This one
  // test therefore validates both eras with the same threshold.
  const priced = pricedRows(rows);
  const med = median(priced.map((r) => r.value_raw / r.ssh_prnamt));

  let quarantine = null;
  if (med != null) {
    if (med < 1.0) {
      if (units !== "THOUSANDS") source = "implied_price";
      units = "THOUSANDS";
    } else if (med <= 5000) {
      if (units !== "DOLLARS") source = "implied_price";
      units = "DOLLARS";
    } else {
      // Berkshire Class A trades near $700k, so a single high row is fine — but
      // a high MEDIAN across the whole book is not. Keep the hypothesis so the
      // data stays usable, and flag it for a human.
      quarantine = {
        code: "implied_price_implausible",
        severity: "error",
        detail: `median implied price ${med.toFixed(2)} over ${priced.length} long SH rows`,
      };
    }
  } else if (rows.length > 0) {
    // All-options or all-PRN books give the detector nothing to work with. Fall
    // back to the documented rule and say so.
    source = source === "implied_price" ? "acceptance_date" : source;
  }

  return { units, source, medianImpliedPrice: med, quarantine };
}

export function toUsd(valueRaw, units) {
  return units === "THOUSANDS" ? valueRaw * 1000 : valueRaw;
}

/**
 * Rung 4: SUM(value) must equal the cover page's tableValueTotal EXACTLY.
 * Verified exact on Citadel 2026-Q1: 618,473,172,395 over 15,589 rows.
 *
 * Note precisely what this does and does not catch. Both sides are in the same
 * units, so it CANNOT detect a 1000x unit error — that is rung 3's job. What it
 * catches is a truncated download, a missed <infoTable> element, or a namespace
 * shape the parser mishandled. It is the cheapest possible parse-completeness
 * check and it costs one comparison.
 */
export function reconcileTotal(rows, tableValueTotal) {
  if (tableValueTotal == null) return { ok: null, sum: null, delta: null };
  const sum = rows.reduce((a, r) => a + (r.value_raw || 0), 0);
  return { ok: sum === tableValueTotal, sum, delta: sum - tableValueTotal };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Collapse an information table to one row per position.
 *
 * The grouping key is (cusip, put_call, ssh_prnamt_type) and DELIBERATELY
 * EXCLUDES other_manager.
 *
 * Duplicate keys within one filing are normal, not an error: measured across
 * 315,211 rows, 142,765 of 760,433 keys (18.8%) appear more than once. They are
 * ADDITIVE PORTIONS of a single position, split by manager attribution, voting
 * authority or discretion — not repeated reports of the same holding.
 *
 * Proof, from Cantillon 2026-Q1 (0001279936-26-000004), 76 rows / 38 CUSIPs:
 *     other_manager blank : $9,218,668,217   (38 rows)
 *     other_manager = '1' : $5,832,310,749   (38 rows)
 *     sum                 : $15,050,978,966
 * which is EXACTLY the filing's tableValueTotal. `SELECT DISTINCT` or
 * `MAX(value) GROUP BY cusip` understates this fund by 38.8%.
 *
 * Grouping on cusip ALONE is a different failure: it silently merges puts,
 * calls and longs into one meaningless number. Citadel's 68243Q106 appears as
 * value 80,560 (Call) and 172,672 (Put) — averaging or summing those without
 * the put_call split invents a position the fund does not hold.
 */
export function aggregateHoldings(rows, units) {
  const byKey = new Map();

  for (const r of rows) {
    const putCall = r.put_call ?? "";
    const type = r.ssh_prnamt_type ?? "SH";
    const key = `${r.cusip}|${putCall}|${type}`;

    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        cusip: r.cusip,
        put_call: putCall,
        ssh_prnamt_type: type,
        name_of_issuer: r.name_of_issuer,
        title_of_class: r.title_of_class,
        figi: r.figi ?? null,
        value_usd: 0,
        ssh_prnamt: 0,
        voting_sole: 0,
        voting_shared: 0,
        voting_none: 0,
        row_count: 0,
      };
      byKey.set(key, acc);
    }

    acc.value_usd += toUsd(r.value_raw || 0, units);
    acc.ssh_prnamt += r.ssh_prnamt || 0;
    acc.voting_sole += r.voting_sole || 0;
    acc.voting_shared += r.voting_shared || 0;
    acc.voting_none += r.voting_none || 0;
    acc.row_count += 1;
    if (!acc.figi && r.figi) acc.figi = r.figi;
  }

  const out = [...byKey.values()];

  // Weight denominators. Long equity only — never a denominator that mixes
  // option notional with equity market value. Post-2023 filers are inconsistent
  // about whether an option row's value is fair value or underlying notional,
  // and large filers commonly report notional, so a mixed denominator inflates
  // the book and deflates every weight by an amount that varies per fund.
  const valueLong = out
    .filter((h) => h.put_call === "" && h.ssh_prnamt_type === "SH")
    .reduce((a, h) => a + h.value_usd, 0);

  for (const h of out) {
    // NULLIF-equivalent: 167 of 315,211 measured rows have value = 0, rare
    // enough to miss in fixtures and common enough to appear in production.
    h.weight_pct = valueLong > 0 ? (h.value_usd / valueLong) * 100 : null;
    h.implied_price =
      h.put_call === "" && h.ssh_prnamt_type === "SH" && h.ssh_prnamt > 0
        ? h.value_usd / h.ssh_prnamt
        : null;
  }

  return out;
}

/** Portfolio-level totals, each with an explicit and separate denominator. */
export function summarizeHoldings(holdings) {
  const long = holdings.filter((h) => h.put_call === "" && h.ssh_prnamt_type === "SH");
  const options = holdings.filter((h) => h.put_call !== "");
  const prn = holdings.filter((h) => h.put_call === "" && h.ssh_prnamt_type === "PRN");
  const sum = (xs) => xs.reduce((a, h) => a + h.value_usd, 0);

  const sorted = [...long].sort((a, b) => b.value_usd - a.value_usd);
  const valueLong = sum(long);
  const top10 = sorted.slice(0, 10).reduce((a, h) => a + h.value_usd, 0);

  return {
    value_long_usd: valueLong,
    value_options_usd: sum(options),
    value_prn_usd: sum(prn),
    positions_total: holdings.length,
    positions_long: long.length,
    positions_options: options.length,
    top10_weight_pct: valueLong > 0 ? (top10 / valueLong) * 100 : null,
  };
}

// ---------------------------------------------------------------------------
// Index files
// ---------------------------------------------------------------------------

const FORM_TYPES = new Set(["13F-HR", "13F-HR/A", "13F-NT", "13F-NT/A"]);

/**
 * Parse a daily-index or full-index `form.idx`.
 *
 * ---------------------------------------------------------------------------
 * PARSED FROM THE ARCHIVE PATH, NOT FROM COLUMN OFFSETS.
 * ---------------------------------------------------------------------------
 * This used to locate the header rule, read the column offsets out of the line
 * above it, and slice each row at those offsets. It returned ZERO ROWS against
 * the live file, and had done for as long as anyone had looked, because EDGAR
 * wraps the header across two lines:
 *
 *   Form Type   Company Name                                            CIK
 *         Date Filed  File Name
 *   -------------------------------------------------------------------------
 *   13F-HR           &PARTNERS                    107136   20260814   edgar/data/107136/0001214659-26-010148.txt
 *
 * The line immediately above the rule is "      Date Filed  File Name", which
 * contains neither "Company Name" nor "CIK", so offset detection bailed and the
 * function returned []. The offsets do not line up with the data even when the
 * header is joined — "Company Name" sits at column 12 and the names start at 17.
 *
 * Every row ends in `edgar/data/{cik}/{accession}.txt`, and that is a far better
 * anchor than any column: it carries the FILER's cik and the accession
 * unambiguously and cannot drift. Checked against the whole of 2026-08-14 —
 * 11,140 rows — the path's cik equals the CIK column on every single one.
 *
 * (Not to be confused with taking the cik from the ACCESSION, which is wrong:
 * the accession's first ten digits are the SUBMITTER, often a filing agent. It
 * is the `data/{cik}/` directory segment that identifies the filer.)
 *
 * One daily file covers EVERY filer: 2026-08-14 contained 1,784 13F-HR + 51
 * 13F-HR/A + 767 13F-NT in a single request. That is the entire global feed for
 * one day at a cost of one request — which is what makes the SEC 403 risk
 * manageable.
 */
const IDX_PATH = /(?:^|\s)(edgar\/data\/(\d{1,10})\/(\d{10}-\d{2}-\d{6})\.[A-Za-z0-9]+)\s*$/;

export function parseFormIdx(text) {
  const lines = String(text).split(/\r?\n/);
  // Skip the preamble when there is a rule line, but do not REQUIRE one: a row
  // has to start with a 13F form type and end with an archive path, and no
  // header line can do both.
  const ruleIdx = lines.findIndex((l) => /^-{10,}/.test(l));
  const body = ruleIdx >= 0 ? lines.slice(ruleIdx + 1) : lines;

  const seen = new Set();
  const out = [];
  for (const line of body) {
    if (!line.trim()) continue;
    const formType = (/^(\S+)/.exec(line) ?? [])[1] ?? "";
    if (!FORM_TYPES.has(formType)) continue;

    const p = IDX_PATH.exec(line);
    if (!p) continue;
    const [, path, cikRaw, accession] = p;

    // Everything between the form type and the path: the company name, the CIK
    // column and the filing date, in that order, separated by runs of spaces.
    //
    // Sliced at the MATCH INDEX, not at `length - path.length`: EDGAR pads these
    // rows with trailing spaces, so counting back from the end of the line lands
    // inside the path and hands the whole row back as the company name.
    const middle = line.slice(formType.length, p.index).trim();
    const tail = /^(.*?)\s+(\d{1,10})\s+(\d{4}-?\d{2}-?\d{2})$/.exec(middle);

    // Index files contain byte-identical duplicate rows. Verified: Kingdon
    // Capital's 2026-05-15 13F-HR appears twice.
    const key = `${accession}|${cikRaw}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      form_type: formType,
      company_name: tail ? tail[1].trim() : middle,
      cik: cikRaw.padStart(10, "0"),
      filing_date: tail ? normalizeDate(tail[3]) : null,
      accession_number: accession,
      path,
    });
  }
  return out;
}

/** Pipe-delimited master.idx — preferred over form.idx where both exist. */
export function parseMasterIdx(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => /^-{10,}/.test(l));
  const body = start >= 0 ? lines.slice(start + 1) : lines;

  const seen = new Set();
  const out = [];
  for (const line of body) {
    const f = line.split("|");
    if (f.length < 5) continue;
    const formType = f[2].trim();
    if (!FORM_TYPES.has(formType)) continue;
    const accession = accessionFromPath(f[4].trim());
    if (!accession || seen.has(accession)) continue;
    seen.add(accession);
    out.push({
      cik: f[0].trim().padStart(10, "0"),
      company_name: f[1].trim(),
      form_type: formType,
      filing_date: normalizeDate(f[3].trim()),
      accession_number: accession,
      path: f[4].trim(),
    });
  }
  return out;
}

/**
 * "edgar/data/1350694/0001350694-26-000002.txt" -> "0001350694-26-000002".
 *
 * IMPORTANT: never derive the filer's CIK from an accession number. The first
 * 10 digits are the SUBMITTER, which is frequently a third-party filer agent.
 * Bridgewater's 2025-Q3 filing is 0001172661-25-004777 — that prefix is the
 * agent; Bridgewater is 1350694. Cantillon's restatements were filed under
 * 0000899140-, which is why amendment discovery must use the submissions API
 * rather than an accession-prefix scan.
 */
export function accessionFromPath(path) {
  const m = /(\d{10}-\d{2}-\d{6})/.exec(String(path));
  return m ? m[1] : null;
}

/**
 * `filings.recent` from the submissions API is a COLUMNAR structure — parallel
 * arrays, not a list of objects. It also truncates at ~1,000 filings; overflow
 * lives in `filings.files` shards, which must be followed for prolific filers
 * (State Street had 1,018 recent plus 3 shards). Bridgewater's `files` is
 * empty, so this is easy to miss in testing.
 */
export function parseSubmissions(json) {
  const recent = json?.filings?.recent ?? {};
  const n = recent.accessionNumber?.length ?? 0;
  const filings = [];
  for (let i = 0; i < n; i++) {
    const form = recent.form[i];
    if (!form || !form.startsWith("13F")) continue;
    filings.push({
      accession_number: recent.accessionNumber[i],
      form_type: form,
      filing_date: recent.filingDate[i],
      period_end: recent.reportDate[i],
      acceptance_datetime: recent.acceptanceDateTime?.[i] ?? null,
      primary_document: recent.primaryDocument?.[i] ?? null,
      size: recent.size?.[i] ?? null,
    });
  }
  return {
    cik: String(json?.cik ?? "").padStart(10, "0"),
    name: json?.name ?? null,
    // For 13F filers entityType is "other" and sic / tickers / exchanges /
    // category are typically empty. Do not rely on them.
    formerNames: json?.formerNames ?? [],
    businessState: json?.addresses?.business?.stateOrCountry ?? null,
    stateOfIncorporation: json?.stateOfIncorporation ?? null,
    filings,
    overflowShards: (json?.filings?.files ?? []).map((f) => f.name),
  };
}
