// shared/sectors.mjs
//
// One holding -> one sector. Shared by the pipeline and the dashboard so a
// stock cannot be "Semiconductors" in one panel and "Unclassified" in another.
//
// The ticker -> sector list itself comes from scripts/build-sectors.mjs (the
// SEC's own industry codes). This file is what happens when a holding does not
// match that list exactly, which on 17 Nov 2026 was a quarter of all the money
// focused managers traded. Measured on their Q3 2026 trades, Unclassified was:
//
//   51%  funds and ETFs — SPY, IVV, QQQ. Not a company, so no industry code.
//   36%  companies the list missed — new listings, foreign filers.
//    9%  holdings filed with no ticker at all, only a name.
//    4%  the same ticker spelled two ways: BRKB in a filing, BRK-B at the SEC.
//
// The first two are fixed in build-sectors.mjs. The last two, and funds the
// SEC's fund list does not name, are fixed here.

/** Upper case, letters and digits only: BRK-B, BRK.B, BRK/B and BRKB are one ticker. */
export function normTicker(t) {
  return String(t ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Strip a company name down to what two spellings of it share. */
export function normName(n) {
  let s = String(n ?? "").toUpperCase().replace(/&/g, " AND ").replace(/[^A-Z0-9 ]/g, " ");
  for (const [from, to] of NAME_ABBREVIATIONS) s = s.replace(from, to);
  return s
    .split(/\s+/)
    .filter((w) => w && !NAME_NOISE.has(w))
    .join(" ");
}

// 13F filers abbreviate; the SEC's company list does not.
const NAME_ABBREVIATIONS = [
  [/\bINDS?\b/g, "INDUSTRIES"],
  [/\bINTL\b/g, "INTERNATIONAL"],
  [/\bHLDGS?\b/g, "HOLDINGS"],
  [/\bTECHNOLOG\w*\b/g, "TECHNOLOGIES"],
  [/\bTECHN?\b/g, "TECHNOLOGIES"],
  [/\bPHARMACEUTICAL\b/g, "PHARMACEUTICALS"],
  [/\bMFG\b/g, "MANUFACTURING"],
  [/\bSVCS?\b/g, "SERVICES"],
  [/\bCOMMUNICATION\b/g, "COMMUNICATIONS"],
];
// Legal forms and filler that differ between spellings of the same company.
const NAME_NOISE = new Set([
  "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LIMITED",
  "PLC", "LLC", "LP", "SA", "AG", "NV", "SE", "SPA", "AB", "ASA", "OYJ", "THE",
  "NEW", "DEL", "DE", "COM", "CL", "CLASS", "A", "B", "ORD", "SHS", "ADR", "ADS",
]);

/**
 * A fund or ETF, judged from what the filer wrote. Used only when the ticker
 * did not resolve to a company, so "NORTHERN TRUST CORP" (NTRS) is never
 * caught by it.
 *
 * Deliberately narrow: words that only ever name funds. "TRUST" and "FUND"
 * alone are not enough — plenty of REITs and banks are trusts.
 */
const FUND_NAME = new RegExp(
  "\\b(" + [
    "ETFS?", "ISHARES", "SPDR", "VANGUARD", "PROSHARES", "DIREXION", "WISDOMTREE TR",
    "FIRST TR", "FIRST TRUST", "GLOBAL X", "VANECK", "SELECT SECTOR", "XTRACKERS",
    "ROUNDHILL", "PACER FDS", "AMPLIFY ETF", "INVESCO QQQ", "INVESCO EXCHANGE", "INVESCO ACTIVELY",
    "INVESCO DB", "SCHWAB STRATEGIC", "DIMENSIONAL", "DFA INVT", "DIMENSIONS GROUP",
    "GRAYSCALE", "EXCHANGE TRADED", "INDEX FDS?", "INDEX FUNDS?", "JANUS DETROIT",
    "TAX-MANAGED FDS", "SECTOR SPDR", "ARK ETF", "MF CLOSED", "MF OPEN",
  ].join("|") + ")\\b",
);
const FUND_CLASS = /\b(ETFS?|TR UNIT|UNIT SER|UNITS? BEN|MF CLOSED|MF OPEN)\b/;

export function looksLikeFund(name, cls) {
  return FUND_NAME.test(String(name ?? "").toUpperCase()) || FUND_CLASS.test(String(cls ?? "").toUpperCase());
}

export const FUNDS = "Funds & ETFs";
export const UNCLASSIFIED = "Unclassified";

/**
 * Companies the SEC files under a catch-all code that says nothing about what
 * they sell, placed by what they sell instead.
 *
 *   7389  "business services, not elsewhere classified" — Visa, Uber, Alibaba
 *   7320  "credit reporting"                             — S&P Global, Moody's
 *   7340  "services to buildings"                        — Airbnb
 *   7370  "computer programming"                         — SpaceX
 *
 * Without this, Visa and Mastercard read as Industrials beside staffing firms,
 * and SpaceX as software. Kept short on purpose: only names big enough to
 * move a sector total, and only where the code is a catch-all — a company
 * with a specific code keeps it, even where an index provider would differ.
 */
export const PLACED_BY_BUSINESS = {
  // payments
  V: "Financials", MA: "Financials", PYPL: "Financials", FISV: "Financials", FI: "Financials",
  GPN: "Financials", DLO: "Financials", RELY: "Financials", WU: "Financials",
  // marketplaces, delivery, travel
  MELI: "Consumer Discretionary", PDD: "Consumer Discretionary", BABA: "Consumer Discretionary",
  JD: "Consumer Discretionary", SE: "Consumer Discretionary", DASH: "Consumer Discretionary",
  EBAY: "Consumer Discretionary", ETSY: "Consumer Discretionary", CART: "Consumer Discretionary",
  ABNB: "Consumer Discretionary", TCOM: "Consumer Discretionary",
  // ride-hailing
  UBER: "Transport & Logistics", LYFT: "Transport & Logistics",
  // ratings and index data
  SPGI: "Capital Markets", MCO: "Capital Markets", MSCI: "Capital Markets",
  // IT services and analytics
  ACN: "Software & IT Services", FICO: "Software & IT Services", AKAM: "Software & IT Services",
  IT: "Software & IT Services",
  // property listings and data
  Z: "Real Estate", ZG: "Real Estate", CSGP: "Real Estate",
  // rockets and satellites
  SPCX: "Industrials",
};

/**
 * Build a lookup over a ticker -> sector list.
 *
 * `names` is optional: normalised company name -> sector, for holdings filed
 * with no ticker. The dashboard does without it (it would be a large download
 * for a small share of rows); the pipeline uses it.
 *
 * Order matters and is the point of this function:
 *   1. the ticker as filed            — the SEC's own classification
 *   2. the ticker without punctuation — BRKB is BRK-B
 *   3. fund by name or share class    — SPY filed as "SPDR S&P 500 ETF TR"
 *   4. the company name               — a holding with no ticker
 */
export function createSectorLookup(map, { names = null } = {}) {
  const byNorm = new Map();
  for (const [t, s] of Object.entries(map ?? {})) {
    const k = normTicker(t);
    // An exact spelling already in the list wins over a stripped one.
    if (k && !byNorm.has(k)) byNorm.set(k, s);
  }
  return function sectorOf({ ticker, name, cls } = {}) {
    if (ticker) {
      const exact = map?.[String(ticker).toUpperCase()];
      if (exact && exact !== UNCLASSIFIED) return exact;
      const loose = byNorm.get(normTicker(ticker));
      if (loose && loose !== UNCLASSIFIED) return loose;
    }
    if (looksLikeFund(name, cls)) return FUNDS;
    if (names && name) {
      const byName = names[normName(name)];
      if (byName) return byName;
    }
    return UNCLASSIFIED;
  };
}

/**
 * Assemble the ticker -> sector list from what the SEC publishes.
 *
 *   tickers      ticker -> { cik, title }        (company_tickers.json)
 *   fundSymbols  Set of fund and ETF tickers     (company_tickers_mf.json)
 *   sicOf        cik -> SIC code, or 0 for "asked, none on file"
 *   sectorForSic the SIC -> sector rule (shared/sic.mjs)
 *
 *   filedNames   normName -> SIC, from the financial data sets' own company
 *                names. These outlive a ticker: a company bought out this
 *                year (Electronic Arts, Janus Henderson) has left the ticker
 *                list but its last 10-Q is still there, and funds still sold it.
 *
 * Returns { sectors: ticker -> { sic, sector }, names: normName -> sector }.
 *
 * Every ticker with punctuation also gets its bare spelling (BRK-B -> BRKB),
 * because that is how 13F holdings arrive, and consumers that look tickers up
 * exactly — the monthly build's own sector totals — then match too.
 */
export function assembleSectorMap({ tickers, fundSymbols, sicOf, sectorForSic, filedNames = new Map() }) {
  const sectors = {};
  for (const [ticker, { cik, title }] of tickers) {
    const sic = sicOf.get(cik) || null;
    let sector = PLACED_BY_BUSINESS[ticker] ?? (sic ? sectorForSic(sic) : null);
    // A fund the SEC lists as one, or a registrant whose name says so, is a
    // fund — unless its own industry code says it is an operating company.
    if ((!sector || sector === UNCLASSIFIED) && (fundSymbols.has(ticker) || looksLikeFund(title))) sector = FUNDS;
    if (!sector) continue;
    sectors[ticker] = { sic, sector };
  }
  // Fund share classes that are not in the company list. Open-end mutual fund
  // classes (five letters ending in X) never appear in a 13F, so they are left
  // out rather than shipped to every visitor.
  for (const sym of fundSymbols) {
    if (sectors[sym] || (sym.length === 5 && sym.endsWith("X"))) continue;
    sectors[sym] = { sic: null, sector: FUNDS };
  }
  for (const [ticker, v] of Object.entries(sectors)) {
    const bare = normTicker(ticker);
    if (bare && bare !== ticker && !sectors[bare]) sectors[bare] = v;
  }

  // Company name -> sector, for holdings filed without a ticker. A name two
  // companies normalise to with DIFFERENT sectors is dropped, not guessed.
  const names = {};
  const clash = new Set();
  const add = (k, s) => {
    if (!s || s === UNCLASSIFIED || !k || clash.has(k)) return;
    if (names[k] && names[k] !== s) { clash.add(k); delete names[k]; return; }
    names[k] = s;
  };
  for (const [ticker, { title }] of tickers) add(normName(title), sectors[ticker]?.sector);
  // Names from the financial data sets, for companies no longer in the ticker
  // list. Only where the list itself had nothing to say about that name.
  const listed = new Set(Object.keys(names));
  for (const [k, sic] of filedNames) if (!listed.has(k)) add(k, sectorForSic(sic));
  return { sectors, names };
}
