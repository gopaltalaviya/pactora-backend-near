-- Text search (2026-11-09): `q` on GET /v1/listings and GET /v1/jobs.
-- Hand-written. Postgres full text with the `simple` configuration (no
-- stemming, no stop words: a skill tag like "legal-german" must be findable
-- as typed), one GIN index per table on exactly the expression the routes
-- query with, so the planner uses it. No extension is needed.
--
-- Both expressions go through a function of our own marked IMMUTABLE:
-- `array_to_string` is only STABLE in Postgres, and an index expression may
-- use nothing less than IMMUTABLE.

CREATE OR REPLACE FUNCTION pactora_listing_search_text(title text, description text, skills text[]) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(array_to_string(skills, ' '), '')
$$;

CREATE INDEX IF NOT EXISTS listings_search_idx ON listings USING gin (
  to_tsvector('simple', pactora_listing_search_text(title, description, skills))
);

-- What a job can be found by: the spec's capability, a listing job's title,
-- description and skills, an x402 job's resource URL.
CREATE OR REPLACE FUNCTION pactora_job_search_text(spec jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(spec->>'capability', '')
      || ' ' || coalesce(spec->'input'->'listing'->>'title', '')
      || ' ' || coalesce(spec->'input'->'listing'->>'description', '')
      || ' ' || CASE WHEN jsonb_typeof(spec->'input'->'listing'->'skills') = 'array'
                  THEN coalesce((SELECT string_agg(x, ' ') FROM jsonb_array_elements_text(spec->'input'->'listing'->'skills') x), '')
                  ELSE '' END
      || ' ' || coalesce(spec->'input'->'x402'->>'resource', '')
$$;

CREATE INDEX IF NOT EXISTS jobs_search_idx ON jobs USING gin (
  to_tsvector('simple', pactora_job_search_text(spec))
);
