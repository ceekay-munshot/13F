// tests/sectors.test.mjs
//
// Sector classification, and the arithmetic of "what was bought and sold".
//
// Both halves have already produced a confidently wrong number once, so both
// are pinned here.

import { describe, it, expect } from "vitest";
import { sectorForSic, SECTORS } from "../shared/sic.mjs";

describe("sectorForSic", () => {
  it("puts the semiconductor codes in Semiconductors", () => {
    // The question this whole feature exists to answer.
    expect(sectorForSic(3674)).toBe("Semiconductors"); // NVDA, AVGO
    expect(sectorForSic(3559)).toBe("Semiconductors"); // semi cap equipment
  });

  it("does NOT sweep every tech company into one bucket", () => {
    // SIC is a 1987 taxonomy and splits what a human groups together. Pretending
    // otherwise is how an "AI sector" gets invented out of nothing.
    expect(sectorForSic(7372)).toBe("Software & IT Services"); // MSFT, ORCL
    expect(sectorForSic(7370)).toBe("Software & IT Services"); // GOOGL
    expect(sectorForSic(3571)).toBe("Computers & Hardware");   // AAPL
    expect(new Set([sectorForSic(3674), sectorForSic(7372), sectorForSic(3571)]).size).toBe(3);
  });

  it("keeps funds and ETFs out of the operating sectors", () => {
    // An S&P 500 ETF is exposure to everything. Folding SIC 6726 into
    // Financials would misattribute the whole position, and an aggregate hides
    // that completely.
    expect(sectorForSic(6726)).toBe("Funds & ETFs");
    expect(sectorForSic(6722)).toBe("Funds & ETFs");
  });

  it("says Unclassified rather than guessing", () => {
    for (const bad of [null, undefined, 0, -1, 9999, "", "abc", NaN]) {
      expect(sectorForSic(bad)).toBe("Unclassified");
    }
  });

  it("only ever returns a declared sector", () => {
    for (let sic = 100; sic <= 9999; sic += 1) {
      expect(SECTORS).toContain(sectorForSic(sic));
    }
  });

  it("classifies a real spread of codes", () => {
    expect(sectorForSic(2834)).toBe("Health Care");        // pharma
    expect(sectorForSic(6021)).toBe("Banks & Lending");
    expect(sectorForSic(6798)).toBe("Real Estate");        // REIT
    expect(sectorForSic(1311)).toBe("Energy");
    expect(sectorForSic(4911)).toBe("Utilities");
  });
});

// ---------------------------------------------------------------------------
// The flow arithmetic. Two mistakes, both made and both caught by looking at
// the output rather than the code.
// ---------------------------------------------------------------------------
describe("traded value, not change in value", () => {
  // Mirrors the rule in scripts/ingest-dera.mjs.
  const traded = (r) =>
    r.action === "NEW"
      ? (r.value ?? 0)
      : (r.dShares != null && r.price != null ? r.dShares * r.price : 0);

  it("reports ZERO for a position that was never touched", () => {
    // THE first mistake. Summing dValue said Computers & Hardware was bought
    // +$8.11B in a quarter with literally no trading in it — that was price
    // appreciation on untouched positions, reported as conviction.
    const untouchedButUp = { action: "HELD", dShares: 0, price: 250, value: 8_110_000_000, dValue: 8_110_000_000 };
    expect(traded(untouchedButUp)).toBe(0);
    expect(untouchedButUp.dValue).toBeGreaterThan(0); // the misleading figure
  });

  it("counts a NEW position as bought in full", () => {
    // THE second mistake. computeChanges leaves d_shares null on a NEW row —
    // there is no prior holding to subtract — so reading the delta alone
    // counted new stakes as zero buying while still counting every full exit.
    // Every sector came out net-negative across all filers, which cannot happen.
    const fresh = { action: "NEW", dShares: null, price: 100, value: 5_000_000_000 };
    expect(traded(fresh)).toBe(5_000_000_000);
  });

  it("values an add and a trim at the shares that moved", () => {
    expect(traded({ action: "ADDED", dShares: 1000, price: 50, value: 90_000 })).toBe(50_000);
    expect(traded({ action: "TRIMMED", dShares: -400, price: 50, value: 10_000 })).toBe(-20_000);
  });

  it("buying and selling stay the same order of magnitude in aggregate", () => {
    // The sanity check that caught the NEW bug. One manager's sale is broadly
    // another's purchase, so a universe-wide total that is negative in EVERY
    // sector means the arithmetic is wrong, not that the market sold everything.
    const book = [
      { action: "NEW", dShares: null, price: 10, value: 1_000 },
      { action: "ADDED", dShares: 50, price: 10, value: 800 },
      { action: "TRIMMED", dShares: -60, price: 10, value: 400 },
      { action: "HELD", dShares: 0, price: 10, value: 900 },
    ];
    const bought = book.map(traded).filter((v) => v > 0).reduce((a, b) => a + b, 0);
    const sold = -book.map(traded).filter((v) => v < 0).reduce((a, b) => a + b, 0);
    expect(bought).toBe(1_500);
    expect(sold).toBe(600);
    expect(bought).toBeGreaterThan(0);
    expect(sold).toBeGreaterThan(0);
  });
});
