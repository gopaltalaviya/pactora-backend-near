import type {FastifyInstance, FastifyRequest} from 'fastify';
import {and, asc, desc, eq, gt, lte, sql} from 'drizzle-orm';
import {z} from 'zod';
import {agentEventReads, agentEventSeq, agentEvents, jobs, listings, type Db} from '@pactora/db';
import {actorOf} from '../actor.js';

/**
 * A durable, per-agent feed of everything that happens on its jobs
 * (docs/26 F9, F10). The rows are written by a trigger on job_events, in
 * the same transaction, for the API's events and the indexer's alike, and
 * numbered per agent with no gaps: an agent that remembers the last `seq`
 * it handled and asks for `after=<seq>` misses nothing and sees nothing
 * twice, across restarts and replicas.
 *
 * A person's notifications are the same feed for their person agent, plus
 * how far they have read.
 */

export const EventsQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  /** Long-poll: wait up to this many seconds for something new when there is nothing yet. */
  wait: z.coerce.number().int().min(0).max(30).default(0),
});

export const NotificationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Page back: the oldest `seq` of the previous page. */
  before: z.coerce.number().int().min(1).optional(),
});

export const ReadBody = z.object({
  /** Everything up to and including this `seq` is read. */
  upTo: z.coerce.number().int().min(0),
});

type Row = typeof agentEvents.$inferSelect & {jobPublicId: string | null; listingPublicId: string | null};

/** One feed item. `jobId` or `listingId` (or neither, for an account event) says what it is about. */
const view = (r: Row) => ({
  seq: r.seq,
  kind: r.kind,
  role: r.role,
  jobId: r.jobPublicId,
  listingId: r.listingPublicId,
  payload: r.payload,
  at: r.createdAt.toISOString(),
});

/** The feed rows with the public ids of what they are about: a job, a listing, or neither. */
const SELECT = {e: agentEvents, jobPublicId: jobs.publicId, listingPublicId: listings.publicId};
const withIds = (r: {
  e: typeof agentEvents.$inferSelect;
  jobPublicId: string | null;
  listingPublicId: string | null;
}) => ({
  ...r.e,
  jobPublicId: r.jobPublicId,
  listingPublicId: r.listingPublicId,
});

export interface AgentEventRouteDeps {
  db: Db;
  /** How often a long-poll looks again; default 500 ms. */
  pollMs?: number;
}

export async function registerAgentEventRoutes(
  app: FastifyInstance,
  deps: AgentEventRouteDeps,
): Promise<void> {
  const {db} = deps;
  const pollMs = deps.pollMs ?? 500;

  const read = (agentId: number, after: number, limit: number) =>
    db
      .select(SELECT)
      .from(agentEvents)
      .leftJoin(jobs, eq(jobs.id, agentEvents.jobId))
      .leftJoin(listings, eq(listings.id, agentEvents.listingId))
      .where(and(eq(agentEvents.agentId, agentId), gt(agentEvents.seq, after)))
      .orderBy(asc(agentEvents.seq))
      .limit(limit + 1)
      .then((rows) => rows.map(withIds));

  const lastSeq = async (agentId: number) =>
    (await db.query.agentEventSeq.findFirst({where: eq(agentEventSeq.agentId, agentId)}))?.last ?? 0;

  /** Stops waiting when the caller goes away. */
  const gone = (request: FastifyRequest) => request.raw.destroyed || request.raw.socket?.destroyed === true;

  app.get('/v1/events', async (request) => {
    const actor = await actorOf(db, request);
    const q = EventsQuery.parse(request.query ?? {});
    const deadline = Date.now() + q.wait * 1000;
    let rows = await read(actor.agent.id, q.after, q.limit);
    while (rows.length === 0 && Date.now() < deadline && !gone(request)) {
      await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
      rows = await read(actor.agent.id, q.after, q.limit);
    }
    const more = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    return {
      agentId: actor.agent.publicId,
      after: q.after,
      next: page.at(-1)?.seq ?? q.after,
      more,
      latest: await lastSeq(actor.agent.id),
      events: page.map(view),
    };
  });

  app.get('/v1/notifications', async (request) => {
    const actor = await actorOf(db, request);
    const q = NotificationsQuery.parse(request.query ?? {});
    const rows = await db
      .select(SELECT)
      .from(agentEvents)
      .leftJoin(jobs, eq(jobs.id, agentEvents.jobId))
      .leftJoin(listings, eq(listings.id, agentEvents.listingId))
      .where(
        and(
          eq(agentEvents.agentId, actor.agent.id),
          ...(q.before !== undefined ? [lte(agentEvents.seq, q.before - 1)] : []),
        ),
      )
      .orderBy(desc(agentEvents.seq))
      .limit(q.limit);
    const latest = await lastSeq(actor.agent.id);
    const readSeq =
      (await db.query.agentEventReads.findFirst({where: eq(agentEventReads.agentId, actor.agent.id)}))
        ?.readSeq ?? 0;
    const oldest = rows.at(-1)?.e.seq;
    return {
      unread: Math.max(0, latest - readSeq),
      readSeq,
      latest,
      before: oldest !== undefined && oldest > 1 ? oldest : null,
      notifications: rows.map((r) => ({
        ...view(withIds(r)),
        read: r.e.seq <= readSeq,
      })),
    };
  });

  app.post('/v1/notifications/read', async (request) => {
    const actor = await actorOf(db, request);
    const body = ReadBody.parse(request.body ?? {});
    const latest = await lastSeq(actor.agent.id);
    // Never past what exists, and never backwards: a stale tab cannot un-read.
    const upTo = Math.min(body.upTo, latest);
    const [row] = await db
      .insert(agentEventReads)
      .values({agentId: actor.agent.id, readSeq: upTo})
      .onConflictDoUpdate({
        target: agentEventReads.agentId,
        set: {
          readSeq: sqlGreatest(upTo),
          updatedAt: new Date(),
        },
      })
      .returning({readSeq: agentEventReads.readSeq});
    const readSeq = row?.readSeq ?? upTo;
    return {readSeq, latest, unread: Math.max(0, latest - readSeq)};
  });
}

/** GREATEST(existing, given): the read mark only moves forward. */
const sqlGreatest = (n: number) => sql`GREATEST(${agentEventReads.readSeq}, ${n})`;
