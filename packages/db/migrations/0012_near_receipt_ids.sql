DROP INDEX "job_events_idempotency_uk";--> statement-breakpoint
DROP INDEX "token_transfers_uk";--> statement-breakpoint
ALTER TABLE "job_events" ADD COLUMN "receipt_id" text;--> statement-breakpoint
ALTER TABLE "token_transfers" ADD COLUMN "receipt_id" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "job_events_idempotency_uk" ON "job_events" USING btree ("chain_id","receipt_id","log_index");--> statement-breakpoint
CREATE UNIQUE INDEX "token_transfers_uk" ON "token_transfers" USING btree ("chain_id","receipt_id","log_index");