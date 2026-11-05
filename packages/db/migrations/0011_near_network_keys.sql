-- Hand-added: the two same-chain foreign keys (0001_constraints) span
-- chain_id, and Postgres cannot retype one side of a foreign key at a time.
-- Drop them, retype every table, then restore them exactly.
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_client_same_chain";--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_worker_same_chain";--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "chain_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "indexer_cursor" ALTER COLUMN "chain_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "job_events" ALTER COLUMN "chain_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "chain_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "chain_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "registration_challenges" ALTER COLUMN "chain_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "chain_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "signer_txs" ALTER COLUMN "chain_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "token_transfers" ALTER COLUMN "chain_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_client_same_chain"
  FOREIGN KEY (client_agent_id, chain_id) REFERENCES agents (id, chain_id);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_worker_same_chain"
  FOREIGN KEY (worker_agent_id, chain_id) REFERENCES agents (id, chain_id);--> statement-breakpoint
-- Hand-added (drizzle cannot express CHECKs): every network key is a NEAR
-- CAIP-2 id, docs/NEAR-PORT.md §1. A stray '10143' cannot be written.
ALTER TABLE "agents" ADD CONSTRAINT "agents_chain_caip2" CHECK (chain_id ~ '^near:[a-z0-9-]+$');--> statement-breakpoint
ALTER TABLE "indexer_cursor" ADD CONSTRAINT "indexer_cursor_chain_caip2" CHECK (chain_id ~ '^near:[a-z0-9-]+$');--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_chain_caip2" CHECK (chain_id ~ '^near:[a-z0-9-]+$');--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_chain_caip2" CHECK (chain_id ~ '^near:[a-z0-9-]+$');--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_chain_caip2" CHECK (chain_id ~ '^near:[a-z0-9-]+$');--> statement-breakpoint
ALTER TABLE "registration_challenges" ADD CONSTRAINT "registration_challenges_chain_caip2" CHECK (chain_id ~ '^near:[a-z0-9-]+$');--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_chain_caip2" CHECK (chain_id ~ '^near:[a-z0-9-]+$');--> statement-breakpoint
ALTER TABLE "signer_txs" ADD CONSTRAINT "signer_txs_chain_caip2" CHECK (chain_id ~ '^near:[a-z0-9-]+$');--> statement-breakpoint
ALTER TABLE "token_transfers" ADD CONSTRAINT "token_transfers_chain_caip2" CHECK (chain_id ~ '^near:[a-z0-9-]+$');
