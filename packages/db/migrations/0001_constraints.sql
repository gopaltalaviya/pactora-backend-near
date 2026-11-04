-- Constraints Drizzle cannot express, applied after the generated schema.
-- These are the ones that make bad states impossible rather than merely
-- discouraged.

-- A job may never span two chains. A composite foreign key makes that
-- STRUCTURAL: there is no sequence of application bugs that can produce a job
-- whose client is on testnet and whose worker is on mainnet.
ALTER TABLE jobs
  ADD CONSTRAINT jobs_client_same_chain
    FOREIGN KEY (client_agent_id, chain_id) REFERENCES agents (id, chain_id),
  ADD CONSTRAINT jobs_worker_same_chain
    FOREIGN KEY (worker_agent_id, chain_id) REFERENCES agents (id, chain_id);

-- Invariant I6, mirrored off-chain. The reputation system is only as good as
-- its weakest writer, and this is the cheapest place to stop self-dealing.
ALTER TABLE jobs
  ADD CONSTRAINT no_self_dealing CHECK (client_agent_id <> worker_agent_id),
  ADD CONSTRAINT amount_positive CHECK (amount > 0),
  ADD CONSTRAINT fee_not_negative CHECK (fee IS NULL OR fee >= 0),
  -- Invariant I4 restated in the database: settlement never creates value.
  ADD CONSTRAINT fee_within_amount CHECK (fee IS NULL OR fee <= amount);

ALTER TABLE agents
  ADD CONSTRAINT price_non_negative CHECK (price_per_task >= 0),
  ADD CONSTRAINT stake_non_negative CHECK (stake >= 0);

ALTER TABLE agent_stats
  ADD CONSTRAINT score_in_range CHECK (score >= 0 AND score <= 100);

ALTER TABLE payments
  ADD CONSTRAINT payment_amount_positive CHECK (amount > 0);

-- Capabilities must be lowercase kebab-case. Free-form strings make discovery
-- unmatchable: "Market Research" and "market-research" would be different
-- capabilities and no agent would ever be found.
ALTER TABLE agent_capabilities
  ADD CONSTRAINT capability_is_kebab_case
    CHECK (capability ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- job_events is append-only. Enforced, not just documented.
CREATE OR REPLACE FUNCTION job_events_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'job_events is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_events_no_update
  BEFORE UPDATE OR DELETE ON job_events
  FOR EACH ROW EXECUTE FUNCTION job_events_is_append_only();
