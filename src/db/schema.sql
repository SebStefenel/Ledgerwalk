-- Ledgerwalk storage. Phase 1 only: detected recurring charges.
-- Later phases add their own tables; this file is applied with `exec` on every
-- open and must stay idempotent.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS subscriptions (
  id              INTEGER PRIMARY KEY,
  merchant        TEXT    NOT NULL,           -- rawest human-readable form seen
  normalized_name TEXT    NOT NULL UNIQUE,    -- fuzzy grouping key
  cadence         TEXT    NOT NULL CHECK (cadence IN ('monthly', 'annual')),
  amount          REAL    NOT NULL,           -- representative (median) charge
  charge_count    INTEGER NOT NULL,
  first_seen      TEXT    NOT NULL,           -- ISO yyyy-mm-dd
  last_seen       TEXT    NOT NULL,           -- ISO yyyy-mm-dd
  annual_cost     REAL    NOT NULL,           -- inferred from cadence
  confirmed       INTEGER NOT NULL DEFAULT 0, -- set from the hand-edited JSON
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS charges (
  id              INTEGER PRIMARY KEY,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  charged_on      TEXT    NOT NULL,
  description     TEXT    NOT NULL,
  amount          REAL    NOT NULL,
  source_file     TEXT    NOT NULL,
  UNIQUE (subscription_id, charged_on, amount, description)
);

CREATE INDEX IF NOT EXISTS idx_charges_subscription ON charges (subscription_id);

-- Phase 2: one row per agent run over a service's billing page.
CREATE TABLE IF NOT EXISTS audits (
  id            INTEGER PRIMARY KEY,
  service       TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  fields_json   TEXT,                 -- extracted billing fields, JSON object
  reason        TEXT    NOT NULL,
  steps         INTEGER NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  trace_dir     TEXT    NOT NULL,
  started_at    TEXT    NOT NULL,
  finished_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audits_service ON audits (service, finished_at DESC);
