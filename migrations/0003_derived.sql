-- 0003_derived.sql — precomputed aggregates.
--
-- The governing rule for the whole project: NO READ ENDPOINT PERFORMS AN
-- AGGREGATION WHOSE ROW COUNT SCALES WITH HOLDINGS. D1 bills rows scanned,
-- not rows returned. Every table here exists so a read is a keyed lookup.

-- ---------------------------------------------------------------------------
-- fund_period_metrics — one row per (cik, period). All-time, all filers.
--
-- Deliberately NOT subject to the 8-quarter holdings retention window: this is
-- what drives the "Reported 13F Value" bar chart back to 2013 and every KPI,
-- without ever touching a holdings row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fund_period_metrics (
  cik                 TEXT NOT NULL,
  period_end          TEXT NOT NULL,

  -- THREE denominators, always. Post-2023 filers are inconsistent about
  -- whether an option row's value is fair value or underlying notional, and
  -- large filers commonly report notional. Every weight, top-10 and sector
  -- figure defaults to value_long_usd and is labelled "% of long equity
  -- portfolio". A chart's denominator is never implicit.
  reported_total_usd  INTEGER,                -- cover-page total; reconciles with EDGAR
  value_long_usd      INTEGER,                -- put_call = '' only
  value_options_usd   INTEGER,
  value_prn_usd       INTEGER,                -- debt principal, held apart from shares

  positions_total     INTEGER,
  positions_long      INTEGER,
  positions_options   INTEGER,

  n_new               INTEGER,
  n_added             INTEGER,
  n_held              INTEGER,
  n_trimmed           INTEGER,
  n_exited            INTEGER,

  top10_weight_pct    REAL,
  -- BOTH turnover definitions, because they legitimately disagree and the
  -- reference site publishes both. The UI labels each and puts the formula in
  -- a tooltip; it never renders an unexplained "Turnover: 34%".
  turnover_position_pct REAL,                 -- (entries + exits) / (prior + current) * 2
  turnover_value_pct    REAL,                 -- |value traded| / avg portfolio value

  -- Prior-quarter resolution state. Resolved on the CALENDAR (period - 1
  -- quarter) then looked up — NEVER `ORDER BY period DESC LIMIT 1 OFFSET 1`,
  -- which silently skips gaps. Three of these four states mean NO deltas may
  -- be rendered at all.
  prior_state         TEXT NOT NULL,          -- PRIOR_OK | PRIOR_IS_NT | PRIOR_MISSING | NO_PRIOR
  prior_period        TEXT,
  prior_accession     TEXT,

  -- Structural-event detection (see lib/filingQuality). PRO_RATA_REDUCTION is
  -- the Cantillon case: 22 of 27 retained positions sharing a share-ratio of
  -- 0.0460 to four significant figures is one redemption, not 27 sells.
  structural_event    TEXT,                   -- NULL | PRO_RATA_REDUCTION | REVIEW | UNIT_SCALE_CHANGE
  structural_detail   TEXT,                   -- JSON: ratios, counts, the evidence
  deltas_suppressed   INTEGER NOT NULL DEFAULT 0,

  is_confidential_omitted INTEGER NOT NULL DEFAULT 0,
  filing_lag_days     INTEGER,                -- acceptance - period_end
  accession_count     INTEGER NOT NULL DEFAULT 1,  -- how many filings folded
  latest_acceptance   TEXT,                   -- drives "data as of"
  computed_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cik, period_end)
);

CREATE INDEX IF NOT EXISTS idx_fpm_period ON fund_period_metrics(period_end);
CREATE INDEX IF NOT EXISTS idx_fpm_value  ON fund_period_metrics(period_end, value_long_usd DESC);

-- ---------------------------------------------------------------------------
-- security_period_agg — per (period, issuer_id) ACROSS ALL FILERS.
--
-- ~10k issuers x 8 quarters = ~80k rows. Cheap, and it is the entire reason
-- the "All filers" scope can answer "most owned name" / "biggest aggregate
-- buy this quarter" instantly instead of scanning 3M holdings rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security_period_agg (
  period_end        TEXT NOT NULL,
  issuer_id         TEXT NOT NULL,
  primary_ticker    TEXT,
  issuer_name       TEXT NOT NULL,
  sector            TEXT,
  holder_count      INTEGER NOT NULL DEFAULT 0,
  holder_count_prior INTEGER,
  d_holder_count    INTEGER,
  total_value_usd   INTEGER NOT NULL DEFAULT 0,
  total_value_prior INTEGER,
  total_shares      INTEGER NOT NULL DEFAULT 0,
  total_shares_prior INTEGER,
  n_new_holders     INTEGER,
  n_exited_holders  INTEGER,
  PRIMARY KEY (period_end, issuer_id)
);

CREATE INDEX IF NOT EXISTS idx_spa_holders ON security_period_agg(period_end, holder_count DESC);
CREATE INDEX IF NOT EXISTS idx_spa_value   ON security_period_agg(period_end, total_value_usd DESC);
CREATE INDEX IF NOT EXISTS idx_spa_flow    ON security_period_agg(period_end, d_holder_count DESC);

-- ---------------------------------------------------------------------------
-- issuer_overlap — the Consensus Matrix's backing store, per watchlist.
--
-- Keyed on watchlist_hash so a user's arbitrary fund set is a keyed lookup
-- rather than a join across N funds at read time. Recomputed whenever a member
-- fund's (cik, period) is invalidated by a new accession.
--
-- Overlap is computed on issuer_id, NOT cusip. GOOG (02079K305) and GOOGL
-- (02079K107) are two CUSIPs of one issuer: computing on cusip means a fund
-- holding GOOG and a fund holding GOOGL show zero overlap on Alphabet.
-- Display remains at share-class level ("12 issuers / 14 share classes").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS issuer_overlap (
  watchlist_hash    TEXT NOT NULL,
  period_end        TEXT NOT NULL,
  issuer_id         TEXT NOT NULL,
  primary_ticker    TEXT,
  issuer_name       TEXT NOT NULL,
  fund_count        INTEGER NOT NULL,
  fund_ciks_json    TEXT NOT NULL,            -- JSON array, ordered as displayed
  cells_json        TEXT NOT NULL,            -- per-fund {cik, weight, action, value}
  combined_value_usd INTEGER NOT NULL,
  share_class_count INTEGER NOT NULL DEFAULT 1,
  -- Sum of +1 per add/new and -1 per trim/exit. The highest-signal sort in the
  -- product: it surfaces moves the whole group made in the same direction.
  net_direction     INTEGER NOT NULL DEFAULT 0,
  n_new             INTEGER NOT NULL DEFAULT 0,
  n_exited          INTEGER NOT NULL DEFAULT 0,
  computed_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (watchlist_hash, period_end, issuer_id)
);

CREATE INDEX IF NOT EXISTS idx_overlap_rank ON issuer_overlap(watchlist_hash, period_end, fund_count DESC, combined_value_usd DESC);
CREATE INDEX IF NOT EXISTS idx_overlap_net  ON issuer_overlap(watchlist_hash, period_end, net_direction);

-- ---------------------------------------------------------------------------
-- holding_spells — position tenure modelled as spells, not as a count.
--
-- "Average quarters held" is ambiguous when a position is exited and later
-- re-entered. A gap of >= 1 quarter CLOSES a spell; "currently held for N
-- quarters" reads the open spell only. Confounder worth a tooltip: a position
-- can vanish for one quarter because of confidential treatment rather than a
-- trade, which closes a spell that economically never ended.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holding_spells (
  cik            TEXT NOT NULL,
  issuer_id      TEXT NOT NULL,
  start_period   TEXT NOT NULL,
  end_period     TEXT,
  quarters       INTEGER NOT NULL DEFAULT 1,
  is_open        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (cik, issuer_id, start_period)
);

CREATE INDEX IF NOT EXISTS idx_spells_open ON holding_spells(cik, is_open);
