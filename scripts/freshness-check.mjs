#!/usr/bin/env node
// scripts/freshness-check.mjs
//
// Deadline-aware staleness watchdog. Reads the PUBLISHED artifacts, so it
// detects the failure the ingest workflow cannot report on itself: a run that
// never started.
//
//   node scripts/freshness-check.mjs --data=public/data
//
// Exits 1 and writes /tmp/freshness.md when something should have happened and
// did not. Stays silent otherwise — for most of the year, doing nothing is the
// correct behaviour, and alerting on quiet days is how an alert gets ignored.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { filingSeason, filingDeadline, periodLabel, priorPeriod } from "../shared/calendar.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DATA = args.data || "public/data";
// --origin=https://… audits what is actually SERVED. --data=… audits a local
// build. Origin wins when both are given.
const ORIGIN = args.origin && args.origin !== true ? String(args.origin) : null;
const today = (args.today || new Date().toISOString().slice(0, 10)).slice(0, 10);

const problems = [];
const notes = [];

function fail(msg) { problems.push(msg); }

/**
 * Load the manifest the WATCHDOG SHOULD BE GRADING — which is the one users are
 * served, not the one sitting in the git checkout.
 *
 * This ran `--data=public/data` against a fresh actions/checkout, so it audited
 * the committed tree. But `functions/data/[[path]].js` claims /data/* outright
 * and serves from R2, so the committed copy is not what anyone reads. The
 * watchdog was therefore blind to the serving path at exactly the moment R2
 * became the serving path: R2 could go stale, serve a torn build, or lose its
 * manifest entirely, and this would still report "Freshness OK" — the precise
 * failure it exists to catch. (It did, for a day.)
 *
 * With --origin it fetches over HTTPS instead. The local --data mode is kept
 * for running the check against a build before publishing it.
 */
async function loadManifest() {
  if (!ORIGIN) {
    const manifestPath = `${DATA}/manifest.json`;
    if (!existsSync(manifestPath)) {
      fail(`No manifest at \`${manifestPath}\` — nothing has ever been published.`);
      return null;
    }
    notes.push(`Source: local tree \`${manifestPath}\``);
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  }

  // Cache-bust: the manifest is served with max-age=60, and a watchdog that can
  // be answered from cache is measuring the cache.
  const url = `${ORIGIN.replace(/\/+$/, "")}/data/manifest.json?freshness=${Date.now()}`;
  let res;
  try {
    res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  } catch (err) {
    fail(`Could not reach \`${url}\` — the site may be down. (${err.message})`);
    return null;
  }
  if (!res.ok) {
    fail(`\`${url}\` returned **${res.status}**. The dashboard cannot load without this file.`);
    return null;
  }
  // An SPA fallback answers 200 with HTML, which JSON.parse reports as a syntax
  // error somewhere in a <!doctype>. Check the type and say what actually
  // happened instead.
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) {
    fail(`\`${url}\` returned 200 but \`content-type: ${ct}\` — that is the SPA fallback, not the manifest.`);
    return null;
  }
  notes.push(`Source: live origin \`${ORIGIN}\``);
  return await res.json();
}

const mf = await loadManifest();
if (mf) {
  const season = filingSeason(today);
  const periods = mf.periods ?? [];
  const peakFunds = Math.max(1, ...periods.map((p) => p.funds ?? 0));

  notes.push(`Build \`${mf.buildId}\`, generated ${mf.generatedAt}`);
  notes.push(`Coverage ${periodLabel(mf.coverage.from)} → ${periodLabel(mf.coverage.to)}`);
  notes.push(`Season: **${season.season}** · ${periodLabel(season.period)} due ${season.deadline} (${season.daysToDeadline}d)`);

  // 1. The build must not itself be ancient. Generous, because the pipeline
  //    correctly idles between seasons; this only catches a truly dead cron.
  const ageDays = Math.round((Date.parse(today) - Date.parse(mf.generatedAt)) / 86_400_000);
  if (ageDays > 10) {
    fail(`The published build is **${ageDays} days old**. The ingest cron may be disabled — check that the keepalive commits are landing.`);
  }

  // 2. Deadline+3: every tracked fund should have filed by now, or be explicitly
  //    accounted for. This is the check that catches "we quietly lost a fund".
  //
  //    Target the most recent period whose DEADLINE HAS PASSED — not
  //    priorPeriod(season.period). Those differ for most of the year: on
  //    2026-09-08 the current period is Q2 2026 and its deadline (2026-08-14) is
  //    already 25 days gone, so Q2 is the quarter that should be complete.
  //    Checking Q1 instead would report all-clear while Q2 sat at one filing.
  let closed = season.period;
  for (let i = 0; i < 4 && filingDeadline(closed) > today; i++) closed = priorPeriod(closed);
  const closedDue = filingDeadline(closed);

  if (today > closedDue) {
    const row = periods.find((p) => p.period === closed);
    const daysPast = Math.round((Date.parse(today) - Date.parse(closedDue)) / 86_400_000);
    notes.push(`Most recent past-due period: ${periodLabel(closed)} (due ${closedDue}, ${daysPast}d ago)`);
    if (!row) {
      fail(`${periodLabel(closed)} was due ${closedDue} (${daysPast}d ago) and is not in the manifest at all.`);
    } else if (daysPast >= 3) {
      // Compare against the PRIOR period with a tolerance, not the all-time peak.
      //
      // Filer counts churn every quarter — managers wind down, cross the $100M
      // threshold, or merge — so 8,472 against a peak of 8,586 is ordinary
      // variation, not a missing-data incident. Comparing to the peak made this
      // fire on a perfectly healthy build, and an alert that cries wolf is worse
      // than no alert.
      const priorRow = periods.find((p) => p.period === priorPeriod(closed));
      const baseline = priorRow?.funds ?? peakFunds;
      const TOLERANCE = 0.85;
      // DEFER TO THE SEC-DERIVED CHECK WHEN THERE IS ONE. Comparing this quarter
      // to the last one is a proxy for "how much have we got"; `known` answers it
      // directly. Both firing means the same shortfall is reported twice in the
      // same alert, in two different numbers, which reads as two problems.
      if (row.known) {
        notes.push(`${periodLabel(closed)} filer count graded against the SEC below rather than against the prior quarter.`);
      } else if (baseline > 0 && row.funds < baseline * TOLERANCE) {
        fail(
          `${periodLabel(closed)} was due ${closedDue} (${daysPast}d ago) and has **${row.funds}** filers ` +
          `against ${baseline} the prior quarter — a drop of ${(100 - (row.funds / baseline) * 100).toFixed(0)}%. ` +
          `Either the ingest is missing filings, or those managers genuinely have not reported.`,
        );
      } else {
        notes.push(`Filer count ${row.funds} vs ${baseline} prior — within normal churn.`);
      }
    }
  }

  // 3. In-season liveness. During the ramp and peak, filings arrive daily, so a
  //    build that has not moved for two days means the pipeline is stuck.
  if ((season.season === "ramp" || season.season === "peak") && ageDays > 2) {
    fail(`It is **${season.season}** season for ${periodLabel(season.period)} and the build has not changed in ${ageDays} days. Filings arrive daily in this window.`);
  }

  // 3b. COVERAGE, GRADED AGAINST WHAT THE SEC HAS ACTUALLY PUBLISHED.
  //
  //     Every check above compares the dashboard to itself — to its own age, to
  //     its own previous quarter — and all of them passed for eleven days while
  //     the same-day ingest quietly published thirteen filers out of 10,698 for
  //     Q2 2026. The first one to notice was check 2, which only looks three days
  //     AFTER a deadline, by which point the quarter has been wrong for a fortnight.
  //
  //     `known` is the count of managers EDGAR's daily indexes show have filed
  //     for the quarter. It comes from outside our own data, it exists from the
  //     first day of a season rather than three days after the deadline, and it
  //     is the only number here that can tell "nobody has filed yet" apart from
  //     "we are not reading the filings".
  const cur = periods.find((p) => p.period === season.period);
  if (cur?.known) {
    // GRADE THE QUEUE, NOT `known - funds`.
    //
    // `funds` counts holdings pages; `known` counts every manager who filed,
    // including the ~2,000 a quarter who file only a NOTICE ("my positions are
    // in someone else's report") and so never get a holdings page. That gap
    // never closes. On 16 Nov 2026 it read "1,451 filings not ingested" and
    // had said so every day for over a week — an alarm that is always on is
    // an alarm nobody reads, and it was not read on the day it mattered.
    //
    // `pending` is the ingest cursor's own count of managers still queued.
    // Builds from before it was published fall back to the old comparison.
    const queued = Number.isFinite(cur.pending) ? cur.pending : cur.known - (cur.funds ?? 0);
    const pct = (cur.known - queued) / cur.known;
    notes.push(
      `${periodLabel(cur.period)} coverage: ${cur.known - queued} of ${cur.known} managers EDGAR has published ` +
      `are read (${(pct * 100).toFixed(0)}%), ${queued} queued` +
      (Number.isFinite(cur.pending) ? "" : " — estimated; this build does not say how many are queued"),
    );
    // 90%: filings that arrive within the hour are legitimately not in yet, and
    // a manager whose filing we quarantined is deliberately absent.
    if (pct < 0.9) {
      fail(
        `${periodLabel(cur.period)}: **${queued} of ${cur.known}** managers who have filed are still waiting to be ` +
        `read (${(100 - pct * 100).toFixed(0)}%). The ingest drains about 800 a run, so in filing season this ` +
        `should clear within a few hours — check that the last few runs of \`Ingest 13F filings\` are green.`,
      );
    }
  } else if (season.season === "ramp" || season.season === "peak" || season.season === "tail") {
    notes.push(
      "No `known` count on the current period — the same-day ingest has not published one yet, " +
      "so coverage cannot be graded against the SEC this run.",
    );
  }

  // 3c. IS THE INGEST ACTUALLY BEING STARTED?
  //
  //     Asked of GitHub, not inferred from the data. This used to read the age
  //     of `knownAsOf` — but that only moves when a run publishes something, so
  //     a healthy run with nothing new to read looked exactly like a dead one,
  //     and it said "it is not running" for two days in a row while it ran.
  //
  //     The workflow passes when the ingest last STARTED. In filing season it is
  //     due every half hour (see shared/watch.mjs); three hours without a start
  //     means neither GitHub's timer nor the watcher is starting it.
  const lastStart = typeof args["last-ingest-start"] === "string" ? Date.parse(args["last-ingest-start"]) : NaN;
  if (Number.isFinite(lastStart)) {
    const hours = (Date.now() - lastStart) / 3_600_000;
    const limit = season.season === "quiet" ? 8 : 3;
    notes.push(`The ingest last started ${hours.toFixed(1)}h ago (alarm at ${limit}h in ${season.season} season).`);
    if (hours > limit) {
      fail(
        `The ingest has not started for **${hours.toFixed(1)} hours**. It is due every ` +
        `${season.season === "quiet" ? "two hours" : "half hour to hour"} — check that ` +
        `\`Keep the ingest on time\` is running in the Actions tab.`,
      );
    }
  } else if (args["last-ingest-start"] !== undefined) {
    notes.push("Could not tell when the ingest last started — GitHub did not say.");
  }

  // 4. Quarantine and parse problems recorded by the last ingest.
  //
  //    A THRESHOLD, NOT A TRIPWIRE. This used to fire on a single note, which was
  //    right when a run covered thirteen hand-picked, well-behaved managers. A run
  //    now covers hundreds drawn from whoever filed, and a handful of filings that
  //    do not reconcile against their own cover page is the ordinary state of the
  //    world — those are quarantined and excluded from the fold, which is the
  //    system working. Alerting on every one of them would teach everybody to
  //    ignore the alert, and this is the only watchdog there is.
  //    A RATE, and graded against the size of the run that produced it. The first
  //    version of this threshold was an absolute 25, which the very first
  //    universe-scale run tripped: 61 filings that do not sum to their own cover
  //    page, out of ~1,300 fund-quarters — 4.7%, and every one of them correctly
  //    quarantined and kept out of the fold. That is the world being messy, not
  //    the pipeline being broken, and it would have fired every day for ever.
  const NOTE_ALARM_RATE = 0.15;
  const noteCount = Number(mf.notesTotal) || (Array.isArray(mf.notes) ? mf.notes.length : 0);
  const noteOf = Number(mf.notesOf) || 0;
  if (noteCount) {
    const rate = noteOf > 0 ? noteCount / noteOf : null;
    const shown = mf.notes?.slice(0, 15).map((n) => `- \`${n}\``).join("\n") ?? "";
    if (rate != null && rate >= NOTE_ALARM_RATE) {
      fail(
        `The last ingest could not reconcile **${noteCount} of ${noteOf}** filings it read ` +
        `(${(rate * 100).toFixed(0)}%), which is well above the usual few per cent:\n\n${shown}`,
      );
    } else if (rate == null && noteCount >= 200) {
      // No denominator published (an older build). Fall back to a number, but a
      // high one, so it flags a real incident rather than an ordinary day.
      fail(`The last ingest recorded **${noteCount}** problems and did not say how many filings it read:\n\n${shown}`);
    } else {
      notes.push(
        `Last ingest quarantined ${noteCount}${noteOf ? ` of ${noteOf}` : ""} filing(s)` +
        `${rate != null ? ` (${(rate * 100).toFixed(1)}%)` : ""} — routine; they are withheld, not published wrong.`,
      );
    }
  }

  // 5. The manifest must actually point at files that exist. A published
  //    manifest referencing missing artifacts is worse than no manifest: the UI
  //    renders chrome and then fails per widget.
  //
  //    CHECK THE SAME PLACE THE MANIFEST CAME FROM. This used to stat the local
  //    checkout even when --origin had been given, so in the mode this watchdog
  //    actually runs in it graded a tree nobody serves against a manifest from a
  //    bucket — two unrelated things — and could report a missing file that was
  //    published, or miss one that was not.
  for (const p of periods.slice(0, 2)) {
    const rel = `period/${p.period}/filings.json`;
    if (!ORIGIN) {
      if (!existsSync(`${DATA}/${rel}`)) fail(`Manifest lists ${periodLabel(p.period)} but \`${DATA}/${rel}\` is missing.`);
      continue;
    }
    const url = `${ORIGIN.replace(/\/+$/, "")}/data/${rel}?freshness=${Date.now()}`;
    try {
      const r = await fetch(url, { method: "HEAD", headers: { "cache-control": "no-cache" } });
      if (!r.ok) fail(`Manifest lists ${periodLabel(p.period)} but \`${url}\` returned **${r.status}**.`);
    } catch (err) {
      fail(`Manifest lists ${periodLabel(p.period)} but \`${url}\` could not be reached (${err.message}).`);
    }
  }
}

// WRITE THE REPORT WHATEVER HAPPENS.
//
// The workflow reads /tmp/freshness.md to fill in the issue it opens. If this
// script throws before writing it — a malformed manifest, an unreachable origin
// — the human gets an issue whose entire body is "(no detail written)", which is
// the least useful possible version of an alert.
process.on("uncaughtException", (err) => {
  try {
    writeFileSync("/tmp/freshness.md", `## The freshness check itself failed\n\n\`${err.message}\`\n`);
  } catch { /* nothing left to try */ }
  console.error(err.stack || err.message);
  process.exit(1);
});

const md = [
  problems.length ? `## ${problems.length} freshness problem(s)` : "## Freshness OK",
  "",
  ...problems.map((p) => `- ${p}`),
  "",
  "### Context",
  ...notes.map((n) => `- ${n}`),
].join("\n");

writeFileSync("/tmp/freshness.md", md);
console.log(md);

if (problems.length) process.exit(1);
