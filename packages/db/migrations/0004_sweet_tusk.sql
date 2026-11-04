ALTER TABLE "api_keys" ADD COLUMN "key_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_id_uk" ON "api_keys" USING btree ("key_id");