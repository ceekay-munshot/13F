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
//
// Each holding also gets a SUBSECTOR, chosen inside the sector this file
// decides and never instead of it. That half lives in shared/sector-list.mjs,
// which only the pipeline loads: the dashboard reads each trade's subsector
// from the file, so visitors never download the subsector lists.

/** Upper case, letters and digits only: BRK-B, BRK.B, BRK/B and BRKB are one ticker. */
export function normTicker(t) {
  return String(t ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Strip a company name down to what two spellings of it share.
 *
 * Also cuts off what describes the SECURITY rather than the company, so a
 * preferred or a note finds its issuer: "WELLS FARGO CO 7.5Percen" and
 * "BOEING CO PFD CONV SER A" read as Wells Fargo and Boeing.
 */
export function normName(n) {
  let s = String(n ?? "").toUpperCase()
    .replace(/\([^)]*\)/g, " ")          // "General Motors Co (GM)"
    .replace(/\bA\s*\/\s*S\b/g, " ")     // Danish "A/S"
    .replace(/\/[A-Z]{1,4}\/?/g, " ")    // the SEC's "/DE/", "/MN", "/CAN/"
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]/g, " ");
  for (const [from, to] of NAME_ABBREVIATIONS) s = s.replace(from, to);
  const words = s.split(/\s+/).filter(Boolean);
  // Everything from the first word that describes the security, or carries a
  // number, is dropped. Never the first word: "3M CO" is a company.
  const cut = words.findIndex((w, i) => i > 0 && (/\d/.test(w) || SECURITY_WORDS.has(w)));
  return (cut > 0 ? words.slice(0, cut) : words).filter((w) => !NAME_NOISE.has(w)).join(" ");
}

const SECURITY_WORDS = new Set([
  "PFD", "PREF", "PREFERRED", "DEP", "DEPOSITARY", "DEPOSITORY", "CONV", "CONVERTIBLE",
  "NOTE", "NOTES", "PERCENT", "PCT", "SR", "SUB", "WTS", "WARRANT", "WARRANTS", "RIGHTS",
  "UNIT", "UNITS", "EQUITY", "MANDATORY",
]);

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
  [/\bPETE\b/g, "PETROLEUM"],
  [/\bMGMT\b|\bMGT\b/g, "MANAGEMENT"],
  [/\bLABS\b/g, "LABORATORIES"],
  [/\bSYS\b/g, "SYSTEMS"],
  [/\bCTR\b/g, "CENTER"],
  [/\bTHERAPEUTIC\b/g, "THERAPEUTICS"],
  [/\bFINL\b/g, "FINANCIAL"],
  [/\bCMNTYS\b/g, "COMMUNITIES"],
  [/\bCMNTY\b/g, "COMMUNITY"],
  [/\bPPTYS\b/g, "PROPERTIES"],
  [/\bRLTY\b/g, "REALTY"],
  [/\bINVTS?\b|\bINVESTMENTS\b/g, "INVESTMENT"],
  [/\bENTMT\b/g, "ENTERTAINMENT"],
  [/\bNATL\b/g, "NATIONAL"],
];
// Legal forms and filler that differ between spellings of the same company.
const NAME_NOISE = new Set([
  "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LIMITED",
  "PLC", "LLC", "LP", "SA", "AG", "NV", "SE", "SPA", "AB", "ASA", "OYJ", "THE",
  "NEW", "DEL", "DE", "COM", "CL", "CLASS", "A", "B", "ORD", "SHS", "ADR", "ADS", "AND",
]);

/**
 * Bump when normName() or the list's rules change. A list built under an
 * older version is rebuilt on the next run instead of waiting out its week,
 * because its name index was keyed by the old rules.
 */
export const SECTOR_LIST_VERSION = 3; // 3: every ticker and name carries its subsector

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

// Only applied to a registrant with no industry code — see assembleSectorMap.
export const INVESTMENT_VEHICLE = /\b(BDC|FUND|FD|TRUST|LENDING|CREDIT|INCOME|CAPITAL CORP|INVESTMENT CORP|FINANCE CORP)\b/;

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
 * for a small share of rows); the pipeline uses it. Its list holds subsectors
 * rather than sectors, so it passes `nameSector` to read one as a sector.
 *
 * Order matters and is the point of this function:
 *   1. the ticker as filed            — the SEC's own classification
 *   2. the ticker without punctuation — BRKB is BRK-B
 *   3. fund by name or share class    — SPY filed as "SPDR S&P 500 ETF TR"
 *   4. the company name               — a holding with no ticker
 */
export function createSectorLookup(map, opts = {}) {
  const resolve = createResolver(map, opts);
  return (row) => resolve(row).sector;
}

/**
 * The lookup's workings -> { sector, key, named }: the sector, the ticker in
 * the list it was found under (a preferred share's is its issuer's), and the
 * name list's own value when it was found by name.
 */
export function createResolver(map, { names = null, nameSector = (v) => v } = {}) {
  const byNorm = new Map();
  for (const [t, s] of Object.entries(map ?? {})) {
    const k = normTicker(t);
    // An exact spelling already in the list wins over a stripped one.
    if (k && !byNorm.has(k)) byNorm.set(k, t);
  }
  /** The list's own spelling of a ticker, or null. */
  const keyOf = (t) => {
    if (!t) return null;
    const up = String(t).toUpperCase();
    const exact = map?.[up];
    if (exact && exact !== UNCLASSIFIED) return up;
    const loose = byNorm.get(normTicker(t));
    return loose && map[loose] !== UNCLASSIFIED ? loose : null;
  };
  const found = (key) => ({ sector: map[key], key, named: null });
  return function resolve({ ticker, name, cls } = {}) {
    const direct = keyOf(ticker);
    if (direct) return found(direct);
    // A preferred share is its issuer's: BAPRA is Boeing's, NEEPRV NextEra's,
    // ORCLPRD Oracle's. Only ever tried on a ticker the list does not know.
    const pref = /^([A-Z]{1,5})PR([A-Z]?)$/.exec(normTicker(ticker));
    const issuer = pref && keyOf(pref[1]);
    if (issuer) return found(issuer);
    // "General Motors Co (GM)": the filer wrote the ticker into the name.
    const inName = /\(([A-Z]{1,5})\)/.exec(String(name ?? "").toUpperCase());
    const named = inName && keyOf(inName[1]);
    if (named) return found(named);
    if (looksLikeFund(name, cls)) return { sector: FUNDS, key: null, named: null };
    if (names && name) {
      const v = names[normName(name)];
      const sector = v ? nameSector(v) : null;
      if (sector && sector !== UNCLASSIFIED) return { sector, key: null, named: v };
    }
    return { sector: UNCLASSIFIED, key: null, named: null };
  };
}
