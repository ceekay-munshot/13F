// shared/emit.mjs
//
// Turning one folded fund-quarter into the things the dashboard reads.
//
// ---------------------------------------------------------------------------
// WHY THIS IS ONE FILE AND NOT TWO
// ---------------------------------------------------------------------------
// The monthly build and the same-day build each carried their own copy of this,
// written twice and then drifted. The copies were character-for-character
// identical when written — including the explanatory comments, which were
// copy-pasted verbatim — and then they diverged in four ways that reach the
// screen:
//
//   TURNOVER on a suppressed quarter. The same-day path withholds it; the
//   monthly path published it. Cantillon's Q2-2026 card therefore reported
//   "TURNOVER 33.8%" a few inches above an Activity widget refusing to draw the
//   same comparison, whenever the monthly job was the one that wrote it.
//
//   CONFIDENTIAL OMISSION. The two paths computed the flag over different
//   populations — one over foldable filings, one over all parsed filings
//   including notices — so the flag stored in the artifact and the flag that
//   decided whether exits were withheld could disagree about the same quarter.
//
//   The FILINGS FEED's `value`: long equity in one path, every row including
//   options and bonds in the other. Same field name, two meanings, merged into
//   one feed.
//
//   The FEED's `rawRows`: the cover page's declared entry count in one, the
//   number of rows actually parsed in the other.
//
// A reader cannot tell which path wrote a given row, so a field that means two
// things means nothing. Each is resolved here, once, in favour of the rule that
// is correct rather than the one that happened to be in the surviving copy.

import { computeChanges, summarizeActions, computeTurnover, PRIOR_STATE } from "./fold.mjs";
import { periodLabel } from "./calendar.mjs";

/**
 * One holding, as the dashboard's column-oriented format wants it.
 *
 * The rounding is part of the contract: `weight` and `dWeightPp` to 4 decimal
 * places, the percentage deltas to 3. Both copies had exactly these, which is
 * how you can tell they were the same code.
 */
export function artifactRow(h, ch) {
  return {
    ticker: h.ticker ?? null,
    name: h.name_of_issuer,
    issuerId: h.issuerId,
    cls: h.title_of_class,
    type: h.put_call,
    unit: h.ssh_prnamt_type,
    value: h.value_usd,
    shares: h.ssh_prnamt,
    weight: h.weight_pct == null ? null : Number(h.weight_pct.toFixed(4)),
    price: h.implied_price == null ? null : Number(h.implied_price.toFixed(4)),
    action: ch?.action ?? null,
    dShares: ch?.d_shares ?? null,
    dSharesPct: ch?.d_shares_pct == null ? null : Number(ch.d_shares_pct.toFixed(3)),
    dValue: ch?.d_value ?? null,
    dValuePct: ch?.d_value_pct == null ? null : Number(ch.d_value_pct.toFixed(3)),
    dWeightPp: ch?.d_weight_pp == null ? null : Number(ch.d_weight_pp.toFixed(4)),
    flags: ch?.flags ?? null,
  };
}

/**
 * A position that left the book entirely.
 *
 * `unit` matters: without it a client filtering to long equity cannot tell an
 * exited share position from an exited bond.
 */
export function exitRow(c, { securities = {}, issuerIdFor }) {
  const s = securities[c.cusip];
  return {
    ticker: s?.ticker ?? null,
    name: c.name_of_issuer,
    issuerId: s?.issuerId ?? (issuerIdFor ? issuerIdFor(c.cusip) : null),
    type: c.put_call,
    unit: c.ssh_prnamt_type ?? "SH",
    valuePrior: c.value_prior,
    weightPrior: c.weight_prior,
  };
}

/**
 * Turnover, or the honest absence of it.
 *
 * ---------------------------------------------------------------------------
 * NO TURNOVER FOR A QUARTER WHOSE DELTAS ARE WITHHELD.
 * ---------------------------------------------------------------------------
 * Turnover is a delta measure — entries plus exits over positions, traded value
 * over average book — so a quarter whose per-row changes are too misleading to
 * publish cannot have a meaningful one either.
 *
 * The monthly path computed it anyway, and because computeChanges nulls d_value
 * when it suppresses, what it published was not merely misleading but partly
 * zero: a position turnover derived from a redemption and a value turnover of
 * 183% derived entirely from the same one event.
 *
 * Withheld, not zeroed. Zero is a confident wrong answer where a dash is the
 * true one.
 */
export function turnoverFor(priorState, suppressed, current, prior, changes) {
  if (priorState !== PRIOR_STATE.OK || suppressed) {
    return { turnover_position_pct: null, turnover_value_pct: null };
  }
  return computeTurnover(changes, current, prior);
}

/**
 * Everything one fund-quarter contributes, from one folded record.
 *
 * `cur` and `prior` are the folded shapes both ingests already build:
 * `{ holdings, summary, value_long_usd, reported_total_usd, acceptance,
 *    accessions, warnings, confidentialOmitted }`.
 */
export function fundQuarter({
  period,
  priorPeriod: pp,
  cur,
  prior,
  priorState,
  securities = {},
  issuerIdFor,
}) {
  const { changes, suppressed, reason, structuralEvent, structural, exitsWithheld } = computeChanges(
    { period_end: period, holdings: cur.holdings, value_long_usd: cur.value_long_usd },
    priorState === PRIOR_STATE.OK
      ? {
          period_end: pp,
          accession: prior?.accessions?.at(-1) ?? null,
          holdings: prior.holdings,
          value_long_usd: prior.value_long_usd,
        }
      : null,
    priorState,
    // ONE POPULATION FOR THE OMISSION FLAG.
    //
    // The two paths disagreed: one computed it over foldable filings, the other
    // over every parsed filing including notices and quarantined ones. Whichever
    // is used here MUST be the one stored in `meta` below, or the artifact says
    // the book was complete while the fold treated it as incomplete. Taking it
    // off the folded record makes that impossible.
    { confidentialOmitted: Boolean(cur.confidentialOmitted) },
  );

  const acts = summarizeActions(changes);
  const turnover = turnoverFor(
    priorState,
    suppressed,
    { holdings: cur.holdings, value_long_usd: cur.value_long_usd },
    prior ? { holdings: prior.holdings, value_long_usd: prior.value_long_usd } : null,
    changes,
  );

  const changeByKey = new Map(changes.map((c) => [`${c.cusip}|${c.put_call}`, c]));
  const rows = cur.holdings
    .map((h) => artifactRow(h, changeByKey.get(`${h.cusip}|${h.put_call}`)))
    .sort((a, b) => b.value - a.value);

  const exits = changes
    .filter((c) => c.action === "EXITED")
    .map((c) => exitRow(c, { securities, issuerIdFor }))
    .sort((a, b) => (b.valuePrior ?? 0) - (a.valuePrior ?? 0));

  const meta = {
    priorState,
    priorPeriod: priorState === PRIOR_STATE.OK ? pp : null,
    deltasSuppressed: suppressed,
    structuralEvent,
    structuralDetail: structural?.detail ?? null,
    confidentialOmitted: Boolean(cur.confidentialOmitted),
    foldWarnings: cur.warnings ?? [],
    // How many exits were NOT emitted because the filer withheld positions.
    // Shown, not swallowed: a shorter list with no explanation reads as "they
    // sold nothing", which is a different wrong answer.
    exitsWithheld,
    accessions: cur.accessions ?? [],
    ...cur.summary,
    reportedTotalUsd: cur.reported_total_usd,
    ...acts,
    ...turnover,
  };

  return { changes, suppressed, reason, structuralEvent, structural, exitsWithheld, acts, turnover, rows, exits, meta };
}

/**
 * The entry a fund's summary series carries for one quarter.
 *
 * Kept beside the meta it is derived from so the two cannot describe the same
 * quarter differently — which they did, for turnover, for as long as there were
 * two copies of this.
 */
export function seriesEntry({ period, cur, meta, pages, hasHoldings, positions }) {
  const acceptedAt = cur.acceptance ?? null;
  return {
    period,
    label: periodLabel(period),
    reportedTotalUsd: cur.reported_total_usd ?? null,
    valueLongUsd: cur.summary?.value_long_usd ?? null,
    valueOptionsUsd: cur.summary?.value_options_usd ?? null,
    // Principal-amount rows: bonds and notes, whose "shares" figure is a face
    // value. Held out of the long-equity denominator by design, but the filer's
    // own cover page totals them in, so without this the two can never be
    // reconciled — Nuveen's 28 of them are $433M against a $419B book.
    valuePrnUsd: cur.summary?.value_prn_usd ?? 0,
    positions: positions ?? cur.holdings.length,
    positionsLong: cur.summary?.positions_long ?? null,
    positionsOptions: cur.summary?.positions_options ?? null,
    top10WeightPct: cur.summary?.top10_weight_pct ?? null,
    n_new: meta.n_new ?? null,
    n_added: meta.n_added ?? null,
    n_held: meta.n_held ?? null,
    n_trimmed: meta.n_trimmed ?? null,
    n_exited: meta.n_exited ?? null,
    turnover_position_pct: meta.turnover_position_pct ?? null,
    turnover_value_pct: meta.turnover_value_pct ?? null,
    priorState: meta.priorState,
    deltasSuppressed: meta.deltasSuppressed,
    structuralEvent: meta.structuralEvent,
    confidentialOmitted: Boolean(cur.confidentialOmitted),
    pages,
    acceptedAt,
    filingLagDays: acceptedAt
      ? Math.round((Date.parse(acceptedAt.slice(0, 10) + "T00:00:00Z") - Date.parse(`${period}T00:00:00Z`)) / 86_400_000)
      : null,
    hasHoldings,
  };
}

/**
 * One row of a quarter's filings feed.
 *
 * ---------------------------------------------------------------------------
 * TWO FIELDS THAT MEANT TWO THINGS
 * ---------------------------------------------------------------------------
 * `value` was the fund's LONG EQUITY total in the monthly path and the sum of
 * EVERY aggregated row — options and bond principal included — in the same-day
 * path. `rawRows` was the cover page's DECLARED entry count in one and the
 * number of rows actually PARSED in the other. Both feeds are merged into a
 * single file, so a reader cannot tell which meaning any given row carries.
 *
 * Resolved to the declared-vs-parsed pair that the Filings view actually needs:
 * `value` is long equity, matching the column header, and `rawRows` is what the
 * filer declared, because the point of showing it is to compare against what we
 * parsed.
 */
export function filingRow({ cik, name, filing, summary, acceptedAt }) {
  return {
    cik,
    fund: name,
    code: null,
    accession: filing.accession ?? filing.accession_number,
    form: filing.form,
    filed: filing.filing_date ?? null,
    accepted: acceptedAt ?? null,
    positions: filing.held?.length ?? filing.rows?.length ?? 0,
    rawRows: filing.table_entry_total ?? 0,
    value: summary?.value_long_usd ?? null,
    amendment: filing.is_amendment ? (filing.amendment_type || "AMENDED") : null,
    amendmentNo: filing.amendment_no ?? null,
    confidentialOmitted: Boolean(filing.is_confidential_omitted),
    reconciles: filing.reconciles ?? null,
    quarantined: Boolean(filing.quarantined),
    notice: Boolean(filing.notice),
  };
}
