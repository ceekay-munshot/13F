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
export function compareFingerprints(before, after, { tolerance = DEFAULT_TOLERANCE, expect = [] } = {}) {
  // NAMED, NARROW EXPECTATIONS — never a blanket override.
  //
  // `periods[].funds` was a Math.max ratchet over whatever the filings feed ever
  // saw, so it over-stated every quarter (Q2 2026: 10,765 claimed against 8,428
  // managers actually holding it). Correcting a fabricated number DOWNWARD is
  // indistinguishable, to this gate, from losing data — which is the gate
  // working, not failing.
  //
  // So the one number being corrected can be named, and ONLY that number is
  // downgraded to a note. Every other check stays armed: the per-fund checks
  // below, which are the ones that would have caught the 2026-08-20 outage, are
  // untouched and still prove no fund lost a quarter.
  const expected = new Set(Array.isArray(expect) ? expect : [expect]);
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
      const msg = `quarter ${period} fell from ${b.funds} funds to ${a.funds}`;
      if (expected.has("period-funds")) notes.push(`${msg} — expected: the count was a ratchet and is now counted`);
      else regressions.push(msg);
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

  // ---- the fund search index ----------------------------------------------
  //
  // Aggregate, because storing nine thousand rows in every baseline would make
  // the artifact bigger than what it describes. The two aggregates are chosen so
  // that the failure which was live cannot hide in them: total quarters
  // advertised, and how many managers sit at each newest-quarter.
  const bi = before.index, ai = after.index;
  if (bi && bi.rows && ai === null) {
    notes.push("fund search index could not be read this time — not compared, and not counted as a pass");
  } else if (bi && bi.rows) {
    if (!ai || !ai.rows) {
      regressions.push("the fund search index disappeared — no manager can be found by name");
    } else {
      if (ai.rows < bi.rows) {
        regressions.push(`fund search index lost ${bi.rows - ai.rows} manager(s): ${bi.rows} -> ${ai.rows}`);
      }
      if (ai.quarterSum < bi.quarterSum) {
        regressions.push(
          `fund search index is advertising ${bi.quarterSum - ai.quarterSum} fewer quarter(s) in total ` +
          `(${bi.quarterSum} -> ${ai.quarterSum}) — managers are claiming less history than they had`,
        );
      }
      // COUNT MANAGERS AT OR AFTER EACH QUARTER, NOT EXACTLY AT IT.
      //
      // The first version bucketed by exact newest-quarter and flagged any
      // bucket shrinking. It fired on the repair that fixed 7,449 managers:
      // "7,250 no longer report 2026-03-31 as their newest" — because they now
      // report 2026-06-30. They moved FORWARD, which is the whole point, and the
      // check read it as loss.
      //
      // Cumulative is the measure that means what was intended. A manager moving
      // Q1 -> Q2 leaves "at least Q1" unchanged and raises "at least Q2". Only a
      // genuine move BACKWARDS lowers any bucket.
      const atLeast = (buckets, from) =>
        Object.entries(buckets ?? {})
          .filter(([p]) => p !== "none" && p >= from)
          .reduce((a, [, n]) => a + n, 0);

      for (const period of Object.keys(bi.byNewest ?? {})) {
        if (period === "none") continue;
        const was = atLeast(bi.byNewest, period);
        const now = atLeast(ai.byNewest, period);
        if (now < was) {
          regressions.push(
            `fund search index: ${was - now} manager(s) whose newest quarter was ${period} or later now ` +
            `report an older one (${was} -> ${now}) — the site would say they have not filed`,
          );
        }
      }
    }
  }

  return { regressions, notes };
}

/** Build a fingerprint from a manifest and a set of fund summaries. */
export function fingerprint(manifest, fundSummaries, takenAt, filerIndex) {
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
  // THE FUND SEARCH INDEX, which this gate did not look at and should have.
  //
  // It was built to enforce "a publish may add and it may correct, it may not
  // subtract", and then watched only the manifest and a sample of fund
  // summaries. meta/filers.json was subtracting the whole time: 853 of the 987
  // managers the same-day job had touched were advertising fewer quarters in
  // search than they actually held, because a two-quarter run's row replaced a
  // four-quarter one wholesale.
  //
  // Summarised rather than stored row by row — nine thousand rows in every
  // baseline would make the artifact larger than the thing it describes.
  //
  // NOT MEASURED is a third state, distinct from measured-as-empty. A failed
  // fetch passes null here, and recording that as zero rows would report "the
  // fund search index disappeared" — every manager gone — out of a network
  // blip. The same distinction the baseline itself gets.
  const index = filerIndex == null ? null : { rows: 0, quarterSum: 0, byNewest: {} };
  for (const r of (index && filerIndex?.data) || []) {
    index.rows++;
    index.quarterSum += Number(r.periods) || 0;
    const k = r.latestPeriod ?? "none";
    index.byNewest[k] = (index.byNewest[k] ?? 0) + 1;
  }

  return {
    takenAt,
    buildId: manifest?.buildId ?? null,
    filers: manifest?.counts?.filers ?? 0,
    periods,
    funds,
    index,
  };
}
