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
 * How far below the cover total our long+options figure may sit when we cannot
 * account for the difference exactly.
 *
 * The cover page totals EVERY row. We exclude principal-amount rows — bonds and
 * notes, whose "shares" figure is a face value — from the long-equity
 * denominator by design. Artifacts built before valuePrnUsd existed cannot say
 * how much that was, so those funds get a band instead of an equality.
 *
 * The band is set where it separates the two things that actually happen:
 * Nuveen's 28 principal rows are 0.1% of a $419B book, while deduplicating rows
 * that should have been summed understates Cantillon's 2026-Q1 by 38.8%. Two
 * percent sits far above the first and nowhere near the second.
 *
 * It is a weaker check and it is labelled as one in the output, so it cannot
 * quietly become the normal case.
 */
export const UNEXPLAINED_SHORTFALL_PCT = 2;

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
 * Decide which quarter to compare for one fund, and whether a quarter is missing.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS PER-FUND AND NOT ONE GLOBAL QUARTER
 * ---------------------------------------------------------------------------
 * The first version took the newest quarter in the manifest and asked every fund
 * about it. That works only while the newest quarter is one the watchlist has
 * actually filed for, and it stops working the moment ANY of the 9,268 funds
 * files early for the next one — the manifest gains that quarter, the witness
 * asks fourteen managers about a period none of them has reached, every one
 * comes back not-comparable, and the run exits 1 for having compared nothing.
 *
 * Concretely: Q3 2026 ends 30 September and is not due until 14 November. From
 * the first early filer in October until the watchlist files in November, the
 * ingest would have gone red every two hours for six weeks — while being
 * completely healthy.
 *
 * So each fund is asked about ITS OWN newest quarter, and the two questions the
 * witness actually cares about are separated:
 *
 *   1. Is a quarter MISSING? — decided against EDGAR's newest holdings report
 *      for that fund, whatever quarter that is.
 *   2. Do the NUMBERS agree? — decided on the newest quarter both sides have,
 *      because a quarter only one side has cannot be compared.
 *
 * Neither question needs a global period, and neither breaks when the calendar
 * turns over.
 */
export function chooseComparisonPeriod(ourPeriods, filings, asOf = new Date()) {
  const hrPeriods = [...new Set(filings.filter((f) => f.form.startsWith("13F-HR")).map((f) => f.period))].sort();
  const ours = [...new Set(ourPeriods)].sort();
  const theirNewest = hrPeriods.at(-1) ?? null;
  const ourNewest = ours.at(-1) ?? null;

  // 1. A quarter EDGAR has and we do not, older than the ingest window.
  let missing = null;
  if (theirNewest && (!ourNewest || theirNewest > ourNewest)) {
    const accepted = filings
      .filter((f) => f.period === theirNewest && f.form.startsWith("13F-HR"))
      .map((f) => f.accepted)
      .sort()
      .at(-1);
    const daysOld = (asOf - new Date(accepted)) / 86_400_000;
    if (daysOld > INGEST_GRACE_DAYS) missing = { period: theirNewest, accepted, daysOld };
  }

  // 2. The newest quarter both sides hold.
  const shared = hrPeriods.filter((p) => ours.includes(p));
  return { compare: shared.at(-1) ?? null, missing, theirNewest, ourNewest };
}

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
  //
  // The cover page totals EVERY row, so principal-amount rows have to be added
  // back: we hold them out of the long-equity denominator on purpose, because a
  // bond's "shares" figure is a face value and summing it with share counts is
  // meaningless. Nuveen's 2026-06-30 has 28 of them — $433M against a $419B
  // book — and without this it reads as a 0.1% hole in our aggregation.
  const exact = ours.valuePrnUsd != null;
  const oursSum = (ours.valueLongUsd ?? 0) + (ours.valueOptionsUsd ?? 0) + (ours.valuePrnUsd ?? 0);

  let matched = null;
  if (near(oursSum, cover.declaredUsd)) matched = cover.declaredUsd;
  else if (near(oursSum, cover.alternateUsd) && cover.declaredIsBelowFilingThreshold) matched = cover.alternateUsd;

  // Artifacts built before valuePrnUsd existed cannot account for those rows, so
  // they get a band rather than an equality — and are reported as such.
  let approximate = false;
  if (matched == null && !exact) {
    for (const [candidate, below] of [
      [cover.declaredUsd, false],
      [cover.alternateUsd, cover.declaredIsBelowFilingThreshold],
    ]) {
      if (!candidate || (candidate === cover.alternateUsd && !below)) continue;
      const shortfallPct = ((candidate - oursSum) / candidate) * 100;
      if (shortfallPct >= 0 && shortfallPct <= UNEXPLAINED_SHORTFALL_PCT) {
        matched = candidate;
        approximate = true;
        break;
      }
    }
  }

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
    period,
    value: matched,
    positions: ours.positions,
    entries: cover.entries,
    // Whether this fund got the exact equality or only the band. Surfaced so a
    // pipeline that quietly stopped emitting valuePrnUsd would show up as every
    // fund downgrading to the weaker check, rather than as nothing at all.
    exact: !approximate,
    shortfallUsd: approximate ? matched - oursSum : 0,
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
