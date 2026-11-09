import type {FastifyInstance, FastifyRequest} from 'fastify';
import {and, asc, desc, eq, gt, lte, sql} from 'drizzle-orm';
import {z} from 'zod';
import {
  agentEventItemReads,
  agentEventReads,
  agentEventSeq,
  agentEvents,
  jobs,
  listings,
  type Db,
} from '@pactora/db';
import {ErrorCode, PactoraError} from '@pactora/shared';
import {actorOf} from '../actor.js';
import {CHAIN_KINDS, actorOf as whoActed, jobTitleOf, listingOfSpec} from '../read-model.js';

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
  /**
   * Default true: leave out what the reader did themselves, and the chain's
   * confirmation of an event already in the feed. `false` lists everything.
   */
  fold: z.enum(['true', 'false']).default('true'),
});

export const ReadBody = z.object({
  /** Everything up to and including this `seq` is read. */
  upTo: z.coerce.number().int().min(0),
});

type Row = typeof agentEvents.$inferSelect & {
  jobPublicId: string | null;
  listingPublicId: string | null;
  jobSpec: unknown;
  listingTitle: string | null;
};

/**
 * One feed item. `jobId` or `listingId` (or neither, for an account event)
 * says what it is about; `actor` and `confirmation` let a page fold the
 * chain's echo into the API's event and skip the reader's own actions;
 * `jobTitle` / `listingTitle` name it in words.
 */
const view = (r: Row) => {
  const fromSpec = listingOfSpec(r.jobSpec);
  return {
    seq: r.seq,
    kind: r.kind,
    role: r.role,
    jobId: r.jobPublicId,
    listingId: r.listingPublicId ?? fromSpec?.listingId ?? null,
    jobTitle: r.jobPublicId ? jobTitleOf(r.jobSpec) : null,
    listingTitle: r.listingTitle ?? fromSpec?.title ?? null,
    actor: whoActed(r.kind, r.role, r.payload),
    confirmation: CHAIN_KINDS.has(r.kind),
    payload: r.payload,
    at: r.createdAt.toISOString(),
  };
};

/** The feed rows with the public ids and words of what they are about: a job, a listing, or neither. */
const SELECT = {
  e: agentEvents,
  jobPublicId: jobs.publicId,
  listingPublicId: listings.publicId,
  jobSpec: jobs.spec,
  listingTitle: listings.title,
};
const withIds = (r: {
  e: typeof agentEvents.$inferSelect;
  jobPublicId: string | null;
  listingPublicId: string | null;
  jobSpec: unknown;
  listingTitle: string | null;
}) => ({
  ...r.e,
  jobPublicId: r.jobPublicId,
  listingPublicId: r.listingPublicId,
  jobSpec: r.jobSpec,
  listingTitle: r.listingTitle,
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
    const fold = q.fold === 'true';
    // Folded: a chain echo whose API event is in this agent's feed for the
    // same job is left out (the API event stands for both), and so is what
    // the reader did themselves.
    const echoed = sql`EXISTS (SELECT 1 FROM agent_events o WHERE o.agent_id = ${agentEvents.agentId}
      AND o.job_id = ${agentEvents.jobId} AND o.kind = 'job.' || ${agentEvents.kind})`;
    const isChainKind = sql`${agentEvents.kind} IN ('created', 'accepted', 'submitted', 'disputed', 'settled', 'refunded', 'direct_paid')`;
    const rows = await db
      .select(SELECT)
      .from(agentEvents)
      .leftJoin(jobs, eq(jobs.id, agentEvents.jobId))
      .leftJoin(listings, eq(listings.id, agentEvents.listingId))
      .where(
        and(
          eq(agentEvents.agentId, actor.agent.id),
          ...(q.before !== undefined ? [lte(agentEvents.seq, q.before - 1)] : []),
          ...(fold ? [sql`NOT (${isChainKind} AND ${echoed})`] : []),
        ),
      )
      .orderBy(desc(agentEvents.seq))
      .limit(fold ? q.limit * 3 : q.limit);
    const latest = await lastSeq(actor.agent.id);
    const readSeq =
      (await db.query.agentEventReads.findFirst({where: eq(agentEventReads.agentId, actor.agent.id)}))
        ?.readSeq ?? 0;
    const items = rows
      .map((r) => view(withIds(r)))
      .filter((v) => !fold || v.actor !== 'me')
      .slice(0, q.limit);
    const marked = new Set(
      (
        await db
          .select({seq: agentEventItemReads.seq})
          .from(agentEventItemReads)
          .where(and(eq(agentEventItemReads.agentId, actor.agent.id), gt(agentEventItemReads.seq, readSeq)))
      ).map((m) => m.seq),
    );
    // Paging continues from the last item shown, not the last row read (folding reads ahead).
    const oldest = items.length === q.limit ? items.at(-1)?.seq : rows.at(-1)?.e.seq;
    return {
      unread: Math.max(0, latest - readSeq - marked.size),
      readSeq,
      latest,
      before: oldest !== undefined && oldest > 1 ? oldest : null,
      notifications: items.map((v) => ({...v, read: v.seq <= readSeq || marked.has(v.seq)})),
    };
  });

  /** Mark one notification read, leaving the rest as they are. */
  app.post('/v1/notifications/:seq/read', async (request) => {
    const actor = await actorOf(db, request);
    const seq = Number((request.params as {seq: string}).seq);
    if (!Number.isSafeInteger(seq) || seq < 1)
      throw new PactoraError(ErrorCode.NOT_FOUND, 'no such notification');
    const row = await db.query.agentEvents.findFirst({
      where: and(eq(agentEvents.agentId, actor.agent.id), eq(agentEvents.seq, seq)),
    });
    if (!row) throw new PactoraError(ErrorCode.NOT_FOUND, `no notification ${seq}`);
    await db.insert(agentEventItemReads).values({agentId: actor.agent.id, seq}).onConflictDoNothing();
    return {seq, read: true};
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
