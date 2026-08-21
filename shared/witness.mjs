// shared/witness.mjs
//
// The judgement half of the independent witness. scripts/witness.mjs does the
// fetching; this decides what the two answers mean.
//
// Split for the same reason regression.mjs is split from regression-gate.mjs:
// the fetching cannot be unit-tested and the judgement must be. Every rule below
// came from a filing that broke the obvious version of it.

/** A filer states value in whole dollars only from schema X0202 onward. */
export const DOLLARS_SCHEMA = "X0202";

/**
 * The statutory 13F threshold, and the witness's tiebreak on units.
 *
 * 3.4% of filers declare the dollars schema and then write thousands anyway, so
 * the declaration is a hint rather than an answer. The tiebreak is the law, not
 * anything of ours: a manager must file once it holds $100,000,000 in section
 * 13(f) securities, so a cover page that reads as $8.9M in dollars cannot be in
 * dollars — at that size there would be no filing to read.
 *
 * Aspex Management filed exactly this for 2026-06-30: schemaVersion X0202, a
 * cover total of 8,891,270, and billions under management.
 */
export const FILING_THRESHOLD_USD = 100_000_000;

/**
 * Both sides are the same integer number of dollars, so exact equality is the
 * right expectation. The tolerance absorbs only the rounding introduced when a
 * cover page stated in thousands is scaled back up: one dollar per thousand.
 */
export const TOLERANCE_PCT = 0.001;

/**
 * How long after a filing lands on EDGAR before its absence is a fault.
 *
 * During filing season managers file continuously, and the same-day job runs
 * daily, so "they filed this morning and we do not have it yet" is the pipeline
 * working, not failing. Two days is one full cycle plus a spare.
 *
 * Past that it is a real gap: Nuveen filed for 2026-06-30 on 2026-08-11 and was
 * still missing from the dashboard ten days later. This check found it.
 */
export const INGEST_GRACE_DAYS = 2;

export function coverReadings(rawTotal, schemaVersion) {
  if (!Number.isFinite(rawTotal)) return null;
  const isDollars = String(schemaVersion) === DOLLARS_SCHEMA;
  const declaredUsd = isDollars ? rawTotal : rawTotal * 1000;
  return {
    declaredUsd,
    declaredUnits: isDollars ? "dollars" : "thousands",
    alternateUsd: isDollars ? rawTotal * 1000 : rawTotal,
    alternateUnits: isDollars ? "thousands" : "dollars",
    declaredIsBelowFilingThreshold: declaredUsd < FILING_THRESHOLD_USD,
  };
}

const near = (a, b) => (b ? (Math.abs(a - b) / b) * 100 : Infinity) <= TOLERANCE_PCT;
const fmt = (n) => (n == null ? "—" : `$${(n / 1e9).toFixed(3)}B`);

/**
 * Compare one fund-quarter against the SEC's own filings.
 *
 * @param {object}   ours      our published series entry for the period, or null
 * @param {object[]} filings   every 13F EDGAR holds for (cik, period)
 * @param {Function} readCover async (accession) => cover readings, called at
 *                             most once and only when a comparison is possible
 */
export async function judge({ name, period, ours, filings, readCover, asOf = new Date() }) {
  const holdings = filings.filter((f) => f.form.startsWith("13F-HR"));
  const notices = filings.filter((f) => f.form.startsWith("13F-NT"));
  const said = (n) => `${n} position${n === 1 ? "" : "s"}`;

  // No holdings table. Two situations that must never be reported as one:
  // Pershing Square filed a NOTICE for 2026-06-30 — a filing that says another
  // manager reports its holdings. Calling that "did not file" sends someone
  // hunting for a filing that is sitting on EDGAR.
  if (!holdings.length) {
    if (ours && ours.positions > 0) {
      return {
        verdict: "disagree",
        name,
        what: notices.length
          ? `we show ${said(ours.positions)} worth ${fmt(ours.reportedTotalUsd)}, but for ${period} this ` +
            `manager filed a NOTICE (${notices.at(-1).form}) — its holdings are reported by another manager, ` +
            `so we should be showing the notice state, not a portfolio.`
          : `we show ${said(ours.positions)} worth ${fmt(ours.reportedTotalUsd)}, but EDGAR has no 13F of ` +
            `any kind from this manager for ${period}.`,
      };
    }
    return {
      verdict: "not-comparable",
      name,
      why: notices.length
        ? `filed a notice (${notices.at(-1).form}) for ${period} — no holdings table to compare, correctly`
        : `no 13F filed for ${period}`,
    };
  }

  // They filed and we are not showing it. This is the outage shape, and the one
  // a client notices first: their fund's page saying it has not reported yet.
  if (!ours) {
    const acceptedAt = new Date(holdings.at(-1).accepted);
    const daysOld = (asOf - acceptedAt) / 86_400_000;
    const when = String(holdings.at(-1).accepted).slice(0, 10);
    const forms = holdings.map((h) => h.form).join(", ");
    if (daysOld <= INGEST_GRACE_DAYS) {
      return {
        verdict: "not-comparable",
        name,
        why: `filed ${forms} for ${period} on ${when}, ${daysOld < 1 ? "today" : `${Math.floor(daysOld)}d ago`} ` +
             `— inside the ${INGEST_GRACE_DAYS}-day ingest window, so not yet a gap`,
      };
    }
    return {
      verdict: "disagree",
      name,
      what: `EDGAR has ${forms} for ${period} (accepted ${when}, ${Math.floor(daysOld)} days ago), but our ` +
            `dashboard has no ${period} at all.`,
    };
  }

  // Amended. The period's true total is a FOLD of several cover pages, and the
  // fold is the thing under test. Refuse to judge, and say so — "no finding" and
  // "clean" being the same output is how prune stayed invisible for its life.
  if (holdings.length > 1) {
    return {
      verdict: "not-comparable",
      name,
      why: `${holdings.length} filings for ${period} (${holdings.map((h) => h.form).join(", ")}) — ` +
           `the period total is a fold, which is the thing under test`,
    };
  }

  const cover = await readCover(holdings[0].accession);
  if (!cover) {
    return { verdict: "not-comparable", name, why: `no usable tableValueTotal on ${holdings[0].accession}` };
  }

  // THE COMPARISON: our sum of their rows, against their own declared total.
  // Our rows come from the DERA quarterly data set; this total is hand-stated on
  // the manager's cover page. Agreement means units, duplicate-row aggregation,
  // the amendment fold and the quarter mapping are all correct at once.
  const oursSum = (ours.valueLongUsd ?? 0) + (ours.valueOptionsUsd ?? 0);

  let matched = null;
  if (near(oursSum, cover.declaredUsd)) matched = cover.declaredUsd;
  else if (near(oursSum, cover.alternateUsd) && cover.declaredIsBelowFilingThreshold) matched = cover.alternateUsd;

  if (matched == null) {
    // Name the SHAPE of the error, not only its size. A factor of exactly 1000
    // is a unit slip and nothing else; saying so turns a number nobody can act
    // on into a one-line diagnosis.
    const ratio = cover.declaredUsd ? oursSum / cover.declaredUsd : 0;
    let shape = "";
    if (Math.abs(ratio - 1000) < 1) shape = " — a factor of 1000: we read their thousands as dollars.";
    else if (Math.abs(ratio - 0.001) < 1e-6) shape = " — a factor of 1/1000: we read their dollars as thousands.";
    else if (ratio > 0 && ratio < 1) {
      shape = ` — we are ${((1 - ratio) * 100).toFixed(1)}% short, which is what dropping duplicate rows ` +
              `instead of summing them looks like.`;
    }
    return {
      verdict: "disagree",
      name,
      what: `we say ${fmt(oursSum)}, their own cover page says ${fmt(cover.declaredUsd)} ` +
            `(${cover.declaredUnits}, ${holdings[0].accession})${shape}`,
    };
  }

  // One-sided and therefore always valid: we aggregate duplicate rows, so our
  // position count may be BELOW their entry count and usually is. Above it is
  // impossible — that would mean inventing holdings.
  if (cover.entries && ours.positions > cover.entries) {
    return {
      verdict: "disagree",
      name,
      what: `we show ${said(ours.positions)} but their cover page declares only ${cover.entries} table ` +
            `entries. Aggregating duplicate rows can only ever reduce that count.`,
    };
  }

  return {
    verdict: "agree",
    name,
    value: matched,
    positions: ours.positions,
    entries: cover.entries,
    // The filer wrote the other unit. Our number is right and theirs is
    // mislabelled — surfaced as a fact about the filing, never as a pass we
    // quietly granted ourselves.
    misdeclaredUnits:
      matched === cover.alternateUsd
        ? `${name} declares schema ${cover.declaredUnits === "dollars" ? DOLLARS_SCHEMA : "pre-" + DOLLARS_SCHEMA} ` +
          `but wrote its cover total in ${cover.alternateUnits} (${holdings[0].accession}). Read as declared it ` +
          `would be ${fmt(cover.declaredUsd)}, below the $100M threshold that compels a 13F at all. ` +
          `We publish ${fmt(oursSum)}.`
        : null,
  };
}
