-- Review adapter fields.
--
-- A review message can be more than one Telegram message (a media group), and the
-- publish target belongs to the RUNNER's knowledge (it posted the media and owns
-- the bot), not to the Worker's configuration. Storing both keeps the edge review
-- adapter stateless: it needs a bot token from the environment and nothing else,
-- and it never has to guess which channel a bot publishes to.

ALTER TABLE reviews ADD COLUMN message_ids TEXT;      -- JSON array of review message ids
ALTER TABLE reviews ADD COLUMN publish_chat_id TEXT;  -- channel the approved review publishes to
ALTER TABLE reviews ADD COLUMN publish_thread_id INTEGER;
ALTER TABLE reviews ADD COLUMN caption TEXT;

-- Duplicate protection: one review per (bot, target, work) is already enforced by
-- the unique index in 0001; this one makes "which reviews still need a decision"
-- cheap for the reconciliation sweep.
CREATE INDEX IF NOT EXISTS idx_reviews_pending ON reviews (bot_id, status, created_at);
