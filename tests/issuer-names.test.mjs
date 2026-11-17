// tests/issuer-names.test.mjs
//
// Does a filing's name column agree with its code column?
//
// The positive case is the real one: Lightrock Netherlands B.V.'s Q3-2026
// filing (0002041485-26-000006), as published on 17 Nov 2026 — names as filed,
// with the code each was filed under. The negative cases are the innocent
// patterns that the first, looser version of this check flagged while being
// measured on the SEC's bulk data. Each is a real filer's habit.
//
// Codes are stand-ins ("X-COHU"), not the real identifiers: a table of real
// codes beside their tickers is the licensed database this repo never commits
// (see .gitignore). The check only needs each code to be consistent between
// the lines and the lookup, which stand-ins are. Names and tickers are the
// real ones from data/securities.json and the filing.

import { describe, it, expect } from "vitest";
import {
  nameTokens, tokensMatch, namesAgree, namesIdentify, checkIssuerNames, NAME_CHECK_MIN_DISPLACED,
} from "../shared/issuer-names.mjs";

const LIGHTROCK_Q3 = [
  ["X-SPSC", "SPS COMM INC", 44034501],
  ["X-CBT", "BRUNSWICK CORP", 27590437],
  ["X-FSLR", "ENVISTA HOLDINGS CORP", 25059561],
  ["X-WTFC", "WINTRUST FINANCIAL CORP", 24284831],
  ["X-AKAM", "AKAMAI TECHNOLOGIES INC", 22472393],
  ["X-GMED", "GLOBUS MEDICAL INC - A", 20510241],
  ["X-ENS", "ENCOMPASS HEALTH CORP", 19973684],
  ["X-JBL", "JABIL INC", 19296498],
  ["X-RNR", "SALLY BEAUTY HOLDINGS INC", 18488870],
  ["X-STRA", "STRATEGIC EDUCATION INC", 15674427],
  ["X-BLKB", "BLACKBAUD INC", 15531168],
  ["X-AYI", "ACUITY INC", 15477178],
  ["X-ANF", "ABERCROMBIE & FITCH CO-CL A", 15354660],
  ["X-BC", "AVANTOR INC", 13310867],
  ["X-LNN", "LINDSAY CORP", 12956159],
  ["X-ALGM", "ALLEGRO MICROSYSTEMS INC", 12813629],
  ["X-MWA", "MUELLER WATER PRODUCTS INC-A", 12528180],
  ["X-LITE", "LUMENTUM HOLDINGS INC", 12462237],
  ["X-CTRE", "CABOT CORP", 11916666],
  ["X-CUBE", "COMPASS MINERALS INTERNATION", 11816018],
  ["X-TOWN", "TOWNE BANK", 11578906],
  ["X-TNC", "TENNANT CO", 10123197],
  ["X-AVTR", "AMERICAN HOMES 4 RENT- A", 9455119],
  ["X-WEX", "WEX INC", 8909047],
  ["X-PFSI", "PENNYMAC FINANCIAL SERVICES", 8492672],
  ["X-ZBH", "ZIMMER BIOMET HOLDINGS INC", 8135317],
  ["X-TROX", "TRONOX HOLDINGS PLC", 7675632],
  ["X-AXS", "AXIS CAP HLDGS LTD", 6069682],
  ["X-COHU", "CARETRUST REIT INC", 5991182],
  ["X-DRH", "DARLING INGREDIENTS INC", 5896033],
  ["X-DAR", "CUBESMART", 5484951],
  ["X-DOC", "HEALTHPEAK PROPERTIES INC", 5471780],
  ["X-TRIP", "TRIPADVISOR INC", 5199159],
  ["X-EHC", "DIAMONDROCK HOSPITALITY CO", 4078800],
  ["X-IRT", "INDEPENDENCE REALTY TRUST IN", 4068400],
];
const LIGHTROCK_CODES = {
  "X-SPSC": { ticker: "SPSC", name: "SPS COMMERCE INC COM STK (DE)" },
  "X-CBT": { ticker: "CBT", name: "CABOT CORP" },
  "X-FSLR": { ticker: "FSLR", name: "FIRST SOLAR, INC. COM" },
  "X-WTFC": { ticker: "WTFC", name: "WINTRUST FINL CORP" },
  "X-AKAM": { ticker: "AKAM", name: "AKAMAI TECHNOLOGIES INC" },
  "X-GMED": { ticker: "GMED", name: "GLOBUS MED INC CL A NEW" },
  "X-ENS": { ticker: "ENS", name: "ENERSYS COM STK" },
  "X-JBL": { ticker: "JBL", name: "JABIL INC" },
  "X-RNR": { ticker: "RNR", name: "RENAISSANCERE HOLDINGS LTD" },
  "X-STRA": { ticker: "STRA", name: "STRATEGIC ED INC" },
  "X-BLKB": { ticker: "BLKB", name: "BLACKBAUD INC" },
  "X-AYI": { ticker: "AYI", name: "ACUITY INC" },
  "X-ANF": { ticker: "ANF", name: "ABERCROMBIE & FITCH CO CL-A" },
  "X-BC": { ticker: "BC", name: "BRUNSWICK CORP" },
  "X-LNN": { ticker: "LNN", name: "LINDSAY CORPORATION" },
  "X-ALGM": { ticker: "ALGM", name: "ALLEGRO MICROSYSTEMS INC DEL C" },
  "X-MWA": { ticker: "MWA", name: "MUELLER WATER PRODUCTS, INC. S" },
  "X-LITE": { ticker: "LITE", name: "LUMENTUM HLGDS INC COM STK" },
  "X-CTRE": { ticker: "CTRE", name: "CARETRUST REIT INC COM STK (MD" },
  "X-CUBE": { ticker: "CUBE", name: "CUBESMART COM SHS (MD)" },
  "X-TOWN": { ticker: "TOWN", name: "TOWNE BANK (VA)" },
  "X-TNC": { ticker: "TNC", name: "TENNANT COMPANY" },
  "X-AVTR": { ticker: "AVTR", name: "AVANTOR INC COM" },
  "X-WEX": { ticker: "WEX", name: "WEX INC COM STK (DE)" },
  "X-PFSI": { ticker: "PFSI", name: "PENNYMAC FINL SVCS INC NEW COM" },
  "X-ZBH": { ticker: "ZBH", name: "ZIMMER BIOMET HOLDINGS INC COM" },
  "X-TROX": { ticker: "TROX", name: "TRONOX HLDGS PLC SHS (GBR)" },
  "X-AXS": { ticker: "AXS", name: "AXIS CAPITAL HOLDINGS LTD" },
  "X-COHU": { ticker: "COHU", name: "COHU INC" },
  "X-DRH": { ticker: "DRH", name: "DIAMONDROCK HOSPITALITY COMPAN" },
  "X-DAR": { ticker: "DAR", name: "DARLING INGREDIENTS INC COMMON" },
  "X-DOC": { ticker: "DOC", name: "HEALTHPEAK PPTYS INC COM (MD)" },
  "X-TRIP": { ticker: "TRIP", name: "TRIPADVISOR INC COM (NV)" },
  "X-EHC": { ticker: "EHC", name: "ENCOMPASS HEALTH CORP COM (DE)" },
  "X-IRT": { ticker: "IRT", name: "INDEPENDENCE RLTY TR INC COM S" },
};

const lightrockRows = () => LIGHTROCK_Q3.map(([cusip, name_of_issuer]) => ({ cusip, name_of_issuer }));

// Codes for the innocent cases, as the SEC's fails-to-deliver list names them.
const CODES = {
  "X-JEPI": { ticker: "JEPI", name: "J P MORGAN EXCHANGE-TRADED FD" },
  "X-JPM": { ticker: "JPM", name: "JPMORGAN CHASE & CO COM STK" },
  "X-IJH": { ticker: "IJH", name: "ISHARES CORE S&P MID-CAP ETF" },
  "X-VOO": { ticker: "VOO", name: "VANGUARD INDEX FDS S&P 500 ETF" },
  "X-BLK": { ticker: "BLK", name: "BLACKROCK INC FDG INC COM" },
  "X-COR": { ticker: "COR", name: "CENCORA, INC." },
  "X-AXIA": { ticker: "AXIA", name: "AXIA ENERGIA SPONSORED ADR REP" },
  "X-AXIAPRC": { ticker: "AXIAPRC", name: "CENTRAIS ELETRICAS BRASILEIRAS" },
  "X-AAPL": { ticker: "AAPL", name: "APPLE INC;COM NPV" },
  "X-AMZN": { ticker: "AMZN", name: "AMAZON COM INC;COM USD0.01" },
  "X-SHOO": { ticker: "SHOO", name: "MADDEN (STEVEN) LTD" },
  "X-ELVA": { ticker: "ELVA", name: "ELECTROVAYA INC COM NEW (CANAD" },
  "X-XLP": { ticker: "XLP", name: "STATE STREET CONSUMER STAPLES" },
  "X-NVDA": { ticker: "NVDA", name: "NVIDIA CORP" },
  "X-MSFT": { ticker: "MSFT", name: "MICROSOFT CORP;COM USD0.000012" },
  "X-ORCL": { ticker: "ORCL", name: "ORACLE CORPORATION" },
  "X-OSK": { ticker: "OSK", name: "OSHKOSH CORPORATION (HOLDING C" },
  "X-OXY": { ticker: "OXY", name: "OCCIDENTAL PETROLEUM CORP" },
};
const row = (cusip, name_of_issuer) => ({ cusip, name_of_issuer });

describe("reading a name", () => {
  it("drops the exchange's par-value suffix", () => {
    // "USD0" from one company's par value matched another's and made Amazon
    // and Microsoft look like one issuer.
    expect(nameTokens("AMAZON COM INC;COM USD0.01")).toEqual(["AMAZON"]);
    expect(namesAgree("MICROSOFT CORP;COM USD0.000012", "AMAZON COM INC;COM USD0.01")).toBe(false);
  });

  it("drops what kind of security it is and keeps whose it is", () => {
    // The exchange truncates at 30 characters, mid place-of-incorporation.
    expect(nameTokens("CARETRUST REIT INC COM STK (MD")).toEqual(["CARETRUST"]);
    expect(nameTokens("CARETRUST REIT INC")).toEqual(["CARETRUST"]);
  });

  it("joins letters spelled out one at a time", () => {
    // Otherwise the P of "J P MORGAN" is dropped as the P of "L P", and a
    // JPMorgan ETF no longer matches its own trust's name.
    expect(nameTokens("J P MORGAN EXCHANGE-TRADED FD")).toEqual(["JP", "MORGAN", "EXCHANGE", "TRADED"]);
    expect(namesAgree("JPMORGAN EQUITY PREMIUM INCOME ETF", "J P MORGAN EXCHANGE-TRADED FD")).toBe(true);
    expect(nameTokens("AT&T INC")).toEqual(["ATT"]);
  });

  it("accepts abbreviations as the same word", () => {
    expect(tokensMatch("HLDGS", "HOLDINGS")).toBe(true);
    expect(tokensMatch("MACHS", "MACHINES")).toBe(true);
    expect(tokensMatch("COHU", "CARETRUST")).toBe(false);
  });
});

describe("a name that belongs to another company", () => {
  it("needs the same distinctive first word, not one that merely fits inside it", () => {
    expect(namesIdentify("CABOT CORP", "CABOT CORP")).toBe(true);
    expect(namesIdentify("CARETRUST REIT INC", "CARETRUST REIT INC COM STK (MD")).toBe(true);
    // TRANE is a subsequence of TRANSFORCE, JOHN a prefix of JOHNSON.
    expect(namesIdentify("TRANSFORCE INC", "TRANE TECHNOLOGIES PLC SHS (IR")).toBe(false);
    expect(namesIdentify("JOHN BEAN TECHNOLOGIES CORP", "JOHNSON & JOHNSON")).toBe(false);
  });

  it("and, where both have one, the same second word", () => {
    expect(namesIdentify("BERKSHIRE HILLS BANCORP INC", "BERKSHIRE HATHWY INC(HLDG CO)B")).toBe(false);
  });

  it("is not on its own enough to call a filing wrong", () => {
    // "LATTICE STRATEGIES TR" reduces to one distinctive word, LATTICE, so it
    // does identify Lattice Semiconductor. What stops it flagging a filing is
    // the chain rule: Lattice Semiconductor's own line, if held, still says
    // LATTICE SEMICONDUCTOR. See "innocent filings stay unflagged".
    expect(namesIdentify("LATTICE STRATEGIES TR", "LATTICE SEMICONDUCTOR CORP")).toBe(true);
  });

  it("never on a generic word alone", () => {
    expect(namesIdentify("FIRST SOLAR INC", "FIRST HORIZON CORP")).toBe(false);
  });
});

describe("Lightrock's Q3-2026 filing", () => {
  const r = checkIssuerNames(lightrockRows(), LIGHTROCK_CODES);

  it("is misaligned", () => {
    expect(r.misaligned).toBe(true);
    expect(r.displaced.length).toBeGreaterThanOrEqual(NAME_CHECK_MIN_DISPLACED);
  });

  it("finds exactly the twelve lines filed under another company's code", () => {
    const wrong = r.mismatched.map((m) => `${m.filedName} @ ${m.ticker}`).sort();
    expect(wrong).toEqual([
      "AMERICAN HOMES 4 RENT- A @ AVTR",
      "AVANTOR INC @ BC",
      "BRUNSWICK CORP @ CBT",
      "CABOT CORP @ CTRE",
      "CARETRUST REIT INC @ COHU",
      "COMPASS MINERALS INTERNATION @ CUBE",
      "CUBESMART @ DAR",
      "DARLING INGREDIENTS INC @ DRH",
      "DIAMONDROCK HOSPITALITY CO @ EHC",
      "ENCOMPASS HEALTH CORP @ ENS",
      "ENVISTA HOLDINGS CORP @ FSLR",
      "SALLY BEAUTY HOLDINGS INC @ RNR",
    ]);
  });

  it("leaves the other twenty-three alone", () => {
    expect(r.checked).toBe(35);
    expect(r.disagree).toBe(12);
  });

  it("names where each displaced name really belongs", () => {
    const care = r.displaced.find((d) => d.filedName === "CARETRUST REIT INC");
    expect(care).toMatchObject({ ticker: "COHU", belongsTo: "CTRE" });
  });
});

describe("innocent filings stay unflagged", () => {
  it("a fund family is not its sponsor (JPMorgan ETF beside JPMorgan Chase)", () => {
    const r = checkIssuerNames([
      row("X-JEPI", "JPMORGAN EQUITY PREMIUM INCOME ETF"),
      row("X-JPM", "JPMORGAN CHASE & CO"),
    ], CODES);
    expect(r.misaligned).toBe(false);
    expect(r.displaced).toEqual([]);
  });

  it("a filer that types the fund manager for every ETF has the right codes", () => {
    // Prime Buchholz files "Blackrock" and "The Vanguard Group" as the issuer.
    const r = checkIssuerNames([
      row("X-IJH", "Blackrock"),
      row("X-VOO", "The Vanguard Group"),
      row("X-BLK", "BLACKROCK INC"),
    ], CODES);
    expect(r.misaligned).toBe(false);
  });

  it("a renamed company disagrees but does not chain", () => {
    const r = checkIssuerNames([row("X-COR", "AMERISOURCEBERGEN CORP"), row("X-AAPL", "APPLE INC")], CODES);
    expect(r.disagree).toBe(1);
    expect(r.displaced).toEqual([]);
    expect(r.misaligned).toBe(false);
  });

  it("two names swapped is two lines, under the line", () => {
    // Brown Brothers Harriman, Q1-2026: a renamed Brazilian utility's two share
    // classes, old and new names crossed over. And Winch Advisory: Oracle and
    // Oshkosh on each other's neighbour's code.
    const axia = checkIssuerNames([
      row("X-AXIA", "CENTRAIS ELETRICAS BR-SP ADR"),
      row("X-AXIAPRC", "AXIA ENERGIA-ADR PREF C"),
    ], CODES);
    expect(axia.displaced).toHaveLength(2);
    expect(axia.misaligned).toBe(false);

    const winch = checkIssuerNames([
      row("X-OSK", "ORACLE CORP"),
      row("X-OXY", "OSHKOSH CORP"),
      row("X-ORCL", "TAPESTRY INC"),
    ], CODES);
    expect(winch.misaligned).toBe(false);
  });

  it("gibberish in the name column names nobody", () => {
    // Mann Financial typed a spreadsheet reference into every name.
    const r = checkIssuerNames([
      row("X-AMZN", "#gid=979403238&range=A8"),
      row("X-AAPL", "#gid=979403238&range=A16"),
      row("X-NVDA", "#gid=979403238&range=A20"),
    ], CODES);
    expect(r.disagree).toBe(3);
    expect(r.misaligned).toBe(false);
  });

  it("names clipped by a letter do not invent links", () => {
    // Virtu drops the first letter: "ADDEN STEVEN" for Madden, "ELECT SECTOR"
    // for Select Sector. ELECT is not ELECTROVAYA.
    const r = checkIssuerNames([
      row("X-SHOO", "ADDEN STEVEN LTD"),
      row("X-XLP", "ELECT SECTOR SPDR TR"),
      row("X-ELVA", "ELECTROVAYA INC"),
    ], CODES);
    expect(r.misaligned).toBe(false);
  });

  it("a code we have no name for is not checked", () => {
    const r = checkIssuerNames([row("X-UNKNOWN", "ANYTHING AT ALL")], CODES);
    expect(r).toMatchObject({ checked: 0, disagree: 0, misaligned: false });
  });
});

describe("the threshold", () => {
  // A shifted block of three: each code carries the next company's name.
  const shifted = [
    row("X-AAPL", "AMAZON COM INC"),     // Apple's code
    row("X-AMZN", "MICROSOFT CORP"),     // Amazon's code
    row("X-MSFT", "NVIDIA CORP"),        // Microsoft's code
    row("X-NVDA", "ORACLE CORP"),        // NVIDIA's code
  ];

  it("three chained lines flag the filing", () => {
    const r = checkIssuerNames(shifted, CODES);
    expect(r.displaced).toHaveLength(3);
    expect(r.misaligned).toBe(true);
  });

  it("is three because nothing measured scored three", () => {
    // 36,371 filings: innocent swaps score 2, broken filings 4 or more.
    expect(NAME_CHECK_MIN_DISPLACED).toBe(3);
  });
});
