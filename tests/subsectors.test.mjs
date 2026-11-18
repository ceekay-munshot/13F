// Subsectors: every sector split a few ways, without ever moving a company
// out of the sector it was already in.

import { describe, it, expect } from "vitest";
import { SECTORS, sectorForSic } from "../shared/sic.mjs";
import {
  SUBSECTORS, SUBSECTOR_SECTOR, fundKind, otherSubsector, subsectorByTicker, subsectorForSic,
} from "../shared/subsectors.mjs";
import { PLACED_BY_BUSINESS, createSectorLookup, normName } from "../shared/sectors.mjs";
import { assembleSectorMap, createPlacer, packSubsectors, unpackSubsectors } from "../shared/sector-list.mjs";

describe("the subsector list", () => {
  it("puts every industry code in a subsector of the sector it already had", () => {
    for (let sic = 1; sic <= 9999; sic++) {
      expect(SUBSECTOR_SECTOR[subsectorForSic(sic)], `SIC ${sic}`).toBe(sectorForSic(sic));
    }
  });
  it("splits each sector a sensible number of ways", () => {
    for (const sector of SECTORS) {
      const n = SUBSECTORS.filter((s) => SUBSECTOR_SECTOR[s] === sector).length;
      if (sector === "Unclassified") expect(n).toBe(1);
      else expect(n, sector).toBeGreaterThanOrEqual(3);
      expect(n, sector).toBeLessThanOrEqual(9);
    }
  });
  it("never reuses a sector's own name, so a name says which it is", () => {
    for (const s of SUBSECTORS) if (s !== "Unclassified") expect(SECTORS).not.toContain(s);
    expect(new Set(SUBSECTORS).size).toBe(SUBSECTORS.length);
  });
  it("gives every sector a catch-all inside it", () => {
    for (const sector of SECTORS) expect(SUBSECTOR_SECTOR[otherSubsector(sector)]).toBe(sector);
  });
});

describe("subsectorForSic", () => {
  it("reads the SEC's codes", () => {
    expect(subsectorForSic(2834)).toBe("Drug makers"); // LLY, JNJ
    expect(subsectorForSic(2836)).toBe("Biotech"); // AMGN, GILD
    expect(subsectorForSic(3841)).toBe("Medical devices"); // BSX, SYK
    expect(subsectorForSic(6021)).toBe("Regional & other banks");
    expect(subsectorForSic(6141)).toBe("Consumer & business lenders"); // AFRM, SLM
    expect(subsectorForSic(7372)).toBe("Software"); // MSFT, ORCL
    expect(subsectorForSic(7370)).toBe("Internet & data services"); // META, GOOGL
    expect(subsectorForSic(3572)).toBe("Storage"); // SNDK, WDC, STX
    expect(subsectorForSic(4911)).toBe("Electric utilities");
    expect(subsectorForSic(4953)).toBe("Waste & environmental"); // WM, RSG
    expect(subsectorForSic(1311)).toBe("Oil & gas producers");
    expect(subsectorForSic(3711)).toBe("Cars & parts"); // TSLA, GM
    expect(subsectorForSic(3724)).toBe("Aerospace & defense"); // HON, RTX
    expect(subsectorForSic(6221)).toBe("Gold, commodities & crypto"); // GLD, IBIT
  });
  it("says Unclassified for a code it does not know", () => {
    expect(subsectorForSic(0)).toBe("Unclassified");
    expect(subsectorForSic(null)).toBe("Unclassified");
  });
});

describe("hand-placed names", () => {
  it("only ever applies inside the sector the SEC gave", () => {
    expect(subsectorByTicker("MU", "Semiconductors")).toBe("Memory");
    expect(subsectorByTicker("MU", "Health Care")).toBeNull();
    // KLA is chip equipment whichever of the two sectors its code puts it in.
    expect(subsectorByTicker("KLAC", "Semiconductors")).toBe("Chip equipment");
    expect(subsectorByTicker("KLAC", "Electronics & Instruments")).toBe("Chip test & inspection");
  });
  it("gives every name placed by its business a subsector of its own", () => {
    for (const [ticker, sector] of Object.entries(PLACED_BY_BUSINESS)) {
      const sub = subsectorByTicker(ticker, sector);
      expect(sub, ticker).not.toBeNull();
      expect(SUBSECTOR_SECTOR[sub], ticker).toBe(sector);
    }
  });
});

describe("fundKind", () => {
  it("knows the big funds by ticker", () => {
    expect(fundKind({ ticker: "IVV" })).toBe("Broad market");
    expect(fundKind({ ticker: "IEMG" })).toBe("International");
    expect(fundKind({ ticker: "TLT" })).toBe("Bonds & credit");
    expect(fundKind({ ticker: "XLF" })).toBe("Sector & thematic");
    expect(fundKind({ ticker: "IBIT" })).toBe("Gold, commodities & crypto");
    expect(fundKind({ ticker: "TQQQ" })).toBe("Leveraged & inverse");
  });
  it("reads the rest from the name and class a 13F gives", () => {
    expect(fundKind({ name: "ISHARES TR", cls: "20 YR TR BD ETF" })).toBe("Bonds & credit");
    expect(fundKind({ name: "SPDR GOLD TR", cls: "GOLD SHS" })).toBe("Gold, commodities & crypto");
    expect(fundKind({ name: "SELECT SECTOR SPDR TR", cls: "TECHNOLOGY" })).toBe("Sector & thematic");
    expect(fundKind({ name: "ISHARES TR", cls: "CORE MSCI EAFE" })).toBe("International");
    expect(fundKind({ name: "ISHARES TR", cls: "RUSSELL 2000 ETF" })).toBe("Broad market");
    expect(fundKind({ name: "PROSHARES TR", cls: "ULTRAPRO QQQ" })).toBe("Leveraged & inverse");
  });
  it("is not fooled by the words that trip a word test", () => {
    // An ultra-short BOND fund is not a leveraged one.
    expect(fundKind({ name: "JPMORGAN ETF TR", cls: "ULTRA SHORT INC" })).toBe("Bonds & credit");
    // Vanguard World and Global X sell US sector funds.
    expect(fundKind({ name: "VANGUARD WORLD FD", cls: "INF TECH ETF" })).toBe("Sector & thematic");
    expect(fundKind({ name: "GLOBAL X FDS", cls: "URANIUM ETF" })).toBe("Sector & thematic");
    // Oil services is an industry; oil is a commodity.
    expect(fundKind({ name: "VANECK ETF TRUST", cls: "OIL SERVICES ETF" })).toBe("Sector & thematic");
    expect(fundKind({ name: "UNITED STATES OIL FUND LP", cls: "UNITS" })).toBe("Gold, commodities & crypto");
  });
  it("reads class lines cut short and abbreviated", () => {
    expect(fundKind({ name: "SPDR SERIES TRUST", cls: "ST STR P400MID" })).toBe("Broad market");
    expect(fundKind({ name: "VANGUARD WORLD FD", cls: "CONSUM DIS ETF" })).toBe("Sector & thematic");
    expect(fundKind({ name: "FIDELITY MERRIMACK STR TR", cls: "LOW DURTIN ETF" })).toBe("Bonds & credit");
    expect(fundKind({ name: "ISHARES INC", cls: "MSCI EURZONE ETF" })).toBe("International");
    expect(fundKind({ name: "ABRDN ETFS", cls: "BBRG ALL COMD K1" })).toBe("Gold, commodities & crypto");
  });
  it("counts lenders and credit funds as credit", () => {
    expect(fundKind({ name: "FS KKR CAP CORP", cls: "COM" })).toBe("Bonds & credit");
    expect(fundKind({ name: "SIXTH STREET SPECIALTY LENDI", cls: "COM" })).toBe("Bonds & credit");
    expect(fundKind({ name: "BLACKROCK DEBT STRATEGIES FD", cls: "COM NEW" })).toBe("Bonds & credit");
    // An equity fund paying "premium income" is an equity fund.
    expect(fundKind({ name: "JPMORGAN EXCHANGE TRADED FD", cls: "EQUITY PREMIUM INCOME" })).toBe("Broad market");
  });
  it("says nothing rather than guess", () => {
    expect(fundKind({ name: "ISHARES TR", cls: "SHS" })).toBeNull();
  });
});

describe("createPlacer", () => {
  const map = {
    BA: "Industrials", NVDA: "Semiconductors", MU: "Semiconductors", SPY: "Funds & ETFs",
    "BRK-B": "Insurance", V: "Financials",
  };
  const subs = { BA: "Aerospace & defense", NVDA: "Chips", "BRK-B": "Property & casualty", V: "Business services" };
  const names = {
    [normName("TEVA PHARMACEUTICAL INDS LTD")]: "Drug makers", // a list with subsectors
    [normName("OLD CO INC")]: "Health Care", // a list from before subsectors
  };
  const place = createPlacer(map, { names, subs });
  // Read the name list the way the pipeline does: a subsector names its sector.
  const sectorOf = createSectorLookup(map, { names, nameSector: (v) => SUBSECTOR_SECTOR[v] ?? v });

  it("always answers the sector createSectorLookup does", () => {
    const rows = [
      { ticker: "BA" }, { ticker: "BAPRA" }, { ticker: "BRKB" }, { ticker: "ZZZZ", name: "ODD INC" },
      { ticker: null, name: "TEVA PHARMACEUTICAL INDS LTD" }, { ticker: null, name: "OLD CO INC" },
      { ticker: "IEF", name: "ISHARES TR", cls: "7-10 YR TRSY BD" }, { ticker: "V" },
    ];
    for (const row of rows) {
      const p = place(row);
      expect(p.sector).toBe(sectorOf(row));
      expect(SUBSECTOR_SECTOR[p.subsector]).toBe(p.sector);
    }
  });
  it("gives a preferred share its issuer's subsector", () => {
    expect(place({ ticker: "BAPRA" })).toEqual({ sector: "Industrials", subsector: "Aerospace & defense" });
  });
  it("prefers the hand list, and ignores a list entry from another sector", () => {
    expect(place({ ticker: "MU" }).subsector).toBe("Memory");
    // Visa's code is a business-services code; its sector is Financials.
    expect(place({ ticker: "V" })).toEqual({ sector: "Financials", subsector: "Payments" });
  });
  it("places a fund by its own filed class", () => {
    expect(place({ ticker: "IEF", name: "ISHARES TR", cls: "7-10 YR TRSY BD" }).subsector).toBe("Bonds & credit");
    expect(place({ ticker: "SPY" }).subsector).toBe("Broad market");
    expect(place({ ticker: null, name: "ISHARES TR", cls: "SHS" }).subsector).toBe("Other funds");
  });
  it("reads a name list with or without subsectors", () => {
    expect(place({ ticker: null, name: "TEVA PHARMACEUTICAL INDS LTD" })).toEqual({ sector: "Health Care", subsector: "Drug makers" });
    expect(place({ ticker: null, name: "OLD CO INC" })).toEqual({ sector: "Health Care", subsector: "Other health care" });
  });
  it("works with no subsector list at all", () => {
    const bare = createPlacer(map);
    expect(bare({ ticker: "NVDA" })).toEqual({ sector: "Semiconductors", subsector: "Other semiconductors" });
    expect(bare({ ticker: "MU" })).toEqual({ sector: "Semiconductors", subsector: "Memory" });
  });
});

describe("assembleSectorMap subsectors", () => {
  const tickers = new Map([
    ["LLY", { cik: 1, title: "ELI LILLY & Co" }],
    ["AMGN", { cik: 2, title: "AMGEN INC" }],
    ["MU", { cik: 3, title: "MICRON TECHNOLOGY INC" }],
    ["V", { cik: 4, title: "VISA INC." }],
    ["GLD", { cik: 5, title: "SPDR GOLD TRUST" }],
    ["AAA", { cik: 6, title: "TWIN NAME CORP" }],
    ["BBB", { cik: 7, title: "TWIN NAME INC" }],
  ]);
  const sicOf = new Map([[1, 2834], [2, 2836], [3, 3674], [4, 7389], [5, 6221], [6, 2834], [7, 2836]]);
  const { sectors, names } = assembleSectorMap({
    tickers, fundSymbols: new Set(["TLT"]), sicOf, sectorForSic,
  });

  it("gives every ticker a subsector inside its sector", () => {
    for (const [t, v] of Object.entries(sectors)) expect(SUBSECTOR_SECTOR[v.subsector], t).toBe(v.sector);
    expect(sectors.LLY.subsector).toBe("Drug makers");
    expect(sectors.AMGN.subsector).toBe("Biotech");
    expect(sectors.MU.subsector).toBe("Memory");
    expect(sectors.V).toMatchObject({ sector: "Financials", subsector: "Payments" });
    expect(sectors.GLD.subsector).toBe("Gold, commodities & crypto");
    expect(sectors.TLT).toMatchObject({ sector: "Funds & ETFs", subsector: "Bonds & credit" });
  });
  it("keeps a shared name's sector, at its catch-all, when only the subsectors differ", () => {
    expect(names[normName("TWIN NAME CORP")]).toBe("Other health care");
  });
  it("packs to a small file and reads back, whatever order the list is in", () => {
    const packed = packSubsectors(sectors);
    const reordered = { ...packed, subsectors: [...packed.subsectors].reverse() };
    for (const [t, i] of Object.entries(packed.tickerSubsectors)) {
      reordered.tickerSubsectors[t] = packed.subsectors.length - 1 - i;
    }
    const back = unpackSubsectors(reordered);
    for (const [t, v] of Object.entries(sectors)) expect(back[t]).toBe(v.subsector);
    expect(unpackSubsectors({})).toBeNull();
  });
});
