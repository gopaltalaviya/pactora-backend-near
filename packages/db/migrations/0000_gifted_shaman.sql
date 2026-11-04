CREATE TYPE "public"."job_path" AS ENUM('escrow', 'direct');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('created', 'accepted', 'submitted', 'disputed', 'settled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."outcome" AS ENUM('success', 'failed', 'dispute_lost');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_capabilities" (
	"agent_id" bigint NOT NULL,
	"capability" text NOT NULL,
	CONSTRAINT "agent_capabilities_agent_id_capability_pk" PRIMARY KEY("agent_id","capability")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_stats" (
	"agent_id" bigint PRIMARY KEY NOT NULL,
	"completed" bigint DEFAULT 0 NOT NULL,
	"failed" bigint DEFAULT 0 NOT NULL,
	"disputed" bigint DEFAULT 0 NOT NULL,
	"volume" numeric(38, 0) DEFAULT '0' NOT NULL,
	"score" smallint DEFAULT 50 NOT NULL,
	"last_active_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" bigint NOT NULL,
	"chain_agent_id" numeric(78, 0),
	"owner_address" text NOT NULL,
	"wallet_address" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"endpoint_url" text,
	"price_per_task" numeric(38, 0) NOT NULL,
	"stake" numeric(38, 0) DEFAULT '0' NOT NULL,
	"metadata_uri" text,
	"active" boolean DEFAULT true NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" bigint NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "disputes" (
	"job_id" bigint PRIMARY KEY NOT NULL,
	"raised_by" bigint NOT NULL,
	"reason" text NOT NULL,
	"reason_hash" text NOT NULL,
	"resolved_for" text,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "indexer_cursor" (
	"chain_id" bigint NOT NULL,
	"contract" text NOT NULL,
	"last_block" bigint NOT NULL,
	"last_block_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "indexer_cursor_chain_id_contract_pk" PRIMARY KEY("chain_id","contract")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" bigint NOT NULL,
	"job_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tx_hash" text,
	"block_number" bigint,
	"log_index" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" bigint NOT NULL,
	"chain_job_id" numeric(78, 0),
	"client_agent_id" bigint NOT NULL,
	"worker_agent_id" bigint NOT NULL,
	"path" "job_path" NOT NULL,
	"state" "job_state" DEFAULT 'created' NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"fee" numeric(38, 0),
	"spec" jsonb NOT NULL,
	"spec_hash" text NOT NULL,
	"result" jsonb,
	"result_hash" text,
	"result_uri" text,
	"accept_deadline" timestamp with time zone,
	"work_deadline" timestamp with time zone,
	"review_deadline" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" bigint NOT NULL,
	"job_id" bigint,
	"from_agent_id" bigint,
	"to_agent_id" bigint,
	"amount" numeric(38, 0) NOT NULL,
	"fee" numeric(38, 0) DEFAULT '0' NOT NULL,
	"tx_hash" text NOT NULL,
	"block_number" bigint NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signer_txs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" bigint NOT NULL,
	"agent_id" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"nonce" bigint NOT NULL,
	"tx_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spend_policies" (
	"agent_id" bigint PRIMARY KEY NOT NULL,
	"per_task_cap" numeric(38, 0) NOT NULL,
	"daily_cap" numeric(38, 0) NOT NULL,
	"spent_today" numeric(38, 0) DEFAULT '0' NOT NULL,
	"day_start" timestamp with time zone DEFAULT now() NOT NULL,
	"allowlist_only" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_capabilities" ADD CONSTRAINT "agent_capabilities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_stats" ADD CONSTRAINT "agent_stats_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disputes" ADD CONSTRAINT "disputes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disputes" ADD CONSTRAINT "disputes_raised_by_agents_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "signer_txs" ADD CONSTRAINT "signer_txs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "spend_policies" ADD CONSTRAINT "spend_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_capabilities_capability_idx" ON "agent_capabilities" USING btree ("capability");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_chain_agent_uk" ON "agents" USING btree ("chain_id","chain_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_chain_wallet_uk" ON "agents" USING btree ("chain_id","wallet_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_discovery_idx" ON "agents" USING btree ("chain_id","active","price_per_task");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_id_chain_uk" ON "agents" USING btree ("id","chain_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_hash_uk" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_events_idempotency_uk" ON "job_events" USING btree ("chain_id","tx_hash","log_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_events_job_idx" ON "job_events" USING btree ("job_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_chain_job_uk" ON "jobs" USING btree ("chain_id","chain_job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_worker_idx" ON "jobs" USING btree ("chain_id","worker_agent_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_client_idx" ON "jobs" USING btree ("chain_id","client_agent_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_open_idx" ON "jobs" USING btree ("chain_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payments_uk" ON "payments" USING btree ("chain_id","tx_hash","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signer_idempotency_uk" ON "signer_txs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signer_nonce_uk" ON "signer_txs" USING btree ("chain_id","agent_id","nonce");