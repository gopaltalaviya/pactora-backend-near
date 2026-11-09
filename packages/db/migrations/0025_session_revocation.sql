-- Session revocation on a key change (2026-11-09). Hand-written.
--
-- A person's session outlived the keys that opened it: an account whose
-- full-access key was rotated (or stolen and replaced), or whose agent's
-- wallet was re-proposed, kept every session it had. Now a sign-in records
-- a hash of the account's full-access public keys; a sweep re-reads them and
-- ends the sessions of an account whose set changed, and the indexer ends
-- them on wallet_proposed / wallet_accepted. `revoked_reason` is what the
-- next request with that token is told.

ALTER TABLE sessions
  ADD COLUMN access_keys_hash text,
  ADD COLUMN revoked_reason text;
