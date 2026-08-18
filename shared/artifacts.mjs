// shared/artifacts.mjs
//
// The artifact contract: every path, envelope and size rule for the static
// files that ARE this product's database.
//
// Imported by the ingest scripts (which write) and the frontend (which reads),
// so a path can never drift between the two.
//
// ---------------------------------------------------------------------------
// WHY FILES INSTEAD OF A DATABASE
// ---------------------------------------------------------------------------
// 13F is quarterly, immutable once filed, and this dashboard asks a fixed set
// of questions. There is no reason to answer them at request time. The pipeline
// works every answer out on the runner — where there is no CPU limit — and
// writes it as a plain JSON file. The browser fetches the one file it needs
// straight off the CDN edge, which compresses it in transit.
//
// That is why the whole product runs on free tiers: R2 gives 10 GB with no
// egress charge, and there is no server to bill. It is also simply faster than
// a database that has to think, and there is nothing to fall over during the
// deadline-day burst.
//
// The cost is that every question must be decided in advance. Adding a new view
// means adding a new artifact and a backfill, not writing a query.

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
//
//   manifest.json                        pointer to the current build (NOT immutable)
//   meta/filers.json                  every filer: cik, name, code  (fund search)
//   meta/periods.json                 periods that exist, deadlines, filing counts
//   period/{period}/filings.json      one row per filing that quarter (the feed)
//   period/{period}/leaderboard.json  most-owned / biggest buys+sells, all filers
//   period/{period}/sectors.json      sector totals across all filers
//   fund/{cik}/summary.json           all-time series + activity for one fund
//   fund/{cik}/{period}.json          holdings + QoQ changes for one fund-quarter
//   fund/{cik}/{period}.p{n}.json     paged, for funds too large for one file
//   security/{issuerId}/{period}.json who holds it, across all filers
//
// EVERYTHING except manifest.json is immutable for a given build id. That is
// what allows `Cache-Control: public, max-age=31536000, immutable` and means a
// fund-quarter is fetched once, ever.

export const ARTIFACT_VERSION = 1;

/** Only this file is ever re-read. Keep it small and short-cached. */
export const MANIFEST_PATH = "manifest.json";

export const paths = {
  manifest: () => MANIFEST_PATH,
  filers: () => "meta/filers.json",
  periods: () => "meta/periods.json",
  // One file carrying the value/position series for EVERY filer.
  //
  // Replaces ~8,500 individual summary.json files, which cost 33 MB and 8,500
  // requests-worth of objects for ONE quarter and would have multiplied by every
  // quarter of history added. The same information keyed compactly in a single
  // file is a few MB, is fetched once, and makes history affordable for the whole
  // universe rather than just the funds whose line items we store.
  series: () => "meta/series.json",
  periodFilings: (period) => `period/${period}/filings.json`,
  periodLeaderboard: (period) => `period/${period}/leaderboard.json`,
  periodSectors: (period) => `period/${period}/sectors.json`,
  fundSummary: (cik) => `fund/${cik}/summary.json`,
  fundPeriod: (cik, period, page = 0) =>
    page > 0 ? `fund/${cik}/${period}.p${page}.json` : `fund/${cik}/${period}.json`,
  security: (issuerId, period) => `security/${issuerId}/${period}.json`,
};

/**
 * Rows per holdings page.
 *
 * Most managers fit in one file — the median 13F has a few hundred positions.
 * Citadel does not: 15,589 rows aggregating to ~12,900 positions, which would
 * be a multi-megabyte download for a browser that only renders 50 of them
 * above the fold. Paging keeps the first paint fast and lets the rest stream in
 * behind it.
 */
export const ROWS_PER_PAGE = 2000;

/**
 * Every artifact carries its own provenance.
 *
 * This is not decoration. The dashboard's rule is that it never invents
 * freshness: a file fetched a second ago may describe positions from four and a
 * half months back. `asOf` (the period end) and `acceptedAt` (when the SEC
 * actually received the filing) travel WITH the data so no widget can render a
 * number without being able to say when it was true.
 */
export function envelope({ kind, period, cik, asOf, acceptedAt, buildId, data, extra = {} }) {
  return {
    v: ARTIFACT_VERSION,
    kind,
    buildId,
    ...(period ? { period } : {}),
    ...(cik ? { cik } : {}),
    ...(asOf ? { asOf } : {}),
    ...(acceptedAt ? { acceptedAt } : {}),
    generatedAt: new Date().toISOString(),
    ...extra,
    data,
  };
}

/**
 * Column-oriented encoding for holdings.
 *
 * A 12,900-position fund as an array of objects repeats every key 12,900 times.
 * Storing parallel arrays instead cuts the payload roughly in half before
 * compression and measurably more after, because each column compresses against
 * itself rather than against interleaved noise. The browser rehydrates in one pass.
 */
export const HOLDING_COLUMNS = [
  "ticker",       // resolved; null until enrichment runs
  "name",         // issuer name as filed
  "issuerId",     // overlap is computed on THIS, never on the share class
  "cls",          // title of class
  "type",         // "" long | "Put" | "Call"
  "unit",         // SH | PRN
  "value",        // USD, normalized at ingest
  "shares",
  "weight",       // % of LONG equity — never a mixed denominator
  "price",        // implied: value / shares, long SH rows only
  "action",       // NEW | ADDED | HELD | TRIMMED | EXITED
  "dShares",
  "dSharesPct",   // null when suppressed
  "dValue",
  "dValuePct",
  "dWeightPp",    // percentage POINTS
  "flags",
];

// NOTE: `cusip` is deliberately absent from HOLDING_COLUMNS.
// CUSIP identifiers are proprietary (ABA, licensed via CGS/S&P). They are an
// internal join key only, resolved to issuerId and ticker at ingest and never
// written to an artifact. Because the frontend reads only artifacts, and the
// CSV export reuses the same view-model, a leak is structurally impossible
// rather than policy-dependent. `npm run guard` enforces it.

export function encodeHoldings(rows) {
  const cols = {};
  for (const c of HOLDING_COLUMNS) cols[c] = new Array(rows.length);
  rows.forEach((r, i) => {
    for (const c of HOLDING_COLUMNS) cols[c][i] = r[c] ?? null;
  });
  return { n: rows.length, cols: HOLDING_COLUMNS, ...cols };
}

export function decodeHoldings(enc) {
  if (!enc || !enc.n) return [];
  const out = new Array(enc.n);
  for (let i = 0; i < enc.n; i++) {
    const row = {};
    for (const c of enc.cols) row[c] = enc[c]?.[i] ?? null;
    out[i] = row;
  }
  return out;
}

/**
 * The manifest is the ONLY mutable file, and it is what makes late amendments
 * safe.
 *
 * Amendments arrive up to ~29 months after the fact, so artifacts must be
 * replaceable without breaking immutable caching. Each build gets an id; the
 * manifest maps a logical path to the build that last touched it. A reader
 * loads the manifest (short cache), then fetches artifacts with `?b={buildId}`
 * (forever cache). A restated fund-quarter gets a new buildId on that one path
 * and every other file stays in cache.
 */
export function manifest({ buildId, periods, funds, coverage, counts, notes = [], notesOf = 0 }) {
  return {
    v: ARTIFACT_VERSION,
    buildId,
    generatedAt: new Date().toISOString(),
    coverage,   // { from, to, holdingsFrom }
    periods,    // [{ period, deadline, filings, funds, buildId }]
    funds,      // { [cik]: buildId } — only entries that differ from the root build
    counts,     // { filers, filings, holdings }
    notes,      // the list, capped for size by the merge
    // The COUNT and its DENOMINATOR, so a reader can tell a rate from a number.
    //
    // `notes` alone cannot answer "is this a lot?". Sixty-one unreconciled
    // filings is an incident in a thirteen-fund run and unremarkable in a
    // five-hundred-fund one, and the staleness watchdog graded the raw length —
    // so the moment the ingest started covering the real universe it began
    // alerting every single day about the world being ordinarily messy, which is
    // how an alert gets ignored.
    notesTotal: notes.length,
    notesOf,    // fund-quarters examined to produce them
  };
}

/** Resolve a logical path to a cache-busted URL for the build that owns it. */
export function artifactUrl(base, path, mf, cik = null) {
  const build = (cik && mf?.funds?.[cik]) || mf?.buildId || "0";
  const sep = base.endsWith("/") ? "" : "/";
  return `${base}${sep}${path}?b=${build}`;
}

/**
 * Cache policy. Two classes and no third:
 *   manifest  60s — the only file that ever changes in place
 *   artifact  1 year immutable — the buildId query param is the cache key
 */
export const CACHE_CONTROL = {
  manifest: "public, max-age=60, must-revalidate",
  artifact: "public, max-age=31536000, immutable",
};

// ---------------------------------------------------------------------------
// WHY ARTIFACTS ARE NOT PRE-COMPRESSED
//
// They used to be written as .json.gz with `Content-Encoding: gzip` set in
// _headers. That does not survive Cloudflare: the CDN compresses responses
// itself, so it gzipped the already-gzipped body and set the header once. The
// browser decompressed a single layer, handed the inner gzip bytes to
// JSON.parse, and every widget failed with `Unexpected token '\u001f'`.
//
// Serving plain JSON and letting Cloudflare compress in transit is simpler AND
// smaller on the wire — the CDN negotiates brotli, which beats our gzip. The
// only cost is a larger file in git, which is acceptable at this scale and is
// the right trade for something that cannot silently break.
//
// The lesson generalises: do not hand-manage Content-Encoding behind a CDN that
// manages it for you.
// ---------------------------------------------------------------------------

/** Deterministic short build id from the highest acceptance timestamp seen. */
export function buildIdFrom(latestAcceptance, salt = "") {
  const s = `${latestAcceptance || ""}|${salt}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36).padStart(7, "0").slice(0, 7);
}
