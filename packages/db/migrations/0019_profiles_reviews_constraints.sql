-- docs/26 F16, F17. Hand-written; sorts after the generated
-- 0019_profiles_party_reviews. The API checks all of this first; these are
-- the floor a bug in it cannot go below.

ALTER TABLE public_profiles
  ADD CONSTRAINT public_profiles_name_len CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 60),
  ADD CONSTRAINT public_profiles_headline_len CHECK (char_length(headline) <= 140),
  ADD CONSTRAINT public_profiles_bio_len CHECK (char_length(bio) <= 2000),
  ADD CONSTRAINT public_profiles_published_at CHECK (NOT published OR published_at IS NOT NULL);

ALTER TABLE party_reviews
  ADD CONSTRAINT party_reviews_rating_range CHECK (rating BETWEEN 1 AND 5),
  ADD CONSTRAINT party_reviews_body_len CHECK (char_length(body) BETWEEN 10 AND 2000),
  ADD CONSTRAINT party_reviews_role_known CHECK (author_role IN ('client', 'worker')),
  ADD CONSTRAINT party_reviews_not_self CHECK (author_agent_id <> subject_agent_id),
  ADD CONSTRAINT party_reviews_hidden_reason CHECK (hidden_at IS NULL OR hidden_reason IS NOT NULL);

-- A review is of a SETTLED job, by one of its two parties, of the other.
CREATE OR REPLACE FUNCTION pactora_check_party_review() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  j RECORD;
BEGIN
  SELECT state, client_agent_id, worker_agent_id INTO j FROM jobs WHERE id = NEW.job_id;
  IF NOT FOUND OR j.state <> 'settled' THEN
    RAISE EXCEPTION 'party_reviews: job % is not settled', NEW.job_id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
    (NEW.author_role = 'client' AND NEW.author_agent_id = j.client_agent_id AND NEW.subject_agent_id = j.worker_agent_id)
    OR (NEW.author_role = 'worker' AND NEW.author_agent_id = j.worker_agent_id AND NEW.subject_agent_id = j.client_agent_id)
  ) THEN
    RAISE EXCEPTION 'party_reviews: author and subject must be the job''s two parties' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER party_reviews_check BEFORE INSERT ON party_reviews
  FOR EACH ROW EXECUTE FUNCTION pactora_check_party_review();
