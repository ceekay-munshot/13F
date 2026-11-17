// shared/themes.mjs
//
// THEMES, kept apart from sectors on purpose — see the header of shared/sic.mjs.
// A sector is what the SEC says a company is. A theme is a question people ask
// that cuts across sectors, so it is a hand-kept list and is labelled as one.
//
// "Who cut AI and chips?" is the question this exists for. The SEC's industry
// codes split that trade four ways:
//
//   Semiconductors             NVDA, SK Hynix, AMAT, LRCX, MU
//   Computers & Hardware       SanDisk, Seagate, Western Digital, Super Micro
//   Software & IT Services     Nebius, CoreWeave
//   Electronics & Instruments  Vertiv, Coherent, Lumentum
//
// so no single sector row could answer it.

/**
 * Everything the SEC files as Semiconductors, minus what is not a chip
 * business, plus these. Grouped so a change is easy to review.
 */
const AI_EXTRA = [
  // chip equipment the SEC files elsewhere
  "AMAT", "LRCX", "KLAC", "ASML", "TER", "ONTO", "ACMR", "NVMI", "CAMT", "AEIS", "ENTG",
  "MKSI", "UCTT", "ICHR", "FORM", "COHU", "KLIC", "PLAB", "AEHR", "VECO", "ACLS", "Q",
  // memory and storage
  "MU", "SNDK", "WDC", "STX", "SKHY", "HYNLY",
  // AI infrastructure: GPU clouds, servers, networking, power, optics
  "NBIS", "CRWV", "SMCI", "ANET", "VRT", "CLS", "DELL", "COHR", "LITE", "CIEN", "AAOI",
  "FN", "CRDO", "ALAB", "PENG",
  // bitcoin miners turned AI data-centre hosts
  "IREN", "APLD", "CIFR", "WULF", "CORZ",
];

/**
 * Filed by the SEC under semiconductors, but solar panels, contract
 * manufacturers, lasers and the like — not part of the AI trade.
 */
const NOT_AI = [
  "FSLR", "ENPH", "SEDG", "ARRY", "SHLS", "CSIQ", "DQ", "JKS", "NXT", "TE", "TYGO", "ASTI",
  "TOYO", "MAXN", "RUN", "SPWR", "TTMI", "FLEX", "JBL", "SANM", "PLXS", "BHE", "VIAV", "LASR",
  "IPGP", "KOPN", "NNDM", "OSIS", "ERII", "VELO", "CRCT", "SSM", "SPCB", "AZTA", "CTS",
  "IPWR", "LPTH",
];

const EXTRA = new Set(AI_EXTRA);
const EXCLUDED = new Set(NOT_AI);

export const AI_THEME = "AI & semis";

/** True if a trade belongs in the AI & semis theme. */
export function inAiTheme(ticker, sector) {
  const t = String(ticker ?? "").toUpperCase();
  if (EXCLUDED.has(t)) return false;
  return EXTRA.has(t) || sector === "Semiconductors";
}
