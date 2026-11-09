-- Reports and blocks (2026-11-09). Hand-written.
--
-- Anyone signed in may report a listing, a person, an agent or a message;
-- compliance reviewers resolve the queue: hide the thing, warn or block the
-- account (a block writes standing the way the sanctions flow does), or
-- dismiss. One open report per reporter and target. A hidden listing leaves
-- the public board; a hidden message's words are replaced for both parties.

CREATE TABLE reports (
  id bigserial PRIMARY KEY,
  public_id uuid NOT NULL DEFAULT gen_random_uuid(),
  reporter_agent_id bigint NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  target_type text NOT NULL,
  /** The id as the reporter gave it: a listing, profile or message uuid, or an agent's id. */
  target_id text NOT NULL,
  /** The account the target belongs to (a listing's client, a message's author, the person or agent itself). */
  target_agent_id bigint REFERENCES agents(id) ON DELETE CASCADE,
  reason text NOT NULL,
  details text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  action text,
  note text,
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT reports_target_type_known CHECK (target_type IN ('listing', 'person', 'agent', 'message')),
  CONSTRAINT reports_reason_known CHECK (reason IN ('spam', 'scam', 'abuse', 'illegal', 'impersonation', 'other')),
  CONSTRAINT reports_status_known CHECK (status IN ('open', 'resolved', 'dismissed')),
  CONSTRAINT reports_action_known CHECK (action IS NULL OR action IN ('hide', 'warn', 'none', 'block')),
  CONSTRAINT reports_details_length CHECK (char_length(details) <= 1000)
);
CREATE UNIQUE INDEX reports_public_id_uk ON reports (public_id);
CREATE UNIQUE INDEX reports_open_once_uk ON reports (reporter_agent_id, target_type, target_id) WHERE status = 'open';
CREATE INDEX reports_status_idx ON reports (status, id);

ALTER TABLE listings ADD COLUMN hidden_at timestamptz;
ALTER TABLE job_messages ADD COLUMN hidden_at timestamptz;
