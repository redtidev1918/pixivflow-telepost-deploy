-- Operator recovery attempts.
--
-- Why this exists, in one line: an occurrence can exhaust its automatic attempts
-- because of a fault OUTSIDE the control plane, and then the ledger has no way
-- back. It happened — the legacy Fly watchdog woke the old plane, both planes
-- shared one Pixiv credential, every attempt died in rate-limit cooldown, and
-- `bot1-daily@2026-09-11T1000` reached `failed` with 3/3 attempts spent while
-- nothing was wrong with the occurrence itself.
--
-- Deliberately NOT a "reopen": the automatic attempt history is immutable. These
-- columns record that an operator granted ONE additional attempt, on top of the
-- automatic ceiling, on a new attempt number (4, not a rewritten 1).
--
--   recovery_count       how many operator attempts have been granted. Automatic
--                        retry keeps its own cap; the dispatch ceiling becomes
--                        maxAttempts + recovery_count, so a grant buys exactly one
--                        more attempt and no more.
--   recovery_generation  bumped by every successful grant. The grant is a single
--                        conditional UPDATE guarded by the generation it observed,
--                        so two concurrent operators cannot both widen the ceiling.
--   recovery_reason      the operator's stated reason, kept verbatim.
--   recovered_at         when the grant happened.
ALTER TABLE slot_occurrences ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slot_occurrences ADD COLUMN recovery_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slot_occurrences ADD COLUMN recovery_reason TEXT;
ALTER TABLE slot_occurrences ADD COLUMN recovered_at INTEGER;
