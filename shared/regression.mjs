// shared/regression.mjs
//
// "Did this publish make the site smaller?"
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// Every check this project had asked an ABSOLUTE question: does the index load,
// are there more than a thousand filers, is there at least one quarter, is the
// build recent. The failures that actually reach a client are RELATIVE: is there
// less than there was five minutes ago.
//
// On 2026-08-20 a publish passed every absolute check — index loaded, 9,268
// filers, five quarters, fresh build, artifact probe green — while quietly
// deleting the current quarter from all 9,268 fund summaries. The dashboard told
// a client a manager had not filed when their filing had been live for weeks.
//
// Seven of the eleven real failures in this project's history were "something
// got smaller": the dead site, the quarter vanishing from summaries, prune about
// to delete a quarter, the quarter list losing an entry, the filings feed stuck
// at one row, the collapse from 9,396 funds to 8, and the 18% of filings that
// were silently invisible. One comparison catches all seven.
//
// The rule this encodes: A PUBLISH MAY ADD AND IT MAY CORRECT, BUT IT MAY NOT
// SUBTRACT. Anything that shrinks is a bug until a human says otherwise.

/**
 * What a fingerprint looks like. Deliberately small — this is compared, stored
 * and printed, so it holds counts rather than data.
 *
 * @typedef {{
 *   takenAt: string,
 *   buildId: string|null,
 *   filers: number,
 *   periods: Record<string, {funds: number, filings: number}>,
 *   funds: Record<string, {quarters: number, newest: string|null}>,
 * }} Fingerprint
 */

/**
 * Tolerances.
 *
 * Losing a whole quarter, or a fund losing its newest one, is NEVER acceptable —
 * those are the exact shapes of the outage. Counts may move a little when a
 * quarter is legitimately re-ingested (a filer withdraws, an amendment merges
 * two rows into one), so those get a small allowance rather than a hard zero,
 * which would cry wolf on every monthly run.
 */
export const DEFAULT_TOLERANCE = 0.05; // 5%

/**
 * Compare two fingerprints and return everything that got worse.
 *
 * @param {Fingerprint} before
 * @param {Fingerprint} after
 * @param {{tolerance?: number}} [opts]
 * @returns {{regressions: string[], notes: string[]}}
 */
export function compareFingerprints(before, after, { tolerance = DEFAULT_TOLERANCE } = {}) {
  const regressions = [];
  const notes = [];

  if (!before || !after) {
    // No baseline is not a pass and not a failure — it is the first run. Say so
    // rather than silently returning "all clear", which would make a missing
    // baseline look identical to a good result.
    notes.push("no baseline to compare against — this run establishes one");
    return { regressions, notes };
  }

  // ---- quarters -----------------------------------------------------------
  for (const period of Object.keys(before.periods ?? {})) {
    const b = before.periods[period];
    const a = after.periods?.[period];
    if (!a) {
      regressions.push(`quarter ${period} disappeared from the manifest (had ${b.funds} funds)`);
      continue;
    }
    if (b.funds > 0 && a.funds < b.funds * (1 - tolerance)) {
      regressions.push(`quarter ${period} fell from ${b.funds} funds to ${a.funds}`);
    }
    if (b.filings > 0 && a.filings < b.filings * (1 - tolerance)) {
      regressions.push(`quarter ${period} fell from ${b.filings} filings to ${a.filings}`);
    }
  }
  const gained = Object.keys(after.periods ?? {}).filter((p) => !(before.periods ?? {})[p]);
  if (gained.length) notes.push(`new quarter(s): ${gained.join(", ")}`);

  // ---- the universe -------------------------------------------------------
  if (before.filers > 0 && after.filers < before.filers * (1 - tolerance)) {
    regressions.push(`filer count fell from ${before.filers} to ${after.filers}`);
  }

  // ---- individual funds ---------------------------------------------------
  //
  // THE CHECK THAT WOULD HAVE CAUGHT THE OUTAGE. Every aggregate above was
  // healthy while every fund had lost a quarter, because the loss was uniform:
  // nothing about a total tells you the parts got shorter.
  for (const cik of Object.keys(before.funds ?? {})) {
    const b = before.funds[cik];
    const a = after.funds?.[cik];
    if (!a) {
      regressions.push(`fund ${cik} vanished (had ${b.quarters} quarters)`);
      continue;
    }
    if (a.quarters < b.quarters) {
      regressions.push(`fund ${cik} lost ${b.quarters - a.quarters} quarter(s): ${b.quarters} -> ${a.quarters}`);
    }
    if (b.newest && (!a.newest || a.newest < b.newest)) {
      regressions.push(`fund ${cik} newest quarter went backwards: ${b.newest} -> ${a.newest ?? "none"}`);
    }
  }

  return { regressions, notes };
}

/** Build a fingerprint from a manifest and a set of fund summaries. */
export function fingerprint(manifest, fundSummaries, takenAt) {
  const periods = {};
  for (const p of manifest?.periods ?? []) {
    periods[p.period] = { funds: p.funds ?? 0, filings: p.filings ?? 0 };
  }
  const funds = {};
  for (const [cik, summary] of Object.entries(fundSummaries ?? {})) {
    const series = summary?.data?.series ?? summary?.series ?? [];
    const sorted = series.map((s) => s.period).filter(Boolean).sort();
    funds[cik] = { quarters: sorted.length, newest: sorted.at(-1) ?? null };
  }
  return {
    takenAt,
    buildId: manifest?.buildId ?? null,
    filers: manifest?.counts?.filers ?? 0,
    periods,
    funds,
  };
}
