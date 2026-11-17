#!/usr/bin/env node
// scripts/watch-ingest.mjs
//
// Stay awake, and start the same-day ingest whenever it is due.
//
//   GH_TOKEN=… GITHUB_REPOSITORY=owner/repo node scripts/watch-ingest.mjs --for-minutes=345
//
// See shared/watch.mjs for why this exists. It never touches the SEC or the
// bucket: all it does is look at the ingest's recent runs and, if none is
// running and the last one started long enough ago, ask GitHub to start one.
// The ingest itself decides whether there is anything to do.

import { setTimeout as sleep } from "node:timers/promises";
import { decide, dueEveryMinutes } from "../shared/watch.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const num = (v, d) => (v === undefined || v === true || v === "" ? d : Number(v));

const FOR_MINUTES = num(args["for-minutes"], 345);
const CHECK_EVERY = num(args["check-every"], 5);
const WORKFLOW = typeof args.workflow === "string" ? args.workflow : "ingest.yml";
const REF = typeof args.ref === "string" ? args.ref : "main";
/** --dry-run: say what it would do, start nothing. For checking it by hand. */
const DRY = Boolean(args["dry-run"]);
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

if (!REPO || !TOKEN) {
  console.error("::error::GITHUB_REPOSITORY and GH_TOKEN must be set.");
  process.exit(1);
}

const api = (path, init = {}) =>
  fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });

const stamp = () => new Date().toISOString().slice(11, 16) + "Z";
const endAt = Date.now() + FOR_MINUTES * 60_000;
let started = 0;

console.log(`watching ${WORKFLOW} on ${REPO} for ${FOR_MINUTES} min, checking every ${CHECK_EVERY} min`);

while (Date.now() < endAt) {
  const today = new Date().toISOString().slice(0, 10);
  const every = dueEveryMinutes(today);
  try {
    const res = await api(`/actions/workflows/${WORKFLOW}/runs?per_page=10`);
    if (!res.ok) throw new Error(`listing runs answered ${res.status}`);
    const { workflow_runs: runs = [] } = await res.json();
    const d = decide(runs, new Date(), every);

    if (d.action === "start" && DRY) {
      console.log(`${stamp()} would start ${WORKFLOW} — last run began ${Math.round(d.minutesSince ?? 0)} min ago (dry run)`);
    } else if (d.action === "start") {
      const go = await api(`/actions/workflows/${WORKFLOW}/dispatches`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: REF }),
      });
      // 403/404 here is configuration — this job lacks `actions: write`, or
      // the workflow moved. Retrying cannot fix it; stop red so it is seen.
      if (go.status === 403 || go.status === 404) {
        console.error(`::error::GitHub refused to start ${WORKFLOW} (${go.status}). Check this workflow's permissions.`);
        process.exit(1);
      }
      if (!go.ok) throw new Error(`starting the run answered ${go.status}`);
      started++;
      console.log(
        `${stamp()} started ${WORKFLOW} — last run began ` +
          `${d.minutesSince == null ? "never" : `${Math.round(d.minutesSince)} min ago`}, due every ${every} min`,
      );
    } else if (d.action === "running") {
      console.log(`${stamp()} ${WORKFLOW} is already running or queued`);
    } else {
      console.log(`${stamp()} last run began ${Math.round(d.minutesSince)} min ago; due every ${every} min`);
    }
  } catch (err) {
    // A blip talking to GitHub is not a reason to stop watching.
    console.log(`::warning::${stamp()} could not check on ${WORKFLOW}: ${err.message}`);
  }
  const left = endAt - Date.now();
  if (left <= 0) break;
  await sleep(Math.min(CHECK_EVERY * 60_000, left));
}

console.log(`done: started ${started} run(s) in ${FOR_MINUTES} min`);
