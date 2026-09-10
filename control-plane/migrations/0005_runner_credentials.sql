-- Durable storage for the batch execution plane's Pixiv credential.
--
-- A GitHub runner is destroyed when the job ends, so a refresh token it holds,
-- refreshes and then drops is gone. Pixiv may return a new refresh token from
-- any refresh (the client already treats that as expected: PixivAuth persists a
-- rotation to four places), and nothing proves it will never happen again.
--
-- The control plane is the only durable thing in this architecture, so a rotation
-- is written here. The runner reads the current value at the start of a run and
-- writes back anything that changed before it is allowed to report success.
--
-- The value is stored as-is because the runner has to present it to Pixiv. It is
-- never returned in an API response, never logged, and only reachable behind the
-- same bearer secret as the runner callbacks.
CREATE TABLE IF NOT EXISTS runner_credentials (
  name           TEXT    PRIMARY KEY,
  value          TEXT    NOT NULL,
  updated_at     INTEGER NOT NULL,
  -- Hash of what this value replaced, so a rotation is auditable without storing
  -- token history. Never the value itself.
  previous_hash  TEXT,
  rotations      INTEGER NOT NULL DEFAULT 0
);
