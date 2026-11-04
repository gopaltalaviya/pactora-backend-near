CREATE TABLE "token_transfers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" bigint NOT NULL,
	"block_number" bigint NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"amount" numeric(38, 0) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "token_transfers_uk" ON "token_transfers" USING btree ("chain_id","tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "token_transfers_to_idx" ON "token_transfers" USING btree ("chain_id","to_address","block_number");--> statement-breakpoint
CREATE INDEX "token_transfers_from_idx" ON "token_transfers" USING btree ("chain_id","from_address","block_number");