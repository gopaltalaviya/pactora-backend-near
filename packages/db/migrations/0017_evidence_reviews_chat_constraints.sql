-- docs/26 F6, F7, F8. Hand-written; sorts after the generated
-- 0017_evidence_reviews_chat. The API checks every one of these first;
-- these are the floor a bug in it cannot go below.

ALTER TABLE job_files
  ADD CONSTRAINT job_files_size_range CHECK (size BETWEEN 1 AND 8388608),
  ADD CONSTRAINT job_files_mime_known CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  ADD CONSTRAINT job_files_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE job_drafts
  -- One first draft and at most three revisions.
  ADD CONSTRAINT job_drafts_round_range CHECK (round BETWEEN 1 AND 4),
  ADD CONSTRAINT job_drafts_hash_hex CHECK (snapshot_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE job_reviews
  ADD CONSTRAINT job_reviews_reason_len CHECK (char_length(reason) BETWEEN 10 AND 2000),
  ADD CONSTRAINT job_reviews_checks_count CHECK (
    jsonb_typeof(checks) = 'array' AND jsonb_array_length(checks) BETWEEN 1 AND 30),
  ADD CONSTRAINT job_reviews_hash_hex CHECK (review_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE job_messages
  ADD CONSTRAINT job_messages_body_len CHECK (char_length(body) BETWEEN 1 AND 4000),
  ADD CONSTRAINT job_messages_key_len CHECK (
    idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 16 AND 128),
  ADD CONSTRAINT job_messages_reply_fk FOREIGN KEY (in_reply_to) REFERENCES job_messages (id) ON DELETE SET NULL;
