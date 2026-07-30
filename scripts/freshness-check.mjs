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
const today = (args.today || new Date().toISOString().slice(0, 10)).slice(0, 10);

const problems = [];
const notes = [];

function fail(msg) { problems.push(msg); }

const manifestPath = `${DATA}/manifest.json`;
if (!existsSync(manifestPath)) {
  fail(`No manifest at \`${manifestPath}\` — nothing has ever been published.`);
} else {
  const mf = JSON.parse(readFileSync(manifestPath, "utf8"));
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

  // 4. Quarantine and parse problems recorded by the last ingest.
  if (Array.isArray(mf.notes) && mf.notes.length) {
    fail(`The last ingest recorded ${mf.notes.length} problem(s):\n\n${mf.notes.slice(0, 20).map((n) => `- \`${n}\``).join("\n")}`);
  }

  // 5. The manifest must actually point at files that exist. A published
  //    manifest referencing missing artifacts is worse than no manifest: the UI
  //    renders chrome and then fails per widget.
  for (const p of periods.slice(0, 2)) {
    const path = `${DATA}/period/${p.period}/filings.json`;
    if (!existsSync(path)) fail(`Manifest lists ${periodLabel(p.period)} but \`${path}\` is missing.`);
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
