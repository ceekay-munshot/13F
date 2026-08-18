// shared/manifest-merge.mjs
//
// Merge a same-day watchlist ingest into the live universe manifest.
//
// WHY THIS EXISTS
// ---------------
// Two jobs publish to the same bucket. The monthly DERA job knows about every
// one of ~9,300 filers; the same-day job knows about a handful it just pulled
// from EDGAR. They share `manifest.json`, and the same-day job used to WRITE it
// wholesale — so every run replaced a manifest describing the universe with one
// describing twelve funds. That is why its schedule was switched off, and it is
// the one thing that must not happen again.
//
// So the same-day job no longer writes a manifest. It merges into the live one,
// and the merge is the safety mechanism rather than a convenience:
//
//   THE LIVE MANIFEST IS THE BASE, NOT THE INCOMING ONE. Everything starts from
//   what is already published; the incoming run may only ADD.
//
//   NOTHING SHRINKS. Filer counts, period counts, per-period filing counts and
//   the covered range can only grow. A same-day run that saw 13 funds cannot
//   overwrite a period the universe filled with 10,648.
//
//   THE GLOBAL BUILD ID IS NOT TOUCHED. Every artifact URL carries
//   ?b={mf.funds[cik] ?? mf.buildId}, so bumping the global id would bust the
//   cache for all 9,300 funds to publish an update to one. Instead the run
//   stamps ONLY the funds it refreshed into the per-fund map — a mechanism the
//   schema has always had and neither job ever populated.
//
// The result: publishing one fund invalidates one fund.

/** A period entry keyed for comparison. */
const byPeriod = (list) => new Map((list ?? []).map((p) => [p.period, p]));

/**
 * Rows kept in a quarter's filings feed.
 *
 * Matches the cap the universe run applies for the same reason: the feed is what
 * the Filings view renders, nobody scrolls past a few hundred rows, and a full
 * season is ~10,700 filings. The count of what exists travels alongside as
 * `total`, so capping the list never means understating the quarter.
 */
export const FEED_ROWS = 2000;

/**
 * @param {object} live      the manifest currently published (authoritative)
 * @param {object} incoming  the manifest the same-day run just built locally
 * @param {{ buildId: string, ciks: string[], periodTotals?: Record<string, {filings?: number, funds?: number, known?: number, knownAsOf?: string|null}> }} opts
 *   `periodTotals` is the ACCUMULATED truth for a period, taken from the merged
 *   filings feed rather than from this run's sample. Without it a backfill run
 *   that publishes 450 filings into a quarter that already held 450 reports
 *   `max(450, 450) = 450` forever, so the dashboard's count of a quarter would
 *   freeze at one run's worth while the data behind it kept growing — which is
 *   also the number the staleness watchdog grades, so it would alert for ever.
 * @returns {{ manifest: object, changed: boolean, newPeriods: string[] }}
 */
export function mergeManifest(live, incoming, { buildId, ciks, periodTotals = {} }) {
  if (!live || typeof live !== "object" || !Array.isArray(live.periods)) {
    throw new Error("live manifest is missing or malformed — refusing to merge");
  }
  if (!buildId) throw new Error("a build id is required to stamp refreshed funds");
  if (!Array.isArray(ciks) || ciks.length === 0) {
    throw new Error("no funds were ingested — refusing to publish a manifest");
  }

  const merged = {
    ...live,
    // Deliberately NOT incoming.buildId. See the header.
    buildId: live.buildId,
    funds: { ...(live.funds ?? {}) },
  };

  // Per-fund cache keys for exactly the funds this run refreshed.
  for (const cik of ciks) merged.funds[cik] = buildId;

  // Periods: union, taking the LARGER count on any period both know about. A
  // same-day run reports a handful of filings for a quarter the universe has
  // fully covered, and that is not a correction, it is a smaller sample.
  const livePeriods = byPeriod(live.periods);
  const newPeriods = [];
  for (const p of incoming?.periods ?? []) {
    const totals = periodTotals[p.period] ?? {};
    const existing = livePeriods.get(p.period);
    if (!existing) {
      livePeriods.set(p.period, { ...p, ...pick(totals) });
      newPeriods.push(p.period);
      continue;
    }
    livePeriods.set(p.period, {
      ...existing,
      // Prefer the accumulated total from the merged feed; fall back to the
      // larger of the two samples when this run could not read the feed.
      filings: Math.max(existing.filings ?? 0, p.filings ?? 0, totals.filings ?? 0),
      funds: Math.max(existing.funds ?? 0, p.funds ?? 0, totals.funds ?? 0),
      ...pick(totals),
    });
  }
  merged.periods = [...livePeriods.values()].sort((a, b) => b.period.localeCompare(a.period));

  // Coverage can only widen.
  const newest = merged.periods[0]?.period ?? live.coverage?.to;
  const oldest = merged.periods.at(-1)?.period ?? live.coverage?.from;
  merged.coverage = {
    ...live.coverage,
    to: max(live.coverage?.to, newest),
    from: min(live.coverage?.from, oldest),
  };

  // Counts can only grow. The same-day run has no opinion on how many filers
  // exist in the world; it only ever saw its own watchlist.
  merged.counts = {
    ...live.counts,
    filers: Math.max(live.counts?.filers ?? 0, 0),
    filings: Math.max(live.counts?.filings ?? 0, 0),
    holdings: Math.max(live.counts?.holdings ?? 0, 0),
  };

  merged.generatedAt = incoming?.generatedAt ?? live.generatedAt;

  return { manifest: merged, changed: true, newPeriods };
}

const max = (a, b) => (a && b ? (a > b ? a : b) : a || b);
const min = (a, b) => (a && b ? (a < b ? a : b) : a || b);

/**
 * The coverage fields a period row carries forward.
 *
 * `known` is how many managers EDGAR has published for the quarter, measured
 * from its daily indexes. It is not a count of anything we hold, which is
 * exactly why it is worth carrying: it is the only honest denominator for "how
 * much of this quarter is actually on the dashboard yet".
 */
function pick(totals) {
  const out = {};
  if (totals.known != null) {
    out.known = totals.known;
    out.knownAsOf = totals.knownAsOf ?? null;
  }
  return out;
}

/**
 * Refuse to publish a merge that lost something.
 *
 * Belt and braces over mergeManifest's own rules: this is what stands between a
 * logic slip and a live dashboard that has forgotten 9,000 managers. It compares
 * the OUTPUT against the live input and throws on any regression.
 *
 * @returns {string[]} human-readable reasons, empty when safe
 */
export function verifyMerge(live, merged) {
  const problems = [];
  const at = (m, k) => m?.counts?.[k] ?? 0;

  for (const k of ["filers", "filings", "holdings"]) {
    if (at(merged, k) < at(live, k)) {
      problems.push(`counts.${k} would drop from ${at(live, k)} to ${at(merged, k)}`);
    }
  }
  if ((merged.periods?.length ?? 0) < (live.periods?.length ?? 0)) {
    problems.push(`period count would drop from ${live.periods.length} to ${merged.periods?.length ?? 0}`);
  }
  const m = byPeriod(merged.periods);
  for (const p of live.periods ?? []) {
    const after = m.get(p.period);
    if (!after) { problems.push(`period ${p.period} would disappear`); continue; }
    if ((after.filings ?? 0) < (p.filings ?? 0)) {
      problems.push(`${p.period} filings would drop from ${p.filings} to ${after.filings}`);
    }
    if ((after.funds ?? 0) < (p.funds ?? 0)) {
      problems.push(`${p.period} funds would drop from ${p.funds} to ${after.funds}`);
    }
  }
  if (merged.buildId !== live.buildId) {
    problems.push(`global buildId changed (${live.buildId} -> ${merged.buildId}); that busts every fund's cache`);
  }
  if (merged.coverage?.to && live.coverage?.to && merged.coverage.to < live.coverage.to) {
    problems.push(`coverage.to would move backwards (${live.coverage.to} -> ${merged.coverage.to})`);
  }
  return problems;
}

/**
 * Merge a fund's quarter series, so a shallow same-day run cannot truncate its
 * history.
 *
 * The same-day job ingests two quarters per fund — the one just filed and the
 * one before it, which is all a delta needs — while the universe job may hold
 * four or more. `fund/{cik}/summary.json` carries the series the Fund view
 * charts, so writing the shallow version wholesale would silently erase two
 * years of bars from a fund that had them. Same failure as the manifest, one
 * level down.
 *
 * Incoming wins on a period both know about: it was fetched from EDGAR today
 * and the other came from a data set assembled weeks ago, and amendments land
 * in exactly that gap.
 */
export function mergeSummary(live, incoming) {
  const liveSeries = Array.isArray(live?.data?.series) ? live.data.series : [];
  const inSeries = Array.isArray(incoming?.data?.series) ? incoming.data.series : [];
  if (!inSeries.length) throw new Error("incoming summary has no series — refusing to publish it");

  const byPeriodKey = new Map(liveSeries.map((s) => [s.period, s]));
  for (const s of inSeries) byPeriodKey.set(s.period, s);
  const series = [...byPeriodKey.values()].sort((a, b) => String(a.period).localeCompare(String(b.period)));

  if (series.length < liveSeries.length) {
    throw new Error(`merged series would shrink from ${liveSeries.length} to ${series.length} quarters`);
  }

  // Take the incoming envelope (fresher name, code, state) but never a shorter
  // history than what is already published.
  return { ...incoming, data: { ...incoming.data, series } };
}

/**
 * Merge a same-day run's filings into the published feed for one quarter.
 *
 * THE FEED IS SHARED, SO IT MUST BE MERGED AND NOT REPLACED — the same rule the
 * manifest and the fund summaries already follow, for the same reason. The
 * universe run writes ~10,000 rows per quarter; a same-day run knows about a
 * dozen managers. Publishing its version wholesale is how the site lost 9,000
 * funds once already.
 *
 * Rows are keyed by ACCESSION, which is the filing's identity: a re-run replaces
 * its own rows in place rather than appending duplicates, and an amendment
 * arrives as its own accession alongside the original, which is correct — both
 * were really filed.
 *
 * The incoming run only speaks for the CIKs it was asked about, so rows for
 * every other manager are carried through untouched. Anything that would drop
 * one of those throws: a shorter feed is not a fresher feed.
 */
export function mergePeriodFilings(live, incoming, ciks, { cap = FEED_ROWS, known = null, knownAsOf = null } = {}) {
  const liveRows = Array.isArray(live?.data) ? live.data : [];
  const inRows = Array.isArray(incoming?.data) ? incoming.data : [];
  if (!inRows.length) throw new Error("incoming feed has no rows — refusing to publish it");

  const owned = new Set(ciks);
  // Everything this run does NOT speak for, exactly as published.
  const foreign = liveRows.filter((r) => !owned.has(r.cik));

  // Its own rows, keyed by accession so a re-run supersedes rather than repeats.
  const mine = new Map();
  for (const r of liveRows) if (owned.has(r.cik)) mine.set(r.accession, r);
  for (const r of inRows) if (owned.has(r.cik)) mine.set(r.accession, r);

  const all = [...foreign, ...mine.values()].sort((a, b) =>
    String(b.accepted ?? b.filed ?? "").localeCompare(String(a.accepted ?? a.filed ?? "")),
  );

  // The safety property is checked on the FULL merge, before any display cap:
  // no manager this run does not speak for may lose a row.
  const foreignAfter = all.filter((r) => !owned.has(r.cik)).length;
  if (foreignAfter < foreign.length) {
    throw new Error(`merge would drop ${foreign.length - foreignAfter} filings belonging to other managers`);
  }

  // THE FEED IS A DISPLAY ARTIFACT AND IS CAPPED; THE COUNT IS NOT.
  //
  // The universe run already caps at FEED_ROWS — nobody scrolls past a few
  // hundred rows and shipping ten thousand to every visitor is pure weight — and
  // records the real number alongside. The same-day merge has to do the same, or
  // a season that ends with ~10,700 filers would grow this file to several
  // megabytes on the one view people open during filing week.
  //
  // `total` is the LARGER of what was recorded and what this merge can see, and
  // never a plain recount: recounting a capped list can only ever see the rows
  // that survived the cap, which would report a ten-thousand-filing quarter as
  // two thousand the moment a same-day run touched it.
  //
  // While a quarter is small the merged list IS the whole quarter and `all.length`
  // is exact. Once it passes the cap this number stops climbing, and the manifest
  // stops relying on it: the ingest cursor knows precisely how many managers have
  // been through, and publish-day.mjs passes that instead.
  const rows = cap > 0 ? all.slice(0, cap) : all;

  return {
    ...incoming,
    total: Math.max(Number(live?.total) || 0, all.length),
    funds: Math.max(Number(live?.funds) || 0, new Set(all.map((r) => r.cik)).size),
    shown: rows.length,
    // How many managers EDGAR has actually published for this quarter. Measured
    // from the daily indexes, not from what we hold — it is the denominator that
    // turns "9,255 outstanding" (a lie, they had filed) into "463 of 10,698
    // ingested so far" (the truth).
    ...(known != null
      ? { known, knownAsOf }
      : live?.known != null
        ? { known: live.known, knownAsOf: live.knownAsOf ?? null }
        : {}),
    data: rows,
  };
}

/**
 * Keys a same-day run is allowed to write.
 *
 * An allowlist, not a denylist. The failure that took the site down was writing
 * a shared index nobody remembered was shared, so the rule is stated as "these
 * and nothing else" — a new shared index added later is excluded by default
 * rather than included by omission.
 */
export function isPublishableDayKey(key) {
  if (key === "manifest.json") return true;      // merged, never replaced
  if (key.startsWith("fund/")) return true;      // this run's own funds
  // The quarter's filings feed — MERGED row-by-row, never replaced, and only
  // for the CIKs this run speaks for. Without it the Filings view still reports
  // the universe run's count, which during filing season is the one number on
  // the site guaranteed to be stale: 1 filing shown against 12 already landed.
  if (/^period\/\d{4}-\d{2}-\d{2}\/filings\.json$/.test(key)) return true;
  return false;                                   // meta/*, leaderboards, anything new
}
