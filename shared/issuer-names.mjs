// shared/issuer-names.mjs
//
// Does the company name a filer typed agree with the company its CUSIP belongs
// to? Pure functions, no I/O.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// A 13F carries no ticker. Every ticker on the dashboard comes from the CUSIP
// the filer typed, looked up in the SEC's fails-to-deliver list
// (scripts/build-securities.mjs). We have to trust the CUSIP — it is the only
// identifier on the form — but the issuer name sits in the next column, and
// when the two disagree in a particular pattern the filing is wrong, not us.
//
// Measured case: Lightrock Netherlands B.V., 2026-Q3 (0002041485-26-000006).
// Twelve of its 35 lines have the CUSIP column shifted against the names:
// "CARETRUST REIT INC" filed under Cohu's code, "CABOT CORP" under
// CareTrust's, "BRUNSWICK CORP" under Cabot's. The dashboard showed COHU
// against a CareTrust position. Its Q4-2025, Q1-2026 and Q2-2026 filings carry
// the same shift.
//
// ---------------------------------------------------------------------------
// WHY A CHAIN, NOT A DISAGREEMENT
// ---------------------------------------------------------------------------
// A name that merely disagrees with its CUSIP is common and harmless — 0.9% of
// all rows in the SEC's Q1-2026 bulk data. The company was renamed
// (AMERISOURCEBERGEN / CENCORA), the exchange's name is truncated at 30
// characters, or a trust files each ETF under the trust's name while the
// exchange lists the fund's own name.
//
// Even "the name matches ANOTHER CUSIP in the same filing" is not enough. A
// first measurement counted that and flagged 1 filing in 20, nearly all of them
// innocent: a JPMorgan ETF is not JPMorgan Chase, Lattice Strategies is not
// Lattice Semiconductor, and every First Trust buffer ETF matches every other.
//
// What a shifted column produces, and nothing innocent does, is a CHAIN: this
// row's name belongs to another CUSIP in the filing, AND that CUSIP's own row
// is carrying a name that is not its own either. CareTrust's name sits on
// Cohu's code; CareTrust's code is carrying Cabot's name; Cabot's code is
// carrying Brunswick's. When JPMorgan's ETF names JPMorgan Chase, JPMorgan
// Chase's own row still says JPMORGAN CHASE — no chain, no flag.

/**
 * Words that say what kind of thing a security is, not whose it is.
 * Dropped before comparing, on both sides.
 */
const NOISE = new Set([
  "THE", "AND", "OF",
  "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "COS",
  "LTD", "LIMITED", "PLC", "LLC", "LP", "LLP",
  "SA", "NV", "AG", "SE", "AB", "ASA", "AS", "OYJ", "SPA", "BV", "KK", "NA",
  "COM", "COMMON", "STK", "STOCK", "SHS", "SH", "SHARES", "SHARE", "ORD", "ORDINARY",
  "CL", "CLASS", "SER", "SERIES", "NEW", "PAR", "VAL", "VALUE", "NPV",
  "ADR", "ADS", "SPONSORED", "SPON", "DEP", "DEPOSITARY", "RECEIPT", "RECEIPTS", "RCPT",
  "HLDGS", "HLDG", "HOLDINGS", "HOLDING", "GROUP", "GRP",
  "TR", "TRUST", "FD", "FDS", "FUND", "FUNDS", "ETF", "INDEX",
  "DEL", "MD", "DE", "NY", "NJ", "PA", "VA", "FL", "TX", "CA", "NEV",
  "REIT", "WT", "WTS", "WARRANT", "WARRANTS", "UNIT", "UNITS", "RT", "RTS", "RIGHT", "RIGHTS",
  "A", "B", "C", "I", "II", "III",
]);

/**
 * Words so common across issuers that a match on one of them says nothing
 * about identity. They may make the lenient own-name check more forgiving, but
 * are never the evidence that a name belongs to some other CUSIP.
 */
const GENERIC = new Set([
  "AMERICAN", "AMERICA", "FIRST", "UNITED", "NATIONAL", "GENERAL", "GLOBAL", "INTERNATIONAL", "INTL",
  "US", "USA", "NORTH", "SOUTH", "EAST", "WEST",
  "BANK", "BANCORP", "BANCSHARES", "BANKSHARES", "FINANCIAL", "FINL", "CAPITAL",
  "INVESTMENT", "INVESTMENTS", "INVT",
  "ENERGY", "TECHNOLOGIES", "TECHNOLOGY", "TECH", "SYSTEMS", "INDUSTRIES", "INDS", "INDL",
  "RESOURCES", "SERVICES", "SOLUTIONS", "PROPERTIES", "REALTY", "PHARMACEUTICALS", "PHARMA",
  "THERAPEUTICS", "BIOSCIENCES", "HEALTH", "HEALTHCARE", "MEDICAL", "ENTERPRISES", "PARTNERS",
  "ACQUISITION", "ACQUISITIONS", "MINING", "MINERALS", "GOLD", "OIL", "GAS", "POWER", "ELECTRIC",
  "ISHARES", "SPDR", "VANGUARD", "INVESCO", "SCHWAB", "PROSHARES", "DIREXION", "GRANITESHARES",
  "SELECT", "SECTOR", "EXCHANGE", "EXCHNG", "TRADED", "DAILY", "SHORT", "LONG", "BULL", "BEAR",
  "EQUITY", "INCOME", "STRATEGIES", "STRATEGY", "ACTIVE", "PREMIUM", "SER",
]);

const TOKEN_CACHE = new Map();

/** Significant words of an issuer name, in order. */
export function nameTokens(name) {
  const key = name ?? "";
  const hit = TOKEN_CACHE.get(key);
  if (hit) return hit;
  const out = tokenize(key);
  // Bounded: the monthly build sees a few hundred thousand distinct names, and
  // the same few thousand (APPLE INC, MICROSOFT CORP…) on every filing.
  if (TOKEN_CACHE.size > 200_000) TOKEN_CACHE.clear();
  TOKEN_CACHE.set(key, out);
  return out;
}

function tokenize(name) {
  let s = String(name).toUpperCase();
  // The exchange's names end in a truncated place of incorporation —
  // "CARETRUST REIT INC COM STK (MD" — that never closes, or in a class and
  // par value after a semicolon — "AMAZON COM INC;COM USD0.01". Left in, the
  // "USD0" of one company matches the "USD0" of another.
  s = s.replace(/;.*$/, " ").replace(/\(.*$/, " ");
  // "AT&T", "S&P", "JOHNSON & JOHNSON": joined, so AT&T stays one word.
  s = s.replace(/&/g, "");
  s = s.replace(/[^A-Z0-9]+/g, " ").trim();
  if (!s) return [];
  // A run of single letters is one word spelled out: "J P MORGAN" is JP
  // MORGAN, "U S BANCORP" is US BANCORP. Joined BEFORE the noise filter, which
  // would otherwise read "L P" and "S A" as two separate meaningless letters.
  const words = [];
  let run = "";
  for (const w of s.split(" ")) {
    if (w.length === 1) { run += w; continue; }
    if (run) { words.push(run); run = ""; }
    words.push(w);
  }
  if (run) words.push(run);
  return words.filter((t) => !NOISE.has(t));
}

/**
 * Lenient word match: equal, one a prefix of the other ("MICROSO" from a
 * truncated name), or an abbreviation keeping the first letter and the order
 * of the rest ("HLDGS" / "HOLDINGS", "MACHS" / "MACHINES").
 */
export function tokensMatch(a, b) {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length < 3) return false;
  if (l.startsWith(s)) return true;
  if (s[0] !== l[0]) return false;
  let j = 0;
  for (let i = 0; i < l.length && j < s.length; i++) if (l[i] === s[j]) j++;
  return j === s.length;
}

/**
 * Lenient: could `filed` be a way of writing `known`? Anything plausible is a
 * yes, because a false "no" here is the first step toward flagging an innocent
 * filing.
 *
 * `ticker` counts as a name: some filers type the symbol in the name column.
 */
export function namesAgree(filed, known, ticker = null) {
  const a = nameTokens(filed);
  const b = nameTokens(known);
  // Nothing left to compare on one side — a bare "COM", or "ISHARES TR"
  // reduced to one generic word. Unknown is not disagreement.
  if (!a.length || !b.length) return true;
  if (ticker) {
    const t = String(ticker).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (t && a.join("") === t) return true;
  }
  // Glued or split words: "WAL MART" / "WALMART".
  const ja = a.join("");
  const jb = b.join("");
  if (ja.length >= 4 && jb.length >= 4 && (ja.startsWith(jb.slice(0, 6)) || jb.startsWith(ja.slice(0, 6)))) return true;
  for (const x of a) for (const y of b) if (tokensMatch(x, y)) return true;
  return false;
}

/** The distinctive words of a name: no generic words, no bare numbers. */
function distinctive(name) {
  return nameTokens(name).filter((t) => !GENERIC.has(t) && !/^\d+$/.test(t));
}

/**
 * Strict: is `filed` specifically the company called `known`? Only ever used
 * as evidence that a name sits on the wrong CUSIP, so it errs toward "no".
 *
 * The first distinctive words must be the same word — equal, or one cut short
 * of the other at 5+ letters (the exchange truncates at 30 characters). No
 * abbreviation matching here: TRANE is a subsequence of TRANSFORCE and MERIT
 * of METROCITY, and that is how a loose rule finds companies that are not
 * there. Where both names have a second distinctive word, it must agree too:
 * BERKSHIRE HILLS is not BERKSHIRE HATHAWAY.
 */
export function namesIdentify(filed, known) {
  const a = distinctive(filed);
  const b = distinctive(known);
  if (!a.length || !b.length) return false;
  if (!sameWord(a[0], b[0])) return false;
  if (a.length > 1 && b.length > 1 && !tokensMatch(a[1], b[1])) return false;
  return true;
}

function sameWord(x, y) {
  if (x.length < 4 || y.length < 4) return false;
  if (x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 5 && l.startsWith(s);
}

/**
 * How many chained lines make a filing "misaligned".
 *
 * Measured on the four SEC bulk 13F windows on hand — 36,371 filings, 13.9
 * million lines, mostly Q4-2024, Q3-2025, Q4-2025 and Q1-2026 reports:
 *
 *   chained lines   filings
 *   0               36,327
 *   2               12      two names swapped: a renamed issuer's share
 *                           classes (Eletrobras/Axia), Oracle/Oshkosh
 *   3               0
 *   4 or more       32      every one a shifted or scrambled column on
 *                           inspection — Lightrock in both quarters it filed,
 *                           Franklin Resources (86 lines), BNP Paribas,
 *                           Allen Investment Management (208 of 220 names)
 *
 * Nothing scores 1 by construction: a link only counts if it joins another.
 * Three sits in the empty gap between an innocent swap and a broken filing.
 *
 * KNOWN MISS: two small filings (Hurlow Wealth, Redwood Wealth, Q4-2025) whose
 * codes were scrambled rather than shifted, so the names point at securities
 * the filing does not hold and no chain forms. A test for "most names are some
 * other company's" would catch them, and was tried and dropped: a filer who
 * types the fund sponsor ("Blackrock", "The Vanguard Group") for every ETF has
 * correct codes and scored 48% on it, beside broken filings at 47%.
 */
export const NAME_CHECK_MIN_DISPLACED = 3;

/** The first distinctive word of 4+ letters, or null. */
function headWord(name) {
  const d = distinctive(name);
  return d.length && d[0].length >= 4 ? d[0] : null;
}

/**
 * Check one filing's rows against the known name for each CUSIP.
 *
 * @param {Array<{cusip: string, name_of_issuer: string}>} rows  as filed or
 *   aggregated; only `cusip` and `name_of_issuer` are read
 * @param {Record<string, {ticker?: string, name?: string}>} securities
 * @returns {{
 *   checked: number,      rows whose CUSIP has a known name
 *   disagree: number,     of those, rows whose filed name does not fit it
 *   mismatched: Array<{cusip, filedName, ticker, knownName}>,  every distinct
 *                         line whose name does not fit its code
 *   displaced: Array<{cusip, filedName, ticker, knownName, belongsTo}>,  the
 *                         subset that forms chains — the evidence
 *   misaligned: boolean,
 * }}
 */
export function checkIssuerNames(rows, securities) {
  const known = new Map();
  for (const r of rows ?? []) {
    const c = r?.cusip;
    if (!c || known.has(c)) continue;
    const s = securities?.[c];
    if (s?.name) known.set(c, s);
  }

  // Pass 1: which rows carry a name that is not their CUSIP's, and which
  // CUSIPs are therefore "occupied" by some other name.
  let checked = 0;
  let disagree = 0;
  const wrong = [];
  const occupied = new Set();
  for (const r of rows ?? []) {
    const c = r?.cusip;
    const s = c ? known.get(c) : null;
    if (!s) continue;
    checked++;
    if (namesAgree(r.name_of_issuer, s.name, s.ticker)) continue;
    disagree++;
    wrong.push(r);
    occupied.add(c);
  }

  // Pass 2: a wrong name that belongs to ANOTHER occupied CUSIP in the same
  // filing is a link in a chain. Only occupied CUSIPs can be the target, which
  // also keeps this cheap: they are ~1% of rows.
  const targets = [...occupied].map((c) => [c, known.get(c)]);
  const links = [];
  const seen = new Set();
  for (const r of wrong) {
    const key = `${r.cusip}|${r.name_of_issuer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const s = known.get(r.cusip);
    for (const [oc, os] of targets) {
      if (oc === r.cusip) continue;
      // Two share classes of one issuer typed the wrong way round is not a
      // misaligned column.
      if (namesAgree(os.name, s.name)) continue;
      if (!namesIdentify(r.name_of_issuer, os.name)) continue;
      links.push({
        cusip: r.cusip,
        to: oc,
        filedName: r.name_of_issuer,
        ticker: s.ticker ?? null,
        knownName: s.name,
        belongsTo: os.ticker ?? null,
      });
      break;
    }
  }

  // Pass 3: keep only links that join another link.
  //
  // A shifted block is a path — Cohu's code carries CareTrust's name,
  // CareTrust's code carries Cabot's, Cabot's carries Brunswick's — so every
  // link in it touches the next one. A coincidence is an isolated pair: a
  // renamed company whose old name happens to start like an unrelated holding
  // ("SMART GLOBAL" on Penguin Solutions' code), or a filer that clips the
  // first letter off every name ("ADDEN STEVEN" for Madden). In the largest
  // filings, where 1 row in 10 carries an unusual name, isolated pairs turn up
  // by chance; connected ones did not.
  const from = new Set(links.map((l) => l.cusip));
  const to = new Set(links.map((l) => l.to));
  const displaced = links
    .filter((l) => from.has(l.to) || to.has(l.cusip))
    .map(({ to: _to, ...rest }) => rest);

  const mismatched = [];
  const listed = new Set();
  for (const r of wrong) {
    const key = `${r.cusip}|${r.name_of_issuer}`;
    if (listed.has(key)) continue;
    listed.add(key);
    const s = known.get(r.cusip);
    mismatched.push({ cusip: r.cusip, filedName: r.name_of_issuer, ticker: s.ticker ?? null, knownName: s.name });
  }

  return {
    checked,
    disagree,
    mismatched,
    displaced,
    misaligned: displaced.length >= NAME_CHECK_MIN_DISPLACED,
  };
}
