// tests/same-day.test.mjs
//
// 16 Nov 2026, Q3's deadline: eleven of the client's fourteen funds filed during
// the day, the pipeline only read EDGAR's nightly index, and a client was told
// all afternoon that Lone Pine "had not been read yet". These tests replay that
// day against the pieces that now prevent it.

import { describe, it, expect } from "vitest";
import { parseCurrentFeed } from "../scripts/_sec-parse.mjs";
import {
  alreadyRecorded,
  behindOnSite,
  crossOff,
  emptyDay,
  expectationsFor,
  liveListProblem,
  mergeIndexDay,
  noteLiveFiling,
  readDay,
  requeue,
} from "../shared/ingest-cursor.mjs";
import { decide, dueEveryMinutes } from "../shared/watch.mjs";

const LNP = "0001061165";
const BRK = "0001067983";
const PSH = "0002026053";
const OTHER = "0001454224";

// Verbatim shape from sec.gov, 16 Nov 2026 (trimmed to four entries).
const FEED = `<?xml version="1.0" encoding="ISO-8859-1" ?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Latest Filings - Mon, 16 Nov 2026 23:31:59 EST</title>
<updated>2026-11-16T23:31:59-05:00</updated>
<entry>
<title>13F-HR - DUNHAM TRUST Co (0001454224) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1454224/000158064226007760/0001580642-26-007760-index.htm"/>
<summary type="html">
 &lt;b&gt;Filed:&lt;/b&gt; 2026-11-16 &lt;b&gt;AccNo:&lt;/b&gt; 0001580642-26-007760 &lt;b&gt;Size:&lt;/b&gt; 169 KB
</summary>
<updated>2026-11-16T17:30:35-05:00</updated>
<category scheme="https://www.sec.gov/" label="form type" term="13F-HR"/>
<id>urn:tag:sec.gov,2008:accession-number=0001580642-26-007760</id>
</entry><entry>
<title>13F-HR/A - PERSHING SQUARE INC. (0002026053) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/2026053/000117266126005426/0001172661-26-005426-index.htm"/>
<summary type="html">
 &lt;b&gt;Filed:&lt;/b&gt; 2026-11-16 &lt;b&gt;AccNo:&lt;/b&gt; 0001172661-26-005426 &lt;b&gt;Size:&lt;/b&gt; 30 KB
</summary>
<updated>2026-11-16T17:02:35-05:00</updated>
<category scheme="https://www.sec.gov/" label="form type" term="13F-HR/A"/>
<id>urn:tag:sec.gov,2008:accession-number=0001172661-26-005426</id>
</entry><entry>
<title>13F-HR - LONE PINE CAPITAL LLC (0001061165) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1061165/000091957426008115/0000919574-26-008115-index.htm"/>
<summary type="html">
 &lt;b&gt;Filed:&lt;/b&gt; 2026-11-16 &lt;b&gt;AccNo:&lt;/b&gt; 0000919574-26-008115 &lt;b&gt;Size:&lt;/b&gt; 18 KB
</summary>
<updated>2026-11-16T09:14:02-05:00</updated>
<category scheme="https://www.sec.gov/" label="form type" term="13F-HR"/>
<id>urn:tag:sec.gov,2008:accession-number=0000919574-26-008115</id>
</entry><entry>
<title>13F-HR - SOME FILING AGENT (0009999999) (Filed by)</title>
<summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-11-16 &lt;b&gt;AccNo:&lt;/b&gt; 0009999999-26-000001</summary>
<updated>2026-11-16T09:00:00-05:00</updated>
<category scheme="https://www.sec.gov/" label="form type" term="13F-HR"/>
<id>urn:tag:sec.gov,2008:accession-number=0009999999-26-000001</id>
</entry>
</feed>`;

const freshState = () => ({ v: 1, days: { "2026-11-13": { rows: 2, all: [BRK, OTHER], pending: [] } } });

describe("EDGAR's latest-filings list", () => {
  const rows = parseCurrentFeed(FEED);

  it("reads the filer, form, filing date and accession of each entry", () => {
    expect(rows).toHaveLength(3);
    const lnp = rows.find((r) => r.cik === LNP);
    expect(lnp).toMatchObject({
      form_type: "13F-HR",
      company_name: "LONE PINE CAPITAL LLC",
      filing_date: "2026-11-16",
      accession_number: "0000919574-26-008115",
      accepted: "2026-11-16T09:14:02-05:00",
    });
  });

  it("keeps amendments, and ignores entries that are not the filer's own", () => {
    expect(rows.find((r) => r.cik === PSH)?.form_type).toBe("13F-HR/A");
    expect(rows.some((r) => r.cik === "0009999999")).toBe(false);
  });

  it("returns nothing, rather than throwing, for a page past the end", () => {
    expect(parseCurrentFeed('<feed><title>Latest Filings - No recent filings</title></feed>')).toEqual([]);
  });
});

describe("a filing seen during the day", () => {
  it("is queued at once, under the day EDGAR files it", () => {
    const state = freshState();
    const lnp = parseCurrentFeed(FEED).find((r) => r.cik === LNP);
    expect(noteLiveFiling(state, lnp)).toBe(true);
    expect(state.days["2026-11-16"]).toMatchObject({ live: true, pending: [LNP], all: [LNP] });
    // Seen again on the next run's read of the list: nothing new.
    expect(noteLiveFiling(state, lnp)).toBe(false);
  });

  it("knows when it has reached ground an earlier run covered, so it can stop paging", () => {
    const state = freshState();
    const lnp = { cik: LNP, filing_date: "2026-11-16", accession_number: "0000919574-26-008115" };
    expect(alreadyRecorded(state, lnp)).toBe(false);
    noteLiveFiling(state, lnp);
    expect(alreadyRecorded(state, lnp)).toBe(true);
    // Same fund, a filing not seen before: not covered.
    expect(alreadyRecorded(state, { ...lnp, accession_number: "0000919574-26-009999" })).toBe(false);
    // Any filing on a day whose index is in: covered.
    expect(alreadyRecorded(state, { cik: "0000000001", filing_date: "2026-11-13", accession_number: "z" })).toBe(true);
  });

  it("does not touch a day whose nightly index is already in", () => {
    const state = freshState();
    expect(noteLiveFiling(state, { cik: "0000000001", filing_date: "2026-11-13", accession_number: "x" })).toBe(false);
    expect(state.days["2026-11-13"].pending).toEqual([]);
  });

  it("re-queues a fund already read that day when a NEW filing of theirs appears", () => {
    // Pershing Square filed a 13F-HR and a 13F-HR/A on deadline day.
    const state = freshState();
    noteLiveFiling(state, { cik: PSH, filing_date: "2026-11-16", accession_number: "0001172661-26-005427" });
    crossOff(state, new Set([PSH]));
    expect(state.days["2026-11-16"].pending).toEqual([]);
    expect(noteLiveFiling(state, { cik: PSH, filing_date: "2026-11-16", accession_number: "0001172661-26-005426" })).toBe(true);
    expect(state.days["2026-11-16"].pending).toEqual([PSH]);
  });
});

describe("that night's daily index", () => {
  const index = [
    { cik: LNP, accession_number: "0000919574-26-008115" },
    { cik: BRK, accession_number: "0001193125-26-463399" },
    { cik: PSH, accession_number: "0001172661-26-005427" },
    { cik: PSH, accession_number: "0001172661-26-005426" },
  ];

  it("on a day never followed live, queues everyone — exactly as before", () => {
    const d = mergeIndexDay(undefined, index);
    expect(d).toEqual({ rows: 4, all: [LNP, BRK, PSH], pending: [LNP, BRK, PSH] });
    expect(d.live).toBeUndefined();
  });

  it("leaves finished what the live list already finished, and queues what it missed", () => {
    const state = freshState();
    noteLiveFiling(state, { cik: LNP, filing_date: "2026-11-16", accession_number: "0000919574-26-008115" });
    noteLiveFiling(state, { cik: PSH, filing_date: "2026-11-16", accession_number: "0001172661-26-005427" });
    crossOff(state, new Set([LNP, PSH]));

    const d = mergeIndexDay(state.days["2026-11-16"], index);
    // Lone Pine: read during the day, nothing new tonight.
    expect(d.pending).not.toContain(LNP);
    // Berkshire: a page of the live list the run never reached.
    expect(d.pending).toContain(BRK);
    // Pershing Square: its amendment was never seen live.
    expect(d.pending).toContain(PSH);
    // The day is final now.
    expect(d.live).toBeUndefined();
    expect(d.acc).toBeUndefined();
  });
});

describe("a stored cursor", () => {
  it("keeps a live day live across runs — dropping the flag would mean its index is never read", () => {
    const day = readDay(JSON.parse(JSON.stringify({ ...emptyDay(true), all: [LNP], pending: [LNP], acc: { [LNP]: ["a"] } })));
    expect(day.live).toBe(true);
    expect(day.acc).toEqual({ [LNP]: ["a"] });
  });

  it("still reads a cursor written before any of this existed", () => {
    expect(readDay({ rows: 3, all: [LNP], pending: [] })).toEqual({ rows: 3, all: [LNP], pending: [] });
  });
});

describe("what the ingest must see before calling a fund finished", () => {
  it("is the filing that queued it, while that is recent", () => {
    const state = freshState();
    noteLiveFiling(state, { cik: LNP, filing_date: "2026-11-16", accession_number: "0000919574-26-008115" });
    expect(expectationsFor(state, [LNP, BRK], "2026-11-14")).toEqual({ [LNP]: ["0000919574-26-008115"] });
  });

  it("never holds a fund back for an old filing", () => {
    const state = freshState();
    noteLiveFiling(state, { cik: LNP, filing_date: "2026-11-16", accession_number: "0000919574-26-008115" });
    expect(expectationsFor(state, [LNP], "2026-11-20")).toEqual({});
  });

  it("is dropped once a final day's fund is crossed off", () => {
    const state = freshState();
    requeue(state, { cik: BRK, filing_date: "2026-11-13", accession_number: "acc-1" });
    expect(state.days["2026-11-13"].acc).toEqual({ [BRK]: ["acc-1"] });
    crossOff(state, new Set([BRK]));
    expect(state.days["2026-11-13"].acc).toBeUndefined();
  });
});

describe("a client fund whose page is behind the SEC", () => {
  const summary = (periods) => ({ name: "LONE PINE CAPITAL LLC", data: { series: periods.map((period) => ({ period })) } });
  const filings = [
    { form_type: "13F-HR", period_end: "2026-09-30", filing_date: "2026-11-16", accession_number: "0000919574-26-008115" },
    { form_type: "13F-HR", period_end: "2026-06-30", filing_date: "2026-08-14", accession_number: "0000919574-26-005485" },
  ];

  it("is found — this is the check that would have caught 16 November by itself", () => {
    expect(behindOnSite(summary(["2026-03-31", "2026-06-30"]), filings)).toEqual({
      period: "2026-09-30",
      ourNewest: "2026-06-30",
      filings: [{ accession_number: "0000919574-26-008115", filing_date: "2026-11-16" }],
    });
  });

  it("is left alone once the page has caught up", () => {
    expect(behindOnSite(summary(["2026-06-30", "2026-09-30"]), filings)).toBeNull();
  });

  it("counts a notice quarter as shown", () => {
    const nt = [{ form_type: "13F-NT", period_end: "2026-09-30", filing_date: "2026-11-16", accession_number: "n" }];
    expect(behindOnSite({ data: { series: [] }, notices: [{ period: "2026-09-30" }] }, nt)).toBeNull();
  });

  it("is behind when there is no page at all", () => {
    expect(behindOnSite(null, filings)?.period).toBe("2026-09-30");
  });

  it("is never queued without a filing from the SEC to point at", () => {
    expect(behindOnSite(summary(["2026-06-30"]), [])).toBeNull();
  });

  it("is queued even if the cursor had crossed it off", () => {
    const state = freshState();
    expect(state.days["2026-11-13"].all).toContain(BRK);
    expect(requeue(state, { cik: BRK, filing_date: "2026-11-13", accession_number: "acc-1" })).toBe(true);
    expect(state.days["2026-11-13"].pending).toEqual([BRK]);
  });
});

describe("the alarm for a live list we can no longer use", () => {
  // Without the live list everything still arrives, a day late — which is the
  // 16 Nov outage again, quieter. These are the cases that must be told.

  it("is quiet when the list reads normally", () => {
    expect(liveListProblem({ entries: 3645, parsed: 3645, season: "peak" })).toBeNull();
  });

  it("goes off when the SEC changes the list's format", () => {
    // Exactly what a format change looks like: entries arrive, none make sense.
    const garbled = FEED.replace(/<title>13F/g, "<title>Form 13F");
    const parsed = parseCurrentFeed(garbled).length;
    expect(parsed).toBe(0);
    const msg = liveListProblem({ entries: 4, parsed, season: "quiet" });
    expect(msg).toMatch(/format has probably changed/);
    expect(msg).toMatch(/Nothing is lost/);
  });

  it("goes off when the list is empty in filing season, but not between seasons", () => {
    expect(liveListProblem({ entries: 0, parsed: 0, season: "peak" })).toMatch(/came back empty/);
    expect(liveListProblem({ entries: 0, parsed: 0, season: "ramp" })).toMatch(/came back empty/);
    expect(liveListProblem({ entries: 0, parsed: 0, season: "quiet" })).toBeNull();
  });

  it("goes off when the list's address stops working", () => {
    expect(liveListProblem({ entries: 0, parsed: 0, season: "quiet", error: { name: "SecFetchError", status: 404 } }))
      .toMatch(/answered 404/);
    expect(liveListProblem({ entries: 0, parsed: 0, season: "quiet", error: { name: "SecMissingError", status: 403 } }))
      .toMatch(/address has probably changed/);
  });

  it("stays quiet for a busy SEC or a network blip — the next run reads it again", () => {
    expect(liveListProblem({ entries: 0, parsed: 0, season: "peak", error: { name: "SecFetchError", status: 503 } })).toBeNull();
    expect(liveListProblem({ entries: 0, parsed: 0, season: "peak", error: { name: "SecFetchError", status: 429 } })).toBeNull();
    expect(liveListProblem({ entries: 0, parsed: 0, season: "peak", error: { name: "TypeError" } })).toBeNull();
  });
});

describe("starting the ingest on time", () => {
  it("is half-hourly around a deadline, hourly after, two-hourly otherwise", () => {
    expect(dueEveryMinutes("2026-11-16")).toBe(30); // deadline day
    expect(dueEveryMinutes("2026-11-02")).toBe(30); // two weeks before
    expect(dueEveryMinutes("2026-12-01")).toBe(60); // late filers
    expect(dueEveryMinutes("2026-04-10")).toBe(120); // between seasons
  });

  const now = new Date("2026-11-16T15:00:00Z");
  const run = (minsAgo, status = "completed") => ({
    status,
    created_at: new Date(now.getTime() - minsAgo * 60_000).toISOString(),
  });

  it("starts a run when the last one began longer ago than the cadence", () => {
    expect(decide([run(45), run(200)], now, 30).action).toBe("start");
  });

  it("waits when one began recently", () => {
    expect(decide([run(10)], now, 30).action).toBe("wait");
  });

  it("never starts a second while one is running or queued", () => {
    expect(decide([run(300, "in_progress")], now, 30).action).toBe("running");
    expect(decide([run(300, "queued"), run(400)], now, 30).action).toBe("running");
  });

  it("starts one if there has never been one", () => {
    expect(decide([], now, 30).action).toBe("start");
  });
});
