-- The live-events channel is `pactora_events` (2026-11-09). Hand-written.
-- 0009 now creates pactora_notify_event() on a fresh database; a database
-- migrated before this gets it here, its two triggers are pointed at it,
-- and any older *_notify_event() function they used is dropped. The API
-- listens on the new channel (apps/api/src/live.ts EVENTS_CHANNEL).
CREATE OR REPLACE FUNCTION pactora_notify_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'job_events' THEN
    PERFORM pg_notify('pactora_events',
      json_build_object('kind', 'job', 'topic', NEW.job_id, 'id', NEW.id)::text);
  ELSE
    PERFORM pg_notify('pactora_events',
      json_build_object('kind', 'run', 'topic', NEW.run_id, 'id', NEW.id)::text);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER job_events_notify AFTER INSERT ON job_events
  FOR EACH ROW EXECUTE FUNCTION pactora_notify_event();
CREATE OR REPLACE TRIGGER run_events_notify AFTER INSERT ON run_events
  FOR EACH ROW EXECUTE FUNCTION pactora_notify_event();

DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE '%\_notify\_event' AND p.proname <> 'pactora_notify_event'
       AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid)
  LOOP
    EXECUTE format('DROP FUNCTION %s', f.sig);
  END LOOP;
END $$;
