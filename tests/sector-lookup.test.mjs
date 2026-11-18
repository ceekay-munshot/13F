// A holding that does not match the SEC's ticker list exactly used to land in
// "Unclassified" — a quarter of all the money focused managers traded in Q3
// 2026. Each case here is one of the ways that happened.

import { describe, it, expect } from "vitest";
import { createSectorLookup, normTicker, normName, looksLikeFund } from "../shared/sectors.mjs";
import { assembleSectorMap, createPlacer } from "../shared/sector-list.mjs";
import { sectorForSic } from "../shared/sic.mjs";
import { SUBSECTOR_SECTOR } from "../shared/subsectors.mjs";

describe("normTicker / normName", () => {
  it("treats BRK-B, BRK.B and BRKB as one ticker", () => {
    expect(new Set(["BRK-B", "BRK.B", "brk/b", "BRKB"].map(normTicker)).size).toBe(1);
  });
  it("matches a filer's abbreviation to the SEC's spelling", () => {
    expect(normName("TEVA PHARMACEUTICAL INDS LTD")).toBe(normName("Teva Pharmaceutical Industries Ltd"));
    expect(normName("BERKSHIRE HATHAWAY INC DEL")).toBe(normName("Berkshire Hathaway Inc"));
    expect(normName("SPACE EXPLORATION TECHN CORP")).toBe(normName("Space Exploration Technologies Corp"));
  });
});

describe("looksLikeFund", () => {
  it("knows the ways funds are written in a 13F", () => {
    expect(looksLikeFund("STATE STR SPDR S&P 500 ETF T", "TR UNIT")).toBe(true);
    expect(looksLikeFund("INVESCO QQQ TR", "UNIT SER 1")).toBe(true);
    expect(looksLikeFund("ISHARES TR", "CORE S&P500 ETF")).toBe(true);
    expect(looksLikeFund("VANGUARD INDEX FDS", "S&P 500 ETF SHS")).toBe(true);
    expect(looksLikeFund("JANUS DETROIT STR TR", "HENDRSON AAA CL")).toBe(true);
  });
  it("does not call a company a fund for having TRUST in its name", () => {
    expect(looksLikeFund("NORTHERN TRUST CORP", "COM")).toBe(false);
    expect(looksLikeFund("FEDERAL REALTY INVT TR", "SH BEN INT NEW")).toBe(false);
    expect(looksLikeFund("AMPLIFY ENERGY CORP NEW", "COM")).toBe(false);
  });
});

describe("createSectorLookup", () => {
  const look = createSectorLookup(
    { "BRK-B": "Insurance", NVDA: "Semiconductors", NTRS: "Banks & Lending", ODD: "Unclassified" },
    { names: { [normName("Teva Pharmaceutical Industries Ltd")]: "Health Care" } },
  );
  it("uses the ticker first, with or without punctuation", () => {
    expect(look({ ticker: "NVDA" })).toBe("Semiconductors");
    expect(look({ ticker: "BRKB" })).toBe("Insurance");
  });
  it("a company's own ticker beats a fund-like name", () => {
    expect(look({ ticker: "NTRS", name: "NORTHERN TRUST ETF SERVICES" })).toBe("Banks & Lending");
  });
  it("places a fund the list does not know", () => {
    expect(look({ ticker: "SPY", name: "SPDR S&P 500 ETF TR", cls: "TR UNIT" })).toBe("Funds & ETFs");
  });
  it("places a holding filed with no ticker by its name", () => {
    expect(look({ ticker: null, name: "TEVA PHARMACEUTICAL INDS LTD" })).toBe("Health Care");
  });
  it("says Unclassified rather than guess", () => {
    expect(look({ ticker: "ZZZZ", name: "SOMETHING NEW INC" })).toBe("Unclassified");
    expect(look({ ticker: "ODD", name: "ODD CO" })).toBe("Unclassified");
  });
});

describe("assembleSectorMap", () => {
  const tickers = new Map([
    ["BRK-B", { cik: 1, title: "BERKSHIRE HATHAWAY INC" }],
    ["XOM", { cik: 2, title: "EXXON MOBIL CORP" }],
    ["SPY", { cik: 3, title: "SPDR S&P 500 ETF TRUST" }],
    ["GLD", { cik: 4, title: "SPDR GOLD TRUST" }],
    ["NEWCO", { cik: 5, title: "NEW COMPANY INC" }],
    ["AAA", { cik: 6, title: "SAME NAME CORP" }],
    ["BBB", { cik: 7, title: "SAME NAME INC" }],
  ]);
  const sicOf = new Map([[1, 6331], [2, 2911], [4, 6221], [6, 2834], [7, 3674]]);
  const { sectors, names } = assembleSectorMap({
    tickers, fundSymbols: new Set(["IVV", "VFIAX"]), sicOf, sectorForSic,
  });

  it("places companies by their industry code, and adds the bare spelling", () => {
    expect(sectors.XOM.sector).toBe("Energy");
    expect(sectors["BRK-B"].sector).toBe("Insurance");
    expect(sectors.BRKB.sector).toBe("Insurance");
  });
  it("places funds from the SEC's fund list or their name", () => {
    expect(sectors.SPY.sector).toBe("Funds & ETFs");
    expect(sectors.GLD.sector).toBe("Funds & ETFs"); // commodity pool, SIC 6221
    expect(sectors.IVV.sector).toBe("Funds & ETFs");
  });
  it("leaves out what it cannot place, and mutual fund classes nobody files", () => {
    expect(sectors.NEWCO).toBeUndefined();
    expect(sectors.VFIAX).toBeUndefined();
  });
  it("drops a name two companies share with different sectors", () => {
    // The name list holds the subsector, which names its sector.
    expect(names[normName("EXXON MOBIL CORP")]).toBe("Integrated oil & refiners");
    expect(SUBSECTOR_SECTOR[names[normName("EXXON MOBIL CORP")]]).toBe("Energy");
    expect(names[normName("SAME NAME CORP")]).toBeUndefined();
  });
});

describe("catch-all codes and bought-out companies", () => {
  const tickers = new Map([
    ["V", { cik: 10, title: "VISA INC." }],
    ["UBER", { cik: 11, title: "Uber Technologies, Inc" }],
    ["SPGI", { cik: 12, title: "S&P Global Inc." }],
    ["ACME", { cik: 13, title: "ACME STAFFING INC" }],
  ]);
  const sicOf = new Map([[10, 7389], [11, 7389], [12, 7320], [13, 7363]]);
  const filedNames = new Map([[normName("ELECTRONIC ARTS INC."), 7372], [normName("Acme Staffing Inc"), 2834]]);
  const { sectors, names } = assembleSectorMap({ tickers, fundSymbols: new Set(), sicOf, sectorForSic, filedNames });

  it("places well-known catch-all companies by what they sell", () => {
    expect(sectors.V.sector).toBe("Financials");
    expect(sectors.UBER.sector).toBe("Transport & Logistics");
    expect(sectors.SPGI.sector).toBe("Capital Markets");
  });
  it("keeps the code's own answer for everyone else in it", () => {
    expect(sectors.ACME.sector).toBe("Industrials");
  });
  it("finds a company that has left the ticker list by its filed name", () => {
    // The name list holds subsectors; the pipeline reads it with createPlacer.
    const look = createPlacer({}, { names });
    expect(look({ ticker: "EA", name: "ELECTRONIC ARTS INC", cls: "COM" })).toEqual({
      sector: "Software & IT Services", subsector: "Software",
    });
  });
  it("lets the ticker list's own name win over an older filed name", () => {
    expect(SUBSECTOR_SECTOR[names[normName("ACME STAFFING INC")]]).toBe("Industrials");
  });
});

describe("industry codes that used to be misread", () => {
  it("puts climate controls, HVAC and Eaton in Industrials, not Health Care or nowhere", () => {
    expect(sectorForSic(3822)).toBe("Industrials"); // Trane
    expect(sectorForSic(3585)).toBe("Industrials"); // Carrier, Lennox
    expect(sectorForSic(3590)).toBe("Industrials"); // Eaton
    expect(sectorForSic(3821)).toBe("Health Care"); // lab apparatus stays
  });
  it("puts the finance catch-all in Financials, not Banks & Lending", () => {
    expect(sectorForSic(6199)).toBe("Financials");
    expect(sectorForSic(6021)).toBe("Banks & Lending");
  });
});

describe("preferreds, shorthand names, investment vehicles", () => {
  const look = createSectorLookup(
    { BA: "Industrials", NEE: "Utilities", ORCL: "Software & IT Services", GM: "Industrials" },
    { names: { [normName("Wells Fargo & Company/MN")]: "Banks & Lending", [normName("Occidental Petroleum Corp")]: "Energy",
               [normName("Abbott Laboratories")]: "Health Care", [normName("Ascendis Pharma A/S")]: "Health Care" } },
  );
  it("places a preferred share with its issuer", () => {
    expect(look({ ticker: "BAPRA" })).toBe("Industrials");
    expect(look({ ticker: "NEEPRV" })).toBe("Utilities");
    expect(look({ ticker: "ORCLPRD" })).toBe("Software & IT Services");
  });
  it("reads a ticker the filer wrote into the name", () => {
    expect(look({ ticker: null, name: "General Motors Co (GM)" })).toBe("Industrials");
  });
  it("finds the issuer behind a coupon, and expands shorthand", () => {
    expect(look({ ticker: null, name: "WELLS FARGO CO 7.5Percen" })).toBe("Banks & Lending");
    expect(look({ ticker: null, name: "OCCIDENTAL PETE CORP" })).toBe("Energy");
    expect(look({ ticker: null, name: "ABBOTT LABS" })).toBe("Health Care");
    expect(look({ ticker: null, name: "ASCENDIS PHARMA" })).toBe("Health Care");
  });
  it("keeps a company whose name starts with a number", () => {
    expect(normName("3M CO")).toBe("3M");
  });
  it("calls a listed name with no industry code and a fund-like name a fund", () => {
    const { sectors } = assembleSectorMap({
      tickers: new Map([["FSK", { cik: 1, title: "FS KKR Capital Corp" }], ["ODDCO", { cik: 2, title: "ODD COMPANY INC" }]]),
      fundSymbols: new Set(), sicOf: new Map(), sectorForSic,
    });
    expect(sectors.FSK.sector).toBe("Funds & ETFs");
    expect(sectors.ODDCO).toBeUndefined();
  });
});
