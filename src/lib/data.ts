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

// Where artifacts are served from.
//
//   VITE_DATA_BASE unset  -> "<base>/data", the committed tree (dev, and a
//                            working fallback if R2 is not configured)
//   VITE_DATA_BASE set    -> an absolute R2 custom-domain origin, e.g.
//                            "https://data.example.com"
//
// R2 is the production home: 10 GB free with free egress, so a fund's book costs
// nothing to serve however often it is read, and the artifacts stay out of git
// history where a quarterly refresh would otherwise compound forever.
const DATA_BASE = import.meta.env.VITE_DATA_BASE as string | undefined;
const BASE = DATA_BASE ? DATA_BASE.replace(/\/$/, "") : import.meta.env.BASE_URL + "data";

export interface Manifest {
  v: number;
  buildId: string;
  generatedAt: string;
  coverage: { from: string; to: string; holdingsFrom: string };
  periods: {
    period: string;
    label: string;
    deadline: string;
    /** Filings we HOLD for this quarter. */
    filings: number;
    /** Managers we HOLD a filing from for this quarter. */
    funds: number;
    /**
     * Managers who have actually filed for this quarter, counted from EDGAR's
     * daily indexes rather than from anything we hold.
     *
     * The difference between this and `funds` is the only honest way to say
     * "still loading" — without it the Filings view subtracted what we held from
     * the whole filer universe and called the remainder "outstanding", which
     * told a client that 9,255 managers had not filed on a day when they had.
     *
     * Absent on quarters published before this existed, and on quarters the
     * monthly universe run rebuilt; treat undefined as "no opinion", never as 0.
     */
    known?: number;
    knownAsOf?: string | null;
  }[];
  funds: Record<string, string>;
  /**
   * Cache keys for SHARED artifacts the same-day job rewrites in place, keyed by
   * artifact path. Same mechanism as `funds`, one level up — see `get()`.
   * Absent on manifests published before this existed; `buildId` is the fallback.
   */
  shared?: Record<string, string>;
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
  hasHoldings?: boolean;
  /** In the curated active-manager comparison set. */
  watch?: boolean;
}

export interface FundPeriodMeta {
  priorState: "PRIOR_OK" | "PRIOR_IS_NT" | "PRIOR_MISSING" | "NO_PRIOR";
  priorPeriod: string | null;
  deltasSuppressed: boolean;
  structuralEvent: string | null;
  structuralDetail: { message?: string; retained?: number; reductionPct?: number } | null;
  confidentialOmitted: boolean;
  /**
   * Exits NOT emitted because the filer withheld positions under a confidential
   * treatment request. On such a quarter an absent position is indistinguishable
   * from a sold one, so none are published — this is how many were suppressed,
   * so the UI can say so instead of showing a silently shorter list.
   */
  exitsWithheld?: number;
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
  /**
   * SH or PRN. Optional because artifacts written before this field existed do
   * not carry it — and the safe reading of "unknown" is SH, since wrongly
   * hiding an equity exit is a far worse error than wrongly showing a bond.
   * Exact for every artifact the ingest has rewritten since.
   */
  unit?: string;
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
  /** False when this fund-quarter's holdings are outside the stored set. */
  hasHoldings?: boolean;
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
    // THE MANIFEST IS ON THE CRITICAL PATH FOR EVERYTHING.
    //
    // Every artifact URL carries ?b={buildId} from this file, so nothing else
    // can even be requested until it resolves. Measured on the live site: 740ms
    // for the manifest against 8ms for each artifact behind it — the whole
    // first-paint delay was one blocking round trip, not the data.
    //
    // The cause was `cache: "no-cache"`, which forces revalidation on every
    // load and defeats the 60s max-age the file is already published with. That
    // header is the correct freshness policy and it is enforced by R2 at the
    // origin; asking the browser to ignore it bought nothing but latency. A
    // reload inside a minute is now instant, and `force` — the refresh button —
    // still bypasses the cache entirely when the user explicitly asks.
    manifestPromise = fetch(
      `${BASE}/manifest.json`,
      force ? { cache: "reload" } : undefined,
    ).then((r) => {
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
  // WHICH CACHE KEY THIS FILE IS ON.
  //
  //   funds[cik]    a fund the same-day job refreshed
  //   shared[path]  a shared file it rewrote — the quarter feed, the filer index
  //   buildId       everything else, i.e. whatever the universe run last built
  //
  // The middle one was missing, and its absence made a whole class of update
  // invisible. Artifacts are published `max-age=31536000, immutable`, and the
  // same-day job is structurally forbidden from bumping `buildId` (the merge
  // rejects a publish that changes it, because moving the global key would bust
  // the cache for 9,300 funds to publish an update to one). So the quarter's
  // filings feed was rewritten in place at a URL that never changed: a visitor
  // who had loaded the site once kept the year-old copy for a year, however many
  // filings landed after it. First load looked perfect, which is why it survived.
  const build = (cik && mf.funds[cik]) || mf.shared?.[path] || mf.buildId;
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
    // KEEP "this does not exist" — it is an ANSWER, not a failure.
    //
    // A manager who did not file a quarter has no artifact, and the SPA host
    // answers the request with index.html, which `get` turns into a
    // MissingArtifactError. Evicting that alongside real failures meant every
    // not-filed lookup was refetched on every mount, forever: measured at 47
    // requests on each return to the Consensus tab, all of them re-asking a
    // question whose answer cannot change until the build id does — and the
    // build id is in the URL, so a new build gets a new key anyway.
    //
    // During filing season most fund-quarters are in exactly this state, so
    // this was the common path, not an edge case.
    //
    // A genuine failure (5xx, a dropped connection) IS still evicted, so a
    // refresh can retry it.
    p.catch((e) => {
      if (!(e instanceof MissingArtifactError)) memo.delete(url);
    });
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

/**
 * Series for EVERY filer, from one shared file.
 *
 * Fetched once and memoised. This exists so history is available for the whole
 * universe: writing ~8,500 individual summary files cost 33 MB for a single
 * quarter and would have multiplied by every quarter added, whereas the same
 * information keyed compactly is a few MB.
 */
// The tuple column order, from shared/series-fields.mjs — the single definition
// the ingest also publishes. Two hand-maintained copies drifted once already.
import { SERIES_FIELDS } from "../../shared/series-fields.mjs";

interface SeriesRow { cik: string; name: string; state: string | null; hasHoldings: boolean; s: unknown[][] }
let seriesIndex: Promise<Map<string, SeriesRow>> | null = null;

function loadSeriesIndex(mf: Manifest): Promise<Map<string, SeriesRow>> {
  if (!seriesIndex) {
    seriesIndex = get<{ data: SeriesRow[] }>("meta/series.json", mf)
      .then((env) => new Map(env.data.map((r) => [r.cik, r])))
      .catch(() => new Map<string, SeriesRow>()); // optional: older builds lack it
  }
  return seriesIndex;
}

/** Expand a compact tuple back into a FundSeriesPoint. */
function expandSeries(tuple: unknown[]): FundSeriesPoint {
  const o: Record<string, unknown> = {};
  SERIES_FIELDS.forEach((f, i) => { o[f] = tuple[i] ?? null; });
  const period = String(o.period);
  const q = Math.ceil(Number(period.slice(5, 7)) / 3);
  return {
    ...(o as unknown as FundSeriesPoint),
    label: `Q${q} ${period.slice(0, 4)}`,
    confidentialOmitted: o.confidentialOmitted === 1 || o.confidentialOmitted === true,
    hasHoldings: o.hasHoldings === 1 || o.hasHoldings === true,
    // RE-DERIVED ONLY WHERE THE COMPACT FORMAT PREDATES THE FIELD.
    //
    // `Boolean(structuralEvent)` is not the rule the ingest applies: it suppresses
    // for PRO_RATA_REDUCTION and UNIT_SCALE_CHANGE, and publishes a REVIEW-flagged
    // quarter with its deltas intact. Re-deriving here made this path disagree
    // with the fund's own summary.json about the same quarter, so which numbers a
    // reader saw depended on which artifact happened to answer.
    deltasSuppressed:
      o.deltasSuppressed == null
        ? Boolean(o.structuralEvent)
        : o.deltasSuppressed === 1 || o.deltasSuppressed === true,
    pages: 0,
    acceptedAt: null,
  };
}

/**
 * Sort a fund's series OLDEST-FIRST, whatever order the producer wrote it in.
 *
 * The two ingest paths disagreed. scripts/ingest-funds.mjs walks quarters newest
 * -> oldest and reverses, so it emits ascending; scripts/ingest-dera.mjs walks
 * them oldest -> newest and reverses, so it emits DEscending. Both call the
 * field `series` and neither records which way it runs, so the frontend had a
 * 50% chance of being right and — since the universe ingest is what serves
 * production — it was wrong. On screen that meant the reported-value bars ran
 * backwards in time, "most recent filing" named the OLDEST quarter, and a
 * quarter-on-quarter delta was computed against the quarter AFTER it.
 *
 * Sorting on arrival rather than trusting the producer fixes it for artifacts
 * already sitting in R2 — no re-ingest — and makes the frontend immune to
 * whichever order a future producer happens to pick. Ordering is cheap: a fund
 * carries at most a few dozen quarters.
 */
function ascendingByPeriod<T extends { period: string }>(series: T[]): T[] {
  return [...series].sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
}

export async function loadFundSummary(cik: string, mf: Manifest): Promise<FundSummary> {
  try {
    const env = await get<{ cik: string; name: string; code: string | null; formerNames: unknown[]; state: string | null; data: { series: FundSeriesPoint[] } }>(
      `fund/${cik}/summary.json`, mf, cik,
    );
    return {
      cik: env.cik, name: env.name, code: env.code, formerNames: env.formerNames, state: env.state,
      series: ascendingByPeriod(env.data.series ?? []),
    };
  } catch (e) {
    if (!(e instanceof MissingArtifactError)) throw e;
    // No dedicated file: this manager is outside the stored line-item set. Its
    // totals still exist in the shared index, so the Fund view can show the value
    // history and say plainly that holdings are not carried — rather than
    // claiming the fund never filed.
    const idx = await loadSeriesIndex(mf);
    const row = idx.get(cik);
    if (!row) throw e;
    return {
      cik, name: row.name, code: null, formerNames: [], state: row.state,
      series: ascendingByPeriod(row.s.map(expandSeries)),
    };
  }
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

/**
 * Warm a fund-quarter without rendering it.
 *
 * Everything a click on a favourite chip needs is one summary file plus page 0
 * of the book. Starting those on HOVER — a few hundred milliseconds before the
 * click lands — means the click resolves against the memo instead of the
 * network, which is the difference between "it loads quickly" and "it was
 * already there".
 *
 * Deliberately silent. A prefetch is a guess about what the user will do next;
 * if the guess is wrong, or the manager never filed, nothing should reach the
 * screen or the console. The real load repeats the same calls and handles its
 * own errors properly.
 */
export function prefetchFund(cik: string, period: string, mf: Manifest): void {
  void loadFundSummary(cik, mf).catch(() => {});
  void loadFundPeriod(cik, period, mf, 0).catch(() => {});
}

/** A quarter's feed, and — crucially — whether it is the WHOLE quarter. */
export interface PeriodFeed {
  rows: FilingRow[];
  /** Filings that exist for this quarter. */
  total: number;
  /** How many of them are in `rows`. Less than `total` means the list is a tail. */
  shown: number;
}

/**
 * The quarter's filing feed.
 *
 * RETURNS THE ENVELOPE, NOT JUST THE ROWS. The producers cap this file at 2,000
 * rows — a full season is ~10,700 filings and nobody scrolls past a few hundred —
 * and record the real count beside it. This function used to return `env.data`
 * and drop `total`/`shown`, so every consumer had to assume the list was the
 * whole quarter. The Filings view did assume it, subtracted the visible CIKs from
 * the entire filer universe, and printed the remainder under the heading
 * "Outstanding — managers with no filing". For Q1 2026 that named roughly 7,300
 * managers as not having filed when all of them had.
 */
export async function loadPeriodFilings(period: string, mf: Manifest): Promise<PeriodFeed> {
  const env = await get<{ data: FilingRow[]; total?: number; shown?: number }>(
    `period/${period}/filings.json`,
    mf,
  );
  const rows = env.data ?? [];
  return { rows, total: env.total ?? rows.length, shown: env.shown ?? rows.length };
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
export function defaultPeriod(mf: Manifest): string {
  if (!mf.periods.length) return mf.coverage.to;

  // THE NEWEST QUARTER ANYONE HAS FILED FOR. That is the whole rule.
  //
  // It used to demand a QUORUM — 60% of the busiest quarter's filer count —
  // which sounds prudent and measures the wrong population. This dashboard
  // compares thirteen managers; the threshold was computed against 10,753
  // universe filers. On 15 August, twelve of the fourteen tracked funds had
  // filed for Q2 2026 and the dashboard still opened on Q1, because 13 is 0.1%
  // of 10,753. The quarter the user came to look at was one click away and not
  // the one they landed on.
  //
  // Opening on an EMPTY quarter is the thing the quorum was guarding against,
  // and that cannot happen here: a period only appears in the manifest at all
  // once something has been filed for it. Between a quarter ending and its
  // deadline six weeks later, the new quarter simply is not in the list, so the
  // newest entry is still the last complete one. The guard was doing a job that
  // the data shape already does.
  //
  // Coverage is stated rather than hidden — the KPI row reads "12 of 14 · 2 not
  // yet filed" — so an early quarter is legible as early instead of looking
  // broken.
  return mf.periods.reduce((best, p) => (p.period > best.period ? p : best), mf.periods[0]).period;
}

/**
 * Which fund should the Fund view open on?
 *
 * `filers[0]` is not an answer. The filer index is ordered for lookup, not for
 * interest, and its first entry is a Vanguard entity whose last 13F was Q4
 * 2024 — so the dashboard's opening screen was an empty state reading "has not
 * filed for Q1 2026". A first impression should show the product working.
 *
 * The rule, in order:
 *   1. the largest CURATED manager with holdings in the opening quarter — these
 *      are the funds the comparison set is built around, so the Fund view opens
 *      on something the Consensus view also talks about;
 *   2. failing that, the largest filer with holdings in that quarter;
 *   3. failing that, anything at all, so this can never return null when a
 *      filer exists.
 *
 * Size is the tiebreak rather than alphabetical order because reported value is
 * the one ranking every user of a 13F product already has in their head.
 */
export function defaultFilerCik(filers: Filer[], period: string | null): string | null {
  if (!filers.length) return null;

  const usable = (f: Filer) =>
    f.hasHoldings !== false && (period === null || (f.latestPeriod !== null && f.latestPeriod >= period));
  const larger = (a: Filer, b: Filer) => ((b.latestValueUsd ?? 0) > (a.latestValueUsd ?? 0) ? b : a);

  const pick = (pool: Filer[]) => (pool.length ? pool.reduce(larger) : null);

  return (
    pick(filers.filter((f) => f.watch && usable(f)))?.cik ??
    pick(filers.filter(usable))?.cik ??
    filers[0].cik
  );
}

/** SEC EDGAR link for a filing — the citation behind every number on screen. */
export function edgarUrl(cik: string, accession: string): string {
  const bare = String(Number(cik.replace(/\D/g, "")));
  return `https://www.sec.gov/Archives/edgar/data/${bare}/${accession.replace(/-/g, "")}/${accession}-index.htm`;
}

// ---------------------------------------------------------------------------
// Sectors
// ---------------------------------------------------------------------------

export interface SectorFlow {
  sector: string;
  /** USD of stock actually bought — shares that moved, at period-end price. */
  bought: number;
  sold: number;
  net: number;
  /** USD held at period end, for context beside the flow. */
  held: number;
}

let sectorMapPromise: Promise<Record<string, string>> | null = null;

/**
 * ticker -> sector, for bucketing holdings the browser already has.
 *
 * The same map the ingest used for the universe aggregate, so the two scopes on
 * screen can never disagree about which sector a name is in. Optional by
 * design: a build published before sectors existed simply has no file, and the
 * views fall back to "Unclassified" rather than failing.
 */
export function loadSectorMap(mf: Manifest): Promise<Record<string, string>> {
  if (!sectorMapPromise) {
    sectorMapPromise = get<{ data: Record<string, string> }>("meta/sectors.json", mf)
      .then((env) => env.data ?? {})
      .catch(() => ({}));
  }
  return sectorMapPromise;
}

/** Universe-wide sector flows for one quarter, precomputed at ingest. */
export async function loadPeriodSectors(period: string, mf: Manifest): Promise<SectorFlow[]> {
  const env = await get<{ data: SectorFlow[] }>(`period/${period}/sectors.json`, mf);
  return env.data ?? [];
}
