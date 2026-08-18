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
      if (baseline > 0 && row.funds < baseline * TOLERANCE) {
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
    const pct = cur.known ? (cur.funds ?? 0) / cur.known : 1;
    notes.push(`${periodLabel(cur.period)} coverage: ${cur.funds} of ${cur.known} managers EDGAR has published (${(pct * 100).toFixed(0)}%)`);
    // 90%: filings that arrive within the hour are legitimately not in yet, and
    // a manager whose filing we quarantined is deliberately absent.
    if (pct < 0.9) {
      fail(
        `${periodLabel(cur.period)}: **${cur.funds} of ${cur.known}** managers who have filed are on the dashboard ` +
        `(${(pct * 100).toFixed(0)}%). ${cur.known - (cur.funds ?? 0)} filings the SEC has published are not ingested. ` +
        `If the ingest is running this clears itself within a day or two — check that the last few runs of ` +
        `\`Ingest 13F filings\` are green and that their summaries show the number climbing.`,
      );
    }
    // And the counter itself has to be moving. It is written by the same-day job
    // on every run, so a stale one means that job is not running at all — which
    // no other check here can see, because everything else it publishes would
    // simply stay as it was.
    if (cur.knownAsOf) {
      const hours = Math.round((Date.parse(today + "T23:59:59Z") - Date.parse(cur.knownAsOf)) / 3_600_000);
      if (hours > 36) {
        fail(`The same-day ingest has not recorded a filing count since ${cur.knownAsOf} (${hours}h ago). It runs every three hours, so it is not running.`);
      }
    }
  } else if (season.season === "ramp" || season.season === "peak" || season.season === "tail") {
    notes.push(
      "No `known` count on the current period — the same-day ingest has not published one yet, " +
      "so coverage cannot be graded against the SEC this run.",
    );
  }

  // 4. Quarantine and parse problems recorded by the last ingest.
  if (Array.isArray(mf.notes) && mf.notes.length) {
    fail(`The last ingest recorded ${mf.notes.length} problem(s):\n\n${mf.notes.slice(0, 20).map((n) => `- \`${n}\``).join("\n")}`);
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
