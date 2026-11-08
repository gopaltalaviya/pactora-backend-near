CREATE TYPE "public"."application_status" AS ENUM('pending', 'selected', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."hiring_mode" AS ENUM('applications', 'instant');--> statement-breakpoint
CREATE TYPE "public"."interaction_mode" AS ENUM('task', 'conversation', 'capture');--> statement-breakpoint
CREATE TYPE "public"."listing_category" AS ENUM('physical', 'expertise', 'judgment');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('open', 'closed', 'filled', 'cancelled');--> statement-breakpoint
CREATE TABLE "applications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" bigint NOT NULL,
	"applicant_agent_id" bigint NOT NULL,
	"price" numeric(38, 0) NOT NULL,
	"proposal" text NOT NULL,
	"status" "application_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"reopenable" boolean DEFAULT false NOT NULL,
	"job_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "listing_slots" (
	"listing_id" bigint NOT NULL,
	"slot" smallint NOT NULL,
	"application_id" bigint NOT NULL,
	"job_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_slots_listing_id_slot_pk" PRIMARY KEY("listing_id","slot")
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" text NOT NULL,
	"client_agent_id" bigint NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"category" "listing_category" NOT NULL,
	"interaction_mode" "interaction_mode" NOT NULL,
	"skills" text[] DEFAULT '{}' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"max_price" numeric(38, 0) NOT NULL,
	"max_workers" smallint NOT NULL,
	"hiring_mode" "hiring_mode" NOT NULL,
	"estimated_minutes" integer NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"criteria" text NOT NULL,
	"accept_window_seconds" integer NOT NULL,
	"work_window_seconds" integer NOT NULL,
	"status" "listing_status" DEFAULT 'open' NOT NULL,
	"reserved" numeric(38, 0) NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "person_actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" bigint NOT NULL,
	"agent_id" bigint NOT NULL,
	"action" text NOT NULL,
	"call" jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tx_hash" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "location" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "result_mismatch" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_applicant_agent_id_agents_id_fk" FOREIGN KEY ("applicant_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_slots" ADD CONSTRAINT "listing_slots_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_slots" ADD CONSTRAINT "listing_slots_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_slots" ADD CONSTRAINT "listing_slots_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_client_agent_id_agents_id_fk" FOREIGN KEY ("client_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_actions" ADD CONSTRAINT "person_actions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_actions" ADD CONSTRAINT "person_actions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "applications_public_id_uk" ON "applications" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_one_live_uk" ON "applications" USING btree ("listing_id","applicant_agent_id") WHERE status IN ('pending', 'selected');--> statement-breakpoint
CREATE INDEX "applications_listing_idx" ON "applications" USING btree ("listing_id","created_at");--> statement-breakpoint
CREATE INDEX "applications_applicant_idx" ON "applications" USING btree ("applicant_agent_id","listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_slots_application_uk" ON "listing_slots" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_public_id_uk" ON "listings" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_client_idempotency_uk" ON "listings" USING btree ("client_agent_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "listings_board_idx" ON "listings" USING btree ("chain_id","status","id");--> statement-breakpoint
CREATE INDEX "listings_client_idx" ON "listings" USING btree ("client_agent_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_actions_tx_uk" ON "person_actions" USING btree ("job_id","tx_hash");--> statement-breakpoint
CREATE INDEX "person_actions_job_idx" ON "person_actions" USING btree ("job_id","agent_id","action");