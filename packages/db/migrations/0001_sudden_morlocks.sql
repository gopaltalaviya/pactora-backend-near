CREATE TYPE "public"."run_state" AS ENUM('running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" bigint NOT NULL,
	"agent_id" bigint NOT NULL,
	"goal" text NOT NULL,
	"state" "run_state" DEFAULT 'running' NOT NULL,
	"answer" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"spent" numeric(38, 0) DEFAULT '0' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_events_run_idx" ON "run_events" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_agent_idx" ON "runs" USING btree ("agent_id","id");