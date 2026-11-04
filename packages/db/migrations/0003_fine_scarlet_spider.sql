CREATE TABLE IF NOT EXISTS "x402_redemptions" (
	"job_id" bigint PRIMARY KEY NOT NULL,
	"resource" text NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "x402_redemptions" ADD CONSTRAINT "x402_redemptions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
