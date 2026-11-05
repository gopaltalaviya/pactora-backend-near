CREATE TABLE "signer_keys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" text NOT NULL,
	"account_id" text NOT NULL,
	"public_key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signer_wallet_txs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"method" text NOT NULL,
	"chain_agent_id" text NOT NULL,
	"nonce" bigint NOT NULL,
	"tx_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signer_txs" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "signer_txs" ADD COLUMN "failure" text;--> statement-breakpoint
CREATE UNIQUE INDEX "signer_keys_account_uk" ON "signer_keys" USING btree ("chain_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signer_wallet_txs_nonce_uk" ON "signer_wallet_txs" USING btree ("chain_id","wallet_address","nonce");--> statement-breakpoint
-- Hand-added (drizzle cannot express CHECKs): CAIP-2 network keys, as 0011.
ALTER TABLE "signer_keys" ADD CONSTRAINT "signer_keys_chain_caip2" CHECK (chain_id ~ '^near:[a-z0-9-]+$');--> statement-breakpoint
ALTER TABLE "signer_wallet_txs" ADD CONSTRAINT "signer_wallet_txs_chain_caip2" CHECK (chain_id ~ '^near:[a-z0-9-]+$');
