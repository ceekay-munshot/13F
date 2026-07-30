-- 0004_securities.sql — the identity layer.
--
-- Two jobs: (1) resolve CUSIP -> issuer so overlap is computed on the right
-- key, and (2) confine CUSIP to exactly one table so it can never leak.

-- ---------------------------------------------------------------------------
-- securities — CUSIP is confined HERE and nowhere else.
--
-- CUSIP identifiers are proprietary: owned by the American Bankers Association,
-- licensed exclusively through CUSIP Global Services (operated by S&P Global
-- Market Intelligence). The SEC's own inability to publish the quarterly 13(f)
-- list as anything but a PDF — "By arrangement with S&P Global Market
-- Intelligence ... the SEC can only publish the quarterly 13(f) list in PDF
-- format" — is direct evidence of how tightly this is enforced.
--
-- Posture: CUSIP is a TRANSIENT INTERNAL JOIN KEY. It is stripped from every
-- API response body, every CSV export, and every URL. Because exports reuse
-- the same view-model as the tables, a leak is structurally impossible rather
-- than policy-dependent. FIGI is explicitly open (MIT, an OMG standard) and
-- carries no such restriction — which is exactly why the SEC added the
-- optional <figi> element to Form 13F in 2023.
--
-- NOT LEGAL ADVICE. The redistribution question goes to counsel before any
-- public launch.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS securities (
  cusip           TEXT PRIMARY KEY,          -- TEXT: 002824100 != 2824100
  -- The 6-char CUSIP issuer prefix is a good CANDIDATE GENERATOR for issuer_id
  -- (02079K covers both Alphabet share classes) but it is a heuristic, not a
  -- rule — it fails for some structures. Curated corrections live in
  -- issuer_overrides and win.
  issuer_id       TEXT NOT NULL,
  ticker          TEXT,
  issuer_name     TEXT NOT NULL,
  title_of_class  TEXT,
  figi            TEXT,
  composite_figi  TEXT,
  exch_code       TEXT,
  security_type   TEXT,
  sector          TEXT,                      -- SIC-division derived; labelled honestly in the UI
  sic_code        TEXT,
  issuer_cik      TEXT,
  resolve_status  TEXT NOT NULL DEFAULT 'pending', -- pending | resolved | unmapped
  resolve_source  TEXT,                      -- inband_figi | sec_fails | openfigi | manual
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_sec_issuer  ON securities(issuer_id);
CREATE INDEX IF NOT EXISTS idx_sec_ticker  ON securities(ticker);
CREATE INDEX IF NOT EXISTS idx_sec_pending ON securities(resolve_status) WHERE resolve_status <> 'resolved';

-- Curated overrides for cases where the 6-char prefix heuristic is wrong.
CREATE TABLE IF NOT EXISTS issuer_overrides (
  cusip        TEXT PRIMARY KEY,
  issuer_id    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  added_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- cusip_alias — issuer identity across a CUSIP change.
--
-- On M&A or reincorporation an issuer's CUSIP changes with NO in-band signal.
-- Naively this renders as a full exit plus a full new entry on the same
-- economic position — the nastiest silent error in the product, because both
-- halves look individually plausible.
--
-- Detector: an exit and an entry in the same fund-quarter whose values are
-- within 10% and share counts within 20% -> POSSIBLE_IDENTITY_CHANGE, routed
-- here for review rather than auto-merged. Seed candidates from the SEC's
-- Official List of Section 13(f) Securities, which publishes quarterly
-- (A)dditions and (D)eletions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cusip_alias (
  old_cusip     TEXT PRIMARY KEY,
  canonical_issuer_id TEXT NOT NULL,
  effective_period TEXT,
  reason        TEXT,
  confirmed     INTEGER NOT NULL DEFAULT 0,
  added_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- corporate_actions — split adjustment.
--
-- A 4:1 split renders as "+300% added" unless prior shares are adjusted. With
-- no split feed, the fallback detector is: shares_ratio ~= a simple integer or
-- fraction (within 1%) WHILE value_ratio ~= 1.0 +/- 15% -> SUSPECTED_SPLIT,
-- and the delta is SUPPRESSED rather than shown. A withheld number beats a
-- wrong one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS corporate_actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  issuer_id     TEXT NOT NULL,
  cusip         TEXT,
  action_type   TEXT NOT NULL,             -- SPLIT | REVERSE_SPLIT | TICKER_CHANGE
  ex_date       TEXT NOT NULL,
  ratio         REAL,
  source        TEXT NOT NULL,             -- detected | manual
  confirmed     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ca_issuer ON corporate_actions(issuer_id, ex_date);

-- ---------------------------------------------------------------------------
-- watchlists — user-selected fund sets, the "5-10 funds" of the original brief
-- expressed as a first-class object inside the full universe.
--
-- watchlist_hash is a stable digest of the sorted member CIK list. It is the
-- partition key for issuer_overlap, so changing membership produces a new hash
-- and cleanly invalidates the old precomputed rows rather than mutating them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS watchlists (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  owner_key      TEXT,                      -- Munshot org/user; NULL = shared preset
  watchlist_hash TEXT NOT NULL,
  is_preset      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_watchlists_owner ON watchlists(owner_key);
CREATE INDEX IF NOT EXISTS idx_watchlists_hash  ON watchlists(watchlist_hash);

-- A fund maps to an ARRAY of CIKs, not one. Verified live: "Cantillon" returns
-- two CIKs — 0001279936 (Capital Management LLC, New York, files 13F-HR) and
-- 0001352269 (Capital Management LLP, London, files 13F-NT every quarter).
-- Track the LLP and you get zero holdings, forever, with no error. Same shape
-- for Point72 (8+ CIKs), Elliott (5+), Duquesne (2, one defunct since 2010).
--
-- `role` is asserted quarterly against observed form types. A notice_only CIK
-- that starts filing HR, or a primary_hr that starts filing NT, is an ALERT.
CREATE TABLE IF NOT EXISTS watchlist_members (
  watchlist_id  TEXT NOT NULL,
  cik           TEXT NOT NULL,
  display_name  TEXT,
  short_code    TEXT,                       -- 3-char matrix column header
  role          TEXT NOT NULL DEFAULT 'primary_hr', -- primary_hr | notice_only | historical
  justification TEXT,                       -- why THIS cik; required at freeze time
  coverage_start TEXT,
  removed_at    TEXT,                       -- soft delete
  sort_order    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (watchlist_id, cik)
);

CREATE INDEX IF NOT EXISTS idx_wlm_cik ON watchlist_members(cik);
