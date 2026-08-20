// shared/sic.mjs
//
// SIC code -> a readable sector.
//
// WHAT THIS IS, AND WHAT IT IS NOT
// --------------------------------
// SIC is the SEC's own classification: every filer declares one, it is free,
// it is on the public record, and it is what the agency itself uses. That makes
// it the only sector taxonomy this project can use honestly.
//
// It is NOT GICS. GICS is licensed by S&P and MSCI, and a hand-rolled crosswalk
// dressed up as GICS is spotted by an analyst in about five minutes. So these
// are OUR groupings of SIC codes, labelled as such wherever they are shown.
//
// It is also NOT a theme taxonomy. SIC is a 1987 vintage and it splits things a
// modern reader groups together:
//
//   NVDA, AVGO   3674  Semiconductors & Related Devices
//   MSFT, ORCL   7372  Services-Prepackaged Software
//   GOOGL        7370  Services-Computer Programming, Data Processing
//   AAPL         3571  Electronic Computers
//
// All four are "AI" to a human and four different sectors to the SEC. That gap
// is real and this file does not paper over it: "Semiconductors" is a fact
// about the filing, "AI" would be an opinion about the company. Themes belong
// in a separate, clearly-labelled list — never smuggled in here.

/**
 * Ordered rules, first match wins. Ranges are on the 4-digit SIC.
 *
 * Semiconductors gets its own sector rather than sitting inside a broad
 * "Technology Hardware" bucket, because "did they buy or sell semis" is a
 * question people actually ask and 3674 answers it exactly.
 */
const RULES = [
  // --- technology, split the way the codes actually split -------------------
  [[3674, 3674], "Semiconductors"],
  [[3672, 3672], "Semiconductors"],          // printed circuit boards
  [[3559, 3559], "Semiconductors"],          // semiconductor capital equipment
  [[3825, 3827], "Electronics & Instruments"],
  [[3570, 3579], "Computers & Hardware"],
  [[3600, 3669], "Electronics & Instruments"],
  [[3675, 3699], "Electronics & Instruments"],
  [[7370, 7379], "Software & IT Services"],
  [[7371, 7372], "Software & IT Services"],

  // --- health --------------------------------------------------------------
  [[2833, 2836], "Health Care"],             // pharma & biologics
  [[3821, 3824], "Health Care"],
  [[3840, 3851], "Health Care"],             // medical devices
  [[8000, 8099], "Health Care"],
  [[5122, 5122], "Health Care"],

  // --- financials ----------------------------------------------------------
  // 6726 is investment offices — ETFs and closed-end funds live here, and they
  // must not be counted as an operating sector: an S&P 500 ETF is exposure to
  // everything, so folding it into "Financials" would silently misattribute it.
  [[6726, 6726], "Funds & ETFs"],
  [[6722, 6722], "Funds & ETFs"],
  [[6798, 6798], "Real Estate"],             // REITs
  [[6500, 6599], "Real Estate"],
  [[6000, 6199], "Banks & Lending"],
  [[6200, 6299], "Capital Markets"],
  [[6300, 6411], "Insurance"],
  [[6700, 6799], "Financials"],

  // --- energy & materials --------------------------------------------------
  [[1200, 1399], "Energy"],
  [[2900, 2999], "Energy"],
  [[4920, 4925], "Utilities"],
  [[4900, 4919], "Utilities"],
  [[4930, 4991], "Utilities"],
  [[1000, 1099], "Materials"],
  [[2600, 2699], "Materials"],
  [[2800, 2824], "Materials"],
  [[2840, 2899], "Materials"],
  [[3300, 3399], "Materials"],
  [[3200, 3299], "Materials"],

  // --- industrials ---------------------------------------------------------
  [[1500, 1799], "Industrials"],
  [[3400, 3499], "Industrials"],
  [[3500, 3558], "Industrials"],
  [[3560, 3569], "Industrials"],
  [[3700, 3799], "Industrials"],
  [[4000, 4789], "Transport & Logistics"],
  [[8700, 8748], "Industrials"],

  // --- communications & media ---------------------------------------------
  [[2700, 2799], "Media & Publishing"],
  [[4800, 4899], "Communications"],
  [[7812, 7841], "Media & Publishing"],

  // --- consumer ------------------------------------------------------------
  [[2000, 2199], "Consumer Staples"],
  [[5400, 5499], "Consumer Staples"],
  [[2200, 2399], "Consumer Discretionary"],
  [[2500, 2599], "Consumer Discretionary"],
  [[3000, 3199], "Consumer Discretionary"],
  [[3900, 3999], "Consumer Discretionary"],
  [[5000, 5399], "Consumer Discretionary"],
  [[5500, 5999], "Consumer Discretionary"],
  [[7000, 7299], "Consumer Discretionary"],
  [[7900, 7999], "Consumer Discretionary"],
  [[8200, 8299], "Consumer Discretionary"],
];

/** Every sector this file can emit. The UI colours and orders from this list. */
export const SECTORS = [
  "Semiconductors",
  "Software & IT Services",
  "Computers & Hardware",
  "Electronics & Instruments",
  "Communications",
  "Media & Publishing",
  "Health Care",
  "Banks & Lending",
  "Capital Markets",
  "Insurance",
  "Financials",
  "Real Estate",
  "Energy",
  "Utilities",
  "Materials",
  "Industrials",
  "Transport & Logistics",
  "Consumer Discretionary",
  "Consumer Staples",
  "Funds & ETFs",
  "Unclassified",
];

/**
 * @param {number|string|null|undefined} sic
 * @returns {string} one of SECTORS. Never throws, never guesses — anything
 *   unrecognised is "Unclassified", which is a legible answer. Inventing a
 *   sector for a code we do not recognise would be the one failure mode worth
 *   avoiding here, since a wrong sector is invisible in an aggregate.
 */
export function sectorForSic(sic) {
  const n = Number(sic);
  if (!Number.isFinite(n) || n <= 0) return "Unclassified";
  for (const [[lo, hi], sector] of RULES) {
    if (n >= lo && n <= hi) return sector;
  }
  return "Unclassified";
}
