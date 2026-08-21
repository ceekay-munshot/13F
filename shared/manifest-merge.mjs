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
 * @param {{ buildId: string, ciks: string[], periodTotals?: Record<string, {filings?: number, funds?: number, known?: number, knownAsOf?: string|null}>, sharedKeys?: string[] }} opts
 *   `sharedKeys` are the shared artifact paths this run rewrote — the quarter
 *   feeds and the filer index. They get their own cache key so a returning
 *   visitor actually sees them; see the note beside `merged.shared` below.
 *   `periodTotals` is the ACCUMULATED truth for a period, taken from the merged
 *   filings feed rather than from this run's sample. Without it a backfill run
 *   that publishes 450 filings into a quarter that already held 450 reports
 *   `max(450, 450) = 450` forever, so the dashboard's count of a quarter would
 *   freeze at one run's worth while the data behind it kept growing — which is
 *   also the number the staleness watchdog grades, so it would alert for ever.
 * @returns {{ manifest: object, changed: boolean, newPeriods: string[] }}
 */
export function mergeManifest(live, incoming, { buildId, ciks, periodTotals = {}, sharedKeys = [], authoritative = false }) {
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
    shared: { ...(live.shared ?? {}) },
  };

  // Per-fund cache keys for exactly the funds this run refreshed.
  for (const cik of ciks) merged.funds[cik] = buildId;

  // ---- and cache keys for the SHARED files this run rewrote ---------------
  //
  // Without these, everything below was invisible to anyone who had loaded the
  // site before. Artifacts are published `max-age=31536000, immutable` and the
  // browser is handed `?b={buildId}` — but the same-day job is forbidden from
  // touching the global buildId (verifyMerge rejects the publish if it changes,
  // because bumping it would bust the cache for all 9,300 funds to publish an
  // update to one). A fund gets a fresh key from `funds[cik]`. The quarter's
  // filings feed and the filer search index had no equivalent, so they were
  // rewritten in place at a URL that never changed and pinned in every returning
  // visitor's cache for a year.
  //
  // Same mechanism as `funds`, one level up: rewriting one shared file
  // invalidates that one shared file.
  for (const key of sharedKeys) merged.shared[key] = buildId;

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
    // COVERAGE IS CARRIED FORWARD, NOT RATCHETED.
    //
    // These two were `Math.max(existing, incoming, totals)` — monotone, so they
    // could never report a loss and could therefore only ever lie upward. The
    // dashboard said "10,765 of 10,765 managers loaded" for Q2 2026 while 8,295
    // fund pages said the manager had not filed, because `funds` had climbed to
    // whatever the filings feed had ever seen and had no way back down.
    //
    // How many managers hold a quarter is a property of the WHOLE TREE, and a
    // partial run cannot see it: this one refreshed a single fund. So a partial
    // run carries the published value forward untouched, and only a run that
    // rebuilt everything is allowed to set it — see `authoritative` below.
    const row = { ...existing, ...pick(totals) };
    if (authoritative) {
      // A run that rebuilt every fund knows exactly how many hold this quarter.
      row.filings = p.filings ?? existing.filings ?? null;
      row.funds = p.funds ?? existing.funds ?? null;
    } else {
      // A partial run may only ADD the managers it actually gave this quarter
      // to — counted while merging their summaries, not read off the filings
      // feed. The feed is capped at 2,000 rows and accumulates by accession, so
      // its distinct-CIK count is neither complete nor a count of what we hold.
      //
      // This still climbs through a filing season, which the freshness notice
      // needs, without being able to climb past the truth.
      row.funds = (existing.funds ?? 0) + (totals.fundsAdded ?? 0);
      row.filings = Math.max(existing.filings ?? 0, totals.filings ?? 0);
    }
    livePeriods.set(p.period, row);
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

  // CARRY THE INGEST'S PROBLEMS THROUGH. They were being dropped on the floor.
  //
  // `merged` spreads from `live`, and nothing ever read `incoming.notes`, so
  // every quarantined filing and every fund the same-day run failed on vanished
  // at the merge. The staleness watchdog's "the last ingest recorded N problems"
  // check reads exactly this field, and the universe run publishes `notes: []`,
  // so that check was permanently dead for the path that generates most of them.
  //
  // Capped, because a run over ten thousand managers can produce a long list and
  // the manifest is on the critical path for every page load.
  const notes = [...(incoming?.notes ?? [])];
  merged.notes = notes.slice(0, 50);
  if (notes.length > 50) merged.notes.push(`…and ${notes.length - 50} more`);
  // The uncapped count and what it was measured against. Grading `notes.length`
  // grades the cap, and grading a bare count treats a five-hundred-fund run like
  // a thirteen-fund one.
  merged.notesTotal = notes.length;
  merged.notesOf = Number(incoming?.notesOf) || 0;

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
  //
  // Checked by ACCESSION, not by counting `all`'s foreign rows. Counting them
  // compares an array with itself — `all` is built as `[...foreign, ...mine]`
  // and `mine` only ever holds owned CIKs, so `foreignAfter < foreign.length`
  // was arithmetically impossible and the guard could never fire. Identity
  // survival is the property that actually matters, and it catches the class of
  // edit that would break it: a changed key, a dedupe that collides two
  // managers' rows, a filter that reaches too far.
  const survived = new Set(all.map((r) => r.accession));
  const lost = foreign.filter((r) => !survived.has(r.accession));
  if (lost.length) {
    throw new Error(`merge would drop ${lost.length} filing(s) belonging to other managers`);
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
/**
 * Merge this run's filers into the published fund SEARCH INDEX.
 *
 * WHY THE SAME-DAY JOB HAS TO WRITE THIS AT ALL
 * ---------------------------------------------
 * `meta/filers.json` is what the fund search box reads and what the dashboard
 * picks its opening fund from. It was written only by the monthly universe run,
 * so a manager the same-day path discovered had artifacts in the bucket and no
 * row in the index: invisible to search, and — because `defaultFilerCik` opens
 * on the largest filer whose `latestPeriod` reaches the current quarter — the
 * dashboard fell through to whatever happened to be first in the list. On
 * 2026-08-18 the live index had ZERO rows reaching 2026-06-30, so a dashboard
 * whose newest quarter was Q2 opened on a fund whose newest data was Q4 2025.
 *
 * It is a SHARED index, which is why it was excluded in the first place — this
 * job sees a few hundred managers and the universe holds 9,268, so writing it
 * wholesale is the 9,000-funds-to-8 failure again. So it is merged, on exactly
 * the terms the quarter feed already is: rows for managers this run did not
 * touch are carried through untouched, the result may not shrink, and the
 * allowlist only permits the key because this function exists (enforced by
 * `npm run guard`).
 */
/**
 * Merge one fund's row in the search index under the rule the whole pipeline
 * runs on: A PUBLISH MAY ADD AND IT MAY CORRECT. IT MAY NOT SUBTRACT.
 *
 * The naive `{ ...prev, ...next }` looks right and quietly loses coverage,
 * because the two writers know different amounts:
 *
 *   - the same-day job fetches TWO quarters, so its `periods` is 2 and its row
 *     replaced counts of 3 and 4. Measured on the live index: 853 of the 987
 *     funds it had touched were advertising fewer quarters than they held.
 *   - the monthly job rebuilds every fund from whatever DERA windows exist that
 *     day. Run before the window covering the current quarter's deadline
 *     publishes, its row moves `latestPeriod` BACKWARDS — the same shape as the
 *     2026-08-20 outage, one file over.
 *
 * `latestPeriod` and `latestValueUsd` are kept as a PAIR. Taking the newer
 * period from one side and the value from the other is how a reference site
 * ends up showing one quarter's headline total under another quarter's label.
 */
export function mergeFilerRow(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const merged = { ...prev, ...next };

  // Coverage may only grow. Summaries are merged and never shrink, so the count
  // that describes them must not either.
  merged.periods = Math.max(Number(prev.periods) || 0, Number(next.periods) || 0);

  // The newest quarter wins, and drags its own value along with it.
  const pLatest = prev.latestPeriod ?? "";
  const nLatest = next.latestPeriod ?? "";
  if (pLatest > nLatest) {
    merged.latestPeriod = prev.latestPeriod;
    merged.latestValueUsd = prev.latestValueUsd;
  }

  // Watchlist membership is known to the universe build and not to a
  // two-quarter fetch, so it is never cleared by the side that cannot see it.
  // Whichever value wins keeps its own TYPE — the published index holds booleans
  // for 9,268 managers and leaves the field undefined for the 14 the same-day
  // job discovered. Coercing to 1/0 here would rewrite the shape of a file the
  // dashboard already reads.
  merged.watch = next.watch || prev.watch;

  // NOT or-ed, deliberately. `hasHoldings` promises that fund/{cik}/{period}
  // line items exist, and prune deletes those when a rebuild stops storing them.
  // Carrying a stale `true` would advertise a page that 404s.
  merged.hasHoldings = next.hasHoldings ?? prev.hasHoldings;

  return merged;
}

export function mergeFilers(live, incoming, ciks) {
  const liveRows = Array.isArray(live?.data) ? live.data : [];
  const inRows = Array.isArray(incoming?.data) ? incoming.data : [];
  if (!inRows.length) throw new Error("incoming filer index has no rows — refusing to publish it");

  const owned = new Set(ciks);
  const byCik = new Map(liveRows.map((f) => [f.cik, f]));

  for (const f of inRows) {
    if (!owned.has(f.cik)) continue; // this run only speaks for what it fetched
    // The universe build knows things a two-quarter fetch does not, and the
    // two-quarter fetch knows a quarter the universe build may not have yet.
    // mergeFilerRow keeps whichever side has more, per field.
    byCik.set(f.cik, mergeFilerRow(byCik.get(f.cik), f));
  }

  const rows = [...byCik.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (rows.length < liveRows.length) {
    throw new Error(`merged filer index would shrink from ${liveRows.length} to ${rows.length}`);
  }
  return { ...incoming, data: rows };
}

/**
 * Merge the compact series index, fund by fund and quarter by quarter.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHEN IT CAN BE DELETED
 * ---------------------------------------------------------------------------
 * The whole point of Phase 3 is to delete merge functions, not add them. This
 * one is here because the builder is not yet COMPLETE, and it is honest about
 * the precondition rather than pretending otherwise.
 *
 * meta/series.json is written only by the full build, from that build's own
 * view. Until the SEC publishes the bulk window covering the Q2 2026 deadline —
 * around 4 September — the archive holds Q2 for only the funds the same-day job
 * fetched directly. Every other manager's Q2 came from the repair and lives in
 * artifacts. A build run before then therefore has a genuinely thinner view than
 * the published index, and publishing it as-is drops those quarters.
 *
 * Prune is already shielded from exactly this by the coverage floor. The shared
 * indexes need the same protection, and unlike the fund summaries — which have
 * had mergeSummary since the outage — this file had none.
 *
 * Once the archive covers every published quarter, the build is complete by
 * construction and this becomes a no-op. That is a dated, checkable condition,
 * not a hope: compare the archive's windows against the manifest's quarters.
 */
export function mergeSeriesIndex(live, incoming, periodOf = (t) => t[0]) {
  const liveRows = Array.isArray(live?.data) ? live.data : [];
  const inRows = Array.isArray(incoming?.data) ? incoming.data : [];
  if (!inRows.length) throw new Error("incoming series index has no rows — refusing to publish it");
  if (!liveRows.length) return incoming;

  const byCik = new Map(liveRows.map((r) => [r.cik, r]));
  for (const row of inRows) {
    const prev = byCik.get(row.cik);
    if (!prev) { byCik.set(row.cik, row); continue; }

    // Union the quarters. The incoming build is authoritative about a quarter it
    // HAS — it re-derived it from source — and silent about one it does not.
    const tuples = new Map((prev.s ?? []).map((t) => [periodOf(t), t]));
    for (const t of row.s ?? []) tuples.set(periodOf(t), t);
    const s = [...tuples.values()].sort((a, b) => String(periodOf(b)).localeCompare(String(periodOf(a))));
    byCik.set(row.cik, { ...prev, ...row, s });
  }

  const rows = [...byCik.values()];
  if (rows.length < liveRows.length) {
    throw new Error(`merged series index would shrink from ${liveRows.length} to ${rows.length}`);
  }
  return { ...incoming, data: rows };
}

export function isPublishableDayKey(key) {
  if (key === "manifest.json") return true;      // merged, never replaced
  if (key.startsWith("fund/")) return true;      // this run's own funds
  // The fund search index — MERGED row-by-row by mergeFilers, never replaced.
  // Without it a manager this run discovered has artifacts nobody can navigate
  // to, which is indistinguishable from not having ingested it at all.
  if (/^meta\/filers\.json$/.test(key)) return true;
  // The quarter's filings feed — MERGED row-by-row, never replaced, and only
  // for the CIKs this run speaks for. Without it the Filings view still reports
  // the universe run's count, which during filing season is the one number on
  // the site guaranteed to be stale: 1 filing shown against 12 already landed.
  if (/^period\/\d{4}-\d{2}-\d{2}\/filings\.json$/.test(key)) return true;
  return false;                                   // meta/*, leaderboards, anything new
}

/**
 * The quarter a key belongs to, or null if it belongs to no quarter.
 *
 *   fund/0001067983/2026-06-30.json      -> 2026-06-30
 *   fund/0001067983/2026-06-30.p2.json   -> 2026-06-30
 *   period/2026-06-30/filings.json       -> 2026-06-30
 *   fund/0001067983/summary.json         -> null
 *   meta/filers.json                     -> null
 */
export function periodOfKey(key) {
  const m =
    /^fund\/\d{10}\/(\d{4}-\d{2}-\d{2})(?:\.p\d+)?\.json$/.exec(key) ??
    /^period\/(\d{4}-\d{2}-\d{2})\//.exec(key);
  return m ? m[1] : null;
}

/**
 * May a publish DELETE this key?
 *
 * ---------------------------------------------------------------------------
 * "I HAVE NO DATA FOR THAT QUARTER" IS NOT "THAT QUARTER SHOULD NOT EXIST".
 * ---------------------------------------------------------------------------
 * The monthly universe job only covers quarters whose SEC bulk window has been
 * published, and during a filing season the CURRENT quarter has no window for
 * about a month after the deadline. Its local tree therefore contains nothing
 * for that quarter — while the same-day job has been publishing it for weeks.
 *
 * Prune deletes whatever is in the bucket and not in the local tree. So the
 * moment it ran, it would delete the entire current quarter: on 2026-08-20 that
 * was ~10,765 fund-quarters plus the filings feed. It did not, purely because
 * prune was crashing on a variable used before its declaration — the data
 * survived by accident, and fixing that crash on its own would have destroyed
 * it.
 *
 * The 50% safety rail does not help here either: the current quarter is about a
 * quarter of the bucket, well under the threshold, so the rail would have
 * watched it happen.
 *
 * The rule: a key belonging to a quarter this run did not build is NOT stale,
 * it is simply outside what this run knows about. Only quarters the run
 * actually produced may have their leftovers cleaned up.
 *
 * @param {string} key                  the object key in the bucket
 * @param {Set<string>} builtPeriods    quarters this run actually produced
 * @param {string[]} protectedPrefixes  never-touch prefixes (cursors, state)
 */
export function isPrunableKey(key, builtPeriods, protectedPrefixes = [], builtCiks = null) {
  if (protectedPrefixes.some((p) => key.startsWith(p))) return false;

  // A MANAGER THIS RUN NEVER BUILT IS NOT A MANAGER THIS RUN MAY DELETE.
  //
  // The monthly job builds from the SEC's bulk windows. A manager who filed for
  // the first time this season has no window yet, so the same-day job is the
  // only thing that has ever heard of them — and their fund/{cik}/summary.json
  // carries no quarter in its key, which fell through to "no quarter, ordinary
  // retention" below and was deleted outright. Their Fund page then 404s while
  // their holdings sit in the bucket with nothing pointing at them.
  //
  // This never fired, because prune has never once completed: it threw from a
  // temporal dead zone, and then on an undefined name. Repairing prune is what
  // made this reachable, so the rule the rest of the pipeline runs on has to
  // apply here too — not knowing about something is not knowing it should go.
  if (builtCiks) {
    const m = /^fund\/(\d{10})\//.exec(key);
    if (m && !builtCiks.has(m[1])) return false;
  }

  const period = periodOfKey(key);
  if (period === null) return true;          // no quarter — ordinary retention
  return builtPeriods.has(period);           // only quarters we actually built
}

/**
 * Carry forward quarters the incoming manifest says nothing about.
 *
 * For the MONTHLY job, which is authoritative about everything it covers and
 * silent about everything it does not. mergeManifest is the same-day tool and
 * deliberately preserves the global build id; this one does not touch the
 * incoming manifest except to re-add quarters that would otherwise vanish.
 *
 * Why it is needed: the monthly run covers only quarters whose SEC bulk window
 * exists, so during a filing season the current quarter is missing from its
 * manifest entirely. Publishing that as-is removes the quarter from the
 * dashboard's quarter selector — while the data for it is still sitting in the
 * bucket, published by the same-day job and now shielded from prune. The
 * dashboard could not reach data it definitely had.
 *
 * Same rule as prune and as the fund summaries, in a third place: not knowing
 * about a quarter is not the same as knowing it should be gone.
 */
export function carryForwardPeriods(live, incoming) {
  const inPeriods = Array.isArray(incoming?.periods) ? incoming.periods : [];
  if (!inPeriods.length) throw new Error("incoming manifest has no periods — refusing to publish it");
  const livePeriods = Array.isArray(live?.periods) ? live.periods : [];

  const known = new Set(inPeriods.map((p) => p.period));
  const carried = livePeriods.filter((p) => !known.has(p.period));
  if (!carried.length) return { manifest: incoming, carried: [] };

  const periods = [...inPeriods, ...carried].sort((a, b) =>
    String(b.period).localeCompare(String(a.period)),
  );
  return {
    manifest: { ...incoming, periods },
    carried: carried.map((p) => p.period),
  };
}
