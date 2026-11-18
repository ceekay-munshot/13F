#!/usr/bin/env node
// scripts/build-movers.mjs
//
// Build movers/{period}.json — every concentrated manager's trades for the
// quarter — from the fund files already on the live site. Feeds the Sectors tab.
//
//   node scripts/build-movers.mjs --out=.build/movers              # build only
//   node scripts/build-movers.mjs --out=.build/movers --publish    # and upload
//   node scripts/build-movers.mjs --out=.build/movers --limit=200  # sample, never published
//   node scripts/build-movers.mjs --sectors=.build/sectors.json     # a sector list built this run
//
// It reads over plain HTTPS from the live origin, like rebuild-indexes.mjs, so
// what runs in CI can be run and checked by hand first. Zero SEC requests.
//
// INCREMENTAL. The first build reads every fund's quarter once. After that a
// fund is only read again when its data changes — the manifest gives every
// fund a key that moves when the fund is republished — so a run after an
// ingest reads the handful of funds that ingest touched, not 8,500.
//
// It writes only under movers/, which nothing else writes, and never touches
// the manifest. If it cannot read enough of the site to be sure of its answer
// it publishes nothing and the tab keeps showing the last good file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fundMoves, pickNames, moversPath, moversSeenPath, MOVERS_MAX_POSITIONS, MOVERS_MIN_POSITIONS, MOVERS_VERSION } from "../shared/movers.mjs";
import { CACHE_CONTROL } from "../shared/artifacts.mjs";
import { createPlacer, unpackSubsectors } from "../shared/sector-list.mjs";
import { SECTORS } from "../shared/sic.mjs";
import { SUBSECTORS, SUBSECTORS_KEY, otherSubsector } from "../shared/subsectors.mjs";
import { createR2, pool } from "./_r2.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const ORIGIN = (args.origin || process.env.SITE_URL || "https://13f-eo2.pages.dev").replace(/\/$/, "");
const OUT = args.out || ".build/movers";
const PERIODS = Number(args.periods || 2);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const CONCURRENCY = Number(args.concurrency || 24);
// DRY_RUN wins over --publish: a dry run must not be able to publish by mistake.
const PUBLISH = Boolean(args.publish) && LIMIT === Infinity && process.env.DRY_RUN !== "true";
// More read failures than this and the answer is not trustworthy enough to publish.
const MAX_FAILED_SHARE = 0.02;
// Bypasses the edge cache for the two files that change in place.
const FRESH = `fresh=${Date.now()}`;

const log = (m) => console.log(m);

/** null on 404 — "this manager did not file that quarter" is an answer. */
async function get(path, { attempts = 4 } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`${ORIGIN}/data/${path}`, { signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status}`);
      return await res.json();
    } catch (err) {
      last = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, i * 500 + Math.random() * 400));
    }
  }
  throw new Error(`${path}: ${last?.message ?? last}`);
}

const mf = await get(`manifest.json?${FRESH}`);
if (!mf?.buildId) throw new Error("live manifest is unreadable");

const filersEnv = await get(`meta/filers.json?b=${mf.shared?.["meta/filers.json"] ?? mf.buildId}`);
const names = new Map();
for (const f of filersEnv?.data ?? []) if (f.hasHoldings !== false) names.set(f.cik, f.name);
for (const cik of Object.keys(mf.funds ?? {})) if (!names.has(cik)) names.set(cik, cik);
const ciks = [...names.keys()].sort().slice(0, LIMIT);

// THE SECTOR LIST. The weekly one this job keeps (movers/sectors.json) when it
// exists — it places funds, foreign companies and new listings the monthly one
// cannot — and the monthly one otherwise. The names are for holdings filed
// with no ticker.
//
// --sectors=<file> is a list build-sectors.mjs has just written in this same
// run: used directly, so a dry run shows what a new list would do before any
// of it is published.
const local = typeof args.sectors === "string" && existsSync(args.sectors)
  ? JSON.parse(readFileSync(args.sectors, "utf8"))
  : null;
const weekly = local
  ? { builtAt: local.generatedAt, data: Object.fromEntries(Object.entries(local.sectors ?? {}).map(([t, v]) => [t, v.sector])) }
  : await get(`movers/sectors.json?${FRESH}`).catch(() => null);
const sectorEnv = weekly ?? await get(`meta/sectors.json?b=${mf.buildId}`).catch(() => null);
const sectorState = local
  ? { names: local.names }
  : weekly ? await get(`movers/sectors.state.json?${FRESH}`).catch(() => null) : null;
// Each ticker's subsector, from the same build as the list. Without it (a list
// built before subsectors) every trade still gets its right sector, and a
// subsector only where a hand-kept name or a fund's own name gives one.
const subs = local
  ? Object.fromEntries(Object.entries(local.sectors ?? {}).filter(([, v]) => v.subsector).map(([t, v]) => [t, v.subsector]))
  : unpackSubsectors(sectorState);
const placeOf = createPlacer(sectorEnv?.data ?? {}, { names: sectorState?.names ?? null, subs });
// Rows kept from the last build were placed with the list that was current
// then. A new list means every fund is placed again.
const sectorListAt = weekly?.builtAt ?? `monthly:${mf.buildId}`;
log(`sector list: ${weekly ? `weekly, built ${weekly.builtAt}` : "monthly"} · ${Object.keys(sectorEnv?.data ?? {}).length} tickers` +
    ` · ${subs ? `${Object.keys(subs).length} with a subsector` : "no subsectors"}`);

const periods = (mf.periods ?? [])
  .filter((p) => (p.funds ?? 0) > 0)
  .map((p) => p.period)
  .sort()
  .reverse()
  .slice(0, PERIODS);

log(`${ciks.length} managers with holdings · quarters ${periods.join(", ")} · from ${ORIGIN}`);

const r2 = PUBLISH
  ? createR2({
      // Short-cached: unlike every other artifact these change in place.
      headersFor: (key, body) => ({
        "content-type": "application/json",
        "content-length": String(body.length),
        "cache-control": CACHE_CONTROL.manifest,
      }),
    })
  : null;

let failedRuns = 0;

for (const period of periods) {
  const [prev, prevSeen] = await Promise.all([
    get(`${moversPath(period)}?${FRESH}`).catch(() => null),
    get(`${moversSeenPath(period)}?${FRESH}`).catch(() => null),
  ]);
  // A different rule or threshold means last run's rows answer a different
  // question. Start again rather than mix them. That includes the subsector
  // rules: a kept row's subsector is a position in the list it was built with.
  const reusable = prevSeen?.version === MOVERS_VERSION
    && prevSeen?.maxPositions === MOVERS_MAX_POSITIONS && prevSeen?.minPositions === MOVERS_MIN_POSITIONS
    && prevSeen?.sectorListAt === sectorListAt && prevSeen?.subsectorsKey === SUBSECTORS_KEY;
  const seenBefore = reusable ? prevSeen.keys ?? {} : {};
  const rowsBefore = new Map(reusable ? (prev?.funds ?? []).map((f) => [f[0], f]) : []);

  const seen = {};
  const rows = new Map();
  // Ticker -> filed name -> how many funds filed it that way (funds read this run).
  const votes = new Map();
  const tally = { reused: 0, read: 0, notFiled: 0, failed: 0, included: 0 };
  const skips = {};

  await pool(ciks, CONCURRENCY, async (cik) => {
    const key = mf.funds?.[cik] ?? mf.buildId;
    const was = seenBefore[cik];
    if (was && was[0] === key) {
      tally.reused++;
      seen[cik] = was;
      const row = rowsBefore.get(cik);
      if (row) rows.set(cik, [cik, names.get(cik) ?? row[1], row[2], row[3], row[4]]);
      return;
    }
    let env;
    try {
      env = await get(`fund/${cik}/${period}.json?b=${key}`);
    } catch {
      // Not recorded as seen, so the next run tries again. Last good row kept.
      tally.failed++;
      if (rowsBefore.has(cik)) rows.set(cik, rowsBefore.get(cik));
      return;
    }
    tally.read++;
    if (!env) {
      tally.notFiled++;
      seen[cik] = [key, null];
      return;
    }
    const r = fundMoves(env, { placeOf });
    seen[cik] = [key, r.positions ?? null];
    if (r.skip) {
      skips[r.skip] = (skips[r.skip] ?? 0) + 1;
      return;
    }
    rows.set(cik, [cik, names.get(cik), Math.round(r.value), r.positions, r.moves]);
    for (const [ticker, filed] of Object.entries(r.names ?? {})) {
      let v = votes.get(ticker);
      if (!v) votes.set(ticker, (v = new Map()));
      v.set(filed, (v.get(filed) ?? 0) + 1);
    }
  }, (done, total) => log(`  ${period}: ${done}/${total}`));

  const funds = [...rows.values()].sort((a, b) => b[2] - a[2]);
  tally.included = funds.length;
  const moves = funds.reduce((a, f) => a + f[4].length, 0);
  // How much of the money traded still has no sector — the number this list exists to keep small.
  const unc = SECTORS.indexOf("Unclassified");
  let tradedAll = 0, tradedUnc = 0;
  for (const f of funds) for (const m of f[4]) { tradedAll += Math.abs(m[3]); if (m[6] === unc) tradedUnc += Math.abs(m[3]); }
  log(`${period}: ${(100 * tradedUnc / Math.max(1, tradedAll)).toFixed(1)}% of money traded is Unclassified`);
  {
    const left = new Map();
    for (const f of funds) for (const m of f[4]) if (m[6] === unc) left.set(m[0], (left.get(m[0]) ?? 0) + Math.abs(m[3]));
    const top = [...left.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    log(`  largest still unplaced: ${top.map(([t, v]) => `${t} $${(v / 1e6).toFixed(0)}M`).join(", ")}`);
  }
  logSubsectors(period, funds);
  log(`${period}: ${funds.length} concentrated managers, ${moves} trades · ` +
      `read ${tally.read}, reused ${tally.reused}, not filed ${tally.notFiled}, failed ${tally.failed} · ` +
      `left out ${JSON.stringify(skips)}`);

  const body = {
    v: 1, kind: "period-movers", period,
    maxPositions: MOVERS_MAX_POSITIONS, minPositions: MOVERS_MIN_POSITIONS,
    // When the site's data last changed, as of this build — not the wall clock,
    // so an unchanged rebuild is byte-identical and is not re-uploaded.
    asOf: mf.generatedAt ?? null,
    fields: ["cik", "name", "valueLongUsd", "positionsLong", "moves"],
    moveFields: ["ticker", "action", "sharesChangePct", "tradedUsd", "weightBefore", "weightAfter", "sector", "subsector"],
    sectors: SECTORS,
    // What each move's subsector number means, so the file reads back
    // correctly whatever the list in the code later becomes.
    subsectors: SUBSECTORS,
    funds,
    // Ticker -> company name, for the tab's most-sold / most-bought lists.
    names: pickNames(
      funds.flatMap((f) => f[4].map((m) => m[0])),
      votes,
      reusable ? prev?.names ?? {} : {},
    ),
  };
  const seenBody = {
    v: 1, kind: "period-movers-seen", period, version: MOVERS_VERSION,
    maxPositions: MOVERS_MAX_POSITIONS, minPositions: MOVERS_MIN_POSITIONS, sectorListAt,
    subsectorsKey: SUBSECTORS_KEY, keys: seen,
  };

  for (const [path, obj] of [[moversPath(period), body], [moversSeenPath(period), seenBody]]) {
    const file = join(OUT, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj));
  }

  const failedShare = tally.failed / Math.max(1, ciks.length);
  if (failedShare > MAX_FAILED_SHARE) {
    log(`::error::${period}: ${tally.failed} of ${ciks.length} funds could not be read — not publishing this quarter.`);
    failedRuns++;
    continue;
  }
  // Nothing may get smaller by much. A sudden drop is a read problem, not a
  // quarter in which half the focused managers vanished.
  const before = rowsBefore.size;
  if (before > 200 && funds.length < before * 0.8) {
    log(`::error::${period}: ${funds.length} managers against ${before} last time — not publishing this quarter.`);
    failedRuns++;
    continue;
  }
  if (r2) {
    // The rows first, then the record of what was read. If the second upload
    // fails the next run simply reads a few funds again.
    await r2.put(moversPath(period), Buffer.from(JSON.stringify(body)));
    await r2.put(moversSeenPath(period), Buffer.from(JSON.stringify(seenBody)));
    log(`${period}: published`);
  }
}

/**
 * Each sector's money split by subsector, and how much of it is left in the
 * sector's catch-all ("Other health care") — the number that says whether the
 * split is doing its job.
 */
function logSubsectors(period, funds) {
  const bySector = new Map();
  for (const f of funds) {
    for (const m of f[4]) {
      const sector = SECTORS[m[6]] ?? "Unclassified";
      const sub = SUBSECTORS[m[7]] ?? otherSubsector(sector);
      let s = bySector.get(sector);
      if (!s) bySector.set(sector, (s = { total: 0, subs: new Map() }));
      let e = s.subs.get(sub);
      if (!e) s.subs.set(sub, (e = { v: 0, t: new Map() }));
      const v = Math.abs(m[3]);
      s.total += v;
      e.v += v;
      e.t.set(m[0], (e.t.get(m[0]) ?? 0) + v);
    }
  }
  const pct = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(1)}%`;
  log(`${period}: money traded by subsector, with the share left in each sector's catch-all`);
  for (const [sector, s] of [...bySector].sort((a, b) => b[1].total - a[1].total)) {
    const other = s.subs.get(otherSubsector(sector))?.v ?? 0;
    log(`  ${sector} $${(s.total / 1e9).toFixed(2)}B · ${otherSubsector(sector)} ${pct(other, s.total)}`);
    for (const [sub, e] of [...s.subs].sort((a, b) => b[1].v - a[1].v)) {
      const top = [...e.t].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t).join(" ");
      log(`    ${pct(e.v, s.total).padStart(6)}  ${sub} — ${top}`);
    }
  }
}

if (!PUBLISH) log(LIMIT !== Infinity ? "sample run — nothing published" : "built — not published (pass --publish)");
if (failedRuns) process.exit(1);
