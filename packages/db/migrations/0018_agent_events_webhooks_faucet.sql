CREATE TABLE "agent_event_reads" (
	"agent_id" bigint PRIMARY KEY NOT NULL,
	"read_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_event_seq" (
	"agent_id" bigint PRIMARY KEY NOT NULL,
	"last" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_events" (
	"agent_id" bigint NOT NULL,
	"seq" bigint NOT NULL,
	"job_event_id" bigint NOT NULL,
	"job_id" bigint NOT NULL,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_events_agent_id_seq_pk" PRIMARY KEY("agent_id","seq")
);
--> statement-breakpoint
CREATE TABLE "faucet_claims" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" text NOT NULL,
	"account" text NOT NULL,
	"ip" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"day" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" bigint NOT NULL,
	"agent_id" bigint NOT NULL,
	"seq" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_until" timestamp with time zone,
	"last_status" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" bigint NOT NULL,
	"url" text NOT NULL,
	"secret_enc" text NOT NULL,
	"kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"disabled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_event_reads" ADD CONSTRAINT "agent_event_reads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_event_seq" ADD CONSTRAINT "agent_event_seq_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_job_event_id_job_events_id_fk" FOREIGN KEY ("job_event_id") REFERENCES "public"."job_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_events_once_uk" ON "agent_events" USING btree ("agent_id","job_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "faucet_claims_account_day_uk" ON "faucet_claims" USING btree ("chain_id","account","day");--> statement-breakpoint
CREATE INDEX "faucet_claims_ip_day_idx" ON "faucet_claims" USING btree ("ip","day");--> statement-breakpoint
CREATE INDEX "faucet_claims_day_idx" ON "faucet_claims" USING btree ("chain_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_public_id_uk" ON "webhook_deliveries" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_once_uk" ON "webhook_deliveries" USING btree ("webhook_id","agent_id","seq");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhooks_public_id_uk" ON "webhooks" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "webhooks_agent_idx" ON "webhooks" USING btree ("agent_id");