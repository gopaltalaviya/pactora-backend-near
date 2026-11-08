CREATE TABLE "account_standing" (
	"agent_id" bigint PRIMARY KEY NOT NULL,
	"standing" text NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"agent_id" bigint,
	"case_id" bigint,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_cases" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" bigint NOT NULL,
	"subject_account" text NOT NULL,
	"source" text NOT NULL,
	"entry_ref" text NOT NULL,
	"query_name" text NOT NULL,
	"matched_name" text NOT NULL,
	"score" numeric(5, 4) NOT NULL,
	"strength" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "compliance_decisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"case_id" bigint NOT NULL,
	"reviewer" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"case_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_verifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" bigint NOT NULL,
	"provider" text NOT NULL,
	"provider_session_id" text,
	"status" text DEFAULT 'screening' NOT NULL,
	"document_verified" boolean DEFAULT false NOT NULL,
	"legal_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sanctions_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"version_id" bigint NOT NULL,
	"source" text NOT NULL,
	"ref" text NOT NULL,
	"kind" text NOT NULL,
	"names" text[] NOT NULL,
	"addresses" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sanctions_list_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"sha256" text NOT NULL,
	"entry_count" integer NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_standing" ADD CONSTRAINT "account_standing_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_cases" ADD CONSTRAINT "compliance_cases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_decisions" ADD CONSTRAINT "compliance_decisions_case_id_compliance_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."compliance_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanctions_entries" ADD CONSTRAINT "sanctions_entries_version_id_sanctions_list_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."sanctions_list_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compliance_audit_agent_idx" ON "compliance_audit" USING btree ("agent_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_cases_public_id_uk" ON "compliance_cases" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "compliance_cases_status_idx" ON "compliance_cases" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_decisions_once_uk" ON "compliance_decisions" USING btree ("case_id","reviewer");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_verifications_public_id_uk" ON "identity_verifications" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_verifications_session_uk" ON "identity_verifications" USING btree ("provider","provider_session_id");--> statement-breakpoint
CREATE INDEX "identity_verifications_agent_idx" ON "identity_verifications" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "sanctions_entries_version_idx" ON "sanctions_entries" USING btree ("version_id","kind");