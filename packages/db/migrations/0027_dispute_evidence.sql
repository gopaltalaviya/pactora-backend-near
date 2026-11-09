-- Client dispute evidence (2026-11-09). Hand-written.
--
-- A client who disputes could say one sentence (the on-chain reason hash)
-- and nothing more; the desk saw the worker's photos and drafts, never the
-- client's side. Now the client attaches notes (≤ 2000 chars, ≤ 10) and
-- photos (the same pipeline as evidence photos: magic bytes, metadata
-- removed, ≤ 8 MiB, ≤ 10) while the job is submitted or disputed. The
-- on-chain reason_hash is unchanged: evidence is off chain and enters the
-- desk's evidence bundle and hash.

ALTER TABLE job_files ADD COLUMN purpose text NOT NULL DEFAULT 'evidence';
ALTER TABLE job_files ADD CONSTRAINT job_files_purpose_known CHECK (purpose IN ('evidence', 'dispute'));

CREATE TABLE dispute_notes (
  id bigserial PRIMARY KEY,
  public_id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  author_agent_id bigint NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispute_notes_body_length CHECK (char_length(body) BETWEEN 1 AND 2000)
);
CREATE UNIQUE INDEX dispute_notes_public_id_uk ON dispute_notes (public_id);
CREATE INDEX dispute_notes_job_idx ON dispute_notes (job_id, id);
