// A holding that does not match the SEC's ticker list exactly used to land in
// "Unclassified" — a quarter of all the money focused managers traded in Q3
// 2026. Each case here is one of the ways that happened.

import { describe, it, expect } from "vitest";
import { createSectorLookup, assembleSectorMap, normTicker, normName, looksLikeFund } from "../shared/sectors.mjs";
import { sectorForSic } from "../shared/sic.mjs";

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
    expect(names[normName("EXXON MOBIL CORP")]).toBe("Energy");
    expect(names[normName("SAME NAME CORP")]).toBeUndefined();
  });
});
