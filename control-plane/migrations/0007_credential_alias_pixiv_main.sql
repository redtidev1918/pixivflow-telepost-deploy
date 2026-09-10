-- Rename the credential identity, losslessly.
--
-- `credential_key` names WHICH account / external resource a schedule consumes. The
-- old value named the field inside it (`pixiv-refresh-token`), which is an
-- implementation detail: the day a second account exists, `pixiv-refresh-token-1`
-- and `-2` would encode the secret type into an identity that admission, the GitHub
-- concurrency group, rotation, remote login and status all have to key on.
--
--   credential_key = pixiv-main      <- stable alias, never changes
--   provider       = pixiv
--   secret         = refresh token   <- rotates indefinitely under the same alias
--
-- This migration only COPIES. The old row is left in place so the switch can be
-- verified against a value that is still known to work; it is dropped by a later
-- migration once no code references the old name. A copy cannot lose the credential,
-- whereas a rename that fails halfway can.
--
-- The value is copied verbatim, ciphertext included: it is encrypted with the same
-- master key, so the new name decrypts exactly like the old one.
INSERT INTO runner_credentials (name, value, updated_at, previous_hash, rotations)
SELECT 'pixiv-main', value, updated_at, previous_hash, rotations
  FROM runner_credentials
 WHERE name = 'pixiv-refresh-token'
ON CONFLICT(name) DO NOTHING;
