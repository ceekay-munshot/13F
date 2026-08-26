// scripts/_source-load.mjs
//
// Reading the store of record back out, in the one shape the builder folds.
//
// ---------------------------------------------------------------------------
// TWO SOURCES, ONE SHAPE
// ---------------------------------------------------------------------------
// The archive holds filings from two places and they are not interchangeable as
// stored:
//
//   source/dera/{window}.zip  — the SEC's quarterly bulk file. Every filer, but
//     published about a month after its window closes, and carrying a filing
//     DATE with no acceptance time.
//
//   source/edgar/{period}/{accession}.json.gz — a filing fetched directly during
//     the season. Only the funds the same-day job reached, but available within
//     hours and carrying the REAL acceptance timestamp.
//
// For roughly six weeks after each deadline the second is the only copy of a
// quarter that exists. After that the first supersedes it.
//
// Where both have seen a filing, the directly-fetched record wins — not because
// it is fresher (the content is identical; the SEC does not revise) but because
// of the timestamp. DERA's absence of one is filled with noon UTC, so every
// filing a fund made on one day ties in the amendment fold, and the tiebreak
// falls back to accession order — which is the filing AGENT's prefix, not
// anything chronological. A restatement can therefore lose to the original it
// exists to replace. A real acceptance time removes the tie.

import { gunzipSync } from "node:zlib";
import { aggregateHoldings, summarizeHoldings, decideValueUnits, reconcileTotal, issuerIdFor } from "./_sec-parse.mjs";

/**
 * One archived EDGAR filing, in the shape the DERA loader produces.
 *
 * Re-aggregated from the AS-FILED rows rather than trusting the aggregate that
 * was stored alongside them: ticker and issuer identity come from a map that
 * changes between runs, so re-deriving is what makes a rebuild reproduce the
 * current state rather than a snapshot of whatever was known that day.
 */
export function normalizeEdgarFiling(rec, { securities = {} } = {}) {
  if (!rec || !rec.accession_number) return null;

  const raw = Array.isArray(rec.raw) ? rec.raw : null;
  const notice = Boolean(rec.notice);

  // A notice has no information table at all — that is what it means.
  if (notice || !raw) {
    return {
      accession: rec.accession_number,
      cik: rec.cik ?? null,
      name: rec.manager_name ?? null,
      state: null,
      period_end: rec.period ?? rec.period_end ?? null,
      form: rec.form_type ?? rec.form ?? null,
      filing_date: rec.filing_date ?? ((rec.acceptance_datetime ?? "").slice(0, 10) || null),
      acceptance_datetime: rec.acceptance_datetime ?? null,
      is_amendment: Boolean(rec.is_amendment),
      amendment_type: rec.amendment_type ?? null,
      amendment_no: rec.amendment_no ?? null,
      is_confidential_omitted: Boolean(rec.is_confidential_omitted),
      report_type: rec.report_type ?? null,
      table_value_total: rec.table_value_total ?? null,
      table_entry_total: rec.table_entry_total ?? null,
      // The cover page's other-manager list, carried through UNCHANGED. On a
      // notice this is the whole point of the document — who reports these
      // holdings instead — and a rebuild that dropped it would quietly restore
      // the "we have not read this quarter yet" message on a quarter that was
      // read correctly the first time.
      //
      // Archived records written before the parser read this have no such key.
      // Empty is the honest answer for those, not a reason to fail.
      // NULL, NOT []. A record archived before this was parsed knows nothing
      // about the manager list, and the structural detector must be able to tell
      // that apart from a filing that named nobody — see managerKeys in
      // shared/fold.mjs. An empty array would read as an answer.
      cover_managers: Array.isArray(rec.cover_managers) ? rec.cover_managers : null,
      additional_information: rec.additional_information ?? null,
      notice,
      quarantined: Boolean(rec.quarantined),
      reconciles: rec.reconciles ?? null,
      held: [],
      summary: null,
      rows: null,
    };
  }

  // The same four-rung ladder the bulk path runs, on the same rows, so a filing
  // read from either source lands on the same units decision. Rung 1 is
  // available here and not there: the schema version is on the filing itself.
  const units = decideValueUnits({
    schemaVersion: rec.schemaVersion ?? undefined,
    acceptanceDatetime: rec.acceptance_datetime ?? null,
    rows: raw,
  });
  const recon = reconcileTotal(raw, rec.table_value_total);
  const held = aggregateHoldings(raw, units.units).map((h) => {
    const s = securities[h.cusip];
    return { ...h, issuerId: s?.issuerId ?? issuerIdFor(h.cusip), ticker: s?.ticker ?? null };
  });

  return {
    accession: rec.accession_number,
    cik: rec.cik ?? null,
    name: rec.manager_name ?? null,
    state: null,
    period_end: rec.period ?? rec.period_end ?? null,
    form: rec.form_type ?? rec.form ?? null,
    filing_date: rec.filing_date ?? ((rec.acceptance_datetime ?? "").slice(0, 10) || null),
    acceptance_datetime: rec.acceptance_datetime ?? null,
    is_amendment: Boolean(rec.is_amendment),
    amendment_type: rec.amendment_type ?? null,
    amendment_no: rec.amendment_no ?? null,
    is_confidential_omitted: Boolean(rec.is_confidential_omitted),
    report_type: rec.report_type ?? null,
    table_value_total: rec.table_value_total ?? null,
    table_entry_total: rec.table_entry_total ?? null,
    cover_managers: Array.isArray(rec.cover_managers) ? rec.cover_managers : null,
    other_managers: Array.isArray(rec.other_managers) ? rec.other_managers : null,
    additional_information: rec.additional_information ?? null,
    notice: false,
    units: units.units,
    unit_source: units.source,
    reconciles: recon.ok,
    quarantined: recon.ok === false || Boolean(units.quarantine),
    held,
    summary: summarizeHoldings(held),
    rows: null,
  };
}

/**
 * Every archived EDGAR filing, merged into a map already holding the bulk ones.
 *
 * Keyed by accession, so a filing both sources have is REPLACED by the directly
 * fetched one. Returns what it did, because a load that silently found nothing
 * and a load that legitimately had nothing to find must not look the same.
 */
export async function mergeEdgarSource(filings, { r2, prefix, securities = {}, log = () => {} }) {
  let listed = 0, merged = 0, replaced = 0, unreadable = 0;
  let keys;
  try {
    keys = await r2.list(prefix);
  } catch (err) {
    log(`  archived filings could not be listed (${err.message}) — building from the bulk windows alone`);
    return { listed: 0, merged: 0, replaced: 0, unreadable: 0, ok: false };
  }

  for (const key of keys.keys()) {
    if (!key.endsWith(".json.gz")) continue;
    listed++;
    try {
      const buf = await r2.getBuffer(key);
      if (!buf) { unreadable++; continue; }
      const rec = JSON.parse(gunzipSync(buf).toString("utf8"));
      const f = normalizeEdgarFiling(rec, { securities });
      if (!f || !f.period_end || !f.cik) { unreadable++; continue; }
      if (filings.has(f.accession)) replaced++;
      else merged++;
      filings.set(f.accession, f);
    } catch (err) {
      unreadable++;
      log(`  could not read ${key}: ${err.message}`);
    }
  }
  return { listed, merged, replaced, unreadable, ok: true };
}
