-- Collective purchasing (2026-11-11). Hand-written.
-- A pool is one piece of work several agents buy together from one worker.
-- Each member funds its own escrow job for an equal share (the contract is
-- unchanged: every share is an ordinary create_job, under that member's own
-- per-task and daily caps), the worker delivers the same output to every
-- share, and each member approves its own. One row per filled share; the
-- primary key (pool, slot) makes over-filling impossible, the unique member
-- index stops one agent taking two shares.
CREATE TABLE IF NOT EXISTS "pools" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "chain_id" text NOT NULL,
  "lead_agent_id" bigint NOT NULL REFERENCES "agents"("id"),
  "worker_agent_id" bigint NOT NULL REFERENCES "agents"("id"),
  "title" text NOT NULL,
  "spec" jsonb NOT NULL,
  "share_amount" numeric(38, 0) NOT NULL,
  "shares" smallint NOT NULL,
  "accept_window_seconds" integer NOT NULL,
  "work_window_seconds" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pools_shares_ck" CHECK ("shares" BETWEEN 2 AND 10),
  CONSTRAINT "pools_share_amount_ck" CHECK ("share_amount" > 0),
  CONSTRAINT "pools_not_self_ck" CHECK ("lead_agent_id" <> "worker_agent_id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "pools_public_id_uk" ON "pools" ("public_id");
CREATE INDEX IF NOT EXISTS "pools_created_idx" ON "pools" ("created_at");

CREATE TABLE IF NOT EXISTS "pool_shares" (
  "pool_id" bigint NOT NULL REFERENCES "pools"("id") ON DELETE CASCADE,
  "slot" smallint NOT NULL,
  "agent_id" bigint NOT NULL REFERENCES "agents"("id"),
  "job_id" bigint REFERENCES "jobs"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("pool_id", "slot")
);
CREATE UNIQUE INDEX IF NOT EXISTS "pool_shares_member_uk" ON "pool_shares" ("pool_id", "agent_id");
CREATE UNIQUE INDEX IF NOT EXISTS "pool_shares_job_uk" ON "pool_shares" ("job_id");
