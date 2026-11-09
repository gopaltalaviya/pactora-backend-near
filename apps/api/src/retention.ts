import {sql} from 'drizzle-orm';
import type {Db} from '@pactora/db';
import type {ObjectStore} from '@pactora/storage';

/**
 * Retention (docs/26 F27, 2026-11-09): what is kept for how long after a
 * job finishes, and the sweep that enforces it. Run by the API on a timer
 * (RETENTION_INTERVAL_MS, default hourly); `RETENTION_DRY_RUN=1` counts and
 * logs without changing anything.
 *
 * What goes, and what stays:
 * - evidence and dispute photos: the bytes leave the object store
 *   `evidenceDays` after the job settled or was refunded; the row keeps its
 *   sha256 (what every snapshot and the desk's hash named) under a
 *   `purged/` key;
 * - chat: a message's words become "[purged]" after `chatDays`;
 * - drafts: a snapshot's content becomes `{purged: true}` after
 *   `draftsDays`, its hash column kept (the chain committed to it);
 * - job events: a finished job's per-agent event copies (agent_events) are
 *   deleted after `jobEventsDays`; the job_events audit log itself is
 *   append-only (a trigger refuses deletes) and stays;
 * - agent_events a person has read: deleted after `agentEventsReadDays`.
 * Never touched: jobs, payments, token_transfers, reviews' ratings, the
 * compliance audit, anything on chain.
 */

export interface RetentionConfig {
  evidenceDays: number;
  chatDays: number;
  draftsDays: number;
  jobEventsDays: number;
  agentEventsReadDays: number;
  dryRun: boolean;
}

export const RETENTION_DEFAULTS: RetentionConfig = {
  evidenceDays: 180,
  chatDays: 180,
  draftsDays: 90,
  jobEventsDays: 365,
  agentEventsReadDays: 90,
  dryRun: false,
};

export type RetentionKind = 'evidenceFiles' | 'messages' | 'drafts' | 'jobEvents' | 'agentEvents';

export interface RetentionResult {
  dryRun: boolean;
  counts: Record<RetentionKind, number>;
}

/** Jobs that are finished: the clock runs from settlement (or, for a refund, the last event). */
const FINISHED = (cutoff: Date) =>
  sql`j.state IN ('settled', 'refunded')
      AND coalesce(j.settled_at, (SELECT max(e.occurred_at) FROM job_events e WHERE e.job_id = j.id), j.created_at) < ${cutoff.toISOString()}::timestamptz`;

export async function purgeRetention(
  db: Db,
  store: ObjectStore | undefined,
  cfg: Partial<RetentionConfig>,
  now = new Date(),
): Promise<RetentionResult> {
  const c = {...RETENTION_DEFAULTS, ...cfg};
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const counts: Record<RetentionKind, number> = {
    evidenceFiles: 0,
    messages: 0,
    drafts: 0,
    jobEvents: 0,
    agentEvents: 0,
  };
  const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];

  // Photos: the bytes go; the row keeps its hash under a key nothing serves.
  const files = await rows<{id: string | number; public_id: string; object_key: string}>(sql`
    SELECT f.id, f.public_id, f.object_key FROM job_files f JOIN jobs j ON j.id = f.job_id
     WHERE f.object_key NOT LIKE 'purged/%' AND ${FINISHED(ago(c.evidenceDays))} LIMIT 500`);
  counts.evidenceFiles = files.length;
  if (!c.dryRun) {
    for (const f of files) {
      if (store) await store.delete(f.object_key);
      await db.execute(sql`
        UPDATE job_files SET object_key = ${`purged/${f.public_id}`}, withdrawn_at = coalesce(withdrawn_at, now())
         WHERE id = ${Number(f.id)}`);
    }
  }

  const messages = await rows<{n: string | number}>(sql`
    SELECT count(*) AS n FROM job_messages m JOIN jobs j ON j.id = m.job_id
     WHERE m.body <> '[purged]' AND ${FINISHED(ago(c.chatDays))}`);
  counts.messages = Number(messages[0]?.n ?? 0);
  if (!c.dryRun && counts.messages > 0) {
    await db.execute(sql`
      UPDATE job_messages m SET body = '[purged]', hidden_at = coalesce(m.hidden_at, now())
        FROM jobs j WHERE j.id = m.job_id AND m.body <> '[purged]' AND ${FINISHED(ago(c.chatDays))}`);
  }

  const drafts = await rows<{n: string | number}>(sql`
    SELECT count(*) AS n FROM job_drafts d JOIN jobs j ON j.id = d.job_id
     WHERE NOT (d.snapshot ? 'purged') AND ${FINISHED(ago(c.draftsDays))}`);
  counts.drafts = Number(drafts[0]?.n ?? 0);
  if (!c.dryRun && counts.drafts > 0) {
    await db.execute(sql`
      UPDATE job_drafts d SET snapshot = jsonb_build_object('purged', true, 'snapshotHash', d.snapshot_hash)
        FROM jobs j WHERE j.id = d.job_id AND NOT (d.snapshot ? 'purged') AND ${FINISHED(ago(c.draftsDays))}`);
  }

  // Job events: the per-agent copies (agent_events) of a finished job's events
  // go after `jobEventsDays`, read or not. The job_events rows themselves
  // stay: that table is an append-only audit log guarded by a trigger
  // (0001_constraints.sql), and dropping that guard is the owner's call
  // (PROGRESS.md, "Owner decisions pending").
  const events = await rows<{n: string | number}>(sql`
    SELECT count(*) AS n FROM agent_events a JOIN jobs j ON j.id = a.job_id
     WHERE a.created_at < ${ago(c.jobEventsDays).toISOString()}::timestamptz AND ${FINISHED(ago(c.jobEventsDays))}`);
  counts.jobEvents = Number(events[0]?.n ?? 0);
  if (!c.dryRun && counts.jobEvents > 0) {
    await db.execute(sql`
      DELETE FROM agent_events a USING jobs j
       WHERE j.id = a.job_id AND a.created_at < ${ago(c.jobEventsDays).toISOString()}::timestamptz AND ${FINISHED(ago(c.jobEventsDays))}`);
  }

  // Read notifications: gone once old; unread ones wait for their reader.
  const read = await rows<{n: string | number}>(sql`
    SELECT count(*) AS n FROM agent_events a JOIN agent_event_reads r ON r.agent_id = a.agent_id
     WHERE a.seq <= r.read_seq AND a.created_at < ${ago(c.agentEventsReadDays).toISOString()}::timestamptz`);
  counts.agentEvents = Number(read[0]?.n ?? 0);
  if (!c.dryRun && counts.agentEvents > 0) {
    await db.execute(sql`
      DELETE FROM agent_events a USING agent_event_reads r
       WHERE r.agent_id = a.agent_id AND a.seq <= r.read_seq
         AND a.created_at < ${ago(c.agentEventsReadDays).toISOString()}::timestamptz`);
  }

  return {dryRun: c.dryRun, counts};
}
