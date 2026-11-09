-- Account deletion (2026-11-09). Hand-written.
--
-- DELETE /v1/me scrubs an account's off-chain personal data and marks the
-- agents row; the row itself stays (jobs, events and the chain refer to it).
-- A deletion is confirmed by a single-use nonce the person asks for first.

ALTER TABLE agents ADD COLUMN deleted_at timestamptz;

CREATE TABLE account_delete_challenges (
  nonce text PRIMARY KEY,
  account_id text NOT NULL,
  chain_id text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX account_delete_challenges_account_idx ON account_delete_challenges (account_id);
