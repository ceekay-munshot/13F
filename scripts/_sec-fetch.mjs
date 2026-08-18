#!/usr/bin/env node
// scripts/_sec-fetch.mjs
//
// THE ONLY MODULE IN THIS PROJECT THAT TALKS TO sec.gov.
// Everything else goes through SecFetcher. Keeping SEC egress behind one
// surface is what makes the 403 policy enforceable — and what would make a
// future move to a fixed-IP self-hosted runner a one-file change.
//
// ---------------------------------------------------------------------------
// WHY 403 IS NEVER RETRIED — read this before changing anything below.
// ---------------------------------------------------------------------------
// The SEC enforces fair access PER IP, and clearing a block is a manual email
// to webmaster@sec.gov naming a specific address. That process assumes you own
// the IP. We run on GitHub-hosted runners, which draw an arbitrary address from
// a shared pool of ~7,300 Azure CIDRs used by every GitHub user on the planet.
// So a 403 usually means "we landed on an address someone else got blocked",
// which is not something we can fix and not something we caused.
//
// The design turns that into the mitigation:
//
//   Because each run draws a DIFFERENT random IP, a third-party block is
//   SELF-HEALING on the next scheduled run — provided we never retry inside a
//   run, and never lose our place.
//
//   1. Preflight probe. One cheap request first. 403 -> stop immediately,
//      burn nothing, exit 0. `exit 0` is deliberate: this is expected weather,
//      not a failure, and paging a human for it would train them to ignore the
//      alert that actually matters.
//   2. Never retry a 403. Retrying is precisely the behaviour that gets whole
//      ranges blocked, which would harm unrelated parties AND make our own
//      block permanent. `npm run guard` greps this file for retry-on-403 and
//      fails CI — that is the single easiest way for a future contributor to
//      get us permanently blocked.
//   3. Resumable cursors (ingest_cursors in D1) so a blocked run resumes
//      exactly where it stopped. Nothing is re-fetched or skipped.
//   4. Three schedule slots per day, so a blocked run retries within ~2 hours
//      on a fresh IP.
//   5. Poison detector: N consecutive blocked runs across different IPs means
//      the block is following our BEHAVIOUR, not our luck. That fires
//      sec-403-manual-clearance and halts SEC traffic.
//
// And the reason all of this is survivable at all: we fetch BULK FILES, not
// per-filing crawls. Steady state is a few hundred SEC requests per quarter
// (one daily-index file per day, one DERA zip per quarter) rather than the
// ~25,000 a per-filing crawl of 9,300 filers would need.

import { setTimeout as sleep } from "node:timers/promises";

/** Thrown on 403. Callers must treat it as terminal for the whole run. */
export class SecBlockedError extends Error {
  constructor(url, requestCount) {
    super(
      `SEC returned 403 for ${url} after ${requestCount} request(s) this run. ` +
        `This is an IP-level block and is NOT retryable — see the header of ` +
        `scripts/_sec-fetch.mjs. Stopping cleanly so the next scheduled run ` +
        `can resume from the cursor on a different IP.`,
    );
    this.name = "SecBlockedError";
    this.url = url;
    this.requestCount = requestCount;
    this.status = 403;
  }
}

/**
 * Thrown when the SEC answers 403 for a path that simply DOES NOT EXIST, and a
 * corroborating probe proved this machine is otherwise being served normally.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CLASS HAD TO EXIST — the bug that cost a whole quarter of coverage.
 * ---------------------------------------------------------------------------
 * EDGAR does not return 404 for a missing file under /Archives/. It returns
 * **403 Forbidden**. Verified live on 2026-08-18:
 *
 *   daily-index/2026/QTR3/form.20260817.idx  (Monday, exists)     -> 200
 *   daily-index/2026/QTR3/form.20260818.idx  (today, not yet cut) -> 403
 *   daily-index/2026/QTR3/form.20260816.idx  (a Sunday, no file)  -> 403
 *   daily-index/2026/QTR3/form.20261231.idx  (the future)         -> 403
 *
 * Discovery asked for TODAY's daily index first, every run. Today's index is
 * never published until after the day ends, so the first request of every run
 * 403'd, the whole run was declared IP-blocked, and the same-day ingest fell
 * back to thirteen hard-coded funds — silently, reporting success. Four days
 * after the Q2-2026 deadline the dashboard held 13 of ~9,300 filers.
 *
 * "Never retry a 403" is still absolutely right, and is still enforced by
 * `npm run guard`. What was wrong was inferring "we are banned" from a status
 * the SEC also uses for "no such file". So the inference is now CORROBORATED
 * rather than assumed: on a 403 for a path a caller has declared may not exist,
 * one HEAD is sent to a DIFFERENT, known-good static file. That is not a retry
 * — the blocked URL is never requested again — it is evidence.
 *
 *   probe serves 200  -> this machine is fine; the file is missing.
 *   probe 403s/fails  -> we really are blocked. Terminal, as before.
 */
export class SecMissingError extends Error {
  constructor(url, requestCount) {
    super(
      `SEC returned 403 for ${url}, but a probe of a known-good static file was ` +
        `served normally, so this machine is NOT blocked — that path does not exist. ` +
        `(EDGAR answers 403, not 404, for a missing /Archives/ path.) ` +
        `Request ${requestCount} this run.`,
    );
    this.name = "SecMissingError";
    this.url = url;
    this.requestCount = requestCount;
    this.status = 403;
    this.missing = true;
  }
}

/** Thrown when the SEC declines for a reason that is ours to fix. */
export class SecFetchError extends Error {
  constructor(url, status, body) {
    super(`SEC request failed ${status} for ${url}`);
    this.name = "SecFetchError";
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_RPS = 5; // stated ceiling is 10 across ALL sec.gov hosts; leave headroom
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 2000; // 2s, 6s, 18s — see _backoff()

/**
 * How many requests a "we are being served normally" verdict stays good for.
 *
 * The corroborating probe costs a request, so it is not re-sent for every
 * missing file in a batch. It is also not cached for the whole run: a block can
 * begin part-way through, and a stale verdict would keep a genuinely blocked run
 * crawling. Twenty-five requests is a few seconds at the rates used here.
 */
const REACHABILITY_TTL_REQUESTS = 25;

export class SecFetcher {
  /**
   * @param {object} opts
   * @param {string} opts.userAgent  "<App Name> <contact email>" — plain and
   *   space-separated, quoted verbatim from the SEC Webmaster FAQ. NOT a
   *   browser UA. Requests without one get an "Undeclared Automated Tool" page.
   * @param {number} [opts.rps]
   * @param {number} [opts.maxAttempts]
   * @param {number} [opts.retryBaseMs]  exposed so tests can drive the retry
   *   ladder without sleeping through it.
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({
    userAgent,
    rps = DEFAULT_RPS,
    maxAttempts = MAX_ATTEMPTS,
    retryBaseMs = RETRY_BASE_MS,
    log = () => {},
  } = {}) {
    if (!userAgent || !/\S+@\S+\.\S+/.test(userAgent)) {
      throw new Error(
        "SEC_USER_AGENT must be set and must contain a contact email, " +
          'e.g. "Munshot 13F Pipeline ceekay@muns.io". See .env.example.',
      );
    }
    this.userAgent = userAgent;
    this.minIntervalMs = Math.ceil(1000 / rps);
    this.maxAttempts = maxAttempts;
    this.retryBaseMs = retryBaseMs;
    this.log = log;
    this.requestCount = 0;
    this.blocked = false;
    this._nextSlot = 0;
    // When we last proved this machine is being served, measured in requests.
    this._reachableAt = -Infinity;
    this._reachable = false;
    /** Paths that 403'd but were proved missing rather than blocked. */
    this.missingCount = 0;
  }

  /**
   * Exponential backoff with jitter: ~2s, ~6s, ~18s.
   *
   * Linear 5s/10s was too shallow for the sec.gov edge under load — a burst of
   * 503s inside 15 seconds killed a whole pipeline run. Tripling gives the far
   * side ~26s to recover across three retries, which is short enough to stay
   * inside a job timeout and long enough to outlast the transient.
   */
  _backoff(attempt) {
    return Math.round(this.retryBaseMs * 3 ** (attempt - 1) * (0.85 + Math.random() * 0.3));
  }

  /** Single-flight token bucket with jitter. Serializes ALL SEC traffic. */
  async _throttle() {
    const now = Date.now();
    const jitter = Math.floor(this.minIntervalMs * 0.25 * Math.random());
    const slot = Math.max(now, this._nextSlot);
    this._nextSlot = slot + this.minIntervalMs + jitter;
    if (slot > now) await sleep(slot - now);
  }

  _headers(extra = {}) {
    return {
      "User-Agent": this.userAgent,
      // Required by the SEC and materially cheaper: master.idx is ~53 MB raw
      // versus ~4 MB gzipped. Node decompresses transparently.
      "Accept-Encoding": "gzip, deflate",
      ...extra,
    };
  }

  /**
   * @param {string} url
   * @param {object} [opts]
   * @param {'GET'|'HEAD'} [opts.method]  HEAD is for liveness probes: it answers
   *   "will this IP be served?" without transferring a body.
   * @param {string} [opts.accept]
   * @param {'text'|'json'|'buffer'} [opts.as]
   * @param {string} [opts.etag]          previous ETag -> conditional request
   * @param {string} [opts.lastModified]  previous Last-Modified
   * @param {boolean} [opts.mayNotExist]  the caller knows this path can legitimately
   *   be absent. EDGAR answers 403 rather than 404 for a missing /Archives/ path,
   *   so a 403 here is corroborated against a known-good file before it is
   *   allowed to declare the run blocked. Throws SecMissingError when the probe
   *   proves we are being served. See the SecMissingError header.
   * @returns {Promise<{status:number, notModified:boolean, body:any, etag:string|null, lastModified:string|null}>}
   */
  async get(url, { method = "GET", accept, as = "text", etag, lastModified, mayNotExist = false } = {}) {
    if (this.blocked) {
      throw new SecBlockedError(url, this.requestCount);
    }

    const conditional = {};
    if (etag) conditional["If-None-Match"] = etag;
    if (lastModified) conditional["If-Modified-Since"] = lastModified;
    if (accept) conditional.Accept = accept;

    let lastErr;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this._throttle();
      this.requestCount++;

      let res;
      try {
        res = await fetch(url, { method, headers: this._headers(conditional) });
      } catch (err) {
        lastErr = err;
        if (attempt === this.maxAttempts) break;
        await sleep(this._backoff(attempt));
        continue;
      }

      // ---- 403: terminal. Do NOT add a retry branch here. ----
      // A retry would draw the same IP within the same run, look like the
      // abuse pattern the SEC blocks for, and risk escalating an incidental
      // block into a permanent range ban affecting other users.
      //
      // The ONE thing that happens before the verdict is a corroborating probe
      // of a DIFFERENT, known-good static file, and only when the caller has
      // declared this path may legitimately be absent. `url` is never requested
      // again either way, so this is not a retry — it is the difference between
      // "we are banned" and "EDGAR has no such file", which it reports with the
      // same status code. Getting that inference wrong cost a whole quarter of
      // coverage once; see the SecMissingError header.
      if (res.status === 403) {
        if (mayNotExist) {
          const served = await this._servedNormally();
          if (served) {
            this.missingCount++;
            throw new SecMissingError(url, this.requestCount);
          }
        }
        this.blocked = true;
        throw new SecBlockedError(url, this.requestCount);
      }

      if (res.status === 304) {
        return { status: 304, notModified: true, body: null, etag: etag ?? null, lastModified: lastModified ?? null };
      }

      if (res.ok) {
        const body =
          method === "HEAD"
            ? null
            : as === "buffer"
              ? Buffer.from(await res.arrayBuffer())
              : as === "json"
                ? await res.json()
                : await res.text();
        return {
          status: res.status,
          notModified: false,
          body,
          etag: res.headers.get("etag"),
          lastModified: res.headers.get("last-modified"),
        };
      }

      if (RETRY_STATUSES.has(res.status) && attempt < this.maxAttempts) {
        const wait = this._backoff(attempt);
        this.log(`  ${res.status} on ${url}; retrying in ${wait}ms (${attempt}/${this.maxAttempts})`);
        await sleep(wait);
        lastErr = new SecFetchError(url, res.status, null);
        continue;
      }

      throw new SecFetchError(url, res.status, (await res.text()).slice(0, 500));
    }

    throw lastErr ?? new SecFetchError(url, 0, "exhausted attempts");
  }

  /**
   * "Is this machine being served at all right now?" — the evidence behind
   * SecMissingError.
   *
   * Sends one HEAD to the same static file the preflight uses. Deliberately a
   * DIFFERENT url from the one that just 403'd, so nothing is re-requested and
   * the no-retry-on-403 rule is untouched.
   *
   * FAIL SAFE. Anything other than a clean non-403 response means we cannot
   * prove we are being served, and the original 403 keeps its default reading:
   * blocked, terminal, stop. An unprovable case must never be downgraded to
   * "the file is just missing" — that is how a real block would turn into a run
   * that quietly discovers nothing.
   */
  async _servedNormally() {
    if (this.requestCount - this._reachableAt < REACHABILITY_TTL_REQUESTS) {
      return this._reachable;
    }
    await this._throttle();
    this.requestCount++;
    let ok = false;
    try {
      const res = await fetch(SEC_URLS.probe(), { method: "HEAD", headers: this._headers() });
      ok = res.status !== 403 && res.status < 500;
    } catch {
      ok = false; // network trouble proves nothing; keep the strict reading
    }
    this._reachableAt = this.requestCount;
    this._reachable = ok;
    return ok;
  }

  /**
   * Cheap probe run FIRST by every job. If our IP is blocked we find out after
   * one request instead of part-way through a batch, and we stop having spent
   * essentially nothing.
   *
   * ---------------------------------------------------------------------------
   * THE PROBE ASKS EXACTLY ONE QUESTION: "IS THIS IP BLOCKED?"
   * ---------------------------------------------------------------------------
   * Two properties follow from that, and both were learned the hard way when a
   * probe failure took down a run that had nothing wrong with it.
   *
   * 1. It targets a STATIC file over HEAD, not `cgi-bin/browse-edgar`.
   *    browse-edgar is a dynamic CGI script — the slowest, busiest, most
   *    frequently 503-ing path on sec.gov. Probing liveness through the least
   *    reliable endpoint available means the probe fails more often than the
   *    thing it is protecting. A HEAD against a CDN-served static file
   *    transfers zero bytes and answers the same question.
   *
   * 2. A non-403 failure is INCONCLUSIVE, not fatal. A 503 says the SEC is
   *    busy; it says nothing about whether we are blocked. Treating it as fatal
   *    converts someone else's load spike into our outage — which is precisely
   *    the class of failure this whole module exists to avoid. So we log it and
   *    proceed: the real fetches carry their own retries and will fail on their
   *    own merits if the SEC is genuinely unreachable.
   *
   * Only a 403 is decisive, and only a 403 stops the run.
   */
  async preflight() {
    try {
      await this.get(SEC_URLS.probe(), { method: "HEAD" });
      return { ok: true };
    } catch (err) {
      if (err instanceof SecBlockedError) return { ok: false, blocked: true, error: err.message };
      this.log(
        `  preflight probe inconclusive (${err.message}) — not a 403, so not a block. Proceeding.`,
      );
      return { ok: true, degraded: true, error: err.message };
    }
  }
}

/**
 * Wrap a job's main() so a third-party block exits 0 with a clear log while a
 * real failure still exits 1. Callers pass a reporter that records the block in
 * sec_access_log for the poison detector.
 *
 * @param {() => Promise<void>} fn
 * @param {(err: SecBlockedError) => Promise<void>} [onBlocked]
 */
export async function runJob(fn, onBlocked) {
  try {
    await fn();
    process.exit(0);
  } catch (err) {
    if (err instanceof SecBlockedError) {
      console.error(`BLOCKED: ${err.message}`);
      if (onBlocked) {
        try {
          await onBlocked(err);
        } catch (reportErr) {
          console.error(`  (could not record the block: ${reportErr.message})`);
        }
      }
      // Exit 0 on purpose. A blocked run is expected weather on shared
      // runners; the next slot picks up from the cursor on a different IP.
      // The poison detector escalates only when consecutive runs are blocked.
      process.exit(0);
    }
    console.error(`FAILED: ${err.stack || err.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// URL builders. Centralised so no caller hand-assembles an EDGAR path.
// ---------------------------------------------------------------------------

/** CIK zero-padded to exactly 10 characters. Unpadded works inconsistently. */
export function padCik(cik) {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

/** CIK with leading zeros stripped — what the /Archives/ path actually uses. */
export function bareCik(cik) {
  return String(Number(String(cik).replace(/\D/g, "")));
}

export const SEC_URLS = {
  submissions: (cik) => `https://data.sec.gov/submissions/CIK${padCik(cik)}.json`,
  submissionsShard: (name) => `https://data.sec.gov/submissions/${name}`,

  /** Near-real-time feed; `type` is a PREFIX match so this includes 13F-HR/A. */
  currentFeed: (type = "13F-HR", count = 100) =>
    `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${type}` +
    `&company=&dateb=&owner=include&count=${count}&output=atom`,

  /** One file per day covering EVERY filer — the whole global feed, 1 request. */
  dailyIndex: (yyyy, qtr, yyyymmdd) =>
    `https://www.sec.gov/Archives/edgar/daily-index/${yyyy}/QTR${qtr}/form.${yyyymmdd}.idx`,

  /**
   * WHICH DAILY INDEXES ACTUALLY EXIST — ask, never guess.
   *
   * One request returns every file in the quarter's daily-index folder with its
   * name and last-modified time. Guessing dates instead is what broke discovery
   * for a whole quarter: EDGAR answers 403 (not 404) for a day it has not cut an
   * index for, weekends and today included, and that 403 read as an IP ban.
   *
   * Read the folder, fetch what it lists, and a 403 on a daily index means what
   * the policy says it means again.
   */
  dailyIndexDir: (yyyy, qtr) =>
    `https://www.sec.gov/Archives/edgar/daily-index/${yyyy}/QTR${qtr}/index.json`,

  /** Pipe-delimited and safe to split; form.idx is fixed-width and breaks on
   *  company names containing spaces. Both contain DUPLICATE ROWS — dedupe on
   *  accession. */
  fullIndexMaster: (yyyy, qtr) =>
    `https://www.sec.gov/Archives/edgar/full-index/${yyyy}/QTR${qtr}/master.idx`,

  filingDir: (cik, accession) =>
    `https://www.sec.gov/Archives/edgar/data/${bareCik(cik)}/${accession.replace(/-/g, "")}`,

  /** Directory listing. NOTE: `{accession}-index.json` does NOT exist (404) —
   *  the listing is plain `index.json` inside the folder. */
  filingIndexJson: (cik, accession) =>
    `${SEC_URLS.filingDir(cik, accession)}/index.json`,

  /** The SGML header. This is the AUTHORITATIVE way to find the information
   *  table: its filename is filer-agent dependent (infotable.xml for
   *  Bridgewater and Citadel, but 53405.xml for Berkshire), so a
   *  *informationtable*.xml glob matches none of them. Parse the <DOCUMENT>
   *  blocks and take the <FILENAME> next to <TYPE>INFORMATION TABLE. */
  indexHeaders: (cik, accession) =>
    `${SEC_URLS.filingDir(cik, accession)}/${accession}-index-headers.html`,

  primaryDoc: (cik, accession) =>
    `${SEC_URLS.filingDir(cik, accession)}/primary_doc.xml`,

  doc: (cik, accession, filename) =>
    `${SEC_URLS.filingDir(cik, accession)}/${filename}`,

  /** Human-readable filing page — what the source trail links to. */
  filingIndexHtml: (cik, accession) =>
    `${SEC_URLS.filingDir(cik, accession)}/${accession}-index.htm`,

  companyTickers: () => "https://www.sec.gov/files/company_tickers.json",
  companyTickersExchange: () => "https://www.sec.gov/files/company_tickers_exchange.json",

  /**
   * Liveness probe target. MUST be a static, CDN-served file — see the comment
   * on SecFetcher.preflight(). Probed with HEAD, so its size is irrelevant and
   * nothing is transferred.
   */
  probe: () => "https://www.sec.gov/files/company_tickers.json",
};
