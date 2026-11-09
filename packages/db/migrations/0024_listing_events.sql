-- Listing and application events in the per-agent feed (2026-11-09).
-- Hand-written. Until now agent_events rows came only from the job_events
-- trigger, so a new bid, a selection, a closed listing reached nobody's
-- feed, webhook or Telegram. A row may now name a listing instead of a job,
-- and is written by `pactora_agent_event()` with the SAME per-agent
-- numbering as the trigger (the agent_event_seq row is locked first, so the
-- two writers take turns and the sequence keeps no gaps).
--
-- Exactly once: a writer passes a dedupe key (the application's id and the
-- event, say); a retried request or a second sweep finds the key and writes
-- nothing. The key is checked AFTER the seq row is locked, so a concurrent
-- duplicate waits, then sees the first.

ALTER TABLE agent_events
  ALTER COLUMN job_event_id DROP NOT NULL,
  ALTER COLUMN job_id DROP NOT NULL,
  ADD COLUMN listing_id bigint REFERENCES listings(id) ON DELETE CASCADE,
  ADD COLUMN dedupe_key text;

ALTER TABLE agent_events DROP CONSTRAINT agent_events_role_known;
ALTER TABLE agent_events
  ADD CONSTRAINT agent_events_role_known CHECK (role IN ('client', 'worker', 'applicant', 'match', 'account')),
  ADD CONSTRAINT agent_events_subject CHECK (job_id IS NOT NULL OR listing_id IS NOT NULL OR role = 'account');

CREATE UNIQUE INDEX agent_events_dedupe_uk ON agent_events (agent_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX agent_events_listing_idx ON agent_events (listing_id) WHERE listing_id IS NOT NULL;

CREATE OR REPLACE FUNCTION pactora_agent_event(
  p_agent_id bigint, p_role text, p_kind text, p_payload jsonb, p_listing_id bigint, p_dedupe_key text
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  n BIGINT;
BEGIN
  INSERT INTO agent_event_seq (agent_id, last) VALUES (p_agent_id, 0) ON CONFLICT (agent_id) DO NOTHING;
  SELECT last INTO n FROM agent_event_seq WHERE agent_id = p_agent_id FOR UPDATE;
  IF p_dedupe_key IS NOT NULL
     AND EXISTS (SELECT 1 FROM agent_events WHERE agent_id = p_agent_id AND dedupe_key = p_dedupe_key) THEN
    RETURN NULL;
  END IF;
  n := n + 1;
  UPDATE agent_event_seq SET last = n WHERE agent_id = p_agent_id;
  INSERT INTO agent_events (agent_id, seq, job_event_id, job_id, listing_id, role, kind, payload, dedupe_key)
    VALUES (p_agent_id, n, NULL, NULL, p_listing_id, p_role, p_kind, COALESCE(p_payload, '{}'::jsonb), p_dedupe_key);
  INSERT INTO webhook_deliveries (webhook_id, agent_id, seq)
    SELECT w.id, p_agent_id, n
    FROM webhooks w
    WHERE w.agent_id = p_agent_id
      AND w.active
      AND w.deleted_at IS NULL
      AND (cardinality(w.kinds) = 0 OR p_kind = ANY (w.kinds));
  RETURN n;
END;
$$;
