// tests/fixtures.mjs
//
// Fixtures reconstructed from REAL filings. Every total in this file was
// measured from primary sources on sec.gov during design; the per-row splits
// are synthesized to hit those totals exactly, so the invariants under test are
// the real ones.

/** Split an integer total into n exact parts (remainder onto the first). */
export function distribute(total, n) {
  const base = Math.floor(total / n);
  const parts = Array(n).fill(base);
  parts[0] += total - base * n;
  return parts;
}

export function cusipAt(i) {
  // Shape-valid 9-character CUSIPs. Deliberately synthetic: real CUSIPs are
  // licensed and this repo does not check them in.
  const body = String(100000 + i).slice(0, 6);
  return `${body}10${(i % 10)}`;
}

// ---------------------------------------------------------------------------
// Cantillon Capital Management LLC — 2026-Q1, accession 0001279936-26-000004
//
// Measured from the filing:
//   76 information-table rows over 38 distinct CUSIPs (each appears twice,
//   split by otherManager attribution)
//     otherManager blank : $9,218,668,217   (38 rows)
//     otherManager = '1' : $5,832,310,749   (38 rows)
//     -------------------------------------------------
//     sum                : $15,050,978,966  == <tableValueTotal>
//
// This one filing is the cheapest correctness control available: it
// simultaneously pins the aggregation rule, the units decision, and parse
// completeness. If any of the three regress, this fixture fails.
// ---------------------------------------------------------------------------
export const CANTILLON_Q1_2026 = {
  accession: "0001279936-26-000004",
  cik: "0001279936",
  period_end: "2026-03-31",
  acceptance_datetime: "2026-05-07T14:12:00.000Z",
  schemaVersion: "X0202",
  tableValueTotal: 15_050_978_966,
  tableEntryTotal: 76,
  distinctCusips: 38,
  blankManagerTotal: 9_218_668_217,
  manager1Total: 5_832_310_749,
};

/** Build the 76-row information table for the fixture above. */
export function cantillonRows() {
  const n = CANTILLON_Q1_2026.distinctCusips;
  const blank = distribute(CANTILLON_Q1_2026.blankManagerTotal, n);
  const om1 = distribute(CANTILLON_Q1_2026.manager1Total, n);
  const rows = [];
  let seq = 1;
  for (let i = 0; i < n; i++) {
    for (const [value, other] of [
      [blank[i], null],
      [om1[i], "1"],
    ]) {
      rows.push({
        row_seq: seq++,
        name_of_issuer: `ISSUER ${i + 1} INC`,
        title_of_class: "COM",
        cusip: cusipAt(i),
        figi: null,
        value_raw: value,
        // ~$120/share keeps the implied-price detector in the healthy band
        // (measured universe median is $76.39).
        ssh_prnamt: Math.max(1, Math.round(value / 120)),
        ssh_prnamt_type: "SH",
        put_call: null,
        investment_discretion: "DFND",
        other_manager: other,
        voting_sole: 0,
        voting_shared: 0,
        voting_none: 0,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Jefferies Group LLC (CIK 1084580) — period 2021-03-31, filed TWICE.
//
//   original  13F-HR    0001085146-21-001676  filed 2021-05-14
//     schemaVersion absent, tableValueTotal 11,413,760          (THOUSANDS)
//   amendment 13F-HR/A  0001085146-23-003526  filed 2023-09-21  RESTATEMENT
//     schemaVersion X0202, tableValueTotal 11,411,017,784       (DOLLARS)
//
// Same quarter, same manager, a factor of 1000 apart. This is why the units
// cutover MUST key on the filing/acceptance date rather than the period: any
// pipeline that infers units from periodOfReport gets a 1000x error on every
// backfilled amendment of a pre-2023 quarter.
// ---------------------------------------------------------------------------
export const JEFFERIES_2021Q1 = {
  original: {
    accession: "0001085146-21-001676",
    acceptance_datetime: "2021-05-14T20:31:00.000Z",
    schemaVersion: undefined,
    tableValueTotal: 11_413_760,
    expectedUnits: "THOUSANDS",
  },
  amendment: {
    accession: "0001085146-23-003526",
    acceptance_datetime: "2023-09-21T18:02:00.000Z",
    schemaVersion: "X0202",
    tableValueTotal: 11_411_017_784,
    expectedUnits: "DOLLARS",
  },
  // Both describe the same ~$11.41B book, which is the whole point.
  expectedUsdApprox: 11_411_017_784,
};

/**
 * Rows for a book of the given total, priced so the implied-price detector sees
 * roughly `pricePerShare` dollars per share once units are applied correctly.
 */
export function bookRows(totalRaw, units, pricePerShare = 100, n = 40) {
  const parts = distribute(totalRaw, n);
  // Share count is a property of the real world and does not change with the
  // reporting convention, so derive it from the DOLLAR value.
  const scale = units === "THOUSANDS" ? 1000 : 1;
  return parts.map((value, i) => ({
    row_seq: i + 1,
    name_of_issuer: `HOLDING ${i + 1} CORP`,
    title_of_class: "COM",
    cusip: cusipAt(i),
    figi: null,
    value_raw: value,
    ssh_prnamt: Math.max(1, Math.round((value * scale) / pricePerShare)),
    ssh_prnamt_type: "SH",
    put_call: null,
    investment_discretion: "SOLE",
    other_manager: null,
    voting_sole: 0,
    voting_shared: 0,
    voting_none: 0,
  }));
}

// ---------------------------------------------------------------------------
// Citadel-shaped book: ~47% of rows are options, and one CUSIP carries a Call
// leg and a Put leg with different values. Measured on Citadel 2026-Q1:
//   putCall absent 8,285 / Call 3,885 / Put 3,419
//   15,589 rows over 6,733 distinct CUSIPs
//   sshPrnamtType  SH 15,543 / PRN 46
//   68243Q106 appears as value 80,560 (Call) and 172,672 (Put)
// ---------------------------------------------------------------------------
export function optionsHeavyRows() {
  const c = cusipAt(1);
  return [
    mkRow({ seq: 1, cusip: c, value: 1_000_000, shares: 10_000, putCall: null }),
    mkRow({ seq: 2, cusip: c, value: 80_560, shares: 800, putCall: "Call" }),
    mkRow({ seq: 3, cusip: c, value: 172_672, shares: 1_700, putCall: "Put" }),
    // A duplicate long leg split by manager — must SUM into the long row.
    mkRow({ seq: 4, cusip: c, value: 500_000, shares: 5_000, putCall: null, other: "1" }),
    // A debt position: sshPrnamt is DOLLARS OF FACE VALUE, not shares.
    mkRow({ seq: 5, cusip: cusipAt(2), value: 2_000_000, shares: 2_000_000, putCall: null, type: "PRN" }),
    // A zero-value row. Measured at 167 of 315,211 rows — rare enough to miss
    // in hand-written fixtures, common enough to appear in production and
    // produce NaN% or Infinity% where a weight should be.
    mkRow({ seq: 6, cusip: cusipAt(3), value: 0, shares: 0, putCall: null }),
  ];
}

export function mkRow({ seq, cusip, value, shares, putCall = null, type = "SH", other = null }) {
  return {
    row_seq: seq,
    name_of_issuer: `ISSUER ${cusip}`,
    title_of_class: "COM",
    cusip,
    figi: null,
    value_raw: value,
    ssh_prnamt: shares,
    ssh_prnamt_type: type,
    put_call: putCall,
    investment_discretion: "SOLE",
    other_manager: other,
    voting_sole: 0,
    voting_shared: 0,
    voting_none: 0,
  };
}

/** Build a holdings-shaped record (post-aggregation) for fold/change tests. */
export function holding({ cusip, value, shares, putCall = "", type = "SH", weight = null }) {
  return {
    cusip,
    put_call: putCall,
    ssh_prnamt_type: type,
    name_of_issuer: `ISSUER ${cusip}`,
    title_of_class: "COM",
    value_usd: value,
    ssh_prnamt: shares,
    voting_sole: 0,
    voting_shared: 0,
    voting_none: 0,
    row_count: 1,
    weight_pct: weight,
    implied_price: shares > 0 ? value / shares : null,
  };
}
