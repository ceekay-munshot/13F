// tests/sector-stocks.test.ts
//
// The Stocks view on the Sectors tab: each stock once, with its net and how
// many focused managers sold it against how many bought it.

import { describe, it, expect } from "vitest";
import { byStock, sortStocks, type Manager } from "../src/views/SectorsView";
import type { MoverMove } from "../src/lib/data";

const mv = (ticker: string, usd: number): MoverMove => [ticker, usd > 0 ? "A" : "T", null, usd, 1, 1];
const mgr = (cik: string, moves: MoverMove[]): Manager => ({
  cik, name: cik, value: 0, positions: 10, bought: 0, sold: 0, net: 0, weight: 0, moves,
});

describe("byStock", () => {
  it("puts a stock sold by some and bought by others on one row, with its net", () => {
    const rows = byStock([
      mgr("a", [mv("V", -100)]),
      mgr("b", [mv("V", -50)]),
      mgr("c", [mv("V", 30)]),
    ]);
    expect(rows).toEqual([{ ticker: "V", sold: 150, bought: 30, net: -120, sellers: 2, buyers: 1 }]);
  });

  it("counts a manager once, on the side their trades add up to", () => {
    // Two lines of the same stock, one cut and one added: a net buyer.
    const [row] = byStock([mgr("a", [mv("BRK", -10), mv("BRK", 25)])]);
    expect(row).toMatchObject({ net: 15, sellers: 0, buyers: 1 });
  });
});

describe("sortStocks", () => {
  const rows = () => byStock([
    // NV: most money sold, managers split 2 to 1.
    mgr("a", [mv("NV", -900), mv("AM", -10)]),
    mgr("b", [mv("NV", -10), mv("AM", -10)]),
    mgr("c", [mv("NV", 5), mv("AM", -10)]),
  ]);

  it("lists the most net sold first by default", () => {
    expect(sortStocks(rows(), "Sellers", "net").map((s) => s.ticker)).toEqual(["NV", "AM"]);
  });

  it("lists the most one-sided first when asked", () => {
    // AM: 3 sellers, no buyers. NV: 2 sellers, 1 buyer.
    expect(sortStocks(rows(), "Sellers", "agree").map((s) => s.ticker)).toEqual(["AM", "NV"]);
  });
});
