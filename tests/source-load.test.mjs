// tests/source-load.test.mjs
//
// Reading the store of record back out, in the one shape the builder folds.
//
// The archive holds filings from two places. The bulk windows carry every filer
// but publish about a month late and have no acceptance timestamp; the
// directly-fetched records carry only the funds the same-day job reached but
// arrive within hours and have the real one. For roughly six weeks after each
// deadline the second is the ONLY copy of a quarter that exists.
//
// The builder has to fold both as if they were one source, or it is structurally
// incapable of producing the quarter a client is looking at — which is why there
// were two writers in the first place.

import { describe, it, expect } from "vitest";
import { normalizeEdgarFiling, mergeEdgarSource } from "../scripts/_source-load.mjs";
import { gzipSync } from "node:zlib";

const row = (over = {}) => ({
  cusip: "037833100", name_of_issuer: "APPLE INC", title_of_class: "COM",
  value_raw: 1000, ssh_prnamt: 5, ssh_prnamt_type: "SH", put_call: null,
  voting_sole: 5, voting_shared: 0, voting_none: 0, ...over,
});

const record = (over = {}) => ({
  accession_number: "0001279936-26-000005", cik: "0001279936", period: "2026-06-30",
  form_type: "13F-HR", acceptance_datetime: "2026-07-29T17:47:53.000Z",
  is_amendment: false, amendment_type: null, amendment_no: null,
  is_confidential_omitted: false, table_value_total: 2000, table_entry_total: 2,
  manager_name: "CANTILLON CAPITAL MANAGEMENT LLC", notice: false, reconciles: true,
  raw: [row(), row({ other_manager: "1" })],
  ...over,
});

describe("one archived filing, in the builder's shape", () => {
  it("carries the REAL acceptance time, which is the point of preferring it", () => {
    // DERA has only a filing date, so the bulk path fills the time with noon
    // UTC. Every filing a fund made on one day then ties in the amendment fold,
    // and the tiebreak is accession order — the filing agent's prefix, not
    // anything chronological — so a restatement can lose to the original it
    // exists to replace.
    expect(normalizeEdgarFiling(record()).acceptance_datetime).toBe("2026-07-29T17:47:53.000Z");
  });

  it("SUMS rows sharing a CUSIP rather than deduping them", () => {
    // 18.8% of keys universe-wide are split across managers. Deduping Cantillon's
    // 2026-Q1 understates it by 38.8%.
    const f = normalizeEdgarFiling(record());
    expect(f.held).toHaveLength(1);
    expect(f.held[0].value_usd).toBe(2000);
  });

  it("re-derives from the AS-FILED rows, not the stored aggregate", () => {
    // Ticker and issuer identity come from a map that changes between runs, so
    // re-deriving is what makes a rebuild reproduce the CURRENT state rather
    // than a snapshot of whatever was known the day it was fetched.
    const f = normalizeEdgarFiling(record(), { securities: { "037833100": { ticker: "AAPL", issuerId: "iAAPL" } } });
    expect(f.held[0].ticker).toBe("AAPL");
    expect(f.held[0].issuerId).toBe("iAAPL");
  });

  it("runs the same units ladder, with the rung the bulk path cannot use", () => {
    // The bulk path has no schemaVersion, so it starts a rung lower. Here it is
    // on the filing itself.
    const f = normalizeEdgarFiling(record({ schemaVersion: "X0202" }));
    expect(f.units).toBe("DOLLARS");
    expect(f.unit_source).toBeTruthy();
  });

  it("a notice has no information table, and says so", () => {
    const f = normalizeEdgarFiling(record({ notice: true, raw: null }));
    expect(f.notice).toBe(true);
    expect(f.held).toEqual([]);
    expect(f.summary).toBeNull();
    expect(f.period_end).toBe("2026-06-30");
  });

  it("refuses a record it cannot identify rather than inventing one", () => {
    expect(normalizeEdgarFiling(null)).toBeNull();
    expect(normalizeEdgarFiling({})).toBeNull();
  });

  it("carries the declared row count, so the two sources are interchangeable", () => {
    // DERA has it; the same-day path did not until now. A filing archived from
    // there would have come back with a zero where the bulk copy has the real
    // number, and the builder would emit different artifacts depending on which
    // source happened to reach a fund first.
    expect(normalizeEdgarFiling(record()).table_entry_total).toBe(2);
  });
});

describe("merging the archive into the bulk filings", () => {
  const fakeR2 = (entries) => ({
    list: async () => new Map(entries.map(([k]) => [k, 1])),
    getBuffer: async (k) => {
      const e = entries.find(([key]) => key === k);
      return e ? gzipSync(JSON.stringify(e[1])) : null;
    },
  });

  it("adds a filing the bulk windows do not have", async () => {
    const filings = new Map();
    const r = await mergeEdgarSource(filings, {
      r2: fakeR2([["source/edgar/2026-06-30/a.json.gz", record()]]),
      prefix: "source/edgar/",
    });
    expect(r).toMatchObject({ listed: 1, merged: 1, replaced: 0 });
    expect(filings.size).toBe(1);
  });

  it("REPLACES one both sources hold, so the real timestamp wins", async () => {
    const filings = new Map([["0001279936-26-000005", { accession: "0001279936-26-000005", acceptance_datetime: "2026-07-29T12:00:00.000Z" }]]);
    const r = await mergeEdgarSource(filings, {
      r2: fakeR2([["source/edgar/2026-06-30/a.json.gz", record()]]),
      prefix: "source/edgar/",
    });
    expect(r.replaced).toBe(1);
    expect(filings.get("0001279936-26-000005").acceptance_datetime).toBe("2026-07-29T17:47:53.000Z");
  });

  it("an archive that cannot be listed does not fail the build", async () => {
    // It falls back to the bulk windows, which is what the builder did before
    // this existed. An archive being down must never cost a build.
    const filings = new Map();
    const r = await mergeEdgarSource(filings, {
      r2: { list: async () => { throw new Error("nope"); } }, prefix: "source/edgar/",
    });
    expect(r.ok).toBe(false);
    expect(filings.size).toBe(0);
  });

  it("counts what it could not read instead of passing over it", async () => {
    // A load that silently found nothing and a load that legitimately had
    // nothing to find must not look the same.
    const filings = new Map();
    const r = await mergeEdgarSource(filings, {
      r2: fakeR2([["source/edgar/2026-06-30/bad.json.gz", { nonsense: true }]]),
      prefix: "source/edgar/",
    });
    expect(r.unreadable).toBe(1);
    expect(r.merged).toBe(0);
  });
});
