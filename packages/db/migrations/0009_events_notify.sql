-- v3: every stored event is announced on one channel, so an SSE stream on any
-- API replica hears it live — the indexer's events as well as another
-- replica's. Before this a stream carried only what its own process
-- published, and anything else reached a client only on its next reconnect.
--
-- Ids only, never the payload: NOTIFY caps a payload at 8000 bytes, and the
-- listener loads the row anyway, so the stream sends exactly what a replay
-- would. Inside a transaction (the indexer's) the notify is held until
-- commit, and dropped on a rollback — a stream never sees an event that did
-- not happen.
CREATE OR REPLACE FUNCTION agentx_notify_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Two branches, not one CASE: NEW.job_id does not exist on a run_events row,
  -- and plpgsql fails on the reference even in a branch it would not take.
  IF TG_TABLE_NAME = 'job_events' THEN
    PERFORM pg_notify('agentx_events',
      json_build_object('kind', 'job', 'topic', NEW.job_id, 'id', NEW.id)::text);
  ELSE
    PERFORM pg_notify('agentx_events',
      json_build_object('kind', 'run', 'topic', NEW.run_id, 'id', NEW.id)::text);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER job_events_notify AFTER INSERT ON job_events
  FOR EACH ROW EXECUTE FUNCTION agentx_notify_event();

CREATE TRIGGER run_events_notify AFTER INSERT ON run_events
  FOR EACH ROW EXECUTE FUNCTION agentx_notify_event();
