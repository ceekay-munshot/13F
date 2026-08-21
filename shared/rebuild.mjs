// shared/rebuild.mjs
//
// Deriving a fund's summary series from the per-fund artifacts already
// published. The pure half of scripts/rebuild-indexes.mjs.
//
// Split for the same reason shared/regression.mjs and shared/witness.mjs are
// split from their scripts: the fetching cannot be unit-tested and the deriving
// must be. The script does top-level HTTP on import, so anything left inside it
// is unreachable from a test.

import { periodLabel } from "./calendar.mjs";

/**
 * The 23 fields of a summary series entry, rebuilt from one fund-period file.
 *
 * Every one is either on the envelope or in `meta` — nothing is recomputed and
 * nothing is guessed. Where the artifact and the summary disagree on a name
 * (`value_long_usd` vs `valueLongUsd`, `positions_total` vs `positions`) the
 * mapping is spelled out rather than done by a clever transform, because a
 * silent rename here would publish a null into a field the dashboard renders.
 */
export function seriesEntryFrom(artifact) {
  const m = artifact.meta ?? {};
  const period = artifact.period;
  const acceptedAt = artifact.acceptedAt ?? null;
  const suppressed = Boolean(m.deltasSuppressed);
  return {
    period,
    label: periodLabel(period),
    reportedTotalUsd: m.reportedTotalUsd ?? null,
    valueLongUsd: m.value_long_usd ?? null,
    valueOptionsUsd: m.value_options_usd ?? null,
    positions: m.positions_total ?? null,
    positionsLong: m.positions_long ?? null,
    positionsOptions: m.positions_options ?? null,
    top10WeightPct: m.top10_weight_pct ?? null,
    n_new: m.n_new ?? null,
    n_added: m.n_added ?? null,
    n_held: m.n_held ?? null,
    n_trimmed: m.n_trimmed ?? null,
    n_exited: m.n_exited ?? null,
    // TURNOVER IS WITHHELD ON A SUPPRESSED QUARTER — and the artifact cannot be
    // trusted to have withheld it.
    //
    // The two ingest paths disagree here, and only one of them is right. The
    // same-day path withholds turnover when a structural event has made every
    // per-position delta meaningless; the monthly path publishes it anyway. So
    // Cantillon's 2026-Q2 artifact carries turnover_position_pct 33.8% for a
    // quarter whose entire story is that all 27 positions moved by one identical
    // multiplier — the exact number the suppression exists to hide.
    //
    // Copying meta across blindly would have republished it. Caught by round-
    // tripping a fund whose summary was already correct and diffing the result.
    turnover_position_pct: suppressed ? null : m.turnover_position_pct ?? null,
    turnover_value_pct: suppressed ? null : m.turnover_value_pct ?? null,
    priorState: m.priorState ?? null,
    deltasSuppressed: suppressed,
    structuralEvent: m.structuralEvent ?? null,
    confidentialOmitted: Boolean(m.confidentialOmitted),
    pages: artifact.pages ?? 1,
    acceptedAt,
    // Same arithmetic as both ingest paths: whole days from the quarter end to
    // the day the filing was accepted.
    filingLagDays: acceptedAt
      ? Math.round((Date.parse(acceptedAt.slice(0, 10) + "T00:00:00Z") - Date.parse(`${period}T00:00:00Z`)) / 86_400_000)
      : null,
    // Present in the artifact since 2026-08-21. Older artifacts predate it, and
    // null is the honest answer for those — see shared/witness.mjs.
    valuePrnUsd: m.value_prn_usd ?? null,
  };
}

/**
 * Insert recovered quarters into a fund's series without disturbing anything.
 *
 * The published files are not all in the same order — the two ingest paths emit
 * opposite directions, which is why the frontend normalises on load. Rewriting
 * every summary into one order would change 9,268 files that have nothing wrong
 * with them, so the existing direction is detected and preserved.
 */
export function insertPeriods(series, recovered) {
  if (!recovered.length) return series;
  const ascending = series.length < 2 || series[0].period <= series[series.length - 1].period;
  const byPeriod = new Map(series.map((s) => [s.period, s]));
  for (const entry of recovered) {
    // Never overwrite what is already published. This function only ADDS.
    if (!byPeriod.has(entry.period)) byPeriod.set(entry.period, entry);
  }
  const out = [...byPeriod.values()].sort((a, b) => String(a.period).localeCompare(String(b.period)));
  return ascending ? out : out.reverse();
}
