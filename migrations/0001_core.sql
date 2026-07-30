-- 0001_core.sql — Tier 1: all filers, all time. Filing metadata only, no holdings.
--
-- Sizing: ~9,300 13F filers per quarter x ~52 quarters back to 2013-06
--         ~= 480k rows total. Trivial for D1.
--
-- Conventions used by every migration in this directory:
--   * every statement is IF NOT EXISTS so the file is re-runnable
--   * all dates are TEXT in ISO form (YYYY-MM-DD / RFC3339 for timestamps)
--   * CIK is TEXT zero-padded to 10 chars — NEVER an integer. "0000320193"
--     becomes 320193 the moment it touches a numeric type.
--   * CUSIP is TEXT — leading zeros are significant ("002824100" = Abbott).

-- ---------------------------------------------------------------------------
-- filers — one row per CIK that has ever filed a 13F. Powers universe search.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS filers (
  cik                 TEXT PRIMARY KEY,          -- 10-padded
  name                TEXT NOT NULL,             -- EDGAR conformed name
  name_normalized     TEXT NOT NULL,             -- upper, punctuation-stripped, for search
  former_names_json   TEXT,                      -- JSON array of {name, from, to}
  state_of_incorp     TEXT,
  business_state      TEXT,
  -- form13FFileNumber (028-XXXXX) is a MORE STABLE manager identifier than
  -- either the name or the CIK, and it is what 13F-NT filings and cover-page
  -- otherManager blocks reference. Carry it.
  form_13f_file_number TEXT,
  first_seen_period   TEXT,                      -- earliest period_end observed
  last_seen_period    TEXT,                      -- latest period_end observed
  filing_count        INTEGER NOT NULL DEFAULT 0,
  -- Observed form-type behaviour, used by the role-drift watchdog. A filer
  -- that has only ever filed notices ('notice_only') suddenly filing an HR is
  -- an alert, not a silent behaviour change.
  observed_role       TEXT,                      -- primary_hr | notice_only | mixed | unknown
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_filers_name_norm  ON filers(name_normalized);
CREATE INDEX IF NOT EXISTS idx_filers_last_seen  ON filers(last_seen_period DESC);
CREATE INDEX IF NOT EXISTS idx_filers_file_num   ON filers(form_13f_file_number);

-- ---------------------------------------------------------------------------
-- filings — THE immutable spine of the whole system.
--
-- accession_number is the PRIMARY KEY. Holdings are NEVER keyed on
-- (cik, period): a quarter can have an original plus N amendments, amendments
-- arrive up to ~29 months late, and a RESTATEMENT that lands after a
-- NEW HOLDINGS must be able to wipe it. Keying on (cik, period) makes the
-- amendment fold impossible to express.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS filings (
  accession_number    TEXT PRIMARY KEY,          -- dashed form, e.g. 0001350694-26-000002
  cik                 TEXT NOT NULL,             -- SUBJECT cik (never parsed from the accession)
  form_type           TEXT NOT NULL,             -- 13F-HR | 13F-HR/A | 13F-NT | 13F-NT/A
  report_type         TEXT,                      -- 13F HOLDINGS REPORT | 13F NOTICE | 13F COMBINATION REPORT
  period_end          TEXT NOT NULL,             -- ISO, e.g. 2026-06-30
  filing_date         TEXT NOT NULL,             -- ISO
  -- acceptance_datetime is the ONLY correct ordering key for the amendment
  -- fold and the ONLY correct discriminator for the 2023-01-03 value-units
  -- cutover. filing_date is not granular enough: Cantillon filed three
  -- restatements for three different periods on one day.
  acceptance_datetime TEXT,                      -- RFC3339 UTC

  is_amendment        INTEGER NOT NULL DEFAULT 0,
  amendment_no        INTEGER,
  amendment_type      TEXT,                      -- RESTATEMENT | NEW HOLDINGS
  amendment_type_inferred INTEGER NOT NULL DEFAULT 0,
  conf_denied_expired INTEGER,                   -- nullable: the element is often absent

  -- Cover/summary page. A filing with is_confidential_omitted = 1 is
  -- INCOMPLETE BY DESIGN — the reported value is a floor, not the book, and
  -- exits cannot be distinguished from omissions.
  is_confidential_omitted INTEGER NOT NULL DEFAULT 0,
  table_entry_total   INTEGER,
  table_value_total_raw    INTEGER,              -- as filed
  table_value_total_usd    INTEGER,              -- normalized to dollars
  other_managers_count     INTEGER,
  other_managers_json      TEXT,                 -- cover-page otherManagers2Info

  -- Value-unit decision, kept auditable. Never normalize destructively: keep
  -- the raw value and store HOW we decided, so a future correction is a
  -- re-derivation rather than a re-download.
  value_units         TEXT,                      -- DOLLARS | THOUSANDS
  unit_source         TEXT,                      -- schema_x0202 | acceptance_date | implied_price | manual
  median_implied_price REAL,                     -- the evidence for the decision
  schema_version      TEXT,                      -- X0202 when present

  reconciles          INTEGER,                   -- SUM(value) == table_value_total
  parse_status        TEXT NOT NULL DEFAULT 'pending', -- pending | ok | quarantined | skipped
  row_count           INTEGER NOT NULL DEFAULT 0,
  r2_key              TEXT,                      -- raw infotable archived in R2
  source              TEXT NOT NULL,             -- daily_index | full_index | dera | submissions
  ingested_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The global "Latest 13F Filings" feed orders by acceptance/filing date. D1
-- bills rows SCANNED, not returned, so an unindexed ORDER BY over ~480k rows
-- would bill 480k reads on every page view.
CREATE INDEX IF NOT EXISTS idx_filings_feed        ON filings(filing_date DESC, form_type);
CREATE INDEX IF NOT EXISTS idx_filings_accepted    ON filings(acceptance_datetime DESC);
CREATE INDEX IF NOT EXISTS idx_filings_cik_period  ON filings(cik, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_filings_period_form ON filings(period_end, form_type);
CREATE INDEX IF NOT EXISTS idx_filings_fold        ON filings(cik, period_end, acceptance_datetime);
CREATE INDEX IF NOT EXISTS idx_filings_status      ON filings(parse_status) WHERE parse_status <> 'ok';

-- ---------------------------------------------------------------------------
-- filing_filers — one accession can be served under SEVERAL CIKs.
--
-- EDGAR exposes the same accession under /Archives/edgar/data/<CIK>/ for every
-- filer on the submission. Without this table, two funds in a watchlist that
-- co-file one 13F ingest the identical rows twice and cross-fund overlap reads
-- 100% while combined value doubles. Before any overlap render we assert that
-- no two funds in the comparison share an accession for the period.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS filing_filers (
  accession_number TEXT NOT NULL,
  cik              TEXT NOT NULL,
  role             TEXT,                          -- filer | other_included_manager
  PRIMARY KEY (accession_number, cik)
);

CREATE INDEX IF NOT EXISTS idx_filing_filers_cik ON filing_filers(cik);
