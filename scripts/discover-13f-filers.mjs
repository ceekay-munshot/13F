#!/usr/bin/env node
// scripts/discover-13f-filers.mjs
//
// WHO HAS FILED A 13F THAT WE HAVE NOT INGESTED YET?
//
//   node scripts/discover-13f-filers.mjs --max-funds=450 \
//     --state=.cache/day-cursor.json --out-state=.cache/day-cursor.next.json \
//     --out=.cache/ciks.txt --out-plan=.cache/plan.json
//
// Prints the CIKs to stdout too, so it still works by hand.
//
// ---------------------------------------------------------------------------
// THE BUG THIS FILE EXISTS TO NEVER REPEAT
// ---------------------------------------------------------------------------
// This script used to walk backwards from TODAY asking for
// `daily-index/{yyyy}/QTR{q}/form.{yyyymmdd}.idx`, day by day, treating a 404 as
// "nothing filed that day".
//
// EDGAR does not answer 404 for a missing file under /Archives/. It answers
// **403**. And 403, everywhere else in this project, correctly means "the SEC has
// blocked this IP — stop the run and never retry".
//
// Today's daily index does not exist until EDGAR cuts it late in the evening. So
// the FIRST request of EVERY run asked for a file that could not exist yet, got a
// 403, and declared the run blocked. Discovery never once succeeded. The workflow
// fell back to thirteen hard-coded funds, reported success, and four days after
// the Q2-2026 deadline the dashboard held 13 filers out of ~9,300. A client wrote
// in asking why a manager who filed on 29 July was missing.
//
// Two changes make that unrepeatable:
//
//   1. WE ASK WHICH INDEXES EXIST RATHER THAN GUESSING DATES. One request for the
//      quarter's `index.json` lists every daily index EDGAR has actually cut. We
//      fetch only those, so a 403 on one means what the policy says it means
//      again. (SecFetcher also corroborates any 403 on a path declared
//      `mayNotExist` against a known-good file before calling a run blocked —
//      belt and braces, because this cost a whole quarter once.)
//
//   2. WE KEEP A CURSOR, SO NOTHING IS "MISSED", ONLY "NOT YET DONE". Every daily
//      index we read seeds a pending list of filers. A run drains as much as its
//      budget allows and the rest waits. A blocked run, a dropped cron, a
//      timeout — none of them lose a filing, because a filer leaves the pending
//      list only once it has actually been published.
//
// There is deliberately NO watchlist fallback any more. Falling back to thirteen
// favourites is what let a completely broken discovery look like a working
// pipeline for a whole quarter. With a cursor, a run that cannot reach the SEC
// simply does nothing and the next one continues from the same place — which is
// both honest and lossless.
//
// EXIT CODES
//   0  a plan was produced (possibly empty — a genuinely quiet day)
//   0  with plan.blocked=true: the SEC is refusing this machine. Expected weather
//      on shared runners; nothing was lost and the next slot resumes.
//   1  something is actually wrong and a human should look.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SecFetcher, SEC_URLS, SecBlockedError, padCik } from "./_sec-fetch.mjs";
import { parseFormIdx } from "./_sec-parse.mjs";
import { addDays, parseISO, toISO, currentPeriod } from "../shared/calendar.mjs";
import { WATCHLIST_CIKS } from "../shared/watchlist.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const num = (v, dflt) => (v === undefined || v === true || v === "" ? dflt : Number(v));
const str = (v) => (typeof v === "string" && v ? v : null);

/**
 * The OLDEST a daily index may be for this run to care about it.
 *
 * The window is anchored to the CURRENT FILING SEASON — the day after the most
 * recently closed quarter — not to a flat day count, because a flat count drags
 * in the previous season and makes the pipeline re-ingest a quarter it already
 * has. On 2026-08-18 a 100-day window reached back to 10 May and offered up the
 * 5,193 managers who filed for Q1 in the May deadline week, all of them already
 * published: two days of budget spent re-fetching what was on the dashboard
 * already, while Q2 — the quarter people were asking about — waited behind them.
 *
 * WINDOW_DAYS is therefore only the hard ceiling, and MIN_LOOKBACK_DAYS the
 * floor. The floor matters on the day a quarter turns: the season would start
 * "today", today's index does not exist yet, and the window would be empty —
 * so we always keep at least the last few days in view, which also carries the
 * previous season's stragglers across the boundary.
 */
const WINDOW_DAYS = Math.max(2, Math.min(400, num(args["window-days"] ?? args.days, 120)));
const MIN_LOOKBACK_DAYS = Math.max(1, num(args["min-lookback-days"], 10));

/**
 * Filers this run may hand to the ingest.
 *
 * The ingest spends ~3.7 seconds per fund at 3 requests/second, so a 30-minute
 * budget is roughly 480 funds. This is the coarse cap; `--budget-seconds` in the
 * ingest is the hard stop, and the cursor only advances for the funds it
 * actually finished.
 */
const MAX_FUNDS = Math.max(0, num(args["max-funds"], 450));

/**
 * Share of the budget reserved for the NEWEST index days.
 *
 * Without it a large backlog starves same-day freshness: every run would spend
 * its whole budget on filings from a fortnight ago and today's would never land.
 * Newest-first for this fraction, oldest-first for the rest — the backlog drains
 * AND the product keeps its "filed today, on the dashboard today" promise.
 */
const FRESH_SHARE = Math.max(0, Math.min(1, num(args["fresh-share"], 0.35)));

/** Guard against a pathological cold start; normal runs read 0-2 new indexes. */
const MAX_NEW_DAYS = Math.max(1, num(args["max-new-days"], 80));

const TODAY = str(args.today) || new Date().toISOString().slice(0, 10);

/**
 * COMMIT MODE. Cross off the filers a run actually finished.
 *
 *   node scripts/discover-13f-filers.mjs --commit \
 *     --state=.cache/day-cursor.next.json --completed=.cache/completed.txt \
 *     --out-state=.cache/day-cursor.next.json --out-plan=.cache/plan.json
 *
 * Separate from planning, and driven by what the INGEST finished rather than by
 * what the plan offered, because those differ every time the budget cuts a run
 * short. Crossing off the plan would quietly abandon the tail of every run.
 *
 * Touches no network. Runs after the ingest and before the publish, so the
 * cursor uploaded at the end of a successful publish is already correct.
 */
const COMMIT = Boolean(args.commit);
const COMPLETED_IN = str(args.completed);

const STATE_IN = str(args.state);
const STATE_OUT = str(args["out-state"]);
const OUT_CIKS = str(args.out);
const OUT_PLAN = str(args["out-plan"]);

/**
 * The forms that count are decided in `_sec-parse.mjs` — 13F-HR, 13F-HR/A,
 * 13F-NT and 13F-NT/A.
 *
 * Notices are in on purpose. A 13F-NT says another manager reports these
 * holdings — a real, reportable state — and leaving them out counted a manager
 * who HAD filed among the Filings view's "outstanding".
 */
const qtrOf = (iso) => Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1;
const compact = (iso) => iso.replace(/-/g, "");
const note = (m) => console.error(m); // stderr, so stdout stays pipeable

function writeFile(path, body) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/**
 * The cursor: days we have read, and who from each day is still owed an ingest.
 *
 *   { v, updatedAt, days: { "2026-08-14": { rows, all: [cik], pending: [cik] } } }
 *
 * `all` never shrinks, so the manifest can report how many managers EDGAR has
 * actually published for the quarter — the number that turns "9,255 outstanding"
 * (a lie) into "4,102 of 5,188 ingested" (the truth).
 *
 * Losing the cursor is a performance problem, never a correctness one: a fresh
 * one re-reads the window's indexes and re-offers filers we may already hold, and
 * the ingest is idempotent, so the only cost is repeated work.
 */
function loadState(path) {
  const empty = { v: 1, days: {} };
  if (!path || !existsSync(path)) return empty;
  try {
    const s = JSON.parse(readFileSync(path, "utf8"));
    if (!s || typeof s !== "object" || !s.days || typeof s.days !== "object") {
      note("::warning::the ingest cursor is malformed — starting a fresh one.");
      return empty;
    }
    const days = {};
    for (const [d, v] of Object.entries(s.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !v) continue;
      const all = Array.isArray(v.all) ? v.all : [];
      const pending = Array.isArray(v.pending) ? v.pending : [];
      days[d] = { rows: Number(v.rows) || 0, all, pending };
    }
    return { v: 1, days };
  } catch (err) {
    note(`::warning::could not read the ingest cursor (${err.message}) — starting a fresh one.`);
    return empty;
  }
}

/** Every daily index EDGAR has actually cut in a quarter's folder. */
async function existingIndexDates(sec, year, qtr) {
  const res = await sec.get(SEC_URLS.dailyIndexDir(year, qtr), { as: "json" });
  const items = res?.body?.directory?.item ?? [];
  const dates = [];
  for (const it of items) {
    const m = /^form\.(\d{4})(\d{2})(\d{2})\.idx$/.exec(String(it?.name ?? ""));
    if (m) dates.push(`${m[1]}-${m[2]}-${m[3]}`);
  }
  return dates;
}

/** One day's 13F filers. Only ever called for a date the folder listing showed. */
async function filersOn(sec, dateISO) {
  const url = SEC_URLS.dailyIndex(dateISO.slice(0, 4), qtrOf(dateISO), compact(dateISO));
  // mayNotExist: the listing said this file is here, but a listing can be a
  // moment behind. If it 403s, SecFetcher proves whether we are actually blocked
  // before anyone concludes that we are.
  const body = (await sec.get(url, { as: "text", mayNotExist: true })).body ?? "";

  // ONE PARSER FOR THESE FILES, IN _sec-parse.mjs. This module used to carry its
  // own regex, which is how the shared one went unnoticed for months while
  // returning zero rows against the live header layout.
  const rows = parseFormIdx(body);
  const ciks = [...new Set(rows.map((r) => padCik(r.cik)))];
  return { ciks, rows: rows.length };
}

/** See WINDOW_DAYS: season start, clamped by a hard ceiling and a soft floor. */
function windowStart(todayISO) {
  const seasonStart = toISO(addDays(parseISO(currentPeriod(todayISO)), 1));
  const ceiling = toISO(addDays(parseISO(todayISO), -WINDOW_DAYS));
  const floor = toISO(addDays(parseISO(todayISO), -MIN_LOOKBACK_DAYS));
  if (seasonStart < ceiling) return ceiling;
  if (seasonStart > floor) return floor;
  return seasonStart;
}

const plan = {
  generatedAt: new Date().toISOString(),
  today: TODAY,
  blocked: false,
  /** The quarter these filings are for — what the coverage numbers describe. */
  period: currentPeriod(TODAY),
  windowFrom: windowStart(TODAY),
  windowTo: TODAY,
  indexDaysKnown: 0,
  indexDaysRead: 0,
  indexDaysUnread: 0,
  /** Distinct 13F filers EDGAR has published across the window. */
  filersKnown: 0,
  /** Of those, how many are still owed an ingest. */
  filersPending: 0,
  /** And how many have been through — the number the dashboard reports. */
  filersIngested: 0,
  filersSelected: 0,
  /** Watchlist funds this run moved to the front. */
  prioritised: [],
  daysIncomplete: [],
  ciks: [],
};

/**
 * @returns {Promise<number>} process exit code
 */
async function run() {
  const state = loadState(STATE_IN);

  // ---- commit mode: cross off what the ingest finished ---------------------
  if (COMMIT) {
    // Keep what the planning run already worked out — the window, how many index
    // days it read, how many filers it offered. Commit only revises the counts it
    // actually changes, so rewriting the plan file here does not blank the parts
    // the workflow summary reports.
    if (OUT_PLAN && existsSync(OUT_PLAN)) {
      try {
        Object.assign(plan, JSON.parse(readFileSync(OUT_PLAN, "utf8")));
      } catch {
        note("::warning::the plan file could not be re-read; the run summary will be thinner than usual.");
      }
    }
    const raw = COMPLETED_IN && existsSync(COMPLETED_IN) ? readFileSync(COMPLETED_IN, "utf8") : "";
    const done = new Set(raw.split(/[,\s]+/).map((c) => c.trim()).filter(Boolean).map(padCik));
    let removed = 0;
    for (const d of Object.keys(state.days)) {
      const before = state.days[d].pending.length;
      state.days[d].pending = state.days[d].pending.filter((c) => !done.has(c));
      removed += before - state.days[d].pending.length;
    }
    const dates = Object.keys(state.days);
    plan.filersKnown = new Set(dates.flatMap((d) => state.days[d].all)).size;
    plan.filersPending = new Set(dates.flatMap((d) => state.days[d].pending)).size;
    plan.filersIngested = plan.filersKnown - plan.filersPending;
    plan.daysIncomplete = dates.filter((d) => state.days[d].pending.length);
    plan.period = currentPeriod(TODAY);
    plan.committedAt = new Date().toISOString();
    note(
      `crossed off ${done.size} completed fund(s) (${removed} day-entries); ` +
        `${plan.filersIngested} of ${plan.filersKnown} filers are now on the dashboard, ${plan.filersPending} still queued`,
    );
    writeFile(STATE_OUT, JSON.stringify({ v: 1, updatedAt: new Date().toISOString(), days: state.days }, null, 2));
    return 0;
  }

  const sec = new SecFetcher({
    userAgent: process.env.SEC_USER_AGENT,
    rps: Number(process.env.SEC_RATE_LIMIT_RPS || 5),
    log: note,
  });

  const from = plan.windowFrom;

  // Ask the doorman before walking in. A 403 here IS decisive: the probe is a
  // static file that certainly exists, so there is nothing else it could mean.
  const probe = await sec.preflight();
  if (!probe.ok) {
    plan.blocked = true;
    note(
      "::warning::the SEC is refusing this machine right now. Nothing has been lost — the cursor is " +
        "untouched and the next scheduled run resumes from it on a different IP.",
    );
    // Deliberately 0. A third-party block on a shared runner is expected weather,
    // not something to page a human about; the poison detector escalates a run of them.
    return 0;
  }

  // ---- which daily indexes exist? -----------------------------------------
  // One request per quarter the window touches, and never a guessed date.
  const quarters = new Set();
  for (let d = parseISO(from); toISO(d) <= TODAY; d = addDays(d, 1)) {
    quarters.add(`${toISO(d).slice(0, 4)}|${qtrOf(toISO(d))}`);
  }
  const existing = [];
  for (const q of quarters) {
    const [y, n] = q.split("|");
    existing.push(...(await existingIndexDates(sec, Number(y), Number(n))));
  }
  const inWindow = [...new Set(existing)].filter((d) => d >= from && d <= TODAY).sort();
  plan.indexDaysKnown = inWindow.length;
  note(`${inWindow.length} daily index file(s) exist between ${from} and ${TODAY}`);

  // Reading nothing is only believable if EDGAR really cut no index for a hundred
  // days, which does not happen. Say so rather than reporting a quiet spell.
  if (!inWindow.length) {
    note(`::error::EDGAR lists no daily index at all for ${from}..${TODAY}. That is not a quiet spell.`);
    return 1;
  }

  // ---- read the days we have not read yet ---------------------------------
  const unread = inWindow.filter((d) => !state.days[d]);
  for (const d of unread.slice(0, MAX_NEW_DAYS)) {
    const { ciks, rows } = await filersOn(sec, d);
    state.days[d] = { rows, all: ciks, pending: ciks.slice() };
    plan.indexDaysRead++;
  }
  plan.indexDaysUnread = Math.max(0, unread.length - MAX_NEW_DAYS);
  if (plan.indexDaysUnread) {
    note(`::warning::${plan.indexDaysUnread} more index day(s) still unread; the next run picks them up.`);
  }

  // Days that fell out of the window are dropped. Anything still pending after a
  // hundred days is no longer a same-day concern — the monthly universe run from
  // the SEC's quarterly data set is what backfills that far back.
  for (const d of Object.keys(state.days)) {
    if (d < from || d > TODAY) delete state.days[d];
  }

  // ---- choose this run's work ---------------------------------------------
  const dates = Object.keys(state.days).sort();
  plan.filersKnown = new Set(dates.flatMap((d) => state.days[d].all)).size;
  plan.filersPending = new Set(dates.flatMap((d) => state.days[d].pending)).size;
  plan.filersIngested = plan.filersKnown - plan.filersPending;
  plan.daysIncomplete = dates.filter((d) => state.days[d].pending.length);

  const cap = MAX_FUNDS || Infinity;
  const freshCap = FRESH_SHARE > 0 ? Math.min(cap, Math.ceil(cap * FRESH_SHARE)) : 0;
  const picked = new Set();
  const take = (order, budget) => {
    for (const d of order) {
      for (const cik of state.days[d].pending) {
        if (picked.size >= budget) return;
        picked.add(cik);
      }
    }
  };

  // ---- THE CLIENT'S OWN FUNDS COME FIRST. ALWAYS. -------------------------
  //
  // Everything below this orders ten thousand strangers sensibly. None of that
  // matters if the fourteen managers the dashboard is actually ABOUT are
  // somewhere in the middle of it: the first backlog run reached 518 funds in
  // EDGAR's publication order, none of them the client's, and somebody asked
  // about Cantillon while its quarter sat unread.
  //
  // Taken from shared/watchlist.mjs on every run, so adding a fund there means
  // the next run fetches it and removing one simply stops prioritising it — no
  // pipeline change, no re-ingest, nothing to remember.
  //
  // ORDER, NOT SCOPE. This cannot make a run ingest a fund that has not filed:
  // a CIK is only selectable if a daily index put it in `pending`. It is not a
  // fallback and must never become one — see the `no-watchlist-fallback` guard.
  const prioritised = [];
  const wanted = new Set(WATCHLIST_CIKS.map((c) => padCik(c)));
  for (const d of dates) {
    for (const cik of state.days[d].pending) {
      if (wanted.has(cik) && !picked.has(cik)) {
        picked.add(cik);
        prioritised.push(cik);
      }
    }
  }
  plan.prioritised = prioritised;
  if (prioritised.length) {
    note(`${prioritised.length} watchlist fund(s) moved to the front of this run: ${prioritised.join(",")}`);
  }

  // Newest first for the reserved share, so today's filings never queue behind a
  // backlog; then oldest first with the remainder, so the backlog drains.
  take([...dates].reverse(), freshCap);
  take(dates, cap);

  plan.ciks = [...picked];
  plan.filersSelected = plan.ciks.length;

  note(
    `${plan.filersKnown} filer(s) published in the window, ${plan.filersPending} still awaiting ingest ` +
      `across ${plan.daysIncomplete.length} day(s); taking ${plan.filersSelected} this run ` +
      `(cap ${MAX_FUNDS || "none"}${prioritised.length ? `, ${prioritised.length} of them watchlist` : ""})`,
  );

  // The cursor we PROPOSE. The workflow commits it only after the publish has
  // succeeded, and only for the funds the ingest actually finished — so a run
  // that dies half way costs nothing but the time it spent.
  writeFile(STATE_OUT, JSON.stringify({ v: 1, updatedAt: new Date().toISOString(), days: state.days }, null, 2));
  return 0;
}

let code = 1;
try {
  code = await run();
} catch (err) {
  if (err instanceof SecBlockedError) {
    plan.blocked = true;
    note(`::warning::${err.message}`);
    note("::warning::Nothing has been lost — the cursor is untouched and the next run resumes from it.");
    code = 0;
  } else {
    note(`::error::discovery failed: ${err.stack || err.message}`);
    code = 1;
  }
}

writeFile(OUT_PLAN, JSON.stringify(plan, null, 2));
// Commit mode revises the cursor and the counts; it has no fund list to hand on,
// and re-emitting the planning run's would put a stale list where a fresh one is
// expected.
if (!COMMIT) {
  writeFile(OUT_CIKS, plan.ciks.join(","));
  // No process.exit: let stdout drain on its own. Exiting straight after a write
  // truncates a piped list, which would silently shorten the very thing this
  // script exists to produce.
  process.stdout.write(plan.ciks.join(","));
}
process.exitCode = code;
