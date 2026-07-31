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

  for (const f of ordered) {
    accessions.push(f.accession_number);

    if (!f.is_amendment) {
      // An original seeds the set. A second original for the same period is
      // unusual but the later one wins, consistent with restatement semantics.
      rows = [...(f.rows || [])];
      continue;
    }

    const type = (f.amendment_type || "").toUpperCase();

    if (type === "RESTATEMENT") {
      rows = [...(f.rows || [])];
    } else if (type === "NEW HOLDINGS") {
      rows = [...rows, ...(f.rows || [])];
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
    }
  }

  if (ordered.length && ordered[0].is_amendment) {
    warnings.push({
      code: "origin_missing",
      detail: `earliest filing for this period (${ordered[0].accession_number}) is an amendment; the original was not ingested`,
    });
  }

  return { rows, accessions, warnings };
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
export function detectStructuralEvent(current, prior, opts = {}) {
  const detail = {};
  if (!prior || !prior.holdings?.length) return { event: null, detail };

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
  // footnote nobody reads. The UI offers an explicit "show raw deltas anyway".
  const suppressAll =
    structural.event === "PRO_RATA_REDUCTION" || structural.event === "UNIT_SCALE_CHANGE";

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
      action,
      shares_now: h.ssh_prnamt,
      shares_prior: p?.ssh_prnamt ?? null,
      d_shares: dShares,
      d_shares_pct: suppressAll ? null : dSharesPct,
      value_now: h.value_usd,
      value_prior: valuePrior,
      d_value: valuePrior != null ? h.value_usd - valuePrior : null,
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
    if (confidentialOmitted) { exitsWithheld++; continue; }
    changes.push({
      cusip: p.cusip,
      put_call: p.put_call,
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
