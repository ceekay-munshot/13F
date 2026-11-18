// shared/subsectors.mjs
//
// Every sector split into a handful of subsectors, so the Sectors tab can say
// "focused managers sold biotech and bought drug makers" instead of only
// "Health Care was flat".
//
// THE RULE: A SUBSECTOR NEVER MOVES A COMPANY TO ANOTHER SECTOR
// -------------------------------------------------------------
// The sector is decided first, exactly as before (shared/sic.mjs, and the
// hand-placed names in shared/sectors.mjs). The subsector is then chosen
// INSIDE that sector, and a choice that belongs to a different sector is
// ignored. So Consensus's Sector flows, which only reads sectors, cannot
// change because of anything in this file.
//
// WHERE A SUBSECTOR COMES FROM, IN ORDER
// --------------------------------------
//   1. A short hand-kept list, for names the SEC's codes file in a way that
//      would mislead: Micron is "semiconductors" like NVIDIA, Booking.com is
//      "transportation services" like a trucking broker, Corning is "nonferrous
//      wire". Kept short on purpose — only names big enough to move a total.
//   2. The company's own SEC industry code (SIC), which is most of it.
//   3. For funds and ETFs, which have no useful code: what the fund is called.
//      "ISHARES TR / 20 YR TR BD ETF" is a bond fund; "SPDR GOLD TR" is gold.
//   4. Otherwise the sector's catch-all ("Other health care"), never a guess.

import { SECTORS, sectorForSic } from "./sic.mjs";

const r = (lo, hi = lo) => [lo, hi];

/**
 * Per sector: its subsectors in display order, each with the SIC ranges that
 * land in it and the hand-placed tickers, and the catch-all that anything else
 * in the sector falls into.
 *
 * A range only ever applies to codes shared/sic.mjs already puts in THIS
 * sector, so ranges here may be written loosely.
 */
const TREE = {
  "Semiconductors": {
    other: "Other semiconductors",
    subs: [
      ["Chips", [r(3674)]],
      ["Memory", [], ["MU", "SKHY", "HYNLY"]],
      ["Chip equipment", [r(3559)], [
        "AMAT", "LRCX", "ASML", "KLAC", "TER", "FORM", "ICHR", "UCTT", "PLAB", "ACMR", "KLIC",
        "VECO", "ACLS", "ASYS", "ONTO", "CAMT", "NVMI", "COHU", "AEHR", "AEIS", "ENTG", "MKSI",
      ]],
      // Solar panels and inverters, which the SEC files beside NVIDIA.
      ["Solar", [], [
        "FSLR", "ENPH", "SEDG", "CSIQ", "JKS", "DQ", "MAXN", "TE", "TYGO", "ASTI", "SPWR", "RUN",
        "ARRY", "SHLS", "NXT", "FTCI",
      ]],
      ["Circuit boards & assembly", [r(3672)]],
    ],
  },
  "Software & IT Services": {
    other: "Other software & IT",
    subs: [
      ["Software", [r(7372)], ["FICO"]],
      ["Internet & data services", [r(7370), r(7374, 7375)], ["AKAM"]],
      ["IT services", [r(7371), r(7373), r(7376, 7379)], ["ACN", "IT"]],
    ],
  },
  "Computers & Hardware": {
    other: "Peripherals & other hardware",
    subs: [
      ["Computers & servers", [r(3570, 3571), r(3575)]],
      ["Storage", [r(3572)]],
      // Palo Alto and Fortinet sell firewalls, which the SEC files as peripherals.
      ["Networking & security", [r(3576)], ["PANW", "FTNT"]],
      ["Peripherals & other hardware", [r(3573, 3574), r(3577, 3579)]],
    ],
  },
  "Electronics & Instruments": {
    other: "Other electronics",
    subs: [
      // Thermo Fisher and Danaher file as general instruments.
      ["Lab & life-science tools", [r(3826)], ["TMO", "DHR"]],
      // KLA, Teradyne, Onto: chip equipment the SEC files as instruments.
      ["Chip test & inspection", [], ["KLAC", "TER", "ONTO", "CAMT", "NVMI", "COHU", "AEHR", "FORM"]],
      ["Measurement & control", [r(3820, 3825), r(3827, 3829)]],
      ["Communications equipment", [r(3660, 3669)]],
      ["Electronic components", [r(3670, 3679)]],
      ["Electrical equipment & power", [r(3600, 3629), r(3640, 3649), r(3690, 3699)]],
      ["Other electronics", [r(3630, 3639), r(3650, 3659)]],
    ],
  },
  "Communications": {
    other: "Satellite & other communications",
    subs: [
      ["Telecom & wireless", [r(4810, 4829)]],
      ["Cable", [r(4840, 4849)]],
      ["Broadcasting & audio", [r(4830, 4839)]],
      ["Satellite & other communications", [r(4850, 4899)]],
    ],
  },
  "Media & Publishing": {
    other: "Other media",
    subs: [
      ["Film, TV & streaming", [r(7800, 7899)]],
      ["Publishing", [r(2700, 2799)]],
      ["Advertising", [r(7310, 7319)]],
    ],
  },
  "Health Care": {
    other: "Other health care",
    subs: [
      ["Drug makers", [r(2833, 2834)]],
      ["Biotech", [r(2836)]],
      ["Medical devices", [r(3840, 3851)]],
      ["Diagnostics & labs", [r(2835), r(3821), r(8071)]],
      ["Hospitals & care services", [r(8000, 8070), r(8072, 8099), r(8300, 8399)]],
      ["Drug distributors", [r(5122)]],
    ],
  },
  "Banks & Lending": {
    other: "Regional & other banks",
    subs: [
      // The ten largest US bank holding companies the SEC files as banks.
      ["Large US banks", [], ["JPM", "BAC", "C", "WFC", "USB", "PNC", "TFC", "COF", "BK", "STT"]],
      ["Regional & other banks", [r(6000, 6099)]],
      ["Mortgage lenders", [r(6160, 6169)]],
      ["Consumer & business lenders", [r(6100, 6159)]],
    ],
  },
  "Capital Markets": {
    other: "Other capital markets",
    subs: [
      ["Brokers & investment banks", [r(6211)], ["LPLA", "SNEX"]],
      ["Asset managers", [r(6282)]],
      ["Exchanges, ratings & data", [r(6200), r(6230, 6231)], ["SPGI", "MCO", "MSCI"]],
    ],
  },
  "Insurance": {
    other: "Other insurance",
    subs: [
      ["Health insurers", [r(6324)]],
      ["Property & casualty", [r(6330, 6331), r(6350, 6399)]],
      ["Life insurers", [r(6310, 6321)]],
      ["Insurance brokers", [r(6411)]],
    ],
  },
  "Financials": {
    other: "Other financials",
    subs: [
      ["Payments", [], ["V", "MA", "PYPL", "FISV", "FI", "GPN", "DLO", "RELY", "WU"]],
      // SIC 6199 is "finance services": card issuers and bitcoin miners alike.
      ["Crypto & bitcoin miners", [], [
        "COIN", "MSTR", "HUT", "CIFR", "WULF", "BTDR", "CORZ", "RIOT", "MARA", "CLSK", "IREN",
        "BITF", "HIVE", "BTBT", "CAN", "GREE", "SDIG", "BKKT", "BLSH", "CRCL", "GEMI", "GLXY",
      ]],
      ["Cards & fintech lenders", [r(6199)]],
      ["Other financials", [r(6700, 6799), r(9995)]],
    ],
  },
  "Real Estate": {
    other: "Other REITs",
    subs: [
      // REITs all share one SEC code (6798), so their kinds are hand-kept.
      ["Towers & data centres", [], ["AMT", "CCI", "SBAC", "EQIX", "DLR", "IRM"]],
      ["Homes & apartments", [], [
        "AVB", "EQR", "ESS", "MAA", "UDR", "CPT", "INVH", "AMH", "ELS", "SUI", "IRT", "AIV", "VRE",
        "NXRT", "ELME", "CSR",
      ]],
      ["Industrial & storage", [], [
        "PLD", "REXR", "EGP", "FR", "STAG", "TRNO", "LXP", "COLD", "PSA", "EXR", "CUBE", "NSA",
        "ILPT", "PLYM", "IIPR",
      ]],
      ["Health care REITs", [], [
        "WELL", "VTR", "OHI", "DOC", "SBRA", "CTRE", "NHI", "HR", "MPW", "AHR", "LTC", "CHCT", "DHC",
      ]],
      ["Retail & office REITs", [], [
        "SPG", "O", "KIM", "REG", "FRT", "NNN", "ADC", "MAC", "SKT", "BRX", "KRG", "AKR", "FCPT",
        "EPRT", "NTST", "GTY", "BXP", "VNO", "SLG", "KRC", "CUZ", "HIW", "DEI", "ARE", "PDM", "OPI",
        "BDN", "JBGS", "PGRE", "ESRT", "HPP",
      ]],
      ["Mortgage REITs", [], [
        "AGNC", "NLY", "STWD", "BXMT", "RITM", "ABR", "TWO", "ARI", "LADR", "DX", "ORC", "EFC",
        "MFA", "PMT", "RWT", "CIM", "IVR", "KREF", "TRTX", "FBRT", "ACRE", "BRSP", "ARR", "RC", "GPMT",
      ]],
      ["Other REITs", [r(6798)]],
      ["Property services & listings", [r(6500, 6599)], ["Z", "ZG", "CSGP"]],
    ],
  },
  "Energy": {
    other: "Coal & other energy",
    subs: [
      ["Oil & gas producers", [r(1310, 1329)]],
      ["Integrated oil & refiners", [r(2910, 2919)]],
      ["Drilling & oilfield services", [r(1380, 1389)]],
      ["Coal & other energy", [r(1200, 1299), r(2900, 2909), r(2920, 2999)]],
    ],
  },
  "Utilities": {
    other: "Water & other utilities",
    subs: [
      ["Electric utilities", [r(4910, 4919), r(4930, 4939), r(4991)]],
      // Generators selling into the market rather than regulated utilities —
      // the "power for data centres" trade.
      ["Power producers", [], ["VST", "CEG", "TLN", "NRG", "AES", "CWEN", "BEP", "BEPC", "NEP", "OKLO", "SMR"]],
      ["Gas pipelines & utilities", [r(4920, 4925)]],
      ["Waste & environmental", [r(4950, 4959)]],
      ["Water & other utilities", [r(4900, 4909), r(4940, 4949), r(4960, 4990)]],
    ],
  },
  "Materials": {
    other: "Other materials",
    subs: [
      ["Chemicals", [r(2800, 2824), r(2850, 2899)]],
      // P&G, Colgate, Estée Lauder: SIC files soap and cosmetics as chemicals.
      ["Household & personal products", [r(2840, 2844)]],
      ["Gold & silver miners", [r(1040, 1044)]],
      ["Mining", [r(1000, 1039), r(1050, 1099), r(1400, 1499)]],
      ["Steel & metals", [r(3300, 3399)]],
      // Aggregates file as quarrying; Corning as wire, for its optical fibre.
      ["Cement, glass & aggregates", [r(3200, 3299)], ["VMC", "MLM", "KNF", "USLM", "SUM", "GLW"]],
      ["Paper, packaging & wood", [r(2400, 2699), r(800, 899)]],
    ],
  },
  "Industrials": {
    other: "Other industrials",
    subs: [
      ["Aerospace & defense", [r(3720, 3729), r(3760, 3769), r(3795), r(3800, 3812), r(3480, 3489), r(3730, 3732)], ["SPCX"]],
      ["Cars & parts", [r(3710, 3716), r(3750, 3759), r(3790, 3799)]],
      ["Machinery & equipment", [r(3400, 3479), r(3490, 3558), r(3560, 3569), r(3580, 3599), r(3733, 3749), r(3822)]],
      ["Homebuilders", [r(1520, 1531)]],
      ["Construction & engineering", [r(1500, 1519), r(1532, 1799), r(8710, 8713)]],
      ["Business services", [
        r(7300, 7369), r(7380, 7389), r(7600, 7699), r(8100, 8199), r(8700, 8709), r(8714, 8748), r(8900, 8999),
      ]],
    ],
  },
  "Transport & Logistics": {
    other: "Pipelines & other transport",
    subs: [
      ["Airlines & airports", [r(4500, 4512), r(4514, 4599)]],
      ["Railroads", [r(4000, 4099)]],
      ["Shipping & cruises", [r(4400, 4499)]],
      ["Trucking, parcels & logistics", [r(4200, 4299), r(4513), r(4700, 4789)]],
      // Booking.com and Expedia file as "transportation services" like a broker.
      ["Travel & ride-hailing", [], ["BKNG", "EXPE", "TRIP", "MMYT", "UBER", "LYFT", "DESP"]],
      ["Pipelines & other transport", [r(4100, 4199), r(4300, 4399), r(4600, 4699)]],
    ],
  },
  "Consumer Discretionary": {
    other: "Other consumer",
    subs: [
      ["Online retail & marketplaces", [r(5961)], [
        "MELI", "PDD", "BABA", "JD", "SE", "DASH", "EBAY", "ETSY", "CART",
      ]],
      ["Discount & home stores", [r(5200, 5399)]],
      ["Specialty retail & car dealers", [r(5500, 5811), r(5814, 5960), r(5962, 5999)]],
      ["Restaurants", [r(5812, 5813)]],
      ["Travel & leisure", [r(7000, 7099), r(7900, 7999)], ["ABNB", "TCOM"]],
      ["Apparel & home goods", [r(2200, 2399), r(2500, 2599), r(3020, 3021), r(3100, 3199), r(3860, 3879), r(3900, 3999)]],
      ["Wholesale & distribution", [r(5000, 5199)]],
      // Tyres and plastics (Goodyear, Entegris) sit here: SIC files them with
      // shoes, and they are not shoes.
      ["Other consumer", [r(3000, 3019), r(3022, 3099), r(7200, 7299), r(7500, 7599), r(8200, 8299)]],
    ],
  },
  "Consumer Staples": {
    other: "Other staples",
    subs: [
      ["Beverages", [r(2080, 2089)]],
      ["Packaged food", [r(2000, 2079), r(2090, 2099)]],
      ["Tobacco", [r(2100, 2199)]],
      ["Grocery stores", [r(5400, 5499)]],
      ["Farming", [r(100, 999)]],
    ],
  },
  "Funds & ETFs": {
    other: "Other funds",
    subs: [
      ["Broad market", []],
      ["Sector & thematic", []],
      ["International", []],
      ["Bonds & credit", []],
      ["Gold, commodities & crypto", [r(6221)]],
      ["Leveraged & inverse", []],
      ["Other funds", [r(6722), r(6726)]],
    ],
  },
  "Unclassified": {
    other: "Unclassified",
    subs: [["Unclassified", []]],
  },
};

/**
 * Every subsector, in display order, sector by sector. Files that carry a
 * subsector as a number carry this list beside it, so a number always reads
 * back as the name it was written as, whatever this list later becomes.
 */
export const SUBSECTORS = [];
/** subsector -> its sector. */
export const SUBSECTOR_SECTOR = {};
const OTHER = {};
const RANGES = {};
const BY_TICKER = {};

for (const sector of SECTORS) {
  const node = TREE[sector];
  if (!node) throw new Error(`no subsectors for ${sector}`);
  OTHER[sector] = node.other;
  RANGES[sector] = [];
  BY_TICKER[sector] = new Map();
  // The catch-all goes last unless the sector lists it with codes of its own.
  const subs = node.subs.some(([name]) => name === node.other) ? node.subs : [...node.subs, [node.other, []]];
  for (const [name, ranges, tickers = []] of subs) {
    if (SUBSECTOR_SECTOR[name]) throw new Error(`subsector ${name} is in two sectors`);
    SUBSECTORS.push(name);
    SUBSECTOR_SECTOR[name] = sector;
    for (const range of ranges) RANGES[sector].push([range, name]);
    for (const t of tickers) BY_TICKER[sector].set(t, name);
  }
}

export const OTHER_FUNDS = OTHER["Funds & ETFs"];

/** The catch-all subsector of a sector. Unclassified for anything unknown. */
export function otherSubsector(sector) {
  return OTHER[sector] ?? "Unclassified";
}

/** True if `sub` is a subsector of `sector`. */
export function inSector(sub, sector) {
  return sub != null && SUBSECTOR_SECTOR[sub] === sector;
}

/**
 * The subsector an SEC industry code means, inside the sector shared/sic.mjs
 * gives that code. Never null.
 */
export function subsectorForSic(sic) {
  const sector = sectorForSic(sic);
  const n = Number(sic);
  for (const [[lo, hi], name] of RANGES[sector] ?? []) if (n >= lo && n <= hi) return name;
  return otherSubsector(sector);
}

/** A hand-placed subsector for this ticker, if it has one inside `sector`. */
export function subsectorByTicker(ticker, sector) {
  return BY_TICKER[sector]?.get(String(ticker ?? "").toUpperCase()) ?? null;
}

// ---------------------------------------------------------------------------
// Funds and ETFs, by what kind of fund they are
// ---------------------------------------------------------------------------

/**
 * The funds that carry most of the money focused managers trade, placed by
 * ticker: a 13F often names an ETF only by its trust ("ISHARES TR"), which
 * says nothing about the fund.
 */
const FUND_TICKERS = {
  "Broad market": [
    "SPY", "IVV", "VOO", "VTI", "QQQ", "QQQM", "IWM", "IWB", "IWV", "IWF", "IWD", "IWR", "IWO", "IWN",
    "RSP", "DIA", "MDY", "IJH", "IJR", "IVW", "IVE", "VTV", "VUG", "VO", "VB", "VXF", "VIG", "VYM",
    "SCHD", "SCHX", "SCHB", "SCHG", "ITOT", "SPLG", "SPYM", "SPYG", "SPYV", "MGK", "USMV", "MTUM",
    "QUAL", "VLUE", "DGRW", "JEPI", "JEPQ", "BKLC", "BKMC", "DFAC", "DFSV", "DFAT", "DFAU", "DUHP",
    "AVLV", "FNDX", "DYNF", "JHML", "SPMO", "RSPT", "COWZ", "OEF", "XLG", "VV", "SPTM", "DCOR",
  ],
  "International": [
    "EFA", "IEFA", "VEA", "VWO", "IEMG", "EEM", "VXUS", "IXUS", "ACWI", "VEU", "VT", "VGK", "VPL",
    "EWJ", "EWY", "EWZ", "EWT", "MCHI", "FXI", "KWEB", "INDA", "EFG", "EFV", "SPDW", "AVDE", "URTH",
    "DFAI", "DFIV", "DFEM", "SCHF", "IDEV", "EWG", "EWU", "EWC", "EWW", "BKUI", "DXUV",
  ],
  "Bonds & credit": [
    "AGG", "BND", "BNDX", "TLT", "TLH", "IEF", "SHY", "SHV", "BIL", "SGOV", "TIP", "STIP", "SCHP",
    "LQD", "HYG", "JNK", "USHY", "SPHY", "ANGL", "BKLN", "SRLN", "VCIT", "VCSH", "VGIT", "VGSH",
    "VGLT", "VTEB", "MUB", "HYD", "SPTL", "SPTI", "SPTS", "SPTB", "SPIB", "SPSB", "IGSB", "IGIB",
    "USIG", "SLQD", "GOVT", "USFR", "TFLO", "JPST", "MINT", "FLOT", "BOXX", "EMB", "JEMB", "EMLC",
    "XEMD", "BKAG", "BHYB", "JAAA", "IAGG", "FBND", "PYLD", "VBIL", "XBB", "XFIV", "XTRE", "TUA",
    "TLTW", "PFF", "MBB", "VMBS", "BSV", "BIV", "SCHO", "SCHR", "SCHZ", "IUSB", "TRTY", "DFCF",
    "CWB", "LMBS", "FLRT", "VTIP", "IGLB", "ARCC", "FSK", "OBDC", "MAIN", "BXSL", "OCSL", "TSLX",
  ],
  "Sector & thematic": [
    "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC", "SMH", "SOXX",
    "XBI", "IBB", "KRE", "KBE", "KBWB", "ITB", "XHB", "ARKK", "IGV", "VGT", "XOP", "OIH", "IYR",
    "VNQ", "CIBR", "IGF", "COPX", "URA", "TAN", "ICLN", "LIT", "XAR", "ITA", "VHT", "VFH", "VDE",
    "IYW", "FTEC", "SKYY", "BOTZ", "AIQ", "DRAM", "ARMS", "MAGS", "DFAR", "AMLP", "GRID",
  ],
  "Gold, commodities & crypto": [
    "GLD", "GLDM", "IAU", "SGOL", "AAAU", "SLV", "SIVR", "PSLV", "PHYS", "GDX", "GDXJ", "SIL",
    "SILJ", "USO", "UNG", "DBC", "PDBC", "GSG", "IBIT", "FBTC", "GBTC", "ARKB", "BITB", "BITO",
    "HODL", "BTC", "ETHA", "ETHE", "FETH", "ETH", "SPPP", "CPER",
  ],
  "Leveraged & inverse": [
    "TQQQ", "SQQQ", "SOXL", "SOXS", "UPRO", "SPXU", "SPXL", "SPXS", "TNA", "TZA", "LABU", "LABD",
    "FAS", "FAZ", "TECL", "NVDL", "TSLL", "UVXY", "VXX", "SVXY", "QLD", "SSO", "SDS", "SH", "PSQ",
    "DOG", "RWM", "BITX", "CONL", "MSTU", "MSTX", "TMF", "TBT", "YINN", "FNGU", "USD", "MUU",
  ],
};
const FUND_BY_TICKER = new Map();
for (const [kind, list] of Object.entries(FUND_TICKERS)) for (const t of list) FUND_BY_TICKER.set(t, kind);

// By name. Order matters: a leveraged S&P 500 fund is leveraged, a gold
// miners ETF is gold, an emerging-markets bond fund is a bond fund, and an
// equity fund that pays out "premium income" is still an equity fund.
//
// 13F class lines are cut to 16 characters and abbreviated however the filer
// liked ("LOW DURTIN ETF", "CONSUM DIS ETF", "ST STR P400MID"), so most words
// are matched by their start.
const words = (list) => new RegExp("\\b(" + list.join("|") + ")\\b");
const FUND_NAME_RULES = [
  ["Leveraged & inverse", /\b(ULTRAPRO|ULTRASHORT|ULTRA(?! ?SHORT)|BULL|BEAR|[1-5]X|LEVERAGED?|INVERSE|DAILY|DLY|VIX|VOLATILITY)\b/],
  ["Broad market", words(["PREMIUM INCOME", "EQUITY INCOME", "COVERED CALL", "BUYWRITE", "DIVIDEND INCOME"])],
  ["Gold, commodities & crypto", words([
    "GOLD", "SILVER", "PLATINUM", "PALLADIUM", "PRECIOUS", "BULLION", "OIL(?! (?:SERVICES?|SVCS?|&|AND|GAS|EQUIP\\w*|EXPL\\w*))",
    "CRUDE", "BRENT", "NATURAL GAS", "NAT GAS", "COMMODIT\\w*", "COMD\\w*", "COMMD\\w*", "BITCOIN", "BTC",
    "ETHER", "ETHEREUM", "ETH", "CRYPTO\\w*", "SOLANA", "XRP", "COPPER",
  ])],
  // Business development companies and closed-end credit funds lend; they
  // are credit, not stock.
  ["Bonds & credit", words([
    "BONDS?", "BDS?", "TREAS\\w*", "TRSRY", "T BILLS?", "TBILLS?", "BILLS?", "MUNI\\w*", "MUN", "TIPS",
    "AGGREGATE", "AGG", "FIXED", "FIX", "HIGH YIELD", "HI YIELD", "HIGH YLD", "HI YLD", "FLOATING RATE",
    "FLOAT RATE", "FLT RATE", "MORTGAGE", "MBS", "SECURITI[SZ]ED", "SECURITI", "SENIOR LOAN", "BANK LOAN", "CLO",
    "AAA", "INVESTMENT GRADE", "INV GRADE", "INV GRD", "INVST GRD", "CORPORATE", "CORPOR", "ULTRA SHORT",
    "ULT SHR", "SHORT MATURITY", "DUR\\w*", "YR", "GOVT", "GOVERNMENT", "PREFERRED", "PFD", "CONV\\w*",
    "DEBT", "CREDIT", "CR STRATEGIES", "LENDI\\w*", "BDC", "CAP CORP", "CAPITAL CORP\\w*", "INCOME FD",
    "INCOME FUND", "FLEXIBLE INCOME", "BLOOMBERG", "BLMBRG", "BBG",
  ])],
  ["International", words([
    "EAFE", "EMERGING", "EMER", "EMRG", "EMG\\w*", "EMKT", "EM", "INTL", "INTERNATIONAL", "INTERNATL", "WORLD",
    "GLOBAL", "ACWI", "EUROPE\\w*", "EURO", "EUROZONE", "EURZONE", "JAPAN", "CHINA", "CSI", "INDIA", "KOREA",
    "TAIWAN", "BRAZIL", "MEXICO", "CANADA", "GERMANY", "UNITED KINGDOM", "ASIA", "PACIFIC", "LATIN",
    "DEVELOPED", "DEV MKTS?", "EX US", "EXUS", "FRONTIER", "ISRAEL", "SAUDI", "VIETNAM", "AUSTRALIA",
    "SWITZERLAND", "FRANCE", "SPAIN", "ITALY", "SINGAPORE", "HONG KONG", "INDONESIA", "CHILE", "ARGENTINA",
    "AFRICA", "POLAND", "RUSSIA",
  ])],
  ["Sector & thematic", words([
    "SECTOR", "SEMICONDUCTOR\\w*", "SEMIS?", "TECHNOLOGY", "TECH", "TEC", "BIOTECH\\w*", "HEALTH\\w*", "HLTH",
    "FINANCIALS?", "FINL", "ENERGY", "UTILIT\\w*", "REAL ESTATE", "REITS?", "INDUSTRIALS?", "INDL",
    "MATERIALS", "CONSUM\\w*", "DISCRETIONARY", "STAPLES", "HOMEBUILDERS?", "HOME CONSTR\\w*", "REGIONAL",
    "REGL", "BANKS?", "BANKING", "BKG", "INSURANCE", "INNO\\w*", "ROBOTICS?", "AUTOMATION", "CYB\\w*",
    "CLEAN", "CLN", "SOLAR", "WIND", "INTERNET", "SOFTWARE", "AEROSPACE", "DEFENSE", "AI", "A I",
    "ARTIFICIAL", "CLOUD", "INFRASTRUCTURE", "COMMUNICATIONS?", "COMM SRVC", "TRANSPORT\\w*", "GENOMICS?",
    "METALS", "MINING", "MINERS", "OIL", "EXPLORATION", "MLP", "ALERIAN", "PHARMA\\w*", "MEDICAL",
    "NUCLEAR", "URANIUM", "LITHIUM", "BATTERY", "BLOCKCHAIN", "FINTECH", "GAMING", "SPACE", "CANNABIS",
    "WATER", "NATURAL RESOURCES", "RESOURCES",
  ])],
  ["Broad market", words([
    "S&P\\w*", "SP\\d+", "\\w*500\\w*", "\\w*400\\w*", "\\w*600\\w*", "TOTAL", "TOT", "TTL", "STK MKT",
    "STOCK MARKET", "MARKET", "MKT", "RUS\\w*", "NASD\\w*", "QQQ", "DOW", "DJIA", "MID\\w*", "SMALL\\w*",
    "SML", "LARGE\\w*", "LRG", "MEGA\\w*", "MICRO\\w*", "TOP 200", "VALUE", "GROWTH", "GRWTH", "DIVIDEND",
    "DIV", "DV", "EQUAL\\w*", "EQL WT", "MOMENTUM", "QUALITY", "QLTY", "MIN VOL", "LOW VOL", "CORE",
    "EQUITY", "INDEX", "\\w*1000\\w*", "\\w*2000\\w*", "\\w*3000\\w*", "US", "USA", "EXTENDED", "ESG",
    "FACTOR", "MULTIFACTOR",
  ])],
];

// Fund families whose own name would mislead a word test: Global X and
// Vanguard World sell mostly US sector funds.
const FAMILY_NOISE = /\b(GLOBAL X|VANGUARD WORLD)\b/g;

/**
 * What kind of fund this is, from its ticker or its filed name and class.
 * null when nothing says — the caller then uses "Other funds".
 */
export function fundKind({ ticker, name, cls } = {}) {
  const byTicker = FUND_BY_TICKER.get(String(ticker ?? "").toUpperCase());
  if (byTicker) return byTicker;
  const text = `${name ?? ""} ${cls ?? ""}`.toUpperCase()
    .replace(FAMILY_NOISE, " ")
    .replace(/[^A-Z0-9& ]/g, " ")
    .replace(/\s+/g, " ");
  for (const [kind, rule] of FUND_NAME_RULES) if (rule.test(text)) return kind;
  return null;
}
