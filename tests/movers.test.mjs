// What the Sectors tab is built from: one fund-quarter file in, that fund's
// trades out — or a reason it is left out.

import { describe, it, expect } from "vitest";
import { encodeHoldings } from "../shared/artifacts.mjs";
import { fundMoves, pickNames, MOVERS_MAX_POSITIONS } from "../shared/movers.mjs";
import { SECTORS } from "../shared/sic.mjs";
import { SUBSECTORS } from "../shared/subsectors.mjs";
import { createPlacer } from "../shared/sector-list.mjs";

// A trade nothing placed: Unclassified, in its only subsector.
const U = SECTORS.indexOf("Unclassified");
const UU = SUBSECTORS.indexOf("Unclassified");

const row = (o) => ({
  ticker: "AAA", name: "AAA INC", issuerId: "i1", cls: "COM", type: "", unit: "SH",
  value: 1000, shares: 10, weight: 10, price: 100, action: "HELD",
  dShares: 0, dSharesPct: 0, dValue: 0, dValuePct: 0, dWeightPp: 0, flags: [],
  ...o,
});

const fund = ({ rows = [], exits = [], meta = {}, pages = 1 } = {}) => ({
  kind: "fund-period", pages, exits,
  meta: { priorState: "PRIOR_OK", deltasSuppressed: false, structuralEvent: null,
          positions_long: 10, value_long_usd: 10_000, ...meta },
  data: encodeHoldings(rows),
});

describe("fundMoves", () => {
  it("prices a trim at quarter-end and keeps the weights either side", () => {
    const r = fundMoves(fund({
      rows: [row({ ticker: "NVDA", action: "TRIMMED", shares: 6, value: 600, weight: 6,
                   dShares: -4, dSharesPct: -40, dWeightPp: -4 })],
    }));
    expect(r.moves).toEqual([["NVDA", "T", -40, -400, 10, 6, U, UU]]);
  });

  it("counts a new position as all bought and a sale-out at last quarter's value", () => {
    const r = fundMoves(fund({
      rows: [row({ ticker: "MU", action: "NEW", value: 500, weight: 5, dShares: null, dSharesPct: null, dWeightPp: null })],
      exits: [{ ticker: "AMAT", issuerId: "i9", type: "", unit: "SH", valuePrior: 700, weightPrior: 7 }],
    }));
    expect(r.moves).toEqual([["MU", "N", null, 500, 0, 5, U, UU], ["AMAT", "X", -100, -700, 7, 0, U, UU]]);
  });

  it("places each trade in a sector, with the filed name to hand", () => {
    const seen = [];
    const sectorOf = (row) => { seen.push(row); return row.ticker === "NVDA" ? "Semiconductors" : "Bogus" };
    const r = fundMoves(fund({
      rows: [row({ ticker: "NVDA", action: "ADDED", dShares: 1, dSharesPct: 10 })],
      exits: [{ ticker: null, name: "SANDISK CORP", issuerId: "i7", type: "", unit: "SH", valuePrior: 5, weightPrior: 1 }],
    }), { sectorOf });
    expect(r.moves.map((m) => SECTORS[m[6]])).toEqual(["Semiconductors", "Unclassified"]);
    expect(seen[1]).toMatchObject({ ticker: null, name: "SANDISK CORP" });
    // A sector with no subsector given lands in that sector's catch-all.
    expect(r.moves.map((m) => SUBSECTORS[m[7]])).toEqual(["Other semiconductors", "Unclassified"]);
  });

  it("places each trade in a subsector inside its sector", () => {
    const placeOf = createPlacer(
      { MU: "Semiconductors", NVDA: "Semiconductors", LLY: "Health Care" },
      { subs: { NVDA: "Chips", LLY: "Biotech" } },
    );
    const r = fundMoves(fund({
      rows: [
        row({ ticker: "NVDA", action: "ADDED", dShares: 1, dSharesPct: 10 }),
        row({ ticker: "MU", action: "ADDED", dShares: 1, dSharesPct: 10 }),
      ],
      exits: [{ ticker: "LLY", issuerId: "i8", type: "", unit: "SH", valuePrior: 5, weightPrior: 1 }],
    }), { placeOf });
    expect(r.moves.map((m) => [SECTORS[m[6]], SUBSECTORS[m[7]]])).toEqual([
      ["Semiconductors", "Chips"],
      ["Semiconductors", "Memory"], // hand-placed: the SEC files Micron beside NVIDIA
      ["Health Care", "Biotech"],
    ]);
  });

  it("never lets a subsector disagree with its sector", () => {
    const placeOf = () => ({ sector: "Health Care", subsector: "Chips" });
    const r = fundMoves(fund({ rows: [row({ ticker: "X", action: "ADDED", dShares: 1, dSharesPct: 10 })] }), { placeOf });
    expect([SECTORS[r.moves[0][6]], SUBSECTORS[r.moves[0][7]]]).toEqual(["Health Care", "Other health care"]);
  });

  it("leaves out unchanged holdings, options, and splits", () => {
    const r = fundMoves(fund({
      rows: [
        row({ action: "HELD" }),
        row({ ticker: "OPT", type: "Call", action: "TRIMMED", dShares: -1 }),
        row({ ticker: "SPL", action: "ADDED", dShares: 90, flags: ["SUSPECTED_SPLIT"] }),
      ],
    }));
    expect(r.moves).toEqual([]);
  });

  it("counts a sale reported twice only once, at the smaller weight", () => {
    const exit = { ticker: "STX", issuerId: "i5", type: "", unit: "SH", valuePrior: 900 };
    const r = fundMoves(fund({ exits: [{ ...exit, weightPrior: 9 }, { ...exit, weightPrior: 4 }] }));
    expect(r.moves).toEqual([["STX", "X", -100, -900, 4, 0, U, UU]]);
  });

  it("is only for focused managers", () => {
    expect(fundMoves(fund({ meta: { positions_long: MOVERS_MAX_POSITIONS + 1 } })).skip).toBe("not-concentrated");
    expect(fundMoves(fund({ pages: 2 })).skip).toBe("not-concentrated");
    expect(fundMoves(fund({ meta: { positions_long: 2 } })).skip).toBe("too-few-stocks");
    expect(fundMoves(fund({ meta: { positions_long: MOVERS_MAX_POSITIONS } })).skip).toBeUndefined();
  });

  it("is not for options books or one-stock books", () => {
    expect(fundMoves(fund({ meta: { value_options_usd: 20_000 } })).skip).toBe("mostly-options");
    expect(fundMoves(fund({ rows: [row({ weight: 60 })] })).skip).toBe("one-stock-book");
    // Half the fund LAST quarter counts too: selling it down is still not stock picking.
    expect(fundMoves(fund({ rows: [row({ weight: 20, dWeightPp: -45, action: "TRIMMED", dShares: -5 })] })).skip)
      .toBe("one-stock-book");
    expect(fundMoves(fund({ exits: [{ ticker: "Z", type: "", unit: "SH", valuePrior: 1, weightPrior: 70 }] })).skip)
      .toBe("one-stock-book");
  });

  it("is not for operating companies reporting their stakes", () => {
    expect(fundMoves({ ...fund(), cik: "0001045810" }).skip).toBe("company");
  });

  it("does not call a structural change or a withdrawal trading", () => {
    expect(fundMoves(fund({ meta: { priorState: "PRIOR_MISSING" } })).skip).toBe("no-comparison");
    expect(fundMoves(fund({ meta: { deltasSuppressed: true } })).skip).toBe("no-comparison");
    expect(fundMoves(fund({ meta: { structuralEvent: "PRO_RATA_REDUCTION" } })).skip).toBe("withdrawal");
  });
});

// Each case is a real fund's own filing, June or September 2026: its book now
// against last quarter (valueRatio), the share of the typical stock it kept
// (medianRatio), and how many stocks it kept at all (retained).
describe("a fund selling out is not a view on a sector", () => {
  const filed = (detail) => fundMoves(fund({ meta: { structuralEvent: "REVIEW", structuralDetail: detail } }));

  it("leaves out a fund that sold most of almost everything", () => {
    // SoMa Equity, closing (press, Sept 2026): $1.44B -> $66M, kept ~8% of each stock.
    expect(filed({ valueRatio: 0.046, medianRatio: 0.084, retained: 9 }).skip).toBe("selling-out");
    // Motley Fool Wealth Management: kept 2%, filed no holdings the quarter after.
    expect(filed({ valueRatio: 0.01, medianRatio: 0.02, retained: 19 }).skip).toBe("selling-out");
    // Nine Ten Capital: the loosest case caught, 18% kept.
    expect(filed({ valueRatio: 0.15, medianRatio: 0.18, retained: 7 }).skip).toBe("selling-out");
  });

  it("keeps the nearest funds that were really trading", () => {
    // Fourthstone: shrank 76% but kept 46% of the typical stock, and rebuilt to $420M next quarter.
    expect(filed({ valueRatio: 0.24, medianRatio: 0.46, retained: 19 }).skip).toBeUndefined();
    // DARA: sold a few big holdings outright and left every other one untouched.
    expect(filed({ valueRatio: 0.12, medianRatio: 1, retained: 24 }).skip).toBeUndefined();
    // Gallo: the nearest left in, 30% kept.
    expect(filed({ valueRatio: 0.22, medianRatio: 0.30, retained: 9 }).skip).toBeUndefined();
    // Napean: cut old holdings by 80% to buy new ones; the book grew.
    expect(filed({ valueRatio: 1.25, medianRatio: 0.2, retained: 16 }).skip).toBeUndefined();
  });

  it("does not judge on too little evidence", () => {
    // Fewer than five stocks kept: no "typical stock" to speak of.
    expect(filed({ valueRatio: 0.05, medianRatio: 0.05, retained: 4 }).skip).toBeUndefined();
    // A filing where either measure is missing.
    expect(filed({ valueRatio: 0.05, retained: 9 }).skip).toBeUndefined();
    expect(filed({ medianRatio: 0.05, retained: 9 }).skip).toBeUndefined();
    expect(filed(null).skip).toBeUndefined();
  });
});

describe("company names for the stock lists", () => {
  it("keeps the filed name of every stock traded, sold out included", () => {
    const r = fundMoves(fund({
      rows: [
        row({ ticker: "NVDA", name: "NVIDIA CORPORATION", action: "TRIMMED", dShares: -1, dSharesPct: -10, dWeightPp: -1 }),
        row({ ticker: "HLD", name: "HELD ONLY INC", action: "HELD" }),
      ],
      exits: [
        { ticker: "STX", name: "SEAGATE TECHNOLOGY HLDNGS PL", issuerId: "i5", type: "", unit: "SH", valuePrior: 9, weightPrior: 1 },
        { ticker: null, name: "NO TICKER CO", issuerId: "i6", type: "", unit: "SH", valuePrior: 9, weightPrior: 1 },
      ],
    }));
    // Only stocks that were traded, and only where there is a ticker to show it by.
    expect(r.names).toEqual({ NVDA: "NVIDIA CORPORATION", STX: "SEAGATE TECHNOLOGY HLDNGS PL" });
  });

  it("takes the spelling most funds filed, and keeps last build's choice", () => {
    const votes = new Map([
      ["STX", new Map([["SEAGATE TECHNOLOGY HOLDINGS P", 1], ["SEAGATE TECHNOLOGY HLDNGS PL", 3]])],
      ["MU", new Map([["MICRON TECHNOLOGY INC", 2]])],
    ]);
    expect(pickNames(["STX", "MU", "STX", "ZZZ"], votes)).toEqual({
      MU: "MICRON TECHNOLOGY INC", STX: "SEAGATE TECHNOLOGY HLDNGS PL",
    });
    // A rebuild that re-reads a few funds does not reshuffle names already chosen,
    // and a stock no longer traded drops out of the table.
    expect(pickNames(["STX"], votes, { STX: "SEAGATE TECH", MU: "MICRON" })).toEqual({ STX: "SEAGATE TECH" });
    // Keys come out sorted, so an unchanged rebuild writes the same bytes.
    expect(Object.keys(pickNames(["MU", "STX"], votes))).toEqual(["MU", "STX"]);
  });

  it("does not repeat a label that is already the name", () => {
    expect(pickNames(["SOME FUND LP"], new Map([["SOME FUND LP", new Map([["SOME FUND LP", 1]])]]))).toEqual({});
  });
});
