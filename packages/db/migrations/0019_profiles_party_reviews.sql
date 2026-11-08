CREATE TABLE "party_reviews" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"job_id" bigint NOT NULL,
	"author_agent_id" bigint NOT NULL,
	"subject_agent_id" bigint NOT NULL,
	"author_role" text NOT NULL,
	"rating" smallint NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden_at" timestamp with time zone,
	"hidden_reason" text
);
--> statement-breakpoint
CREATE TABLE "public_profiles" (
	"agent_id" bigint PRIMARY KEY NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"display_name" text NOT NULL,
	"headline" text DEFAULT '' NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"show_account" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "party_reviews" ADD CONSTRAINT "party_reviews_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_reviews" ADD CONSTRAINT "party_reviews_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_reviews" ADD CONSTRAINT "party_reviews_subject_agent_id_agents_id_fk" FOREIGN KEY ("subject_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_profiles" ADD CONSTRAINT "public_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "party_reviews_public_id_uk" ON "party_reviews" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "party_reviews_once_uk" ON "party_reviews" USING btree ("job_id","author_agent_id");--> statement-breakpoint
CREATE INDEX "party_reviews_subject_idx" ON "party_reviews" USING btree ("subject_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "public_profiles_published_idx" ON "public_profiles" USING btree ("published","updated_at");