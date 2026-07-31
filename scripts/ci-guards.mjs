#!/usr/bin/env node
// scripts/ci-guards.mjs
//
// Structural guards for the two rules that are easy to break by accident, cost
// nothing to check, and are expensive to discover in production.
//
// Run by `npm run guard`, which `npm run check` and CI both call.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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

if (failures.length) {
  console.error(`\nci-guards: ${failures.length} violation(s)\n`);
  console.error(failures.join("\n\n"));
  console.error("");
  process.exit(1);
}

console.log(`ci-guards: ok (${[...new Set(checks)].join(", ")})`);
