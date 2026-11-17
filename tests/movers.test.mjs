// What the Sectors tab is built from: one fund-quarter file in, that fund's
// trades out — or a reason it is left out.

import { describe, it, expect } from "vitest";
import { encodeHoldings } from "../shared/artifacts.mjs";
import { fundMoves, MOVERS_MAX_POSITIONS } from "../shared/movers.mjs";
import { SECTORS } from "../shared/sic.mjs";

const U = SECTORS.indexOf("Unclassified");

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
    expect(r.moves).toEqual([["NVDA", "T", -40, -400, 10, 6, U]]);
  });

  it("counts a new position as all bought and a sale-out at last quarter's value", () => {
    const r = fundMoves(fund({
      rows: [row({ ticker: "MU", action: "NEW", value: 500, weight: 5, dShares: null, dSharesPct: null, dWeightPp: null })],
      exits: [{ ticker: "AMAT", issuerId: "i9", type: "", unit: "SH", valuePrior: 700, weightPrior: 7 }],
    }));
    expect(r.moves).toEqual([["MU", "N", null, 500, 0, 5, U], ["AMAT", "X", -100, -700, 7, 0, U]]);
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
    expect(r.moves).toEqual([["STX", "X", -100, -900, 4, 0, U]]);
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
