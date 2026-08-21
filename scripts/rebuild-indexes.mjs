#!/usr/bin/env node
// scripts/rebuild-indexes.mjs
//
// Rebuild every shared index from the per-fund artifacts already published.
//
//   node scripts/rebuild-indexes.mjs --out=public/data
//   node scripts/rebuild-indexes.mjs --out=public/data --limit=50      # sample
//   node scripts/rebuild-indexes.mjs --out=public/data --dry-run
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS, AND WHY IT IS THE SHAPE OF THE REAL FIX
// ---------------------------------------------------------------------------
// On 2026-08-20 the monthly run published its own fund summaries over the live
// ones and every fund lost the current quarter. mergeSummary now stops that
// happening again — but nothing ever repaired the damage it did. As of today
// 8,295 managers' pages say "has not filed for Q2 2026" while their Q2 book sits
// in the bucket, complete, with nothing pointing at it.
//
// It could not be repaired because there is no store of record: the dashboard's
// own files are the only copy of the data, so a lost index is normally a
// re-download from the SEC. Except in this case it is not, because the loss was
// confined to the INDEX. Every fact a summary carries is still present in
// fund/{cik}/{period}.json — verified field by field, all 23 of them.
//
// So this reads the per-fund artifacts and DERIVES the indexes from them,
// instead of merging into what is published. Zero SEC requests.
//
// That is deliberately the same shape as the builder that replaces this whole
// class of bug: read a store of record, emit the indexes, never merge. Here the
// store happens to be the artifact tree itself. In Phase 3 it becomes the
// archived SEC files, and this logic moves across largely unchanged.
//
// It reads over plain HTTPS from the live origin rather than through R2
// credentials, so the exact code path that runs in CI can be run and checked by
// hand first.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { periodLabel } from "../shared/calendar.mjs";
import { seriesEntryFrom, insertPeriods } from "../shared/rebuild.mjs";
import { buildIdFrom } from "../shared/artifacts.mjs";
import { SERIES_FIELDS } from "../shared/series-fields.mjs";
import { mergeFilerRow } from "../shared/manifest-merge.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const ORIGIN = (args.origin || process.env.SITE_URL || "https://13f-eo2.pages.dev").replace(/\/$/, "");
const OUT = args.out || "public/data";
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const CONCURRENCY = Number(args.concurrency || 24);
const DRY = Boolean(args["dry-run"]);

const log = (m) => console.log(m);

// ---------------------------------------------------------------------------
// Reading the live tree
// ---------------------------------------------------------------------------

/**
 * A 404 is an ANSWER, not a failure: it means this manager did not file that
 * quarter. Anything else is retried, because one dropped connection in ~18,000
 * requests is close to certain and must not be read as "no data".
 */
async function get(path, { attempts = 3, allow404 = false } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`${ORIGIN}/data/${path}`, { signal: AbortSignal.timeout(45_000) });
      if (res.status === 404 && allow404) return null;
      if (!res.ok) throw new Error(`${res.status}`);
      return await res.json();
    } catch (err) {
      last = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, i * 400 + Math.random() * 300));
    }
  }
  throw new Error(`${path}: ${last?.message ?? "unreadable"}`);
}

async function pool(items, n, fn) {
  const it = items[Symbol.iterator]();
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (let x = it.next(); !x.done; x = it.next()) await fn(x.value);
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Deriving a summary entry from a fund-period artifact
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const written = [];
function write(path, obj) {
  written.push(path);
  if (DRY) return;
  const full = join(OUT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(obj));
}

log(`rebuild-indexes · reading ${ORIGIN}\n`);

const manifest = await get("manifest.json");
const periods = (manifest.periods ?? []).map((p) => p.period ?? p).sort();
log(`quarters the site publishes: ${periods.join(", ")}`);

const filersEnv = await get("meta/filers.json");
const filerRows = filersEnv.data ?? [];
const ciks = filerRows.map((r) => r.cik).slice(0, LIMIT === Infinity ? undefined : LIMIT);
log(`managers in the fund index: ${filerRows.length}${LIMIT === Infinity ? "" : ` (sampling ${ciks.length})`}\n`);

/** cik -> { env, series } after repair */
const funds = new Map();
let repaired = 0, recoveredQuarters = 0, unreadable = 0, probed = 0, done = 0;

await pool(ciks, CONCURRENCY, async (cik) => {
  let summary;
  try {
    summary = await get(`fund/${cik}/summary.json`, { allow404: true });
  } catch (err) {
    unreadable++;
    return;
  }
  if (!summary) return; // no summary published for this manager

  const { data, ...env } = summary;
  const series = data?.series ?? [];
  const have = new Set(series.map((s) => s.period));
  const missing = periods.filter((p) => !have.has(p));

  const recovered = [];
  for (const period of missing) {
    probed++;
    let artifact;
    try {
      artifact = await get(`fund/${cik}/${period}.json`, { allow404: true });
    } catch {
      unreadable++;
      continue;
    }
    // 404 is the normal answer: this manager did not file that quarter.
    if (!artifact) continue;
    recovered.push(seriesEntryFrom(artifact));
  }

  const finalSeries = insertPeriods(series, recovered);
  funds.set(cik, { env, series: finalSeries });

  if (recovered.length) {
    repaired++;
    recoveredQuarters += recovered.length;
    // A summary may only ever grow here. Cheap to assert, and this is the exact
    // invariant whose absence cost 9,268 funds a quarter.
    if (finalSeries.length < series.length) {
      throw new Error(`${cik}: rebuild would shorten the series ${series.length} -> ${finalSeries.length}`);
    }
    write(`fund/${cik}/summary.json`, { ...env, data: { series: finalSeries } });
  }

  if (++done % 1000 === 0) log(`  ${done}/${ciks.length} managers examined · ${repaired} repaired`);
});

log(`\n${done} managers examined · ${probed} quarters probed · ${repaired} summaries repaired ` +
    `· ${recoveredQuarters} fund-quarters recovered${unreadable ? ` · ${unreadable} unreadable` : ""}`);

// ---------------------------------------------------------------------------
// The shared indexes, DERIVED — not merged.
// ---------------------------------------------------------------------------
//
// Everything below is a pure function of the summaries above. That is the whole
// point: a count that is computed cannot ratchet, and an index that is derived
// cannot drift from the thing it indexes.

if (LIMIT === Infinity) {
  // -------------------------------------------------------------------------
  // A NEW BUILD ID, OR NONE OF THIS IS VISIBLE TO ANYBODY.
  // -------------------------------------------------------------------------
  // Artifacts are served `public, max-age=31536000, immutable` and busted only
  // by the `?b={buildId}` the manifest hands out. Writing corrected bytes to the
  // same key under the same build id changes nothing a returning visitor sees —
  // for a year. The repair would run, report success, and be invisible.
  //
  // Derived from the data rather than the clock, so re-running the repair on an
  // unchanged site produces the same id and uploads nothing. That is the same
  // determinism the Phase 3 builder needs, practised here first.
  const newestAcceptance = [...funds.values()]
    .flatMap((f) => f.series.map((s) => s.acceptedAt).filter(Boolean))
    .sort()
    .at(-1) ?? "";
  const buildId = buildIdFrom(newestAcceptance, `rebuild|${funds.size}|${recoveredQuarters}`);
  log(`\nbuild id ${manifest.buildId} -> ${buildId}`);

  // meta/series.json — the compact index. Only the monthly run has ever written
  // it, so every fund the same-day job refreshed has been stale in it since the
  // season began. Derived here from the same summaries the fund pages serve, so
  // the two cannot disagree.
  const seriesRows = [];
  const filerByCik = new Map(filerRows.map((r) => [r.cik, r]));
  for (const [cik, f] of funds) {
    const row = filerByCik.get(cik);
    seriesRows.push({
      cik,
      name: f.env.name ?? row?.name ?? null,
      state: f.env.state ?? row?.state ?? null,
      hasHoldings: Boolean(row?.hasHoldings),
      watch: row?.watch,
      // Newest first, matching what the monthly build emits. The frontend
      // re-sorts on load either way, but matching it keeps the diff honest.
      s: [...f.series].reverse().map((x) => SERIES_FIELDS.map((k) => x[k] ?? null)),
    });
  }
  write("meta/series.json", {
    v: 1,
    kind: "series",
    buildId: null,
    generatedAt: new Date().toISOString(),
    fields: SERIES_FIELDS,
    data: seriesRows,
  });

  // meta/filers.json — coverage recomputed per manager from their own series.
  const nextFilers = filerRows.map((row) => {
    const f = funds.get(row.cik);
    if (!f || !f.series.length) return row;
    const newest = f.series.reduce((a, b) => (a.period > b.period ? a : b));
    return mergeFilerRow(row, {
      ...row,
      periods: f.series.length,
      latestPeriod: newest.period,
      latestValueUsd: newest.reportedTotalUsd ?? newest.valueLongUsd ?? row.latestValueUsd,
    });
  });
  write("meta/filers.json", { ...filersEnv, data: nextFilers });

  // The manifest's per-quarter coverage. THIS is the number the dashboard states
  // as fact and the freshness alarm grades, and it has been a Math.max ratchet
  // over whatever the filings feed ever saw — which is why the site reports
  // "10,765 of 10,765 managers" while 8,295 pages say the manager has not filed.
  // Counted, not ratcheted.
  const fundsPerPeriod = {};
  for (const p of periods) fundsPerPeriod[p] = 0;
  for (const f of funds.values()) for (const s of f.series) if (p_in(fundsPerPeriod, s.period)) fundsPerPeriod[s.period]++;

  const nextManifest = {
    ...manifest,
    buildId,
    generatedAt: new Date().toISOString(),
    periods: (manifest.periods ?? []).map((p) => ({
      ...p,
      // `filings` counts FILINGS and a manager may file several times; it is not
      // derivable from summaries, so it is left exactly as published rather than
      // replaced with a number that would be wrong in a different way.
      funds: fundsPerPeriod[p.period] ?? p.funds,
    })),
    counts: { ...(manifest.counts ?? {}), filers: nextFilers.length },
  };
  write("manifest.json", nextManifest);

  log("");
  log("quarter coverage, counted from published fund pages:");
  for (const p of periods) {
    const before = (manifest.periods ?? []).find((x) => x.period === p);
    const was = before?.funds ?? 0;
    const now = fundsPerPeriod[p] ?? 0;
    log(`  ${periodLabel(p)}  ${String(now).padStart(6)} managers` +
        (was !== now ? `   (the manifest claimed ${was})` : ""));
  }
}

function p_in(obj, k) { return Object.prototype.hasOwnProperty.call(obj, k); }

log(`\n${written.length} file(s) ${DRY ? "would be written" : `written to ${OUT}`}`);
