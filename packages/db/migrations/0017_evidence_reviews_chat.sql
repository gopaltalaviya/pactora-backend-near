CREATE TYPE "public"."review_decision" AS ENUM('revise', 'accept_draft', 'dispute_intent');--> statement-breakpoint
CREATE TABLE "job_drafts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"job_id" bigint NOT NULL,
	"round" smallint NOT NULL,
	"author_agent_id" bigint NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_files" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"job_id" bigint NOT NULL,
	"uploader_agent_id" bigint NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"job_id" bigint NOT NULL,
	"author_agent_id" bigint NOT NULL,
	"body" text NOT NULL,
	"in_reply_to" bigint,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_reviews" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" bigint NOT NULL,
	"job_id" bigint NOT NULL,
	"decision" "review_decision" NOT NULL,
	"reason" text NOT NULL,
	"checks" jsonb NOT NULL,
	"review_hash" text NOT NULL,
	"decided_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_drafts" ADD CONSTRAINT "job_drafts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_drafts" ADD CONSTRAINT "job_drafts_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_files" ADD CONSTRAINT "job_files_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_files" ADD CONSTRAINT "job_files_uploader_agent_id_agents_id_fk" FOREIGN KEY ("uploader_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_messages" ADD CONSTRAINT "job_messages_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_messages" ADD CONSTRAINT "job_messages_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_reviews" ADD CONSTRAINT "job_reviews_draft_id_job_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."job_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_reviews" ADD CONSTRAINT "job_reviews_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_reviews" ADD CONSTRAINT "job_reviews_decided_by_agents_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_drafts_public_id_uk" ON "job_drafts" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_drafts_snapshot_hash_uk" ON "job_drafts" USING btree ("snapshot_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "job_drafts_round_uk" ON "job_drafts" USING btree ("job_id","round");--> statement-breakpoint
CREATE UNIQUE INDEX "job_files_public_id_uk" ON "job_files" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_files_object_key_uk" ON "job_files" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "job_files_job_idx" ON "job_files" USING btree ("job_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_messages_public_id_uk" ON "job_messages" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_messages_idempotency_uk" ON "job_messages" USING btree ("job_id","author_agent_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "job_messages_job_idx" ON "job_messages" USING btree ("job_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_reviews_public_id_uk" ON "job_reviews" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_reviews_draft_uk" ON "job_reviews" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "job_reviews_job_idx" ON "job_reviews" USING btree ("job_id","id");