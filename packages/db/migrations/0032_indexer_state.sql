-- An indexer that cannot move says why (2026-11-09, round 3). Hand-written.
-- One row per chain while the indexer is stalled on something only an
-- operator can fix (a start block the RPC has garbage-collected); the
-- indexer deletes it on its next successful tick. The API's /v1/status
-- reads it, so the stall is visible without the indexer's own /health.
CREATE TABLE IF NOT EXISTS "indexer_state" (
  "chain_id" text PRIMARY KEY NOT NULL,
  "state" text NOT NULL,
  "fix" text NOT NULL DEFAULT '',
  "since" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
