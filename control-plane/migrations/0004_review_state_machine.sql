-- Align the review state machine with the one TelePost proved in production.
--
-- TelePost separates "decided" from "in flight" from "done":
--   preparing -> pending -> publishing -> published
--                        \-> failed (re-claimable)
--   plus terminal rejected / expired / deleted.
--
-- The previous schema collapsed that into a single `approved` state, which has no
-- way to represent a publish that was claimed but never completed: a crash between
-- the decision and the copy left the row indistinguishable from "approved and
-- published", so nothing could ever recover it. `publishing` is what makes that
-- window visible, and `failed` keeps a failed publish distinguishable from a
-- review that was never decided (the approve button must stay meaningful).
--
-- `approved` meant "decided, and the copy succeeded", so it maps to `published`.
--
-- `uncertain` is this deployment's addition, not TelePost's. A stale `publishing`
-- row is reaped to `uncertain` rather than reclaimed: TelePost reclaims it after
-- 300s and re-runs the publish, but a crash after the Telegram call succeeded and
-- before the ledger row was written leaves no evidence the copy happened, so that
-- reclaim is exactly the path that publishes the same media twice. The operator is
-- the only thing that can tell the difference, so the operator is who gets asked.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt.

CREATE TABLE reviews_v2 (
  id                   TEXT    PRIMARY KEY,
  bot_id               TEXT    NOT NULL,
  slot_id              TEXT,
  target_id            TEXT,
  work_id              TEXT,
  chat_id              TEXT    NOT NULL,
  message_id           INTEGER,
  message_ids          TEXT,             -- JSON array of review message ids
  media_group_id       TEXT,
  file_ids             TEXT,             -- JSON array of Telegram file_id
  caption              TEXT,
  publish_chat_id      TEXT,
  publish_thread_id    INTEGER,
  status               TEXT    NOT NULL, -- see below
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL, -- doubles as the publishing claim time
  decided_at           INTEGER,
  decided_by           TEXT,
  published_message_id INTEGER,
  last_error           TEXT,
  CHECK (status IN ('pending','publishing','published','failed','rejected','expired','uncertain'))
);

INSERT INTO reviews_v2
  (id, bot_id, slot_id, target_id, work_id, chat_id, message_id, message_ids, media_group_id,
   file_ids, caption, publish_chat_id, publish_thread_id, status, created_at, updated_at,
   decided_at, decided_by, published_message_id, last_error)
SELECT
  id, bot_id, slot_id, target_id, work_id, chat_id, message_id, message_ids, media_group_id,
  file_ids, caption, publish_chat_id, publish_thread_id,
  CASE status WHEN 'approved' THEN 'published' ELSE status END,
  created_at, updated_at, decided_at, decided_by, published_message_id, last_error
FROM reviews;

DROP TABLE reviews;
ALTER TABLE reviews_v2 RENAME TO reviews;

-- Work-level dedupe stays a constraint, and deliberately stronger than TelePost's:
-- TelePost scopes it to a 7-day window over published reviews, so the same work is
-- reviewed again a week later. Here a work can only ever have ONE review, in any
-- status. Two live reviews for one work is precisely how the same media gets
-- approved twice, and the runner already carries permanent duplicate history, so
-- the window would buy nothing except a second chance to double-post.
--
-- Per-intent idempotency is the primary key: the runner derives the id
-- deterministically, so a replayed callback or a racing runner converges on one row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_work ON reviews (bot_id, target_id, work_id);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews (status, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_pending ON reviews (bot_id, status, created_at);
