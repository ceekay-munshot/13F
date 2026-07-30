-- 0002_holdings.sql — Tier 2: all filers, rolling 8 quarters.
--
-- Sizing: ~3M holdings rows per quarter across the full universe x 8 quarters
--         ~= 24M rows ~= 4-5 GB with indexes.
--         REQUIRES Workers Paid (Free caps D1 at 500 MB).
-- Retention: a prune job drops periods older than the rolling window from
--            holdings_raw / holdings / holdings_changes. fund_period_metrics
--            (0003) keeps the all-time series, and R2 keeps the raw filings,
--            so nothing is truly lost.

-- ---------------------------------------------------------------------------
-- holdings_raw — as-filed rows, exactly as they appear in the information
-- table. IMMUTABLE: never updated, never deleted when an amendment lands.
-- Evidence is never discarded, not even for a quarantined filing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holdings_raw (
  accession_number  TEXT NOT NULL,
  row_seq           INTEGER NOT NULL,        -- position within the info table
  name_of_issuer    TEXT NOT NULL,
  title_of_class    TEXT,
  cusip             TEXT NOT NULL,           -- TEXT: leading zeros are significant
  figi              TEXT,                    -- optional, post-2023; ~12.6% populated
  value_raw         INTEGER NOT NULL,        -- as filed (thousands OR dollars)
  value_usd         INTEGER NOT NULL,        -- normalized at ingest
  ssh_prnamt        INTEGER,
  -- SH = shares. PRN = PRINCIPAL AMOUNT of a debt instrument (face value in
  -- dollars). Summing across both is meaningless; PRN must be excluded from
  -- every share aggregate and from the implied-price unit detector.
  ssh_prnamt_type   TEXT,                    -- SH | PRN
  -- ABSENT for ordinary long equity, 'Put'/'Call' otherwise. `put_call IS NULL`
  -- is the ONLY "shares held long" population. For a fund like Citadel ~47% of
  -- rows are options; treating them as longs invents positions that don't exist.
  put_call          TEXT,
  investment_discretion TEXT,                -- SOLE | DFND | OTR
  -- An INDEX STRING ("1", "1,2") into the cover page's otherManagers2Info —
  -- NOT a CIK. Deliberately excluded from the aggregation key in 0003.
  other_manager     TEXT,
  voting_sole       INTEGER,
  voting_shared     INTEGER,
  voting_none       INTEGER,
  PRIMARY KEY (accession_number, row_seq)
);

CREATE INDEX IF NOT EXISTS idx_hraw_accession ON holdings_raw(accession_number);
CREATE INDEX IF NOT EXISTS idx_hraw_cusip     ON holdings_raw(cusip);

-- ---------------------------------------------------------------------------
-- holdings — DERIVED. The output of the ordered amendment fold followed by
-- duplicate aggregation. This is what every read endpoint queries; nothing
-- reads holdings_raw directly.
--
-- Grouping key is (cusip, put_call, ssh_prnamt_type) and DELIBERATELY EXCLUDES
-- other_manager. 18.8% of (accession, cusip, put_call, type) keys appear more
-- than once, and those rows are ADDITIVE PORTIONS of one position, not
-- duplicate reports. Proof: Cantillon 2026-Q1 is 38 CUSIPs x 2 rows split by
-- other_manager; summing gives exactly the filing's tableValueTotal of
-- $15,050,978,966. Deduping instead of summing understates it by 38.8%.
-- Adding other_manager back to this key yields 76 phantom holdings.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holdings (
  cik               TEXT NOT NULL,
  period_end        TEXT NOT NULL,
  cusip             TEXT NOT NULL,
  put_call          TEXT NOT NULL DEFAULT '',   -- '' = long equity (NULL breaks PK equality)
  ssh_prnamt_type   TEXT NOT NULL DEFAULT 'SH',
  issuer_id         TEXT,                       -- resolved via securities; overlap is computed on THIS
  name_of_issuer    TEXT NOT NULL,
  title_of_class    TEXT,
  value_usd         INTEGER NOT NULL,
  ssh_prnamt        INTEGER NOT NULL DEFAULT 0,
  voting_sole       INTEGER NOT NULL DEFAULT 0,
  voting_shared     INTEGER NOT NULL DEFAULT 0,
  voting_none       INTEGER NOT NULL DEFAULT 0,
  row_count         INTEGER NOT NULL DEFAULT 1, -- how many raw rows were summed
  -- Weight is always computed against value_long (put_call = ''), never against
  -- a denominator that mixes option notional with equity. Stored so the UI
  -- never has to pick a denominator implicitly.
  weight_pct        REAL,
  implied_price     REAL,                       -- value_usd / ssh_prnamt, SH longs only
  -- Provenance: which filings folded into this row.
  source_accessions TEXT,                       -- JSON array
  PRIMARY KEY (cik, period_end, cusip, put_call, ssh_prnamt_type)
);

CREATE INDEX IF NOT EXISTS idx_holdings_fund_period ON holdings(cik, period_end);
CREATE INDEX IF NOT EXISTS idx_holdings_period_issuer ON holdings(period_end, issuer_id);
CREATE INDEX IF NOT EXISTS idx_holdings_period_cusip  ON holdings(period_end, cusip);
CREATE INDEX IF NOT EXISTS idx_holdings_value         ON holdings(cik, period_end, value_usd DESC);

-- ---------------------------------------------------------------------------
-- holdings_changes — precomputed quarter-on-quarter, one row per position.
--
-- Precomputed rather than derived at read time because D1 bills rows scanned
-- and a read endpoint must never run an aggregation whose row count scales
-- with holdings.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holdings_changes (
  cik               TEXT NOT NULL,
  period_end        TEXT NOT NULL,
  cusip             TEXT NOT NULL,
  put_call          TEXT NOT NULL DEFAULT '',
  issuer_id         TEXT,
  name_of_issuer    TEXT NOT NULL,
  action            TEXT NOT NULL,             -- NEW | ADDED | HELD | TRIMMED | EXITED
  shares_now        INTEGER,
  shares_prior      INTEGER,
  d_shares          INTEGER,
  d_shares_pct      REAL,                      -- NULL when suppressed (see flags)
  value_now         INTEGER,
  value_prior       INTEGER,
  d_value           INTEGER,
  d_value_pct       REAL,
  weight_now        REAL,
  weight_prior      REAL,
  -- ALWAYS percentage points, never percent. This is the single most-confused
  -- number in 13F UIs; the column name does the work the label can't.
  d_weight_pp       REAL,
  -- The provenance lock. Every comparison stat carries the identity of the
  -- filing it was compared against, in the SAME row as the value. This is what
  -- makes it structurally impossible to render a header stat and a row delta
  -- computed against different quarters.
  prior_period      TEXT,
  prior_accession   TEXT,
  -- Quality flags, JSON array: SUSPECTED_SPLIT, POSSIBLE_IDENTITY_CHANGE,
  -- PRO_RATA_REDUCTION, DELAYED_DISCLOSURE, UNIT_SCALE_CHANGE.
  -- When a flag suppresses a delta, the numeric column is NULL and the UI
  -- renders an em-dash with an explanation. A withheld number beats a wrong one.
  flags             TEXT,
  PRIMARY KEY (cik, period_end, cusip, put_call)
);

CREATE INDEX IF NOT EXISTS idx_changes_fund_period ON holdings_changes(cik, period_end);
CREATE INDEX IF NOT EXISTS idx_changes_action      ON holdings_changes(period_end, action);
CREATE INDEX IF NOT EXISTS idx_changes_weight      ON holdings_changes(cik, period_end, d_weight_pp);
