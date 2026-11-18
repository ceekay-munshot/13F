// shared/sector-list.mjs
//
// The pipeline's half of sectors: building the ticker -> sector list from what
// the SEC publishes, and placing a holding in a SUBSECTOR as well as a sector.
//
// Kept apart from shared/sectors.mjs, which the dashboard also loads, so the
// subsector lists (shared/subsectors.mjs) never reach a visitor's browser:
// every trade the dashboard shows already carries its subsector.

import { SECTORS } from "./sic.mjs";
import {
  SUBSECTORS, SUBSECTOR_SECTOR, fundKind, inSector, otherSubsector, subsectorByTicker,
  subsectorForSic,
} from "./subsectors.mjs";
import {
  FUNDS, INVESTMENT_VEHICLE, PLACED_BY_BUSINESS, UNCLASSIFIED, createResolver, looksLikeFund, normName,
  normTicker,
} from "./sectors.mjs";

/**
 * A name-list value as a sector: a subsector names its sector, and a list
 * built before subsectors holds sectors.
 */
const nameSector = (v) => SUBSECTOR_SECTOR[v] ?? (SECTORS.includes(v) ? v : null);

/**
 * The same lookup, answering { sector, subsector }. The sector is exactly what
 * createSectorLookup says; the subsector is always one of that sector's.
 */
export function createPlacer(map, { names = null, subs = null } = {}) {
  const resolve = createResolver(map, { names, nameSector });
  return function place(row = {}) {
    const { sector, key, named } = resolve(row);
    let sub = subsectorByTicker(key ?? row.ticker, sector);
    // A fund's own filed class says more than its trust's name in the list:
    // "ISHARES TR / 20 YR TR BD ETF" is a bond fund, "iShares Trust" is not.
    if (!sub && sector === FUNDS) sub = fundKind({ ticker: key ?? row.ticker, name: row.name, cls: row.cls });
    if (!sub && key && inSector(subs?.[key], sector)) sub = subs[key];
    if (!sub && inSector(named, sector)) sub = named; // a name list with subsectors
    return { sector, subsector: sub ?? otherSubsector(sector) };
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
 * Returns { sectors: ticker -> { sic, sector, subsector }, names: normName -> subsector }.
 * A subsector names its sector, so the name list needs nothing else.
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
    // A listed name with no industry code on its SEC record at all is an
    // investment vehicle — every operating company has one. Business
    // development companies (FS KKR, Golub Capital BDC) and closed-end credit
    // funds are the bulk of it, and their names say so.
    if (!sector && sicOf.has(cik) === false && INVESTMENT_VEHICLE.test(String(title).toUpperCase())) sector = FUNDS;
    if (!sector) continue;
    sectors[ticker] = { sic, sector, subsector: listedSubsector(ticker, sector, sic, title) };
  }
  // Fund share classes that are not in the company list. Open-end mutual fund
  // classes (five letters ending in X) never appear in a 13F, so they are left
  // out rather than shipped to every visitor.
  for (const sym of fundSymbols) {
    if (sectors[sym] || (sym.length === 5 && sym.endsWith("X"))) continue;
    sectors[sym] = { sic: null, sector: FUNDS, subsector: listedSubsector(sym, FUNDS, null, "") };
  }
  for (const [ticker, v] of Object.entries(sectors)) {
    const bare = normTicker(ticker);
    if (bare && bare !== ticker && !sectors[bare]) sectors[bare] = v;
  }

  // Company name -> subsector, for holdings filed without a ticker. A name two
  // companies normalise to with DIFFERENT sectors is dropped, not guessed; in
  // the same sector but different subsectors it keeps the sector, at its
  // catch-all, so this list places exactly the names it placed before.
  const names = {};
  const clash = new Set();
  const add = (k, sub) => {
    const sector = SUBSECTOR_SECTOR[sub];
    if (!k || !sector || sector === UNCLASSIFIED || clash.has(k)) return;
    const was = names[k];
    if (was && was !== sub) {
      if (SUBSECTOR_SECTOR[was] !== sector) { clash.add(k); delete names[k]; return; }
      names[k] = otherSubsector(sector);
      return;
    }
    names[k] = sub;
  };
  for (const [ticker, { title }] of tickers) add(normName(title), sectors[ticker]?.subsector);
  // Names from the financial data sets, for companies no longer in the ticker
  // list. Only where the list itself had nothing to say about that name.
  const listed = new Set(Object.keys(names));
  for (const [k, sic] of filedNames) {
    if (listed.has(k)) continue;
    const sector = sectorForSic(sic);
    const sub = subsectorForSic(sic);
    add(k, inSector(sub, sector) ? sub : otherSubsector(sector));
  }
  return { sectors, names };
}

/** A listed ticker's subsector: a hand-placed one, its fund kind, or its code's. */
function listedSubsector(ticker, sector, sic, title) {
  const hand = subsectorByTicker(ticker, sector);
  if (hand) return hand;
  if (sector === FUNDS) {
    const kind = fundKind({ ticker, name: title });
    if (kind) return kind;
  }
  const bySic = sic ? subsectorForSic(sic) : null;
  return inSector(bySic, sector) ? bySic : otherSubsector(sector);
}

/**
 * ticker -> subsector, packed for a file: the list of subsectors once, and a
 * position in it per ticker. Unpacked with the list it was packed with, so it
 * reads back correctly whatever the list in this code later becomes.
 */
export function packSubsectors(sectors) {
  const at = new Map(SUBSECTORS.map((n, i) => [n, i]));
  const tickerSubsectors = {};
  for (const [t, v] of Object.entries(sectors ?? {})) {
    const i = at.get(v?.subsector);
    if (i != null) tickerSubsectors[t] = i;
  }
  return { subsectors: [...SUBSECTORS], tickerSubsectors };
}

/** The reverse of packSubsectors: ticker -> subsector, or null if there are none. */
export function unpackSubsectors(state) {
  const list = state?.subsectors;
  const packed = state?.tickerSubsectors;
  if (!Array.isArray(list) || !packed) return null;
  const out = {};
  for (const [t, i] of Object.entries(packed)) if (list[i]) out[t] = list[i];
  return out;
}
