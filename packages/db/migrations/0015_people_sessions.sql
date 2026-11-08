CREATE TYPE "public"."agent_kind" AS ENUM('agent', 'person');--> statement-breakpoint
CREATE TABLE "login_challenges" (
	"nonce" text PRIMARY KEY NOT NULL,
	"chain_id" text NOT NULL,
	"account_id" text NOT NULL,
	"requester" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"account_id" text NOT NULL,
	"chain_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"requester" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "public_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "kind" "agent_kind" DEFAULT 'agent' NOT NULL;--> statement-breakpoint
CREATE INDEX "login_challenges_account_idx" ON "login_challenges" USING btree ("account_id","requester");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_key_id_uk" ON "sessions" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "sessions_account_idx" ON "sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_public_id_uk" ON "agents" USING btree ("public_id");