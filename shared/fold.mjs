// shared/fold.mjs
//
// The amendment fold and quarter-on-quarter change computation, as pure
// functions with no I/O. Pure so the fixture suite can pin them against real
// filings — this file is where a regression would silently ship wrong numbers
// to a client, so it must be the most-tested code in the repo.

// ---------------------------------------------------------------------------
// The amendment fold
// ---------------------------------------------------------------------------

/**
 * Fold every filing for one (cik, period) into the holdings that were actually
 * in force, applying amendments in acceptance order.
 *
 * @param {Array<{accession_number, acceptance_datetime, is_amendment, amendment_type, rows}>} filings
 * @returns {{rows: Array, accessions: string[], warnings: Array<{code, detail}>}}
 *
 * Why an ORDERED LEFT FOLD and not a per-amendment classification:
 *
 *   RESTATEMENT   the amendment replaces the original in full. The SEC's own
 *                 guidance: "you must resubmit your entire filing, as
 *                 corrected ... your amended filing will supersede your
 *                 original filing."
 *   NEW HOLDINGS  the amendment is ADDITIVE — it adds entries previously
 *                 withheld, most often when confidential treatment expires or
 *                 is denied. Its summary page reflects ONLY the amendment.
 *
 * A RESTATEMENT can arrive AFTER a NEW HOLDINGS and must wipe it. That is why
 * an amendment cannot be classified in isolation and why the fold must be
 * ordered by acceptance_datetime — not by filing_date, which is not granular
 * enough (Cantillon filed three restatements for three different periods on a
 * single day, 2026-02-17).
 *
 * Amendments arrive arbitrarily late: Berkshire amended a 2023-09-30 period on
 * 2024-05-15 (~8 months); Jefferies amended 2021-Q1 in September 2023 (~29
 * months). There is no SEC-stated limit. Derived tables must therefore be
 * invalidatable, never append-only.
 *
 * THE LABEL IS NOT ALWAYS TRUE. Some filers tick "adds new holdings" on what is
 * plainly a full re-filing of the whole book — see `repeatedShare` below for the
 * measurement and the rule. Trusting the label there adds the book to itself.
 *
 * THE RESULT HAS ONE ROW PER POSITION. Each filing's rows were aggregated and
 * weighted on their own; a genuine addition can name a security the book already
 * holds (the withheld part of a partly confidential position), and its weights
 * are shares of the AMENDMENT's total, not the quarter's. So whenever the fold
 * really did combine two filings, the result is merged and re-weighted here.
 */
export function foldFilings(filings) {
  const warnings = [];

  const ordered = [...filings].sort((a, b) => {
    const ta = a.acceptance_datetime || "";
    const tb = b.acceptance_datetime || "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    // Deterministic tiebreak so a fold is reproducible, plus a warning: two
    // filings accepted in the same second cannot be ordered from the data.
    return String(a.accession_number).localeCompare(String(b.accession_number));
  });

  for (let i = 1; i < ordered.length; i++) {
    if (
      ordered[i].acceptance_datetime &&
      ordered[i].acceptance_datetime === ordered[i - 1].acceptance_datetime
    ) {
      warnings.push({
        code: "fold_tie",
        detail: `${ordered[i - 1].accession_number} and ${ordered[i].accession_number} share an acceptance timestamp`,
      });
    }
  }

  let rows = [];
  const accessions = [];
  // What the fold actually did with each filing, in `ordered` order: "replace"
  // or "add". The cover-page total follows these, so it cannot disagree with
  // the rows about which filings make up the quarter.
  const applied = [];
  // True while the book holds rows from more than one filing — the only case in
  // which it can carry two rows for one position, or weights computed against
  // some other total. A later replacement makes it one filing again.
  let combined = false;

  for (const f of ordered) {
    accessions.push(f.accession_number);

    if (!f.is_amendment) {
      // An original seeds the set. A second original for the same period is
      // unusual but the later one wins, consistent with restatement semantics.
      rows = [...(f.rows || [])];
      applied.push("replace");
      combined = false;
      continue;
    }

    const type = (f.amendment_type || "").toUpperCase();

    if (type === "RESTATEMENT") {
      rows = [...(f.rows || [])];
      applied.push("replace");
      combined = false;
    } else if (type === "NEW HOLDINGS") {
      const repeat = repeatedShare(rows, f.rows || []);
      if (
        repeat.share >= RELISTED_BOOK_SHARE ||
        repeat.sameSharesValueShare >= RELISTED_BOOK_SHARE ||
        repeat.sameLinesValueShare >= RELISTED_BOOK_SHARE
      ) {
        // A full re-filing wearing the wrong label. Taken as what it is, and
        // said out loud, because it overrides what the filer wrote.
        const pct = (x) => `${(x * 100).toFixed(0)}%`;
        warnings.push({
          code: "new_holdings_relists_book",
          detail:
            `${f.accession_number} is labelled NEW HOLDINGS but repeats ${repeat.repeated} of the ` +
            `${repeat.of} positions already reported, ` +
            `${pct(repeat.sameSharesValueShare)} of the book by value at identical share counts, ` +
            `${pct(repeat.sameLinesValueShare)} line for line whatever the security code; ` +
            `treated as RESTATEMENT`,
        });
        rows = [...(f.rows || [])];
        applied.push("replace");
        combined = false;
      } else {
        if (rows.length && (f.rows || []).length) combined = true;
        rows = [...rows, ...(f.rows || [])];
        applied.push("add");
      }
    } else {
      // Neither value present. Defaulting to RESTATEMENT is the safer of two
      // bad options — treating an unknown amendment as additive would
      // double-count a full restatement, which is the louder error. Flagged so
      // a human can check rather than silently trusted.
      warnings.push({
        code: type ? "unknown_amendment_type" : "amendment_type_missing",
        detail: `${f.accession_number}: amendment_type=${JSON.stringify(f.amendment_type)}; treated as RESTATEMENT`,
      });
      rows = [...(f.rows || [])];
      applied.push("replace");
      combined = false;
    }
  }

  if (ordered.length && ordered[0].is_amendment) {
    warnings.push({
      code: "origin_missing",
      detail: `earliest filing for this period (${ordered[0].accession_number}) is an amendment; the original was not ingested`,
    });
  }

  // Only when two filings were really combined. Everywhere else the rows are
  // one filing's, already aggregated and weighted by the parser, and passing
  // them through untouched keeps every other artifact byte-for-byte the same.
  if (combined) rows = mergeHoldings(rows);

  return { rows, accessions, warnings, reportedTotalUsd: foldReportedTotal(ordered, applied) };
}

// ---------------------------------------------------------------------------
// A "NEW HOLDINGS" amendment that is really a full re-filing
// ---------------------------------------------------------------------------

/**
 * At or above this share of the book, a NEW HOLDINGS amendment is read as a full
 * re-filing rather than an addition. Three measures, any one enough:
 *
 *   POSITIONS  the share of the positions already reported that the amendment
 *              names again, at any size.
 *   VALUE      the share of the book's value that the amendment repeats with
 *              the SAME share count — the same holding, reported again.
 *   LINES      the share of the book's value in lines the amendment repeats to
 *              the dollar AND the share, whatever security code it puts on
 *              them — a re-send that corrects the codes but not the numbers.
 *
 * MEASURED, 17 Nov 2026, twice, each amendment against the book before it.
 *
 * 101 amendments read from EDGAR — those the dashboard listed for Q4 2025 to Q3
 * 2026, plus those behind the funds whose Q3 exit lists showed doubles. 42 were
 * re-filings, 59 additions. Arbiter Partners' 2026-Q2 original and both its "new
 * holdings" amendments each list the same 42-44 positions worth ~$190M; trusting
 * the label published 127 positions worth $576M, and the one it later sold
 * appeared three times. Arini Capital's original omitted a $491M position; its
 * amendment added it AND re-listed the other 27, so each of those 27 appeared
 * twice with weights a factor of two apart (CZR: 7.40% of the incomplete book,
 * 3.67% of the whole one — the right one). CIK 0001032814, 2026-Q2, is why VALUE
 * exists: it repeats only 17 of 53 positions, but they are its 17 largest, share
 * for share — 99% of a $3.78B book — and adding them would have doubled it.
 *
 * All 247 in the SEC's quarterly bulk data sets for Dec 2024-Feb 2025 and Sep
 * 2025-May 2026 that had a book before them, 212 fund-quarters:
 *
 *   67 re-filings. 65 repeat 58-100% of the positions. The other two are why
 *     LINES exists. GFS Advisors' 2026-Q1 original put its security codes on the
 *     wrong lines (Adobe's value and share count under a Vanguard fund's code);
 *     the amendment fixed the codes and changed no number, $784,681,342 both
 *     times. Matched by code, only 39% of positions recur and the quarter came
 *     out doubled. Line for line, 98.5% of the book's value does. Strategic
 *     Wealth Investment Group, 2024-Q4, is the same shape: 31% by code, 98.2%
 *     line for line, $905.1M both times.
 *
 *   180 additions. Most repeat nothing: they add positions that were
 *     withheld. Some name securities the book already holds — the withheld part
 *     of a partly disclosed position — at most 37% of the positions (HighPoint
 *     Advisor Group, 2025-Q4). The highest on VALUE and LINES is 22%: ECP
 *     ControlCo, whose one-line amendments each name one position of a
 *     four-position book again at the same size.
 *
 * Half sits inside every gap. All three are shares of the BOOK, not of the
 * amendment: an addition of five rows that all name existing securities is 100%
 * repeated by its own measure and still an addition.
 */
export const RELISTED_BOOK_SHARE = 0.5;

/**
 * The key a position is unique on within one filing — the same three fields
 * aggregateHoldings groups by in scripts/_sec-parse.mjs. Never other_manager.
 */
function positionKey(h) {
  return `${h.cusip}|${h.put_call ?? ""}|${h.ssh_prnamt_type ?? "SH"}`;
}

/** Value and shares per position, summed, so a book holding two parts of one position compares as one. */
function byPosition(rows) {
  const out = new Map();
  for (const h of rows) {
    const k = positionKey(h);
    const o = out.get(k) ?? { value: 0, shares: 0 };
    o.value += h.value_usd || 0;
    o.shares += h.ssh_prnamt || 0;
    out.set(k, o);
  }
  return out;
}

/**
 * How much of the book an amendment repeats — see RELISTED_BOOK_SHARE.
 *
 * @returns {{repeated: number, of: number, share: number, sameSharesValueShare: number, sameLinesValueShare: number}}
 *   `repeated` of the book's `of` positions also appear in the amendment, and
 *   `share` is that fraction. `sameSharesValueShare` is the fraction of the
 *   book's value held in positions the amendment repeats at the identical share
 *   count. `sameLinesValueShare` is the fraction of the book's value in lines
 *   the amendment repeats with the identical value and share count, whatever
 *   code either filing put on them; each amendment line answers for one book
 *   line at most. All zero for an empty book: an amendment with nothing before
 *   it repeats nothing.
 */
export function repeatedShare(book, amendmentRows) {
  const before = byPosition(book);
  if (!before.size) return { repeated: 0, of: 0, share: 0, sameSharesValueShare: 0, sameLinesValueShare: 0 };
  let bookValue = 0;
  for (const b of before.values()) bookValue += b.value;

  let repeated = 0;
  let sameSharesValue = 0;
  for (const [k, a] of byPosition(amendmentRows)) {
    const b = before.get(k);
    if (!b) continue;
    repeated++;
    if (a.shares === b.shares) sameSharesValue += b.value;
  }
  return {
    repeated,
    of: before.size,
    share: repeated / before.size,
    sameSharesValueShare: bookValue > 0 ? sameSharesValue / bookValue : 0,
    sameLinesValueShare: bookValue > 0 ? sameLinesValue(book, amendmentRows) / bookValue : 0,
  };
}

/** The book's value in lines the amendment repeats to the dollar and the share, matched one to one. */
function sameLinesValue(book, amendmentRows) {
  const lineKey = (h) => `${h.value_usd || 0}|${h.ssh_prnamt || 0}`;
  const unmatched = new Map();
  for (const h of amendmentRows) unmatched.set(lineKey(h), (unmatched.get(lineKey(h)) ?? 0) + 1);
  let value = 0;
  for (const h of book) {
    const k = lineKey(h);
    const left = unmatched.get(k) ?? 0;
    if (!left) continue;
    unmatched.set(k, left - 1);
    value += h.value_usd || 0;
  }
  return value;
}

// ---------------------------------------------------------------------------
// One row per position, weighted against the whole quarter
// ---------------------------------------------------------------------------

/**
 * Set `weight_pct` and `implied_price` on every holding, against the long-equity
 * total of exactly these holdings. Mutates and returns its argument.
 *
 * The parser's aggregateHoldings calls this too, so there is one formula. It
 * used to live only there, run once per FILING — which is right until the fold
 * puts two filings into one book, when every weight in the second is a share of
 * a total that is no longer the quarter's.
 *
 * Long equity only for the denominator — never a denominator that mixes option
 * notional with equity market value. Post-2023 filers are inconsistent about
 * whether an option row's value is fair value or underlying notional, and large
 * filers commonly report notional, so a mixed denominator inflates the book and
 * deflates every weight by an amount that varies per fund.
 */
export function weighHoldings(holdings) {
  const valueLong = holdings
    .filter((h) => h.put_call === "" && h.ssh_prnamt_type === "SH")
    .reduce((a, h) => a + h.value_usd, 0);

  for (const h of holdings) {
    // NULLIF-equivalent: 167 of 315,211 measured rows have value = 0, rare
    // enough to miss in fixtures and common enough to appear in production.
    h.weight_pct = valueLong > 0 ? (h.value_usd / valueLong) * 100 : null;
    h.implied_price =
      h.put_call === "" && h.ssh_prnamt_type === "SH" && h.ssh_prnamt > 0
        ? h.value_usd / h.ssh_prnamt
        : null;
  }
  return holdings;
}

/**
 * Collapse a combined book to one row per position and re-weight it.
 *
 * Two rows for one position after a genuine addition are two PORTIONS of it —
 * the part reported first and the part that was withheld — so they are summed,
 * exactly as aggregateHoldings sums the portions of a position within one
 * filing. Identity fields are taken from the first row that has them.
 *
 * WHY THIS MATTERS DOWNSTREAM. computeChanges reads the book through maps keyed
 * on the position, which keep one row, but walks the prior book row by row to
 * find exits. A position held twice was therefore matched once and exited twice
 * — the doubled "Exited" list — each copy carrying a weight against a different
 * filing's total.
 *
 * Never mutates its input: the per-filing rows also feed the filings list.
 */
export function mergeHoldings(rows) {
  const byKey = new Map();
  for (const h of rows) {
    const k = positionKey(h);
    const acc = byKey.get(k);
    if (!acc) {
      byKey.set(k, { ...h });
      continue;
    }
    acc.value_usd += h.value_usd || 0;
    acc.ssh_prnamt += h.ssh_prnamt || 0;
    for (const f of ["voting_sole", "voting_shared", "voting_none", "row_count"]) {
      if (acc[f] != null || h[f] != null) acc[f] = (acc[f] || 0) + (h[f] || 0);
    }
    for (const f of ["name_of_issuer", "title_of_class", "figi", "ticker", "issuerId"]) {
      if (acc[f] == null && h[f] != null) acc[f] = h[f];
    }
  }
  return weighHoldings([...byKey.values()]);
}

/**
 * The period's REPORTED total — the cover-page figure, folded on exactly the
 * rules the rows are folded on.
 *
 * It has to live here, next to the row fold, because it is the same question
 * asked of a different field and the two must never disagree. The caller used to
 * answer it with `foldable[foldable.length - 1].table_value_total` — the LAST
 * ELEMENT OF THE INPUT ARRAY. The submissions API returns filings newest-first,
 * so for every amended period that picked the OLDEST filing: the original, the
 * one the amendment exists to supersede. Verified live — Berkshire's 2025-03-31
 * original reports 110 entries and $258.7bn where the amendment restates it, and
 * Cantillon's three 2026-02-17 restatements sit ahead of their originals in the
 * array exactly the same way.
 *
 * The line immediately after it in the caller already sorted the same array to
 * get the latest acceptance, which is what makes this a slip rather than a
 * judgement: array position was never acceptance order.
 *
 * And "take the newest" would still have been wrong. A NEW HOLDINGS amendment's
 * cover total covers only the entries it adds, so the period's reported total is
 * the original plus each addition — the same accumulate-or-reset the rows get.
 *
 * "The same" literally: it is handed what the row fold DID with each filing, not
 * the filing's label. A "new holdings" amendment that was really a full
 * re-filing reset the rows, so it resets the total too — Arbiter Partners'
 * 2026-Q2 read $576M, three copies of a $190M book added together.
 *
 * @param {Array} ordered  filings sorted oldest-first by acceptance
 * @param {Array<"replace"|"add">} applied  what the row fold did with each
 * @returns {number|null}
 */
function foldReportedTotal(ordered, applied) {
  let total = null;
  ordered.forEach((f, i) => {
    const v = f.table_value_total;
    if (v == null) return;
    if (applied[i] === "add") total = (total ?? 0) + v;
    else total = v; // an original, a restatement, or an unclassified amendment
  });
  return total;
}

// ---------------------------------------------------------------------------
// Quarter-on-quarter changes
// ---------------------------------------------------------------------------

export const PRIOR_STATE = {
  OK: "PRIOR_OK",
  IS_NT: "PRIOR_IS_NT",
  MISSING: "PRIOR_MISSING",
  NONE: "NO_PRIOR",
};

/** Ratios a split plausibly produces. */
const SPLIT_RATIOS = [2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 30, 50];

function nearSimpleRatio(r) {
  for (const n of SPLIT_RATIOS) {
    if (Math.abs(r - n) / n < 0.01) return n;
    if (Math.abs(r - 1 / n) * n < 0.01) return 1 / n;
  }
  return null;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Detect fund-level structural events that make per-position deltas
 * meaningless. This is the difference between a dashboard a client can trust
 * and one that repeats a reference site's mistake.
 *
 * The motivating real case — Cantillon Capital Management LLC, 2026-Q2:
 * the reference site rendered "-95.40%" on 22 of 27 rows as if they were 22
 * independent sells. Computed from the primary filings, the share ratio
 * Q2/Q1 for 22 of the 27 retained positions falls in [0.04600, 0.04605] —
 * identical to FOUR significant figures, with 16 of them at exactly 0.04605.
 * Twenty-two independent discretionary trades do not produce a constant
 * multiplier to 4sf. It is one structural event (a redemption, an in-kind
 * distribution, or a transfer to a non-reporting vehicle) rendered 22 times.
 *
 * @returns {{event: string|null, detail: object}}
 */
/**
 * The included-manager list as a comparable set, or null when it is UNKNOWN.
 *
 * `null`/`undefined` means nobody recorded it — an artifact written before the
 * list was parsed, or a source that does not carry it. `[]` means the filing was
 * read and named nobody, which is an ANSWER and compares fine. Collapsing the
 * two is what would let an unparsed quarter look like a manager change.
 *
 * Keyed on CIK where there is one, falling back to the normalised name: a filer
 * that omits the CIK still names the manager, and a set that silently dropped
 * those entries would report a change that did not happen.
 */
function managerKeys(list) {
  if (!Array.isArray(list)) return null;
  const out = new Set();
  for (const m of list) {
    if (!m) continue;
    const k = m.cik || (m.name ? String(m.name).trim().toUpperCase() : null);
    if (k) out.add(k);
  }
  return out;
}

export function detectStructuralEvent(current, prior, opts = {}) {
  const detail = {};
  if (!prior || !prior.holdings?.length) return { event: null, detail };

  // ---------------------------------------------------------------------------
  // 0. THE FORM CHANGED, NOT THE PORTFOLIO.
  // ---------------------------------------------------------------------------
  // A 13F cover page lists the OTHER MANAGERS whose positions are included in
  // it. That list is stable quarter to quarter for almost every filer, and when
  // it moves the book moves with it — not because anybody traded, but because
  // the same holdings are now reported on a different form.
  //
  // This is the second piece of evidence the pro-rata detector was missing. It
  // spots that every position moved by one multiplier, which is right for a
  // redemption and wrong for a family of funds re-splitting its holdings across
  // managers; the two are indistinguishable from the numbers alone. The manager
  // list tells them apart, and it costs nothing — it is on a page we already
  // download and parse.
  //
  // Measured case: Pershing Square Inc. reported one position worth $0.57B for
  // 2026-Q1 with no other managers, then fourteen positions worth $19.47B for
  // 2026-Q2 naming six, its operating manager among them — which filed a notice
  // that same quarter pointing back at it. Read as trading, that is "13 new
  // positions bought and 173% turnover". Nothing was bought.
  //
  // TWO CONDITIONS, BOTH REQUIRED. Managers alone would fire on the routine
  // churn of a large family's filings; a book that jumped alone is the REVIEW
  // rule below, which is deliberately vaguer because it has no explanation to
  // offer. Together they are specific enough to name what happened.
  //
  // UNKNOWN IS NOT EMPTY. A filing whose manager list was never parsed arrives
  // as null and this rule sits it out — guessing from an absent list is how a
  // detector starts inventing events.
  const mgrsNow = managerKeys(current.includedManagers);
  const mgrsPrior = managerKeys(prior.includedManagers);
  if (mgrsNow && mgrsPrior) {
    const gained = [...mgrsNow].filter((m) => !mgrsPrior.has(m));
    const lost = [...mgrsPrior].filter((m) => !mgrsNow.has(m));
    const vN = current.value_long_usd ?? 0;
    const vP = prior.value_long_usd ?? 0;
    const pN = current.holdings.length;
    const pP = prior.holdings.length;
    // 1.5x either way. Well clear of ordinary trading, and both measured cases
    // — 34x here, 2.14x for the Mitsubishi entity that consolidated two
    // managers onto its form — are far above it.
    const grew = (vP > 0 && vN / vP >= 1.5) || (pP > 0 && pN / pP >= 1.5);
    const shrank = (vP > 0 && vN / vP <= 1 / 1.5) || (pP > 0 && pN / pP <= 1 / 1.5);

    if (gained.length && grew) {
      return {
        event: "MANAGER_SET_CHANGED",
        detail: {
          ...detail,
          direction: "gained",
          managersGained: gained.length,
          positionsNow: pN, positionsPrior: pP,
          message:
            `This quarter's filing includes ${gained.length} manager` +
            `${gained.length === 1 ? "" : "s"} that the previous one did not, and the ` +
            `book went from ${pP} position${pP === 1 ? "" : "s"} to ${pN}. These positions ` +
            `were reported on another manager's form last quarter, so they are not ` +
            `purchases and this quarter cannot be compared with the one before it.`,
        },
      };
    }
    if (lost.length && shrank) {
      return {
        event: "MANAGER_SET_CHANGED",
        detail: {
          ...detail,
          direction: "lost",
          managersLost: lost.length,
          positionsNow: pN, positionsPrior: pP,
          message:
            `This quarter's filing drops ${lost.length} manager` +
            `${lost.length === 1 ? "" : "s"} the previous one included, and the book went ` +
            `from ${pP} position${pP === 1 ? "" : "s"} to ${pN}. Those positions are now ` +
            `reported on another manager's form, so they are not sales and this quarter ` +
            `cannot be compared with the one before it.`,
        },
      };
    }
  }

  const priorByKey = new Map(prior.holdings.map((h) => [`${h.cusip}|${h.put_call}`, h]));
  const ratios = [];
  for (const h of current.holdings) {
    const p = priorByKey.get(`${h.cusip}|${h.put_call}`);
    if (p && p.ssh_prnamt > 0 && h.ssh_prnamt > 0 && h.ssh_prnamt_type === "SH") {
      ratios.push(h.ssh_prnamt / p.ssh_prnamt);
    }
  }

  // 1. UNIFORM-RATIO — the pro-rata detector.
  //
  // The DISCRIMINATOR is the IQR, not the magnitude. An earlier version also
  // required `median < 0.5`, tuned to the dramatic case where a book shrank
  // ~95%. That gate made the detector miss the ordinary version of the same
  // event: Cantillon's 2026-Q1 filing shows an identical -11.9% across roughly
  // 30 of 38 positions, which is just as clearly one structural event and was
  // being rendered as 30 independent sells.
  //
  // Thirty positions do not move by the same percentage to four significant
  // figures by coincidence, at ANY magnitude. So the only magnitude condition
  // that belongs here is "it moved at all".
  if (ratios.length >= 5) {
    const sorted = [...ratios].sort((a, b) => a - b);
    const med = quantile(sorted, 0.5);
    const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
    detail.retained = ratios.length;
    detail.medianRatio = med;
    detail.iqr = iqr;
    if (med > 0 && iqr < 0.02 * med && Math.abs(1 - med) > 0.02) {
      const pctMoved = Math.abs(1 - med) * 100;
      const direction = med < 1 ? "reduced" : "increased";
      return {
        event: "PRO_RATA_REDUCTION",
        detail: {
          ...detail,
          reductionPct: (1 - med) * 100,
          message:
            `All ${ratios.length} retained positions were ${direction} by an identical ` +
            `~${pctMoved.toFixed(1)}%. A uniform multiplier across every position is ` +
            `characteristic of a subscription, redemption, in-kind transfer or share ` +
            `reclassification — not ${ratios.length} separate trades.`,
        },
      };
    }
  }

  // 2. UNIT SCALE — the late-amendment 1000x case surfacing as a "trade".
  const vNow = current.value_long_usd ?? 0;
  const vPrior = prior.value_long_usd ?? 0;
  if (vPrior > 0 && vNow > 0) {
    const vr = vNow / vPrior;
    detail.valueRatio = vr;
    if (Math.abs(vr - 1000) / 1000 < 0.003 || Math.abs(vr - 0.001) / 0.001 < 0.003) {
      return {
        event: "UNIT_SCALE_CHANGE",
        detail: {
          ...detail,
          message:
            "Reported value changed by almost exactly 1000x between filings — " +
            "this is a units restatement, not a trade.",
        },
      };
    }
  }

  // 3. MAGNITUDE — a catch-all for books that changed shape too much for
  //    position-level deltas to describe.
  const posNow = current.holdings.length;
  const posPrior = prior.holdings.length;
  const valueMoved = vPrior > 0 ? Math.abs(vNow - vPrior) / vPrior : 0;
  const posDropped = posPrior > 0 ? (posPrior - posNow) / posPrior : 0;
  if (valueMoved > 0.8 || posDropped > 0.5) {
    return {
      event: "REVIEW",
      detail: {
        ...detail,
        positionsNow: posNow,
        positionsPrior: posPrior,
        valueMovedPct: valueMoved * 100,
        message:
          `Positions ${posPrior} → ${posNow}, reported value moved ` +
          `${(valueMoved * 100).toFixed(1)}%. Quarter-on-quarter changes may not ` +
          `reflect trading activity.`,
      },
    };
  }

  return { event: null, detail: { ...detail, ...opts } };
}

/**
 * Compute per-position QoQ changes.
 *
 * Three of the four prior-states produce NO deltas at all. "We can't compute
 * changes for Q2 2026 because this manager filed a 13F Notice for Q1 2026" is
 * a correct answer; "27 new positions" is not.
 *
 * @param {{period_end, holdings, value_long_usd}} current
 * @param {{period_end, accession, holdings, value_long_usd}|null} prior
 * @param {string} priorState  one of PRIOR_STATE
 * @param {{confidentialOmitted?: boolean}} [opts]  `confidentialOmitted` marks
 *   the CURRENT filing as incomplete by the filer's own declaration, which
 *   makes an inferred exit unsound — see the note above the exit loop.
 */
export function computeChanges(current, prior, priorState, opts = {}) {
  const confidentialOmitted = Boolean(opts.confidentialOmitted);

  if (priorState !== PRIOR_STATE.OK || !prior) {
    // NOTE the two distinct fields, and why they are not one.
    //
    // `reason` answers "why are there no deltas?" and its domain is the union
    // of PRIOR_STATE codes and structural-event codes. `structuralEvent`
    // answers "did something happen to this portfolio that makes the numbers
    // themselves untrustworthy?" and its domain is ONLY structural events.
    //
    // They used to be the same field. Both ingest paths wrote
    // `structuralEvent: suppressed ? reason : null`, so a perfectly ordinary
    // first-covered quarter published structuralEvent: "NO_PRIOR" — and the
    // Fund view renders that field raw in an amber warning column and paints
    // the value bar amber. Measured on the shipped tree: 16,414 NO_PRIOR and
    // 169 PRIOR_IS_NT against 41 genuine PRO_RATA_REDUCTIONs. The channel
    // reserved for real data-quality warnings was 99.8% noise, which is the
    // same as having no warning channel at all.
    return {
      changes: [],
      suppressed: true,
      reason: priorState,
      structuralEvent: null, // having no prior quarter is not an event
      structural: null,
      exitsWithheld: 0,
    };
  }

  const structural = detectStructuralEvent(current, prior);
  // A pro-rata reduction or a unit restatement makes EVERY per-row delta
  // misleading, so they are withheld wholesale rather than rendered with a
  // footnote nobody reads.
  //
  // EVERY delta means every delta, including the absolute ones. This used to
  // null only the three percentage fields and publish `d_shares` and `d_value`
  // beside them, so the Position changes card's "Δ Value" toggle rendered the
  // withheld comparison in dollars — the same misleading number the percentage
  // was hidden for, in a different unit. A reader ranking Cantillon's Q2-2026 by
  // Δ Value got the full 95.4% redemption laid out as 27 individual sells, which
  // is precisely the reading this suppression exists to prevent.
  const suppressAll =
    structural.event === "PRO_RATA_REDUCTION" ||
    structural.event === "UNIT_SCALE_CHANGE" ||
    structural.event === "MANAGER_SET_CHANGED";

  // A MANAGER CHANGE ALSO WITHHOLDS THE ACTION, WHICH THE OTHER TWO DO NOT.
  //
  // For a pro-rata reduction the direction is still true — every position really
  // was reduced — and only the magnitudes mislead, so TRIMMED stays and the
  // numbers go. Here the direction is the lie: a position that moved onto this
  // form from another one is labelled NEW, which is the word this dashboard uses
  // for "they bought it". Thirteen of Pershing Square Inc.'s fourteen would have
  // read as purchases.
  //
  // So the label is withheld with the numbers, and because summarizeActions
  // counts by label, the quarter reports 0 new and 0 exited rather than a
  // fabricated 13. "We cannot say" is the honest answer and the only one.
  const suppressAction = structural.event === "MANAGER_SET_CHANGED";

  const key = (h) => `${h.cusip}|${h.put_call}`;
  const priorByKey = new Map(prior.holdings.map((h) => [key(h), h]));
  const currentByKey = new Map(current.holdings.map((h) => [key(h), h]));
  const changes = [];

  for (const h of current.holdings) {
    const p = priorByKey.get(key(h));
    const flags = [];

    let action;
    let dShares = null;
    let dSharesPct = null;

    if (!p) {
      action = "NEW";
    } else {
      dShares = h.ssh_prnamt - p.ssh_prnamt;
      const ratio = p.ssh_prnamt > 0 ? h.ssh_prnamt / p.ssh_prnamt : null;

      // A 4:1 split renders as "+300% added" unless prior shares are adjusted.
      // With no split feed the signature is unmistakable: share count moves by
      // a simple ratio WHILE value stays put. Suppress rather than guess — a
      // withheld number beats a wrong one.
      const valueRatio = p.value_usd > 0 ? h.value_usd / p.value_usd : null;
      const simple = ratio != null ? nearSimpleRatio(ratio) : null;
      if (simple != null && valueRatio != null && Math.abs(valueRatio - 1) < 0.15) {
        flags.push("SUSPECTED_SPLIT");
      }

      if (p.ssh_prnamt > 0 && !flags.includes("SUSPECTED_SPLIT")) {
        dSharesPct = ((h.ssh_prnamt - p.ssh_prnamt) / p.ssh_prnamt) * 100;
      }

      if (dShares > 0) action = "ADDED";
      else if (dShares < 0) action = "TRIMMED";
      else action = "HELD";
    }

    // PRN rows are dollars of face value, not shares. Excluded from share math
    // entirely; a "% change in shares" on a bond position is meaningless.
    if (h.ssh_prnamt_type === "PRN") {
      dSharesPct = null;
      flags.push("PRN_PRINCIPAL");
    }

    const valuePrior = p?.value_usd ?? null;
    changes.push({
      cusip: h.cusip,
      put_call: h.put_call,
      name_of_issuer: h.name_of_issuer,
      action: suppressAction ? null : action,
      shares_now: h.ssh_prnamt,
      shares_prior: p?.ssh_prnamt ?? null,
      d_shares: suppressAll ? null : dShares,
      d_shares_pct: suppressAll ? null : dSharesPct,
      value_now: h.value_usd,
      value_prior: valuePrior,
      d_value: suppressAll || valuePrior == null ? null : h.value_usd - valuePrior,
      d_value_pct:
        suppressAll || !valuePrior ? null : ((h.value_usd - valuePrior) / valuePrior) * 100,
      weight_now: h.weight_pct,
      weight_prior: p?.weight_pct ?? null,
      // ALWAYS percentage points. "+1.8pp" cannot be misread the way "+1.8%"
      // can when the underlying quantity is itself a percentage.
      d_weight_pp:
        suppressAll || p?.weight_pct == null || h.weight_pct == null
          ? null
          : h.weight_pct - p.weight_pct,
      // The provenance lock: the identity of the filing this was compared
      // against travels in the SAME record as the value. A header stat and a
      // row delta therefore cannot come from different quarters — which is
      // exactly the bug that made a reference site show Cantillon's Q1 position
      // count next to its Q4 portfolio value.
      prior_period: prior.period_end,
      prior_accession: prior.accession ?? null,
      flags: flags.length ? flags : null,
    });
  }

  // ---------------------------------------------------------------------------
  // EXITS, AND WHY THEY ARE WITHHELD ON A CONFIDENTIAL-OMISSION QUARTER.
  //
  // An exit is inferred from ABSENCE: the position was in the prior book and is
  // not in this one. That inference is only valid if this book is complete.
  //
  // A manager may request confidential treatment for positions they are still
  // accumulating, and file without them. Those positions are absent from the
  // filing and present in the portfolio — indistinguishable, from the outside,
  // from a sale. Reporting them as "EXITED, -100%" states as fact something the
  // filing explicitly declines to say, and it is the same fabricated-sell error
  // the pro-rata detector exists to prevent, wearing a different hat.
  //
  // So on such a quarter no exit rows are emitted at all, and the count that
  // WOULD have been emitted is returned instead, so the UI can say plainly how
  // many are unaccounted for rather than silently showing a shorter list.
  // Additions and increases are unaffected: a position that IS reported is
  // reported honestly.
  // ---------------------------------------------------------------------------
  let exitsWithheld = 0;
  for (const p of prior.holdings) {
    if (currentByKey.has(key(p))) continue;
    // THE SAME INFERENCE, AND IT FAILS FOR THE SAME REASON.
    //
    // An exit is read off ABSENCE, which only means a sale if this form covers
    // the same managers the last one did. When the manager list changed it does
    // not: a position missing from this quarter may simply be reported on
    // somebody else's form now. Emitting it as "EXITED, -100%" is the fabricated
    // sell this whole detector exists to prevent, arriving from the other end.
    //
    // Counted rather than dropped, so the UI can say how many are unaccounted
    // for instead of quietly showing a shorter list.
    if (confidentialOmitted || suppressAction) { exitsWithheld++; continue; }
    changes.push({
      cusip: p.cusip,
      put_call: p.put_call,
      // Carry the UNIT, not just the put/call flag.
      //
      // An exited convertible note has put_call "" exactly like an exited
      // common-stock position, so on the exit record alone the two are
      // indistinguishable — and a long-equity-only view that filters on
      // put_call keeps the note. 1.3% of the corpus is PRN, so this is a real
      // population, not a hypothetical.
      ssh_prnamt_type: p.ssh_prnamt_type ?? null,
      name_of_issuer: p.name_of_issuer,
      action: "EXITED",
      shares_now: 0,
      shares_prior: p.ssh_prnamt,
      d_shares: -p.ssh_prnamt,
      d_shares_pct: suppressAll ? null : -100,
      value_now: 0,
      value_prior: p.value_usd,
      d_value: -p.value_usd,
      d_value_pct: suppressAll ? null : -100,
      weight_now: 0,
      weight_prior: p.weight_pct,
      d_weight_pp: suppressAll || p.weight_pct == null ? null : -p.weight_pct,
      prior_period: prior.period_end,
      prior_accession: prior.accession ?? null,
      flags: null,
    });
  }

  return {
    changes,
    suppressed: suppressAll,
    reason: structural.event,
    // Only a real structural finding reaches this field — see the note above.
    structuralEvent: structural.event ?? null,
    structural,
    exitsWithheld,
  };
}

/**
 * Both turnover definitions, because they legitimately disagree and the
 * reference product publishes both. Rendering one unexplained number and
 * having a client compare it to a different site is a credibility problem, so
 * the UI labels each and shows the formula.
 */
export function computeTurnover(changes, current, prior) {
  const nNew = changes.filter((c) => c.action === "NEW").length;
  const nExited = changes.filter((c) => c.action === "EXITED").length;
  const posNow = current.holdings.length;
  const posPrior = prior?.holdings.length ?? 0;

  const positionPct =
    posNow + posPrior > 0 ? ((nNew + nExited) / (posNow + posPrior)) * 200 : null;

  const traded = changes.reduce((a, c) => a + Math.abs(c.d_value ?? 0), 0);
  const avgValue = ((current.value_long_usd ?? 0) + (prior?.value_long_usd ?? 0)) / 2;
  const valuePct = avgValue > 0 ? (traded / avgValue) * 100 : null;

  return { turnover_position_pct: positionPct, turnover_value_pct: valuePct };
}

/** Counts for the Activity widget's flow bars. */
export function summarizeActions(changes) {
  const c = (a) => changes.filter((x) => x.action === a).length;
  return {
    n_new: c("NEW"),
    n_added: c("ADDED"),
    n_held: c("HELD"),
    n_trimmed: c("TRIMMED"),
    n_exited: c("EXITED"),
  };
}
