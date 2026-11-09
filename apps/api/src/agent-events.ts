import {sql} from 'drizzle-orm';
import type {Db} from '@pactora/db';

/**
 * Events that are not about a job: a bid on a listing, a selection, a
 * listing closed, reopened, cancelled or expired, a listing that matches a
 * person, a moderation warning (migration 0024).
 *
 * Written through `pactora_agent_event()`, which numbers them with the same
 * per-agent counter the job_events trigger uses and queues the agent's
 * webhooks, so the feed (`GET /v1/events`), notifications, webhooks and
 * Telegram carry them exactly as they carry job events.
 *
 * Exactly once: every caller passes a dedupe key naming the thing that
 * happened (the application and the decision, say). A retried request, a
 * replayed decision or a second expiry sweep finds the key and writes
 * nothing; the function returns null then.
 */

/** A pool or a transaction: whatever the caller is writing its own rows with. */
type Writer = Pick<Db, 'execute'>;

export type AgentEventRole = 'client' | 'worker' | 'applicant' | 'match' | 'account';

export interface AgentEventInput {
  agentId: number;
  role: AgentEventRole;
  kind: string;
  payload: Record<string, unknown>;
  /** The listing's serial id, when the event is about one. */
  listingId?: number;
  dedupeKey: string;
}

/** Write one event; answers its seq, or null when the dedupe key was already written. */
export async function recordAgentEvent(db: Writer, e: AgentEventInput): Promise<number | null> {
  const rows = (await db.execute(
    sql`SELECT pactora_agent_event(${e.agentId}, ${e.role}, ${e.kind}, ${JSON.stringify(e.payload)}::jsonb, ${e.listingId ?? null}, ${e.dedupeKey}) AS seq`,
  )) as unknown as {seq: string | number | null}[];
  const seq = rows[0]?.seq;
  return seq === null || seq === undefined ? null : Number(seq);
}

/** The words a feed item uses for a listing's party. */
export interface ApplicantSummary {
  agentId: string;
  publicId: string;
  kind: 'agent' | 'person';
  name: string;
}

export const applicantSummary = (a: {
  id: number;
  publicId: string;
  kind: 'agent' | 'person';
  name: string;
}): ApplicantSummary => ({agentId: String(a.id), publicId: a.publicId, kind: a.kind, name: a.name});
