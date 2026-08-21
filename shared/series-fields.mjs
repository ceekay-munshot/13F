// shared/series-fields.mjs
//
// The column order of meta/series.json's compact tuples.
//
// ---------------------------------------------------------------------------
// ONE DEFINITION, BECAUSE THREE COPIES ALREADY DRIFTED
// ---------------------------------------------------------------------------
// That index stores each fund-quarter as a POSITIONAL ARRAY rather than an
// object — the key names would otherwise repeat once per fund per quarter across
// nine thousand funds. The names therefore live somewhere else, and until now
// they lived in two somewhere-elses that nothing kept in agreement:
//
//   - scripts/ingest-dera.mjs published a `fields` array beside the data
//   - src/lib/data.ts had its own hardcoded SERIES_FIELDS, which is what the
//     dashboard actually zips against the tuple
//
// Adding valuePrnUsd to the first list and not the second produced twenty names
// for nineteen values. The dashboard was unaffected — it never reads the
// published list — but the artifact then described itself wrongly, and anyone
// who trusted that description would have read positionsLong as a dollar value
// and every field after it shifted by one.
//
// ---------------------------------------------------------------------------
// APPEND. NEVER INSERT.
// ---------------------------------------------------------------------------
// Artifacts already in the bucket were written against the order below. A new
// field added in the MIDDLE silently re-points every column after it for every
// build still live, which is a wrong number on screen with nothing to indicate
// it. A field added at the END is simply absent from older tuples, and
// `tuple[i] ?? null` reads it as null — which is the truth.
export const SERIES_FIELDS = [
  "period", "valueLongUsd", "positions", "reportedTotalUsd", "top10WeightPct",
  "n_new", "n_added", "n_trimmed", "n_exited", "turnover_position_pct",
  "priorState", "structuralEvent", "confidentialOmitted", "filingLagDays",
  "valueOptionsUsd", "positionsLong", "positionsOptions", "hasHoldings",
  "deltasSuppressed",
  // Appended 2026-08-21. Principal-amount holdings (bonds and notes), which the
  // filer's own cover-page total includes and our long-equity figure excludes.
  "valuePrnUsd",
];
