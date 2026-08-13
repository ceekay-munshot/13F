#!/usr/bin/env node
// scripts/discover-13f-filers.mjs
//
// Who filed a 13F in the last N days? Prints CIKs, comma-separated, for
// ingest-funds.mjs --funds=.
//
//   node scripts/discover-13f-filers.mjs --days=2
//
// WHY DISCOVERY RATHER THAN A WATCHLIST
// -------------------------------------
// The same-day job used to ingest a hard-coded seed list, which answers "is my
// dozen up to date" and not "did anything get published today". A user who
// stars a manager outside that list would never see same-day data for them, and
// nothing in the pipeline would even know they were interested.
//
// EDGAR publishes one index file per day listing EVERY filing of every form, so
// "who filed a 13F today" is a single request rather than a crawl of thousands
// of managers. Follow the filings, not a list.
//
// The index is keyed by FILING DATE, and anything submitted after 17:30 ET is
// dated the next business day — so a window of a couple of days is the honest
// default, and re-ingesting a fund already covered is harmless (the artifacts
// are rewritten identically).

import { SecFetcher, SEC_URLS } from "./_sec-fetch.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const DAYS = Math.max(1, Math.min(10, Number(args.days || 2)));
const FORMS = /^13F-HR(\/A)?$/i;

const pad = (n) => String(n).padStart(2, "0");
const qtrOf = (m) => Math.floor(m / 3) + 1;

/**
 * One day's index. A 404 is ordinary — weekends and holidays have no file.
 *
 * A 403 IS NOT. It means the SEC is refusing us, and swallowing it as "nothing
 * filed today" is precisely how a pipeline reports success while discovering
 * nothing: every day looks like a quiet day. This module is not allowed to
 * decide that; it re-throws and the job fails loudly.
 */
async function fetchDay(sec, d) {
  const y = d.getUTCFullYear();
  const url = SEC_URLS.dailyIndex(y, qtrOf(d.getUTCMonth()), `${y}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`);
  try {
    const res = await sec.get(url, { as: "text" });
    if (res?.status === 404) return "";
    return typeof res === "string" ? res : (res?.body ?? "");
  } catch (err) {
    // Match the STATUS, not the message text: "403" appears inside plenty of
    // strings that are not a status, including an accession number.
    if (err?.status === 404 || err?.constructor?.name === "SecNotFoundError") return "";
    throw err;
  }
}

(async () => {
  const sec = new SecFetcher({
    userAgent: process.env.SEC_USER_AGENT,
    rps: Number(process.env.SEC_RATE_LIMIT_RPS || 5),
  });

  const ciks = new Set();
  let daysWithIndex = 0;
  const now = new Date();
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const body = await fetchDay(sec, d);
    if (!body) continue;
    daysWithIndex++;
    for (const line of body.split(/\r?\n/)) {
      // form.idx is fixed-width and breaks on company names containing spaces,
      // so the daily index is read as whitespace-delimited from the RIGHT: the
      // last field is the path, the one before it the date, before that the CIK.
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length < 4) continue;
      const form = parts[0]?.trim();
      if (!FORMS.test(form)) continue;
      const cik = parts[2]?.trim() ?? parts[1]?.trim();
      if (/^\d+$/.test(cik)) ciks.add(cik.padStart(10, "0"));
    }
  }

  const out = [...ciks];
  // stderr so stdout stays pipeable into --funds=
  console.error(`discovered ${out.length} filer(s) with a 13F in the last ${DAYS} day(s), across ${daysWithIndex} index file(s)`);

  // FINDING NOTHING IS A RESULT THAT HAS TO EARN ITSELF.
  //
  // "Zero filings" and "we never managed to read an index" produce the same
  // empty list, and the second is a broken pipeline reporting a quiet day. If
  // not one index file could be read across the whole window, fail — a run that
  // publishes nothing should look like a failure, not a no-op.
  if (daysWithIndex === 0) {
    console.error(`::error::could not read a single daily index across ${DAYS} day(s). Not "nothing filed" — nothing was checked.`);
    process.exit(1);
  }
  process.stdout.write(out.join(","));
})().catch((err) => {
  console.error(`::error::discovery failed: ${err.message}`);
  process.exit(1);
});
