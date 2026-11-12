-- Work credentials (feature/work-credentials). Hand-written.
-- One soulbound NEP-171 credential per settled job, minted to the worker's
-- wallet on the chain's `Credentials` contract (token id = the chain job id).
-- The row is the claim: written BEFORE the mint (unique per job, so two
-- claims cannot both mint), deleted when the signer certainly minted nothing,
-- kept as `failed` when the outcome is unknown — a later claim reads
-- `nft_token` before it mints again. `updated_at` marks the last attempt, so
-- a claim left `pending` by a crash can be taken over once it is stale.
CREATE TABLE IF NOT EXISTS "credentials" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "chain_id" text NOT NULL,
  "job_id" bigint NOT NULL REFERENCES "jobs"("id") ON DELETE CASCADE,
  "receiver" text NOT NULL,
  "token_id" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "tx_hash" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "credentials_status_ck" CHECK ("status" IN ('pending', 'minted', 'failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "credentials_job_uk" ON "credentials" ("job_id");
CREATE INDEX IF NOT EXISTS "credentials_receiver_idx" ON "credentials" ("chain_id", "receiver");
