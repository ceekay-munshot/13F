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
const MAX_ATTEMPTS = 3;

export class SecFetcher {
  /**
   * @param {object} opts
   * @param {string} opts.userAgent  "<App Name> <contact email>" — plain and
   *   space-separated, quoted verbatim from the SEC Webmaster FAQ. NOT a
   *   browser UA. Requests without one get an "Undeclared Automated Tool" page.
   * @param {number} [opts.rps]
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ userAgent, rps = DEFAULT_RPS, log = () => {} } = {}) {
    if (!userAgent || !/\S+@\S+\.\S+/.test(userAgent)) {
      throw new Error(
        "SEC_USER_AGENT must be set and must contain a contact email, " +
          'e.g. "Munshot 13F Pipeline ceekay@muns.io". See .env.example.',
      );
    }
    this.userAgent = userAgent;
    this.minIntervalMs = Math.ceil(1000 / rps);
    this.log = log;
    this.requestCount = 0;
    this.blocked = false;
    this._nextSlot = 0;
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
   * @param {string} [opts.accept]
   * @param {'text'|'json'|'buffer'} [opts.as]
   * @param {string} [opts.etag]          previous ETag -> conditional request
   * @param {string} [opts.lastModified]  previous Last-Modified
   * @returns {Promise<{status:number, notModified:boolean, body:any, etag:string|null, lastModified:string|null}>}
   */
  async get(url, { accept, as = "text", etag, lastModified } = {}) {
    if (this.blocked) {
      throw new SecBlockedError(url, this.requestCount);
    }

    const conditional = {};
    if (etag) conditional["If-None-Match"] = etag;
    if (lastModified) conditional["If-Modified-Since"] = lastModified;
    if (accept) conditional.Accept = accept;

    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this._throttle();
      this.requestCount++;

      let res;
      try {
        res = await fetch(url, { headers: this._headers(conditional) });
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_ATTEMPTS) break;
        await sleep(attempt * 2000);
        continue;
      }

      // ---- 403: terminal. Do NOT add a retry branch here. ----
      // A retry would draw the same IP within the same run, look like the
      // abuse pattern the SEC blocks for, and risk escalating an incidental
      // block into a permanent range ban affecting other users.
      if (res.status === 403) {
        this.blocked = true;
        throw new SecBlockedError(url, this.requestCount);
      }

      if (res.status === 304) {
        return { status: 304, notModified: true, body: null, etag: etag ?? null, lastModified: lastModified ?? null };
      }

      if (res.ok) {
        const body =
          as === "buffer"
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

      if (RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
        const wait = attempt * 5000;
        this.log(`  ${res.status} on ${url}; retrying in ${wait}ms (${attempt}/${MAX_ATTEMPTS})`);
        await sleep(wait);
        lastErr = new SecFetchError(url, res.status, null);
        continue;
      }

      throw new SecFetchError(url, res.status, (await res.text()).slice(0, 500));
    }

    throw lastErr ?? new SecFetchError(url, 0, "exhausted attempts");
  }

  /**
   * Cheap probe run FIRST by every job. If our IP is blocked we find out after
   * one request instead of part-way through a batch, and we stop having spent
   * essentially nothing.
   */
  async preflight() {
    try {
      await this.get("https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=13F-HR&count=1&output=atom");
      return { ok: true };
    } catch (err) {
      if (err instanceof SecBlockedError) return { ok: false, blocked: true, error: err.message };
      throw err;
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
};
