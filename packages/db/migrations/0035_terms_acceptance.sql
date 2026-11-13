-- Terms acceptance (issue 17). Hand-written. The person accepted the terms
-- and privacy policy at /join; the site kept that only in the browser. Kept
-- here on the person's agent row: when, and which version. Nullable — no
-- acceptance recorded yet — and set by POST /v1/me/terms, which keeps the
-- first acceptance of a version.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "terms_accepted_at" timestamp with time zone;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "terms_version" text;
