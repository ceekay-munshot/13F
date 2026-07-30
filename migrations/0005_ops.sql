-- 0005_ops.sql — pipeline state, resumability, quarantine, observability.

-- ---------------------------------------------------------------------------
-- ingest_cursors — THE mechanism that makes a third-party SEC 403 survivable.
--
-- We run on GitHub-hosted runners, which draw an arbitrary IP from a shared
-- pool of ~7,300 Azure CIDRs. The SEC blocks per-IP and clearing a block is a
-- manual email to webmaster@sec.gov for a specific address — a process that
-- assumes you control the IP. We don't.
--
-- The mitigation turns that into an advantage: because each run draws a
-- DIFFERENT random IP, a block caused by someone else's abuse is self-healing
-- on the next run — PROVIDED we never retry inside a run (retry-on-403 is
-- exactly what gets whole ranges blocked) and never lose our place. This table
-- is "never lose our place".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_cursors (
  job                TEXT PRIMARY KEY,       -- daily_index | dera | watchlist_sync | amendment_sweep | backfill
  last_completed_key TEXT,                   -- e.g. '2026-07-29' or 'CIK0001350694'
  last_success_at    TEXT,
  state_json         TEXT,
  updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- sec_access_log — 403 forensics and the poison detector.
--
-- A single 403 is expected weather: someone else's abuse landed us on a
-- blocked IP. N CONSECUTIVE 403s across different runs (hence different IPs)
-- is NOT weather — it means the block is following our behaviour, and that
-- fires the unmissable sec-403-manual-clearance alert and halts SEC traffic.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sec_access_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  job            TEXT NOT NULL,
  run_id         TEXT,
  status         INTEGER NOT NULL,           -- 403, 429, 503 ...
  url            TEXT NOT NULL,
  user_agent     TEXT,
  request_count  INTEGER,                    -- requests made before the block
  note           TEXT
);

CREATE INDEX IF NOT EXISTS idx_sal_recent ON sec_access_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sal_status ON sec_access_log(status, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- ingest_runs — one row per workflow invocation. Powers the Pipeline Health
-- widget and the "last run / next run" lines in the source trail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_runs (
  id                TEXT PRIMARY KEY,
  job               TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  status            TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | ok | failed | blocked | skipped
  sec_requests      INTEGER NOT NULL DEFAULT 0,
  filings_seen      INTEGER NOT NULL DEFAULT 0,
  filings_ingested  INTEGER NOT NULL DEFAULT 0,
  rows_written      INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  detail_json       TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_job ON ingest_runs(job, started_at DESC);

-- ---------------------------------------------------------------------------
-- quarantine — malformed or unverifiable filings.
--
-- A quarantined filing is STILL WRITTEN to holdings_raw. Evidence is never
-- discarded; parse_status simply keeps it out of the fold and marks the
-- period degraded. That way a parser fix is a re-derivation, not a re-download
-- — which matters when re-downloading costs SEC request budget.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quarantine (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  accession_number TEXT,
  cik             TEXT,
  period_end      TEXT,
  code            TEXT NOT NULL,
  -- Codes:
  --   value_total_mismatch      SUM(value) != tableValueTotal (parse defect)
  --   unit_undetermined         unit ladder inconclusive
  --   implied_price_implausible median implied price outside [0.10, 100000]
  --   infotable_not_found       no <TYPE>INFORMATION TABLE in index-headers
  --   xml_parse_error           malformed XML / unexpected namespace shape
  --   unknown_amendment_type    amendmentType neither RESTATEMENT nor NEW HOLDINGS
  --   amendment_type_missing    inferred RESTATEMENT (a judgement call)
  --   origin_missing            the earliest filing for a period is an amendment
  --   fold_tie                  duplicate acceptance_datetime to the second
  --   nt_only_period            notice-only period; deltas suppressed
  --   confidential_omitted      incomplete by design
  --   pre_xml_era               period < 2013-06-01, skipped
  --   duplicate_accession_conflict  same accession, differing metadata
  --   figi_unmapped             OpenFIGI returned {"warning":...} not data
  severity        TEXT NOT NULL DEFAULT 'error',   -- error | warn
  detail          TEXT,
  resolved_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_quar_open ON quarantine(severity, resolved_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quar_acc  ON quarantine(accession_number);

-- ---------------------------------------------------------------------------
-- rebuild_queue — amendment invalidation.
--
-- Amendments arrive arbitrarily late (Berkshire amended a 2023-09-30 period on
-- 2024-05-15; Jefferies amended 2021-Q1 in September 2023, ~29 months later),
-- so derived tables must be INVALIDATABLE rather than append-only.
--
-- Any new accession for (cik, period) enqueues that fund-quarter AND BOTH
-- ADJACENT QUARTERS' deltas — the prior quarter's "exits" and the next
-- quarter's "entries" are both computed against the restated set.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rebuild_queue (
  cik           TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  scope         TEXT NOT NULL,              -- fold | changes | metrics | overlap | spells
  shard         INTEGER,                    -- escape hatch: shard a huge fold 0..15
  reason        TEXT,
  enqueued_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  done_at       TEXT,
  PRIMARY KEY (cik, period_end, scope)
);

CREATE INDEX IF NOT EXISTS idx_rq_pending ON rebuild_queue(done_at, enqueued_at);

-- ---------------------------------------------------------------------------
-- kv_state — small singletons (SEC_BLOCKED flag, retention watermark, the
-- currently-open filing period, last successful DERA window).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kv_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
