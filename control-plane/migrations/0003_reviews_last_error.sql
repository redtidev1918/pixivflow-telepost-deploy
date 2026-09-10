-- 0001 omitted `last_error` on reviews; the store selects it for the review
-- adapter (an expired or uncertain decision records why).
--
-- This was originally found in production, not in tests: the in-memory store used
-- by the unit tests happily returned `lastError`, while D1 rejected the SELECT
-- with "no such column: last_error". test/schema.test.ts now parses these
-- migrations and fails if the store ever selects a column the schema lacks.

ALTER TABLE reviews ADD COLUMN last_error TEXT;
