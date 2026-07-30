// src/lib/data.ts
//
// The data layer. There is no API and no database — the pipeline pre-computes
// every answer into an immutable JSON file, and this module fetches the one a
// view needs straight off the CDN edge.
//
// Artifacts are NOT pre-compressed. Cloudflare compresses in transit, and
// shipping pre-gzipped bodies behind it produced double-encoded responses that
// reached JSON.parse as raw gzip bytes.
//
// Two cache classes and no third:
//   manifest.json   60s, the only file that ever changes in place
//   everything else forever, keyed by the ?b={buildId} the manifest hands out
//
// Which is why a fund-quarter is downloaded once, ever, and why the whole
// product runs with no server and no bill.

const BASE = import.meta.env.BASE_URL + "data";

export interface Manifest {
  v: number;
  buildId: string;
  generatedAt: string;
  coverage: { from: string; to: string; holdingsFrom: string };
  periods: { period: string; label: string; deadline: string; filings: number; funds: number }[];
  funds: Record<string, string>;
  counts: { filers: number; filings: number; holdings: number };
  notes: string[];
}

export interface Filer {
  cik: string;
  name: string;
  code: string | null;
  state: string | null;
  periods: number;
  latestPeriod: string | null;
  latestValueUsd: number | null;
}

export interface FundPeriodMeta {
  priorState: "PRIOR_OK" | "PRIOR_IS_NT" | "PRIOR_MISSING" | "NO_PRIOR";
  priorPeriod: string | null;
  deltasSuppressed: boolean;
  structuralEvent: string | null;
  structuralDetail: { message?: string; retained?: number; reductionPct?: number } | null;
  confidentialOmitted: boolean;
  foldWarnings: { code: string; detail: string }[];
  accessions: string[];
  value_long_usd: number;
  value_options_usd: number;
  value_prn_usd: number;
  positions_total: number;
  positions_long: number;
  positions_options: number;
  top10_weight_pct: number | null;
  reportedTotalUsd: number | null;
  n_new: number;
  n_added: number;
  n_held: number;
  n_trimmed: number;
  n_exited: number;
  turnover_position_pct: number | null;
  turnover_value_pct: number | null;
}

export interface Holding {
  ticker: string | null;
  name: string;
  issuerId: string;
  cls: string | null;
  type: string;        // "" long | Put | Call
  unit: string;        // SH | PRN
  value: number;
  shares: number;
  weight: number | null;
  price: number | null;
  action: "NEW" | "ADDED" | "HELD" | "TRIMMED" | "EXITED" | null;
  dShares: number | null;
  dSharesPct: number | null;
  dValue: number | null;
  dValuePct: number | null;
  dWeightPp: number | null;
  flags: string[] | null;
}

export interface Exit {
  ticker: string | null;
  name: string;
  issuerId: string;
  type: string;
  valuePrior: number;
  weightPrior: number | null;
}

export interface FundPeriod {
  period: string;
  cik: string;
  asOf: string;
  acceptedAt: string | null;
  page: number;
  pages: number;
  total: number;
  meta: FundPeriodMeta;
  exits?: Exit[];
  holdings: Holding[];
}

export interface FundSeriesPoint {
  period: string;
  label: string;
  reportedTotalUsd: number | null;
  valueLongUsd: number;
  valueOptionsUsd: number;
  positions: number;
  positionsLong: number;
  positionsOptions: number;
  top10WeightPct: number | null;
  n_new: number;
  n_added: number;
  n_held: number;
  n_trimmed: number;
  n_exited: number;
  turnover_position_pct: number | null;
  turnover_value_pct: number | null;
  priorState: string;
  deltasSuppressed: boolean;
  structuralEvent: string | null;
  confidentialOmitted: boolean;
  pages: number;
  acceptedAt: string | null;
  filingLagDays: number | null;
}

export interface FundSummary {
  cik: string;
  name: string;
  code: string | null;
  formerNames: unknown[];
  state: string | null;
  series: FundSeriesPoint[];
}

export interface FilingRow {
  cik: string;
  fund: string;
  code: string | null;
  accession: string;
  form: string;
  filed: string;
  accepted: string | null;
  positions: number;
  rawRows: number;
  value: number | null;
  amendment: string | null;
  amendmentNo: number | null;
  confidentialOmitted: boolean;
  reconciles: boolean | null;
  quarantined: boolean;
  notice: boolean;
}

export class DataError extends Error {
  constructor(public path: string, public status: number) {
    super(`Could not load ${path} (${status})`);
    this.name = "DataError";
  }
}

/**
 * A missing artifact is a NORMAL, expected state, not a failure.
 *
 * During filing season most managers simply have not filed the newest quarter
 * yet — on 2026-07-29 roughly 3,200 of ~9,300 filers had, so two thirds of
 * fund-quarter lookups legitimately have nothing behind them. The UI must say
 * "this manager hasn't filed yet" rather than surfacing a fetch error.
 */
export class MissingArtifactError extends DataError {
  constructor(path: string) {
    super(path, 404);
    this.name = "MissingArtifactError";
  }
}

let manifestPromise: Promise<Manifest> | null = null;

export function loadManifest(force = false): Promise<Manifest> {
  if (force) manifestPromise = null;
  if (!manifestPromise) {
    manifestPromise = fetch(`${BASE}/manifest.json`, { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new DataError("manifest.json", r.status);
      return r.json() as Promise<Manifest>;
    });
  }
  return manifestPromise;
}

// In-process memo. The HTTP cache already prevents refetching; this prevents
// re-parsing the same JSON when several widgets on one screen want the same
// fund-quarter.
const memo = new Map<string, Promise<unknown>>();

async function get<T>(path: string, mf: Manifest, cik?: string): Promise<T> {
  const build = (cik && mf.funds[cik]) || mf.buildId;
  const url = `${BASE}/${path}?b=${build}`;
  let p = memo.get(url) as Promise<T> | undefined;
  if (!p) {
    p = fetch(url).then((r) => {
      if (r.status === 404) throw new MissingArtifactError(path);
      if (!r.ok) throw new DataError(path, r.status);
      // A single-page app's host serves index.html for any unmatched path
      // rather than a 404 — true of the Vite dev server and of Cloudflare Pages
      // with an SPA fallback. Without this check a missing artifact surfaces as
      // `Unexpected token '<'`, which reads as a broken product when the real
      // answer is "this manager has not filed that quarter yet".
      const ct = r.headers.get("content-type") ?? "";
      if (ct.includes("text/html")) throw new MissingArtifactError(path);
      // Plain JSON. The CDN negotiates its own compression and the browser
      // has already decoded it, so there is nothing to inflate here.
      return r.json() as Promise<T>;
    });
    memo.set(url, p as Promise<unknown>);
    p.catch(() => memo.delete(url)); // never memoize a failure
  }
  return p;
}

/** Rehydrate the column-oriented holdings encoding into rows. */
function decodeHoldings(enc: Record<string, unknown> & { n: number; cols: string[] }): Holding[] {
  if (!enc || !enc.n) return [];
  const out: Holding[] = new Array(enc.n);
  for (let i = 0; i < enc.n; i++) {
    const row: Record<string, unknown> = {};
    for (const c of enc.cols) row[c] = (enc[c] as unknown[])?.[i] ?? null;
    out[i] = row as unknown as Holding;
  }
  return out;
}

export async function loadFilers(mf: Manifest): Promise<Filer[]> {
  const env = await get<{ data: Filer[] }>("meta/filers.json", mf);
  return env.data;
}

export async function loadPeriods(mf: Manifest) {
  const env = await get<{ data: Manifest["periods"] }>("meta/periods.json", mf);
  return env.data;
}

export async function loadFundSummary(cik: string, mf: Manifest): Promise<FundSummary> {
  const env = await get<{ cik: string; name: string; code: string | null; formerNames: unknown[]; state: string | null; data: { series: FundSeriesPoint[] } }>(
    `fund/${cik}/summary.json`, mf, cik,
  );
  return { cik: env.cik, name: env.name, code: env.code, formerNames: env.formerNames, state: env.state, series: env.data.series };
}

/**
 * Load one fund-quarter.
 *
 * `page` exists because Citadel aggregates to ~12,900 positions while the
 * median manager has a few hundred. Page 0 carries the first screenful plus all
 * the metadata; the rest streams in behind it only if the user scrolls.
 */
export async function loadFundPeriod(cik: string, period: string, mf: Manifest, page = 0): Promise<FundPeriod> {
  const path = page > 0 ? `fund/${cik}/${period}.p${page}.json` : `fund/${cik}/${period}.json`;
  const env = await get<{
    period: string; cik: string; asOf: string; acceptedAt: string | null;
    page: number; pages: number; total: number; meta: FundPeriodMeta; exits?: Exit[];
    data: Record<string, unknown> & { n: number; cols: string[] };
  }>(path, mf, cik);

  return {
    period: env.period, cik: env.cik, asOf: env.asOf, acceptedAt: env.acceptedAt,
    page: env.page, pages: env.pages, total: env.total,
    meta: env.meta, exits: env.exits,
    holdings: decodeHoldings(env.data),
  };
}

/** All pages of a fund-quarter, for the consensus join and CSV export. */
export async function loadFundPeriodAll(cik: string, period: string, mf: Manifest): Promise<FundPeriod> {
  const first = await loadFundPeriod(cik, period, mf, 0);
  if (first.pages <= 1) return first;
  const rest = await Promise.all(
    Array.from({ length: first.pages - 1 }, (_, i) => loadFundPeriod(cik, period, mf, i + 1)),
  );
  return { ...first, holdings: first.holdings.concat(...rest.map((r) => r.holdings)) };
}

export async function loadPeriodFilings(period: string, mf: Manifest): Promise<FilingRow[]> {
  const env = await get<{ data: FilingRow[] }>(`period/${period}/filings.json`, mf);
  return env.data;
}

/**
 * The period the dashboard should open on.
 *
 * NOT simply "the newest quarter that exists". A quarter that has just closed
 * has almost no filings in it, so defaulting there would show a near-empty
 * screen for six weeks of every quarter. Ingest fetches wide; display picks the
 * newest period that actually has enough data to be worth looking at, and the
 * quarter stepper lets the user move to the sparse newest one deliberately.
 */
export function defaultPeriod(mf: Manifest, quorum = 0.6): string {
  if (!mf.periods.length) return mf.coverage.to;

  // Require a QUORUM, not merely one filing.
  //
  // A quarter that closed weeks ago typically has a handful of early filers and
  // nothing else — during the 2026-Q2 window exactly one of eight tracked funds
  // had filed. Opening there gives a technically-correct but useless screen: no
  // overlap is computable from one fund, and the cross-fund view reads as
  // broken rather than as early. Landing on the newest quarter where most funds
  // have reported is the honest default, and the quarter stepper still lets the
  // user walk forward into the sparse one deliberately.
  const peak = Math.max(...mf.periods.map((p) => p.funds));
  const threshold = Math.max(1, Math.floor(peak * quorum));
  const eligible = mf.periods.filter((p) => p.funds >= threshold);
  const pool = eligible.length ? eligible : mf.periods;
  return pool.reduce((best, p) => (p.period > best.period ? p : best), pool[0]).period;
}

/** SEC EDGAR link for a filing — the citation behind every number on screen. */
export function edgarUrl(cik: string, accession: string): string {
  const bare = String(Number(cik.replace(/\D/g, "")));
  return `https://www.sec.gov/Archives/edgar/data/${bare}/${accession.replace(/-/g, "")}/${accession}-index.htm`;
}
