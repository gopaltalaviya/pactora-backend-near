-- docs/26 F9, F10, F23. Hand-written; sorts after the generated
-- 0018_agent_events_webhooks_faucet.
--
-- Every job event, from whichever writer (the API's recordEvent, the
-- indexer), is fanned out here, in the SAME transaction, to:
--   * agent_events, once per party, numbered per agent with no gaps;
--   * webhook_deliveries, one per active hook of that agent that wants it.
--
-- No gaps: the per-agent counter is an upsert, which locks that agent's
-- agent_event_seq row until commit, so two writers for one agent take
-- turns. A rolled-back job_events insert rolls its numbers back with it.
-- Writers for different agents never wait on each other.
--
-- One row per agent: a job whose client and worker were the same agent
-- would otherwise collide on agent_events_once_uk and abort the job_events
-- write itself. The contract refuses such a job (SameOwner); this keeps a
-- bad row from becoming a failed indexer batch.
CREATE OR REPLACE FUNCTION pactora_fan_out_job_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  j RECORD;
  party RECORD;
  n BIGINT;
BEGIN
  SELECT client_agent_id, worker_agent_id, public_id INTO j FROM jobs WHERE id = NEW.job_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  FOR party IN
    SELECT DISTINCT ON (p.agent_id) p.agent_id, p.role
    FROM (VALUES (j.client_agent_id, 'client'), (j.worker_agent_id, 'worker')) AS p(agent_id, role)
    WHERE p.agent_id IS NOT NULL
    ORDER BY p.agent_id, p.role
  LOOP
    INSERT INTO agent_event_seq (agent_id, last) VALUES (party.agent_id, 1)
      ON CONFLICT (agent_id) DO UPDATE SET last = agent_event_seq.last + 1
      RETURNING last INTO n;
    INSERT INTO agent_events (agent_id, seq, job_event_id, job_id, role, kind, payload, created_at)
      VALUES (party.agent_id, n, NEW.id, NEW.job_id, party.role, NEW.kind,
              COALESCE(NEW.payload, '{}'::jsonb) || jsonb_build_object('jobId', j.public_id),
              NEW.occurred_at);
    INSERT INTO webhook_deliveries (webhook_id, agent_id, seq)
      SELECT w.id, party.agent_id, n
      FROM webhooks w
      WHERE w.agent_id = party.agent_id
        AND w.active
        AND w.deleted_at IS NULL
        AND (cardinality(w.kinds) = 0 OR NEW.kind = ANY (w.kinds));
  END LOOP;
  RETURN NULL;
END;
$$;

-- History first, in the same transaction as the trigger below, so an agent
-- reading from seq 0 sees every event its jobs ever had, in order, and no
-- event can land between the backfill and the trigger.
INSERT INTO agent_events (agent_id, seq, job_event_id, job_id, role, kind, payload, created_at)
SELECT p.agent_id,
       row_number() OVER (PARTITION BY p.agent_id ORDER BY e.id),
       e.id, e.job_id, p.role, e.kind,
       COALESCE(e.payload, '{}'::jsonb) || jsonb_build_object('jobId', j.public_id),
       e.occurred_at
FROM job_events e
JOIN jobs j ON j.id = e.job_id
CROSS JOIN LATERAL (
  SELECT DISTINCT ON (q.agent_id) q.agent_id, q.role
  FROM (VALUES (j.client_agent_id, 'client'), (j.worker_agent_id, 'worker')) AS q(agent_id, role)
  ORDER BY q.agent_id, q.role
) p;

INSERT INTO agent_event_seq (agent_id, last)
SELECT agent_id, max(seq) FROM agent_events GROUP BY agent_id;

CREATE TRIGGER job_events_fan_out AFTER INSERT ON job_events
  FOR EACH ROW EXECUTE FUNCTION pactora_fan_out_job_event();

ALTER TABLE agent_events
  ADD CONSTRAINT agent_events_role_known CHECK (role IN ('client', 'worker')),
  ADD CONSTRAINT agent_events_seq_positive CHECK (seq >= 1);

ALTER TABLE agent_event_seq
  ADD CONSTRAINT agent_event_seq_nonneg CHECK (last >= 0);

ALTER TABLE agent_event_reads
  ADD CONSTRAINT agent_event_reads_nonneg CHECK (read_seq >= 0);

ALTER TABLE webhooks
  ADD CONSTRAINT webhooks_url_http CHECK (url ~ '^https?://' AND char_length(url) <= 2048),
  ADD CONSTRAINT webhooks_kinds_count CHECK (cardinality(kinds) <= 50),
  ADD CONSTRAINT webhooks_failures_nonneg CHECK (consecutive_failures >= 0);

ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_status_known CHECK (status IN ('pending', 'delivered', 'failed')),
  ADD CONSTRAINT webhook_deliveries_attempts_range CHECK (attempts BETWEEN 0 AND 8);

ALTER TABLE faucet_claims
  ADD CONSTRAINT faucet_claims_status_known CHECK (status IN ('pending', 'sent', 'failed')),
  ADD CONSTRAINT faucet_claims_amount_positive CHECK (amount > 0),
  ADD CONSTRAINT faucet_claims_day_format CHECK (day ~ '^\d{4}-\d{2}-\d{2}$');
