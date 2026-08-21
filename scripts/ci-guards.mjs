#!/usr/bin/env node
// scripts/ci-guards.mjs
//
// Structural guards for the two rules that are easy to break by accident, cost
// nothing to check, and are expensive to discover in production.
//
// Run by `npm run guard`, which `npm run check` and CI both call.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { undefinedRefsInFile } from "./_undefined-refs.mjs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const failures = [];
const checks = [];

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

function fail(guard, file, msg) {
  failures.push(`  [${guard}] ${relative(ROOT, file)}\n      ${msg}`);
}

// ---------------------------------------------------------------------------
// GUARD 1 — never retry a 403 from the SEC.
//
// The SEC blocks per IP and clears blocks only via a manual email naming a
// specific address. We run on shared GitHub runners, so we neither control nor
// can predict our IP. Retrying a 403 within a run is the exact pattern that
// escalates an incidental block into a range ban — harming unrelated users and
// making our own block permanent. A well-meaning "make it more robust" commit
// that adds a retry here is the single easiest way to break this project
// irreversibly, so it is checked rather than merely documented.
// ---------------------------------------------------------------------------
{
  const guard = "no-retry-on-403";
  const fetchFile = join(ROOT, "scripts/_sec-fetch.mjs");
  checks.push(guard);

  if (!existsSync(fetchFile)) {
    fail(guard, fetchFile, "scripts/_sec-fetch.mjs is missing — all SEC I/O must go through it.");
  } else {
    const src = readFileSync(fetchFile, "utf8");

    const retrySet = /RETRY_STATUSES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(src);
    if (retrySet && /\b403\b/.test(retrySet[1])) {
      fail(guard, fetchFile, "403 appears in RETRY_STATUSES. A 403 is an IP-level block and must be terminal.");
    }
    if (!/throw new SecBlockedError/.test(src)) {
      fail(guard, fetchFile, "no `throw new SecBlockedError` found — the 403 branch must throw, not fall through.");
    }
    // Catch the shape `if (... 403 ...) { ... continue }` anywhere in the file.
    const block = /if\s*\([^)]*\b403\b[^)]*\)\s*\{[^}]*\bcontinue\b/s.exec(src);
    if (block) {
      fail(guard, fetchFile, "a 403 branch reaches `continue` (i.e. retries). It must throw SecBlockedError.");
    }
  }

  // -------------------------------------------------------------------------
  // The liveness probe must stay cheap and static.
  //
  // It once probed `cgi-bin/browse-edgar` — a dynamic CGI script and the most
  // 503-prone path on sec.gov — which made the probe less reliable than the
  // work it guards. A 503 there killed a full universe ingest before it ran.
  // The probe answers one question ("is this IP blocked?"), so it must target a
  // static CDN file over HEAD, and only a 403 may stop a run.
  // -------------------------------------------------------------------------
  {
    const g = "preflight-probe-is-cheap";
    checks.push(g);
    if (existsSync(fetchFile)) {
      const src = readFileSync(fetchFile, "utf8");
      const probe = /probe:\s*\(\)\s*=>\s*["'`]([^"'`]+)["'`]/.exec(src);
      if (!probe) {
        fail(g, fetchFile, "SEC_URLS.probe is missing — the preflight target must be declared there.");
      } else if (/cgi-bin|\?/.test(probe[1])) {
        fail(g, fetchFile, `the preflight probes a dynamic endpoint (${probe[1]}). It must be a static file.`);
      }
      const pf = /async preflight\(\)\s*\{[\s\S]*?\n  \}/.exec(src);
      if (pf && !/method:\s*["']HEAD["']/.test(pf[0])) {
        fail(g, fetchFile, "the preflight must use HEAD so the probe transfers no body.");
      }
      if (pf && /throw err/.test(pf[0])) {
        fail(
          g,
          fetchFile,
          "the preflight rethrows a non-403. Only a 403 is a block; anything else is inconclusive and must let the run proceed.",
        );
      }
    }
  }

  // And nothing else may talk to sec.gov directly.
  for (const f of [...walk(join(ROOT, "scripts"), [".mjs"]), ...walk(join(ROOT, "functions"), [".js"])]) {
    if (f.endsWith("_sec-fetch.mjs") || f.endsWith("ci-guards.mjs")) continue;
    const src = readFileSync(f, "utf8");
    if (/fetch\(\s*[`'"]https?:\/\/[^`'"]*sec\.gov/.test(src)) {
      fail(
        "sec-egress-single-surface",
        f,
        "direct fetch() to sec.gov. All SEC traffic must go through SecFetcher so the rate limit and 403 policy are enforced in one place.",
      );
    }
  }
  checks.push("sec-egress-single-surface");
}

// ---------------------------------------------------------------------------
// GUARD 2 — CUSIP never leaves the data layer.
//
// CUSIP identifiers are proprietary (American Bankers Association, licensed via
// CUSIP Global Services / S&P Global Market Intelligence). They are a
// transient internal join key here: resolved to issuer_id and ticker at ingest,
// then dropped. The commitment is that they appear in no API response body, no
// CSV export, and no URL.
//
// Enforcing it structurally rather than by policy is what makes a leak
// impossible instead of merely discouraged — the export path reuses the same
// view-model as the tables, so if the view-model has no cusip field there is
// nothing to leak.
// ---------------------------------------------------------------------------
{
  const guard = "no-cusip-in-client";
  checks.push(guard);

  // The frontend must never see a CUSIP at all.
  //
  // Comments are exempt, and deliberately so: the reason CUSIP is absent is
  // non-obvious enough that it must be explained in the files where the
  // decision shows up. Stripping only `//` was not enough — it flagged the
  // continuation lines of the block comments doing that explaining.
  for (const f of walk(join(ROOT, "src"), [".ts", ".tsx"])) {
    const src = readFileSync(f, "utf8");
    const lines = src.split(/\r?\n/);
    let inBlock = false;
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      const opens = /\/\*/.test(line);
      const closes = /\*\//.test(line);
      const wasInBlock = inBlock;
      if (opens && !closes) inBlock = true;
      else if (closes) inBlock = false;

      if (wasInBlock || trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;

      const code = line.replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//g, "");
      if (/\bcusip\b/i.test(code)) {
        fail(guard, f, `line ${i + 1}: references CUSIP in client code. Use issuer_id / ticker instead.\n      ${line.trim()}`);
      }
    });
  }

  // Read endpoints must not serialize one. Capture endpoints and the internal
  // SQL helpers legitimately handle CUSIPs — they are the data layer.
  const INTERNAL = ["/capture/", "_sql-fold.js", "_chunk.js", "_serialize.js"];
  for (const f of walk(join(ROOT, "functions"), [".js"])) {
    if (INTERNAL.some((p) => f.includes(p))) continue;
    const src = readFileSync(f, "utf8");
    const lines = src.split(/\r?\n/);
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      // A CUSIP in a JSON key position or a SELECT list is a leak.
      if (/["'`]?\bcusip\b["'`]?\s*:/i.test(code) || /SELECT[^;]*\bcusip\b/i.test(code)) {
        fail(guard, f, `line ${i + 1}: read endpoint emits CUSIP.\n      ${line.trim()}`);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// GUARD 3 — the SEC User-Agent must never be hardcoded to a placeholder or to
// somebody else's contact address. A wrong contact email means the SEC cannot
// reach us before blocking, and an unrelated party gets the mail.
// ---------------------------------------------------------------------------
{
  const guard = "sec-user-agent";
  checks.push(guard);
  for (const f of walk(join(ROOT, "scripts"), [".mjs"])) {
    const src = readFileSync(f, "utf8");
    const m = /User-Agent["']?\s*[:=]\s*["']([^"']+)["']/.exec(src);
    if (m && !/process\.env/.test(m[0]) && /@/.test(m[1]) && !m[1].includes("muns.io")) {
      fail(guard, f, `hardcoded third-party contact in User-Agent: ${m[1]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// GUARD 4 — the duplicate-aggregation key must not gain `other_manager`.
//
// Rows sharing (cusip, put_call, ssh_prnamt_type) within one filing are
// ADDITIVE PORTIONS of one position, split by manager attribution. Measured:
// 18.8% of keys are affected universe-wide. Adding other_manager back to the
// grouping key turns Cantillon's 38 real holdings into 76 phantom ones and
// breaks the tableValueTotal reconciliation.
// ---------------------------------------------------------------------------
{
  const guard = "aggregation-key";
  checks.push(guard);
  const f = join(ROOT, "shared/fold.mjs");
  const parseFile = join(ROOT, "scripts/_sec-parse.mjs");
  if (existsSync(parseFile)) {
    const src = readFileSync(parseFile, "utf8");
    const keyLine = /const key = `\$\{r\.cusip\}\|\$\{putCall\}\|\$\{type\}`/.test(src);
    if (!keyLine) {
      fail(
        guard,
        parseFile,
        "the aggregateHoldings grouping key changed. It must be (cusip, put_call, ssh_prnamt_type) and must NOT include other_manager.",
      );
    }
    if (/const key =[^\n]*other_manager/.test(src)) {
      fail(guard, parseFile, "other_manager appears in the aggregation key — this creates phantom holdings.");
    }
  }
  void f;
}

// ---------------------------------------------------------------------------
// GUARD 5 — never declare Content-Encoding on the artifacts.
//
// The artifacts are PLAIN JSON. Cloudflare compresses on the wire by itself and
// strips its own header on the way out; declaring `Content-Encoding: gzip`
// ourselves makes the browser try to gunzip bytes that were never gzipped, and
// every fetch dies with "not valid JSON" and a � in the console.
//
// This has shipped twice. First as pre-gzipped files served with the header,
// which took the whole dashboard down. Then, still latent, as
// `aws s3 sync --content-encoding gzip` in the daily workflow — which never ran
// only because its `if:` guard was broken. In R2 it is worse than in Pages: the
// value persists as object metadata and the serving Function replays it, so one
// bad publish poisons ~35,000 objects until they are individually rewritten.
//
// Only the storage/publish surfaces are checked. Accept-Encoding on OUTBOUND
// requests to sec.gov is required and unrelated.
// ---------------------------------------------------------------------------
{
  const guard = "no-content-encoding-on-artifacts";
  checks.push(guard);
  const surfaces = [
    ...walk(join(ROOT, ".github/workflows"), [".yml", ".yaml"]),
    ...walk(join(ROOT, "functions"), [".js"]),
    join(ROOT, "scripts/publish-r2.mjs"),
    join(ROOT, "public/_headers"),
  ].filter((f) => existsSync(f));

  for (const f of surfaces) {
    readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/^\s*#.*$/, "").replace(/^\s*\/\/.*$/, "");
      if (/content[-_]encoding/i.test(code)) {
        fail(
          guard,
          f,
          `line ${i + 1}: declares Content-Encoding on the artifact path. The artifacts are plain JSON; Cloudflare handles compression.\n      ${line.trim()}`,
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// GUARD — the same-day job may never write a shared index.
//
// On 2026-07-31 it wrote manifest.json and meta/filers.json with its own
// twelve-fund versions and the live dashboard went from 9,396 funds to 8. It
// publishes again now, through scripts/publish-day.mjs, which enforces an
// allowlist at runtime. This is the compile-time half of the same rule: nothing
// may point the whole-tree publisher at that job, because that publisher also
// PRUNES, and pruning a watchlist build would delete the universe.
// ---------------------------------------------------------------------------
function guardSameDayPublish() {
  const guard = "same-day-publish-is-additive";
  checks.push(guard);
  const f = join(ROOT, ".github/workflows/ingest.yml");
  if (!existsSync(f)) return;
  const text = readFileSync(f, "utf8");

  text.split(/\r?\n/).forEach((line, i) => {
    const code = line.replace(/^\s*#.*$/, "");
    if (/publish-r2\.mjs/.test(code)) {
      fail(
        guard,
        f,
        `line ${i + 1}: the same-day job must not call publish-r2.mjs — it prunes, and this job only ever sees a subset of funds. Use publish-day.mjs.\n      ${line.trim()}`,
      );
    }
    if (/--prune/.test(code)) {
      fail(guard, f, `line ${i + 1}: --prune in the same-day job would delete every fund it did not ingest.\n      ${line.trim()}`);
    }
  });

  // The allowlist itself must stay an allowlist. A denylist would let the next
  // shared index in by omission, which is exactly how this happened.
  const mm = join(ROOT, "shared/manifest-merge.mjs");
  if (existsSync(mm)) {
    const src = readFileSync(mm, "utf8");
    if (!/return false;\s*\/\/ meta\/\*/.test(src) && !/isPublishableDayKey/.test(src)) {
      fail(guard, mm, "isPublishableDayKey is missing — the same-day publisher has no allowlist.");
    }
    // Shared indexes may not be permitted by a bare prefix test.
    //
    // This used to look only for `startsWith("meta/...")`, so widening the
    // allowlist with a regex instead walked straight past it — the guard passing
    // on a technicality is the exact failure its sibling below was written to
    // stop. The rule is now stated over the ALLOWLIST FUNCTION's body, whatever
    // shape the test takes.
    // Backslashes stripped so a regex literal reads the same as a string: the
    // allowlist writes `/^meta\/filers\.json$/`, and a plain includes() for
    // "meta/filers.json" walks right past it — which is how the previous version
    // of this guard was defeated by the very change it was meant to gate.
    const fn = (/export function isPublishableDayKey[\s\S]*?\n\}/.exec(src)?.[0] ?? src).replace(/\\/g, "");
    for (const shared of ["meta/series.json", "meta/periods.json"]) {
      if (fn.includes(shared)) {
        fail(guard, mm, `the allowlist permits ${shared}, which is a shared index with no merge behind it.`);
      }
    }
    // meta/filers.json IS permitted — it has to be, or a manager the same-day
    // path discovered is unsearchable — but ONLY while something merges it.
    // Same conditional rule as the period feed: check the condition rather than
    // trusting that whoever widened the allowlist also wrote the merge.
    if (fn.includes("meta/filers.json")) {
      if (!/export function mergeFilers\s*\(/.test(src)) {
        fail(guard, mm, "the allowlist permits meta/filers.json but there is no mergeFilers to rebuild it — the same-day job would overwrite the whole universe's search index with its own few hundred rows.");
      }
      const pub = join(ROOT, "scripts/publish-day.mjs");
      if (existsSync(pub) && !/mergeFilers\(/.test(readFileSync(pub, "utf8"))) {
        fail(guard, pub, "meta/filers.json is allowed but publish-day.mjs never calls mergeFilers — it would replace the shared search index.");
      }
    }

    // ----------------------------------------------------------------------
    // A SHARED KEY MAY ONLY BE ALLOWED IF SOMETHING MERGES IT.
    //
    // The period filings feed is shared — the universe run writes every
    // manager's rows into it — so permitting it is safe only while the
    // publisher rebuilds it from the published rows instead of overwriting.
    // This guard used to block period/ outright; that was correct when nothing
    // could merge it. Now the rule is conditional, so CHECK THE CONDITION
    // rather than trusting that whoever relaxed the allowlist also wrote the
    // merge. Otherwise the guard passes on a technicality and the site loses
    // ten thousand rows the next time someone widens a regex.
    // ----------------------------------------------------------------------
    const allowsPeriod = /period\\\//.test(src) && /return true/.test(src);
    if (allowsPeriod) {
      if (!/export function mergePeriodFilings\s*\(/.test(src)) {
        fail(guard, mm, "the allowlist permits a period/ key but there is no mergePeriodFilings to rebuild it.");
      }
      const pub = join(ROOT, "scripts/publish-day.mjs");
      if (existsSync(pub) && !/mergePeriodFilings\(/.test(readFileSync(pub, "utf8"))) {
        fail(
          guard,
          pub,
          "period/ is allowed but publish-day.mjs never calls mergePeriodFilings — it would overwrite the shared feed.",
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// GUARD 6 — R2 has exactly ONE writer.
//
// manifest.json and meta/filers.json are shared: they describe the whole
// universe, and whichever job writes them last wins. When the daily
// seed-watchlist ingest also published to R2, it overwrote both with its own
// twelve-fund versions and the live dashboard dropped from 9,396 funds to 8.
// Two writers to one bucket is not redundancy, it is a race.
//
// So: only ingest-universe.yml may write to R2, and only through
// scripts/publish-r2.mjs — which is signature-tested, resumable, refuses to run
// without a manifest, and publishes the manifest before it prunes. A raw
// `aws s3` call bypasses every one of those properties.
// ---------------------------------------------------------------------------
{
  const guard = "single-r2-writer";
  checks.push(guard);
  const AUTHORISED = "ingest-universe.yml";

  // The invariant is ONE WRITER AT A TIME, not one filename. A second workflow
  // may publish if it cannot race the first and cannot fire on its own:
  //
  //   - it shares the `13f-universe` concurrency group, so GitHub serialises
  //     the two rather than letting both upload at once, and
  //   - it has no `schedule:` trigger, so it runs only when a person asks.
  //
  // That is what repair-indexes.yml is: a hand-run job that DERIVES the shared
  // indexes from the complete published tree, which is the opposite of the
  // failure this guard was written for — a narrow run overwriting the indexes
  // with its own partial view.
  const isSerialisedManualWriter = (src) =>
    /^\s*group:\s*13f-universe\s*$/m.test(src) && !/^\s*schedule:\s*$/m.test(src);

  for (const f of walk(join(ROOT, ".github/workflows"), [".yml", ".yaml"])) {
    const src = readFileSync(f, "utf8");
    const lines = src.split(/\r?\n/);
    const authorised = f.endsWith(AUTHORISED) || isSerialisedManualWriter(src);
    lines.forEach((line, i) => {
      if (/^\s*#/.test(line)) return; // the explanation of what was removed
      if (/\baws\s+s3\b|\bs3:\/\//.test(line)) {
        fail(guard, f, `line ${i + 1}: raw aws s3 call. R2 is written only by scripts/publish-r2.mjs.\n      ${line.trim()}`);
      }
      if (!authorised && /publish-r2\.mjs/.test(line)) {
        fail(
          guard,
          f,
          `line ${i + 1}: publishes to R2, but only ${AUTHORISED} may — or a workflow that shares its ` +
            `\`concurrency.group: 13f-universe\` and has no \`schedule:\`, so it can neither race it nor fire on ` +
            `its own. Without that, a run holding a narrower view of the universe overwrites the shared indexes ` +
            `(manifest.json, meta/filers.json) with its own.\n      ${line.trim()}`,
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// GUARD 6 — discovery may not fall back to a hard-coded fund list.
//
// The same-day job used to answer "we could not ask the SEC who filed" with
// "then ingest these thirteen favourites". It sounds defensive. What it actually
// did was make a completely broken discovery indistinguishable from a working
// pipeline: every run for a whole quarter reported SUCCESS while publishing 13
// filers out of the ~10,700 who had filed for Q2 2026, and the first person to
// notice was a client asking why a manager who filed on 29 July was missing.
//
// The cure is not a better fallback, it is no fallback. The ingest cursor in R2
// means a run that cannot reach the SEC loses nothing by doing nothing, and the
// next run resumes from the same place. A run that publishes a token slice of
// the universe and calls itself green is strictly worse than one that stops.
// ---------------------------------------------------------------------------
{
  const guard = "no-watchlist-fallback";
  checks.push(guard);
  const f = join(ROOT, ".github/workflows/ingest.yml");
  if (existsSync(f)) {
    readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/^\s*#.*$/, "");
      if (/favourites\.(ts|js)/.test(code)) {
        fail(
          guard,
          f,
          `line ${i + 1}: the same-day job reads the favourites list. Discovery must not fall back to a fixed set of funds — that is what let a broken run report success for a whole quarter. If the SEC cannot be reached, do nothing and let the cursor resume.\n      ${line.trim()}`,
        );
      }
    });
  }

  // And the planner must keep a cursor, because "do nothing" is only safe when
  // nothing is forgotten by doing it.
  const d = join(ROOT, "scripts/discover-13f-filers.mjs");
  if (existsSync(d)) {
    const src = readFileSync(d, "utf8");
    if (!/out-state/.test(src) || !/pending/.test(src)) {
      fail(guard, d, "the planner no longer produces an ingest cursor. Without one a blocked or budgeted run silently drops the filers it did not reach.");
    }

    // ----------------------------------------------------------------------
    // PRIORITY IS NOT A FALLBACK, AND BOTH MUST STAY TRUE.
    //
    // The planner reads the client's watchlist to decide ORDER — those funds go
    // to the front of every run, because they are what the dashboard is about
    // and a client should never wait two days behind ten thousand strangers.
    // That is the opposite of the fallback this guard exists to forbid, which
    // substituted the watchlist for discovery and made a broken pipeline look
    // healthy.
    //
    // The distinction is that priority can only REORDER `pending`, never add to
    // it: a fund not in a daily index cannot be selected however favoured it is.
    // So the guard checks both halves — that the planner still prioritises, and
    // that it does so by filtering what discovery found rather than by seeding
    // the selection from the list.
    // ----------------------------------------------------------------------
    if (!/WATCHLIST_CIKS/.test(src)) {
      fail(guard, d, "the planner no longer reads the client watchlist, so their own funds are fetched in EDGAR's publication order like any other manager — during a season that is a two-day wait.");
    }
    // The property that keeps priority from becoming a fallback: the watchlist
    // is used to FILTER what discovery already found. If the selection is ever
    // seeded from the list itself, a run with no index data would still ingest
    // the favourites and report a healthy-looking success.
    const block = /THE CLIENT'S OWN FUNDS COME FIRST[\s\S]*?prioritised\.push/.exec(src)?.[0] ?? "";
    if (block && !/state\.days\[d\]\.pending/.test(block)) {
      fail(guard, d, "the watchlist selection no longer reads from the cursor's pending list. Priority may only reorder what a daily index actually produced — seeding from the list is the fallback this guard forbids.");
    }
  }
}

// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// GUARD — "I have no data for that" is not "that should be deleted".
//
// Two jobs write this bucket. The monthly one covers only quarters whose SEC
// bulk window exists, so during a filing season it knows NOTHING about the
// current quarter — while the same-day job has been publishing it for weeks.
// Three separate times that ignorance was written over the other job's
// knowledge:
//
//   fund summaries   every one rewritten without the current quarter, so the
//                    Fund page told a client a manager had not filed when they
//                    had
//   the manifest     the quarter vanished from the selector while its data sat
//                    in the bucket
//   prune            would have DELETED ~10,765 fund-quarters outright. It only
//                    did not because it was crashing on a const in its temporal
//                    dead zone, and the 50% safety rail sits well above the
//                    ~24% the current quarter represents
//
// Same mistake, three places, one of them destructive and masked by a crash.
// ---------------------------------------------------------------------------
{
  const guard = "publish-never-erases-what-it-cannot-see";
  checks.push(guard);
  const f = join(ROOT, "scripts/publish-r2.mjs");
  if (existsSync(f)) {
    const src = readFileSync(f, "utf8");
    if (!/mergeSummary\(/.test(src)) {
      fail(guard, f, "fund summaries written without mergeSummary — this run would delete quarters it has no window for.");
    }
    if (!/isPrunableKey\(/.test(src)) {
      fail(guard, f, "prune does not use isPrunableKey — it would delete every object belonging to a quarter this run did not build.");
    }
    if (!/carryForwardPeriods\(/.test(src)) {
      fail(guard, f, "the manifest is published without carryForwardPeriods — the current quarter would drop out of the quarter selector.");
    }
    // The bug that made prune inert for its whole existence: a `const` declared
    // BELOW the function that reads it. It fails at runtime inside a try/catch,
    // as a warning, which is how it went unnoticed.
    const declAt = src.indexOf("const PROTECTED_PREFIXES");
    const useAt = src.indexOf("await prune()");
    if (declAt !== -1 && useAt !== -1 && declAt > useAt) {
      fail(guard, f, "PROTECTED_PREFIXES is declared after prune() is called — it throws from its temporal dead zone on every run, exactly as it did before.");
    }
  }
}

/**
 * A step that did nothing must fail, not warn.
 *
 * prune threw on its first line — a const read from its temporal dead zone —
 * every run for its entire existence, and every one of those runs was GREEN,
 * because the throw was caught and logged as a warning. Nobody reads a warning
 * on a green run. It was found only on the day it would finally have worked, at
 * which point it would have deleted 10,765 fund-quarters.
 *
 * The rule that replaced it: finish the work, then fail. Publication must never
 * be blocked by cleanup (an early exit once left the site with no manifest at
 * all), but the run must end red with a list of what did not happen.
 *
 * This guard pins the shape. The verdict must be the LAST thing each publish
 * script does, so no later code can swallow it.
 */
function guardNothingFailsQuietly() {
  const guard = "a-step-that-did-nothing-must-fail";
  checks.push(guard);
  for (const rel of ["scripts/publish-r2.mjs", "scripts/publish-day.mjs"]) {
    const f = join(ROOT, rel);
    if (!existsSync(f)) continue;
    const src = readFileSync(f, "utf8");
    if (!/createRegister\(\)/.test(src)) {
      fail(guard, f, "no unfinished-work register — a step that silently did nothing would leave this run green.");
      continue;
    }
    if (!/process\.exit\(unfinished\.report\(/.test(src)) {
      fail(guard, f, "the register is never reported — recording a failure and then exiting 0 is the same green run as before.");
      continue;
    }
    // Nothing may do WORK after the verdict. A `slice(-4)` window was the first
    // attempt and it passed happily with two extra lines appended — the same
    // "looks checked, checks nothing" shape this whole guard exists to stop.
    // Closing an IIFE and attaching .catch is fine; logging or awaiting is not.
    const after = src.slice(src.indexOf("process.exit(unfinished.report(")).split("\n").slice(1);
    const working = after.find((l) => /\bawait\b|console\.log|unfinished\.note\(/.test(l));
    if (working) {
      fail(guard, f, `work happens after the verdict (${working.trim().slice(0, 60)}) — it can throw or return first, and the run ends green.`);
    }
  }
  // And the specific failure with a history: prune must register, not just log.
  const f = join(ROOT, "scripts/publish-r2.mjs");
  if (existsSync(f)) {
    const src = readFileSync(f, "utf8");
    // Match forward from the message by a bounded window rather than to the
    // next `}` — the catch body interpolates ${err.message}, whose brace ends a
    // naive [^}]* match before it ever reaches the register.
    const at = src.indexOf("prune failed");
    if (at !== -1 && !/unfinished\.note\(/.test(src.slice(at, at + 600))) {
      fail(guard, f, "prune failure is logged but not registered — this is the exact bug that hid for the life of the script.");
    }
  }
}

/**
 * No module may call a name that does not exist.
 *
 * prune() has now shipped broken TWICE on adjacent lines. The second time was
 * `XisPrunableKeyX(...)` — a mangled identifier that throws ReferenceError the
 * moment prune runs. It passed `node --check` (syntactically perfect), it passed
 * the regex guard above (which only asked whether the string "isPrunableKey("
 * appeared anywhere in the file, and it did, one line further down), and it was
 * committed and pushed.
 *
 * Both times the crash was invisible, because prune throws inside a try/catch
 * that logged a warning on an otherwise green run.
 *
 * Real scope analysis is the only thing that catches this class reliably. It is
 * exact: a name that resolves to nothing is not a matter of judgement.
 */
function guardNoUndefinedNames() {
  const guard = "no-call-to-a-name-that-does-not-exist";
  checks.push(guard);
  for (const dir of ["scripts", "shared", "tests"]) {
    const d = join(ROOT, dir);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".mjs")) continue;
      const f = join(d, name);
      let problems;
      try {
        problems = undefinedRefsInFile(f);
      } catch (err) {
        fail(guard, f, `could not be parsed (${err.message}) — a file this check cannot read is a file it cannot guard.`);
        continue;
      }
      for (const p of problems) {
        fail(guard, f, `line ${p.line}: \`${p.name}\` is used but never declared, imported, or passed in. It throws ReferenceError the moment this line runs.`);
      }
    }
  }
}

/**
 * R2 access goes through _r2.mjs. Nobody hand-rolls a second client.
 *
 * There were three copies of the same signed-request loop — publish-r2.mjs,
 * publish-day.mjs, and very nearly a fourth for the source archive. They were
 * character-for-character identical when written, which is exactly how this
 * project ended up with two ingest paths that fold amendments by different
 * rules, two artifact-row mappings, and two meanings for the same field name.
 *
 * One copy also means one place to fix. The backoff in those loops was linear
 * while the comment above it said exponential; correcting that in _r2.mjs
 * corrected it everywhere at once.
 */
function guardOneR2Client() {
  const guard = "one-r2-client";
  checks.push(guard);
  const ALLOWED = ["scripts/_r2.mjs", "scripts/_sigv4.mjs"];
  for (const dir of ["scripts", "shared"]) {
    const d = join(ROOT, dir);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".mjs")) continue;
      const rel = `${dir}/${name}`;
      if (ALLOWED.includes(rel)) continue;
      const src = readFileSync(join(d, name), "utf8");
      if (/from\s+["'][^"']*_sigv4\.mjs["']/.test(src)) {
        fail(guard, join(d, name), "imports the signer directly. R2 access goes through scripts/_r2.mjs, so there is one client to get right rather than three that drift.");
      }
    }
  }
}

guardOneR2Client();

guardNoUndefinedNames();

guardNothingFailsQuietly();

guardSameDayPublish();

if (failures.length) {
  console.error(`\nci-guards: ${failures.length} violation(s)\n`);
  console.error(failures.join("\n\n"));
  console.error("");
  process.exit(1);
}

console.log(`ci-guards: ok (${[...new Set(checks)].join(", ")})`);
