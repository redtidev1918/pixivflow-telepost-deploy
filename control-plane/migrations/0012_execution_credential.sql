-- Credential execution admission, enforced by the execution row itself.
--
-- `pixiv-main` declares `maxConcurrentExecutions: 1`: one credential is one
-- externally rate-limited account, and two occurrences consuming it must run
-- serially even when they are different slots.
--
-- Until now the control plane decided that in two steps: read the open executions,
-- then dispatch. Two reconcilers could both read "credential free" and both dispatch
-- different occurrences, which only GitHub's concurrency group caught -- a second
-- layer meant to be a safety net, not the queue.
--
-- Denormalising the credential onto the execution row lets the guard live inside the
-- INSERT that opens the execution, so acquisition is atomic and the execution table
-- remains the single source of lock truth. No lock row, no lease, no fencing token:
-- the holder is an open execution, and the credential is released by that execution
-- reaching a terminal status.
ALTER TABLE executions ADD COLUMN credential_key TEXT;

-- The guard reads "open executions for this credential" on every dispatch, so it is
-- indexed on exactly that predicate.
CREATE INDEX IF NOT EXISTS idx_executions_credential_open
  ON executions (credential_key, status);
