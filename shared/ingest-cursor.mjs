// shared/ingest-cursor.mjs
//
// The bookkeeping behind "who has filed that we have not read yet", kept pure
// so it can be tested without the SEC or a bucket.
//
// ---------------------------------------------------------------------------
// WHAT CHANGED, AND WHY — 17 Nov 2026
// ---------------------------------------------------------------------------
// The cursor used to learn about a filing from ONE place: EDGAR's daily index,
// which EDGAR cuts at about 10pm New York time. So a manager who filed at nine
// in the morning did not exist, as far as the pipeline knew, until that night.
//
// Q3 2026 was due on Monday 16 November. Eleven of the client's fourteen funds
// filed that day. The index for it appeared at 22:01 New York time, seven
// minutes after a run had started and found nothing to do; GitHub did not start
// another for hours. A client refreshed the dashboard all day and was told
// Lone Pine "had not been read yet". It had not been SEEN yet.
//
// So a day can now be learned about twice:
//
//   1. LIVE, during the day, from EDGAR's "Latest Filings" list. The day is
//      marked `live` and remembers, per manager, which filings were seen
//      (`acc`). Anyone new is queued straight away.
//   2. FINAL, that night, from the daily index — still the complete record.
//      Merging it is careful about one thing: a manager we already finished
//      from the live list stays finished, UNLESS the index shows a filing for
//      them we never saw (an amendment filed after we read them, or a page of
//      the live list a run did not reach). Those go back in the queue.
//
// A third source can queue a manager: a client fund whose own filing list at
// the SEC is newer than what the dashboard is showing (see `behindOnSite`).
// That is evidence from the SEC, not a guess from a list — the rule that a fund
// may only be queued because the SEC says it filed is unchanged.
//
// Cursor shape (all fields but `days` optional, so an old cursor still loads):
//
//   { v: 1, updatedAt, days: {
//       "2026-11-16": { rows, all: [cik], pending: [cik], live?: true,
//                       acc?: { [cik]: [accession] } } } }

/** A day nobody has read anything for yet. */
export function emptyDay(live = false) {
  return live ? { rows: 0, all: [], pending: [], live: true, acc: {} } : { rows: 0, all: [], pending: [] };
}

/**
 * Read one stored day defensively. Anything malformed becomes empty rather than
 * throwing: losing the cursor costs repeated work, never correctness.
 */
export function readDay(v) {
  const day = {
    rows: Number(v?.rows) || 0,
    all: Array.isArray(v?.all) ? v.all : [],
    pending: Array.isArray(v?.pending) ? v.pending : [],
  };
  if (v?.live) day.live = true;
  if (v?.acc && typeof v.acc === "object") {
    const acc = {};
    for (const [cik, list] of Object.entries(v.acc)) if (Array.isArray(list) && list.length) acc[cik] = list;
    if (Object.keys(acc).length) day.acc = acc;
  }
  return day;
}

const addTo = (list, x) => {
  if (list.includes(x)) return false;
  list.push(x);
  return true;
};

/**
 * Record one filing seen on the live list.
 *
 * Returns true when this put the manager in the queue. A day whose daily index
 * has already been read is left alone — the index is the complete record for
 * it, and anything the live list says about it is already accounted for.
 */
export function noteLiveFiling(state, { cik, filing_date: date, accession_number: accession }) {
  if (!cik || !date || !accession) return false;
  const existing = state.days[date];
  if (existing && !existing.live) return false;
  const day = existing ?? (state.days[date] = emptyDay(true));
  day.acc ??= {};
  const seen = (day.acc[cik] ??= []);
  if (!addTo(seen, accession)) return false;
  addTo(day.all, cik);
  // A new accession for a manager we already finished — an amendment, or a
  // second filing the same day — is new work, so it goes back in the queue.
  return addTo(day.pending, cik);
}

/**
 * Is EDGAR's latest-filings list still something we can use?
 *
 * Returns a plain-English problem, or null. The live list fails SAFE — without
 * it, filings still arrive from that night's daily index, and client funds are
 * still checked one by one — which is exactly why it needs its own alarm: a
 * silent fallback to "next day" is the 16 Nov 2026 outage again, just quieter.
 *
 * Only things that will not fix themselves are reported. A busy SEC (5xx) or a
 * network blip costs one run its live list and the next run reads it again.
 *
 * @param {object} o
 * @param {number} o.entries  <entry> elements seen across the pages read
 * @param {number} o.parsed   how many of those parseCurrentFeed understood
 * @param {string} o.season   filingSeason(today).season
 * @param {{name?:string,status?:number}|null} [o.error]  what reading it threw, if it did
 */
export function liveListProblem({ entries, parsed, season, error = null }) {
  const after = " Nothing is lost — filings still arrive from the SEC's nightly list, and client funds are " +
    "still checked one by one — but everyone else now appears the next day instead of within the hour.";
  if (error) {
    if (error.name === "SecMissingError") {
      return "The SEC refused its live list of filings while answering everything else normally, so the " +
        "list's address has probably changed." + after;
    }
    const s = Number(error.status);
    if (error.name === "SecFetchError" && s >= 400 && s < 500 && s !== 429) {
      return `The SEC answered ${s} for its live list of filings, so the list's address has probably changed.` + after;
    }
    return null;
  }
  if (entries > 0 && parsed < entries / 2) {
    return `The SEC's live list of filings held ${entries} entries and we could read ${parsed} of them, so its ` +
      "format has probably changed." + after;
  }
  if (entries === 0 && (season === "ramp" || season === "peak")) {
    return "The SEC's live list of filings came back empty in the middle of filing season, when hundreds of " +
      "managers file every day, so it has probably moved or changed format." + after;
  }
  return null;
}

/**
 * Is this live-list entry already in the cursor — seen on the list before, or
 * on a day whose daily index is already in? Lets a run stop paging the list
 * once it reaches ground an earlier run covered.
 */
export function alreadyRecorded(state, { cik, filing_date: date, accession_number: accession }) {
  const day = state.days[date];
  if (!day) return false;
  if (!day.live) return true;
  return Boolean(day.acc?.[cik]?.includes(accession));
}

/**
 * Put a manager back in the queue because the SEC shows a filing the dashboard
 * does not. Works on a live day or a final one; on a final day the accession is
 * kept only as long as the manager is queued, so the ingest can check it saw it.
 */
export function requeue(state, { cik, filing_date: date, accession_number: accession }) {
  if (!cik || !date) return false;
  const day = state.days[date] ?? (state.days[date] = emptyDay(true));
  if (accession) {
    day.acc ??= {};
    addTo((day.acc[cik] ??= []), accession);
  }
  addTo(day.all, cik);
  return addTo(day.pending, cik);
}

/**
 * Fold that night's daily index into a day.
 *
 * `rows` are parseFormIdx rows: { cik, accession_number }. For a day we never
 * followed live this is exactly what the cursor always did — everyone in the
 * index is owed an ingest. For a live day, whoever we already finished stays
 * finished unless the index holds a filing of theirs we never saw.
 */
export function mergeIndexDay(prev, rows) {
  const ciks = [...new Set(rows.map((r) => r.cik))];
  if (!prev || !prev.live) return { rows: rows.length, all: ciks, pending: ciks.slice() };

  const all = new Set(prev.all);
  const pending = new Set(prev.pending);
  for (const r of rows) {
    all.add(r.cik);
    const seen = prev.acc?.[r.cik] ?? [];
    if (!seen.includes(r.accession_number)) pending.add(r.cik);
  }
  return { rows: rows.length, all: [...all], pending: [...pending] };
}

/**
 * Cross off what the ingest actually finished.
 *
 * On a live day the accessions stay — they are what tonight's index is compared
 * against. On a final day they existed only so the ingest could check it read
 * the filing that queued the manager, so they go once the manager is done.
 *
 * @returns {number} day-entries removed
 */
export function crossOff(state, done) {
  let removed = 0;
  for (const day of Object.values(state.days)) {
    const before = day.pending.length;
    day.pending = day.pending.filter((c) => !done.has(c));
    removed += before - day.pending.length;
    if (!day.live && day.acc) {
      for (const cik of Object.keys(day.acc)) if (done.has(cik)) delete day.acc[cik];
      if (!Object.keys(day.acc).length) delete day.acc;
    }
  }
  return removed;
}

/**
 * The filings each queued manager is expected to have, for the ingest to check.
 *
 * Only recent days: the point is the few minutes in which the live list can
 * know about a filing before a manager's own filing list does. An old accession
 * may also have scrolled off a prolific filer's `recent` list, and must never
 * hold a manager in the queue for ever.
 *
 * @returns {Record<string, string[]>}
 */
export function expectationsFor(state, ciks, sinceISO) {
  const want = new Set(ciks);
  const out = {};
  for (const [date, day] of Object.entries(state.days)) {
    if (date < sinceISO || !day.acc) continue;
    for (const [cik, list] of Object.entries(day.acc)) {
      if (!want.has(cik) || !day.pending.includes(cik)) continue;
      for (const a of list) addTo((out[cik] ??= []), a);
    }
  }
  return out;
}

/**
 * Is the dashboard behind the SEC for this fund?
 *
 * Compares the newest quarter the fund's own filing list at the SEC holds — a
 * holdings report or a notice — against the newest quarter its published page
 * holds. Quarter-level on purpose: the live list already catches amendments for
 * every fund, and comparing timestamps across two sources that write them
 * differently would re-queue a fund on every run for nothing.
 *
 * @param {object|null} summary  the published fund summary, or null if there is none
 * @param {Array<{form_type:string, period_end:string, filing_date:string, accession_number:string}>} filings
 *   parseSubmissions(...).filings
 * @returns {null | { period: string, ourNewest: string|null, filings: Array<{accession_number:string, filing_date:string}> }}
 */
export function behindOnSite(summary, filings) {
  const ours = [
    ...(summary?.data?.series ?? []).map((s) => s.period),
    ...(summary?.notices ?? []).map((n) => n?.period),
  ].filter(Boolean).sort();
  const ourNewest = ours.at(-1) ?? null;

  const theirs = (filings ?? []).filter((f) => f?.period_end && /^13F-(HR|NT)/.test(f.form_type ?? ""));
  const theirNewest = theirs.map((f) => f.period_end).sort().at(-1) ?? null;
  if (!theirNewest || (ourNewest && theirNewest <= ourNewest)) return null;

  return {
    period: theirNewest,
    ourNewest,
    filings: theirs
      .filter((f) => f.period_end === theirNewest)
      .map((f) => ({ accession_number: f.accession_number, filing_date: f.filing_date })),
  };
}
