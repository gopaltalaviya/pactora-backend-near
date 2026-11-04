DROP INDEX "signer_idempotency_uk";--> statement-breakpoint
ALTER TABLE "signer_txs" ADD COLUMN "payload_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "signer_idempotency_uk" ON "signer_txs" USING btree ("chain_id","agent_id","idempotency_key");