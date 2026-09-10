-- D1 durable control-plane schema.
--
-- D1 is the single source of business truth: no runner-local file, no Fly volume,
-- no process PID and no HTTP response is authoritative. A business occurrence
-- (`slot_occurrences`) is separate from the concrete execution attempts that try
-- to fulfil it (`executions`), so a failed/timed-out runner never overwrites the
-- state of the occurrence it was working on.

CREATE TABLE IF NOT EXISTS slot_occurrences (
  -- Canonical business identity: "<schedule_id>@<local YYYY-MM-DDTHHMM>".
  -- Derived ONLY from the schedule's cron + timezone, never from "now" or from
  -- when a runner happened to start.
  id                   TEXT    PRIMARY KEY,
  schedule_id          TEXT    NOT NULL,
  bot_id               TEXT    NOT NULL,
  occurrence_at        INTEGER NOT NULL, -- epoch ms of the canonical instant
  occurrence_date      TEXT    NOT NULL, -- schedule-local date (YYYY-MM-DD)
  occurrence_label     TEXT    NOT NULL, -- schedule-local time (HH:MM)
  timezone             TEXT    NOT NULL,
  status               TEXT    NOT NULL, -- pending|dispatched|running|success|partial|failed|cancelled|expired|uncertain
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  current_execution_id TEXT,
  created_at           INTEGER NOT NULL,
  dispatched_at        INTEGER,
  started_at           INTEGER,
  completed_at         INTEGER,
  dispatch_deadline    INTEGER,          -- past this, stop dispatching: `expired`
  last_error           TEXT,
  result_summary       TEXT,
  CHECK (status IN ('pending','dispatched','running','success','partial','failed','cancelled','expired','uncertain'))
);

-- Idempotency layer 1: the same schedule can never own two rows for the same
-- canonical instant, no matter how many clocks or reconciliation sweeps race.
CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_occurrences_identity
  ON slot_occurrences (schedule_id, occurrence_at);

CREATE INDEX IF NOT EXISTS idx_slot_occurrences_status
  ON slot_occurrences (status, occurrence_at);

-- Per-target state. A target that already succeeded is never overwritten because
-- some other target (or the execution) failed.
CREATE TABLE IF NOT EXISTS slot_items (
  slot_id       TEXT    NOT NULL,
  target_id     TEXT    NOT NULL,
  bot_id        TEXT    NOT NULL,
  work_type     TEXT    NOT NULL, -- illustration|novel
  work_id       TEXT,
  status        TEXT    NOT NULL, -- pending|selected|downloaded|delivery_pending|submitted|no_candidate|duplicate|failed|uncertain
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  error_class   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  PRIMARY KEY (slot_id, target_id),
  CHECK (status IN ('pending','selected','downloaded','delivery_pending','submitted','no_candidate','duplicate','failed','uncertain'))
);

CREATE INDEX IF NOT EXISTS idx_slot_items_status ON slot_items (status);

-- One row per dispatch attempt. `slot_occurrences` says what the business needs;
-- this says which disposable runner tried to do it and how that run ended.
CREATE TABLE IF NOT EXISTS executions (
  id             TEXT    PRIMARY KEY,
  slot_id        TEXT    NOT NULL,
  attempt        INTEGER NOT NULL,
  provider       TEXT    NOT NULL, -- github-actions|...
  provider_run_id TEXT,
  status         TEXT    NOT NULL, -- dispatching|dispatched|running|success|partial|failed|cancelled|timeout|uncertain
  created_at     INTEGER NOT NULL,
  dispatched_at  INTEGER,
  started_at     INTEGER,
  completed_at   INTEGER,
  error          TEXT,
  error_class    TEXT,             -- infrastructure_error|provider_error|pixiv_rate_limit|...|uncertain_delivery
  result         TEXT,             -- machine-readable runner result (JSON)
  CHECK (status IN ('dispatching','dispatched','running','success','partial','failed','cancelled','timeout','uncertain'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_slot_attempt ON executions (slot_id, attempt);
CREATE INDEX IF NOT EXISTS idx_executions_open ON executions (status, provider_run_id);

-- Duplicate history must outlive an ephemeral runner: this is the authority that
-- stops a re-run from re-posting work already handled for that bot/target.
CREATE TABLE IF NOT EXISTS processed_works (
  bot_id        TEXT    NOT NULL,
  work_type     TEXT    NOT NULL,
  pixiv_id      TEXT    NOT NULL,
  target_id     TEXT,
  slot_id       TEXT,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, work_type, pixiv_id)
);

-- Edge review state. Media itself lives in Telegram (file_id / message_id);
-- the control plane stores only ids so the Worker never handles bytes.
CREATE TABLE IF NOT EXISTS reviews (
  id                   TEXT    PRIMARY KEY,
  bot_id               TEXT    NOT NULL,
  slot_id              TEXT,
  target_id            TEXT,
  work_id              TEXT,
  chat_id              TEXT    NOT NULL,
  message_id           INTEGER,
  media_group_id       TEXT,
  file_ids             TEXT,             -- JSON array of Telegram file_id
  status               TEXT    NOT NULL, -- pending|approved|rejected|expired|uncertain
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  decided_at           INTEGER,
  decided_by           TEXT,
  published_message_id INTEGER,
  CHECK (status IN ('pending','approved','rejected','expired','uncertain'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_work ON reviews (bot_id, target_id, work_id);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews (status, created_at);

-- One row per reconciliation sweep, so "did the clock run?" is answerable from
-- state instead of from log archives.
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id            TEXT    PRIMARY KEY,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  created_slots INTEGER NOT NULL DEFAULT 0,
  dispatched    INTEGER NOT NULL DEFAULT 0,
  reconciled    INTEGER NOT NULL DEFAULT 0,
  retried       INTEGER NOT NULL DEFAULT 0,
  expired       INTEGER NOT NULL DEFAULT 0,
  errors        TEXT
);

-- Structured event log (structured on purpose: the old system could only be
-- debugged by grepping tens of thousands of free-text lines).
CREATE TABLE IF NOT EXISTS event_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  event           TEXT    NOT NULL,
  slot_id         TEXT,
  schedule_id     TEXT,
  execution_id    TEXT,
  attempt         INTEGER,
  provider_run_id TEXT,
  target_id       TEXT,
  bot_id          TEXT,
  detail          TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_log_slot ON event_log (slot_id, ts);
CREATE INDEX IF NOT EXISTS idx_event_log_ts ON event_log (ts);
