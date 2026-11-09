-- Per-item read marks for notifications (2026-11-09, UI audit). Hand-written.
-- `agent_event_reads.read_seq` marks everything up to a seq; this marks one
-- item, for a page that opens a notification without reading the rest.
CREATE TABLE agent_event_item_reads (
  agent_id bigint NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, seq)
);
