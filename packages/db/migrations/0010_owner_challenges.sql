-- Audit M1: registration proves control of the owner address. A challenge is
-- issued per owner and consumed by the registration it was signed for.
CREATE TABLE "registration_challenges" (
	"nonce" text PRIMARY KEY NOT NULL,
	"chain_id" bigint NOT NULL,
	"owner_address" text NOT NULL,
	"requester" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Audit L2: several live re-issue challenges per agent, keyed by nonce. One
-- per agent let an unauthenticated caller keep replacing the owner's.
-- drizzle-kit cannot name the old primary key; 0007 created it as the
-- Postgres default, key_challenges_pkey.
ALTER TABLE "key_challenges" DROP CONSTRAINT "key_challenges_pkey";--> statement-breakpoint
ALTER TABLE "key_challenges" ADD PRIMARY KEY ("nonce");--> statement-breakpoint
ALTER TABLE "key_challenges" ADD COLUMN "requester" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "registration_challenges_owner_idx" ON "registration_challenges" USING btree ("owner_address","requester");--> statement-breakpoint
CREATE INDEX "key_challenges_agent_idx" ON "key_challenges" USING btree ("agent_id","requester");
