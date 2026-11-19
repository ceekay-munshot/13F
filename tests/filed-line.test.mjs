// tests/filed-line.test.mjs
//
// Reading a holding line past what the form's boxes say: an option typed as a
// class, a ticker with the SEC's ZZZZ on it, and one stock filed under a new
// code from one quarter to the next. Each case is one seen in real filings.

import { describe, it, expect } from "vitest";
import { putCallFromClass, putCallOf, cleanTicker, cleanSecurities, shareKind, pairRecoded } from "../shared/filed-line.mjs";
import { computeChanges, PRIOR_STATE } from "../shared/fold.mjs";
import { artifactRow } from "../shared/emit.mjs";
import { aggregateHoldings, summarizeHoldings } from "../scripts/_sec-parse.mjs";
import { mkRow } from "./fixtures.mjs";

describe("an option typed as the class", () => {
  it("reads PUT and CALL, plural or with 'option', in any case", () => {
    expect(putCallFromClass("PUT")).toBe("Put");
    expect(putCallFromClass("CALL")).toBe("Call");
    expect(putCallFromClass("Calls")).toBe("Call");
    expect(putCallFromClass("call option")).toBe("Call");
    expect(putCallFromClass("LONG OPTION PUTS")).toBe("Put");
  });

  it("leaves everything else alone, including funds whose names mention options", () => {
    for (const cls of ["COM", "SPONSORED ADS", "OPTION", "OPT STRATEGY ETF", "PUT WRITE ETF", "CL A", "", null]) {
      expect(putCallFromClass(cls)).toBe(null);
    }
  });

  it("a ticked box wins over the class", () => {
    expect(putCallOf("Put", "CALL")).toBe("Put");
    expect(putCallOf(null, "CALL")).toBe("Call");
    expect(putCallOf("", "COM")).toBe(null);
  });

  it("is an option when the lines are added up, apart from the stock it is on", () => {
    // Alpine's SanDisk: the put sat in the long book as $585M of stock.
    const put = { ...mkRow({ seq: 2, cusip: "80004C200", value: 584_603_040, shares: 3_360 }), title_of_class: "PUT" };
    const stock = mkRow({ seq: 1, cusip: "80004C200", value: 10_000_000, shares: 5_000 });
    const held = aggregateHoldings([stock, put], "DOLLARS");
    expect(held.map((h) => h.put_call).sort()).toEqual(["", "Put"]);
    const s = summarizeHoldings(held);
    expect(s.value_long_usd).toBe(10_000_000);
    expect(s.value_options_usd).toBe(584_603_040);
  });
});

describe("the ZZZZ the SEC's list adds to a second code", () => {
  it("comes off, leaving the company's ticker", () => {
    expect(cleanTicker("HONZZZZ")).toBe("HON");
    expect(cleanTicker("UPZZZZ")).toBe("UP");
    expect(cleanTicker("ENGNWZZZZ")).toBe("ENGNW");
    expect(cleanTicker("AAPL")).toBe("AAPL");
    expect(cleanTicker(null)).toBe(null);
  });

  it("comes off every entry of the list, and nothing else changes", () => {
    const s = cleanSecurities({ A: { ticker: "GTESZZZZ", issuerId: "i1" }, B: { ticker: "GTES", issuerId: "i2" } });
    expect(s).toEqual({ A: { ticker: "GTES", issuerId: "i1" }, B: { ticker: "GTES", issuerId: "i2" } });
  });
});

describe("shareKind", () => {
  it("tells common from preferred, units and lettered classes", () => {
    expect(shareKind("SPONSORED ADS")).toBe("common");
    expect(shareKind("SHS")).toBe("common");
    expect(shareKind("CL B NEW")).toBe("class B");
    expect(shareKind("CAP STK CL C")).toBe("class C");
    expect(shareKind("PFD SER A MAND")).toBe("preferred");
    expect(shareKind("UNIT SER 1")).toBe("unit");
  });
});

// One line of a fund's book, as computeChanges sees it.
const line = ({ cusip, name, cls = "COM", ticker = null, value, shares }) => ({
  cusip, put_call: "", ssh_prnamt_type: "SH", name_of_issuer: name, title_of_class: cls,
  value_usd: value, ssh_prnamt: shares, ticker, weight_pct: 10, implied_price: value / shares,
});
const book = (period, holdings) => ({ period_end: period, holdings, value_long_usd: 1e9 });
const changesOf = (prior, current) =>
  computeChanges(book("2026-09-30", current), book("2026-06-30", prior), PRIOR_STATE.OK).changes;

describe("one stock filed under a new code", () => {
  it("is one trim, not a sale of everything and a new purchase (Lingotto's Teva)", () => {
    const changes = changesOf(
      [line({ cusip: "881624209", name: "TEVA PHARMACEUTICAL INDS LTD", cls: "SPONSORED ADS", ticker: "TEVA", value: 684_577_349, shares: 20_205_943 })],
      [line({ cusip: "M8769Q102", name: "TEVA PHARMACEUTICAL INDS LTD", cls: "SHS", value: 694_375_902, shares: 17_534_745 })],
    );
    expect(changes).toHaveLength(1);
    const [c] = changes;
    expect(c.action).toBe("TRIMMED");
    expect(c.d_shares).toBe(17_534_745 - 20_205_943);
    expect(c.flags).toEqual(["RECODED"]);
    expect(c.ticker_prior).toBe("TEVA");
    // The fund page keeps the ticker the line had last quarter.
    const h = line({ cusip: "M8769Q102", name: "TEVA PHARMACEUTICAL INDS LTD", cls: "SHS", value: 1, shares: 1 });
    expect(artifactRow(h, c).ticker).toBe("TEVA");
  });

  it("pairs the same ticker under two codes, ZZZZ or not (Honeywell)", () => {
    const changes = changesOf(
      [line({ cusip: "438516106", name: "HONEYWELL INTL INC", ticker: "HONZZZZ", value: 97_100_000, shares: 450_000 })],
      [line({ cusip: "438516205", name: "Honeywell International Inc", ticker: "HON", value: 73_900_000, shares: 340_000 })],
    );
    expect(changes.map((c) => c.action)).toEqual(["TRIMMED"]);
  });

  it("leaves an ordinary sale and purchase alone", () => {
    const changes = changesOf(
      [line({ cusip: "000001101", name: "ALPHA CORP", ticker: "ALP", value: 5e6, shares: 1e5 })],
      [line({ cusip: "000002101", name: "BETA CORP", ticker: "BET", value: 5e6, shares: 1e5 })],
    );
    expect(changes.map((c) => c.action).sort()).toEqual(["EXITED", "NEW"]);
  });

  it("does not pair two stocks with different tickers, even under one name", () => {
    // A filing named AROW "ASSOCIATED BANC-CORP"; the tickers are what is right.
    const changes = changesOf(
      [line({ cusip: "042744102", name: "ASSOCIATED BANC-CORP", ticker: "AROW", value: 26.1e6, shares: 1e6 })],
      [line({ cusip: "045487105", name: "ASSOCIATED BANC-CORP", ticker: "ASB", value: 27.8e6, shares: 1.1e6 })],
    );
    expect(changes.map((c) => c.action).sort()).toEqual(["EXITED", "NEW"]);
  });

  it("does not pair when the name is ambiguous: two iShares funds left, one came in", () => {
    const changes = changesOf(
      [
        line({ cusip: "464288101", name: "ISHARES TR", cls: "IBONDS DEC 29", ticker: "IBTJ", value: 10.6e6, shares: 4.6e5 }),
        line({ cusip: "464289102", name: "ISHARES TR", cls: "IBOXX INV CP ETF", ticker: "IBDS", value: 5.3e6, shares: 2.2e5 }),
      ],
      [line({ cusip: "464288200", name: "ISHARES TR", cls: "IBONDS DEC 29", value: 10.5e6, shares: 4.5e5 })],
    );
    expect(changes.map((c) => c.action).sort()).toEqual(["EXITED", "EXITED", "NEW"]);
  });

  it("does not pair two funds of one family whose class differs", () => {
    const changes = changesOf(
      [line({ cusip: "464287101", name: "ISHARES TR", cls: "S&P 500 VAL ETF", ticker: "IVE", value: 9e6, shares: 4.5e4 })],
      [line({ cusip: "464287200", name: "ISHARES TR", cls: "RUS 1000 VAL ETF", value: 9e6, shares: 4.5e4 })],
    );
    expect(changes.map((c) => c.action).sort()).toEqual(["EXITED", "NEW"]);
  });

  it("does not pair a class A share with a class B one", () => {
    const changes = changesOf(
      // Priced alike on purpose, so it is the class that refuses the pair.
      [line({ cusip: "084670108", name: "BERKSHIRE HATHAWAY INC DEL", cls: "CL A", value: 7.4e6, shares: 15_000 })],
      [line({ cusip: "084670702", name: "BERKSHIRE HATHAWAY INC DEL", cls: "CL B NEW", value: 7.3e6, shares: 15_000 })],
    );
    expect(changes.map((c) => c.action).sort()).toEqual(["EXITED", "NEW"]);
  });

  it("does not pair a share with an ADR worth many of them", () => {
    const changes = changesOf(
      [line({ cusip: "000003101", name: "FOREIGN CO", cls: "ORD", ticker: "FRN", value: 10e6, shares: 1e6 })],
      [line({ cusip: "000004101", name: "FOREIGN CO", cls: "SPONSORED ADR", value: 10e6, shares: 1e5 })],
    );
    expect(changes.map((c) => c.action).sort()).toEqual(["EXITED", "NEW"]);
  });

  it("does not pair a preferred with the common", () => {
    const pairs = pairRecoded(
      [line({ cusip: "644393209", name: "NEW FORTRESS ENERGY INC", cls: "PFD SER A MAND", value: 10e6, shares: 4e5 })],
      [line({ cusip: "644393100", name: "NEW FORTRESS ENERGY INC", cls: "COM CL A", ticker: "NFE", value: 9e6, shares: 4e5 })],
    );
    expect(pairs.size).toBe(0);
  });

  it("never pairs an option with stock", () => {
    const put = { ...line({ cusip: "80004C900", name: "SANDISK CORP", value: 5e6, shares: 1e5 }), put_call: "Put" };
    const pairs = pairRecoded([put], [line({ cusip: "80004C200", name: "SANDISK CORP", ticker: "SNDK", value: 5e6, shares: 1e5 })]);
    expect(pairs.size).toBe(0);
  });
});
