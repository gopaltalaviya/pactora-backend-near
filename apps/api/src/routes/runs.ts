import type {FastifyInstance} from 'fastify';
import {and, asc, desc, eq, gt, lt} from 'drizzle-orm';
import {z} from 'zod';
import {runEvents, runs, type Db} from '@pactora/db';
import {PactoraError, ErrorCode} from '@pactora/shared';
import type {ChainConfig} from '@pactora/config';
import {authenticate, resolveChainId} from '../auth.js';
import {isPublicId} from './jobs.js';
import {Cursor, page} from '../cursor.js';
import {lastEventIdOf, streamEventOf, streamEvents, type EventBus} from '../events.js';
import type {RunService} from '../runs.js';

/**
 * Orchestrator runs: one goal in, a trace and an answer out.
 *
 * This is what the live demo page is built on. A run is started, its id comes
 * back immediately, and everything after that is read from the stream — so
 * the page can show the first event rather than joining halfway through.
 *
 * Reading a run is public. The trace is the thing being demonstrated, and a
 * judge following a link should not need a key to watch it; starting one is
 * not, because it spends.
 */

export const StartRun = z.object({
  goal: z.string().min(3).max(2_000),
});

export interface RunRouteDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  runBus: EventBus;
  /** Absent when no model is configured; starting a run then fails cleanly. */
  runs?: RunService;
}

export const RunListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** v3: the `nextCursor` of the previous page. */
  cursor: Cursor.optional(),
});

export async function registerRunRoutes(app: FastifyInstance, deps: RunRouteDeps): Promise<void> {
  const {db, chains, runBus} = deps;
  const enabled = Object.keys(chains);

  app.post('/v1/runs', async (request, reply) => {
    const caller = await authenticate(db, request);
    const chainId = resolveChainId(request, caller, enabled);

    if (!deps.runs) {
      throw new PactoraError(
        ErrorCode.CHAIN_NOT_ENABLED,
        'this deployment has no orchestrator configured — set a model provider key and restart',
      );
    }

    const {goal} = StartRun.parse(request.body);

    // The API key is carried into the run because the orchestrator acts AS
    // this agent: it hires under this agent's identity and spends under this
    // agent's on-chain caps. A run that ran under anything else would not be
    // bounded by the caps the owner actually set.
    const auth = (request.headers.authorization ?? '').slice('Bearer '.length).trim();
    const {publicId} = await deps.runs.start({chainId, agentId: caller.agentId, apiKey: auth, goal});

    return reply.status(202).send({
      runId: publicId,
      chainId,
      state: 'running',
      /** Subscribe here before the first event lands. */
      eventsUrl: `/v1/runs/${publicId}/events`,
    });
  });

  app.get('/v1/runs', async (request) => {
    const caller = await authenticate(db, request);
    // Validated: `?limit=abc` used to become NaN and reach Postgres.
    const {limit, cursor} = RunListQuery.parse(request.query ?? {});

    const fetched = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.agentId, caller.agentId),
          eq(runs.chainId, caller.chainId),
          // v3: newest first, so the next page is older than the cursor.
          cursor !== undefined ? lt(runs.id, cursor) : undefined,
        ),
      )
      // Newest first here, unlike jobs: a list of runs is a history to browse,
      // not a queue to work through.
      .orderBy(desc(runs.id))
      .limit(limit + 1);
    const {rows, nextCursor} = page(fetched, limit);

    return {count: rows.length, nextCursor, runs: rows.map(summarise)};
  });

  app.get('/v1/runs/:id', async (request) => {
    const run = await load(request.params as {id: string});
    const events = await db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, run.id))
      .orderBy(asc(runEvents.id));

    return {
      ...summarise(run),
      answer: run.answer,
      steps: run.steps,
      error: run.error,
      events: events.map((e) => ({kind: e.kind, payload: e.payload, occurredAt: e.occurredAt})),
    };
  });

  app.get('/v1/runs/:id/events', async (request, reply) => {
    const run = await load(request.params as {id: string});
    // v3: a reconnect resumes after the last event it saw.
    const after = lastEventIdOf(request);
    // The query runs inside streamEvents, after it has subscribed: see there.
    await streamEvents(reply, runBus, run.id, async () => {
      const past = await db
        .select()
        .from(runEvents)
        .where(
          after === null
            ? eq(runEvents.runId, run.id)
            : and(eq(runEvents.runId, run.id), gt(runEvents.id, after)),
        )
        .orderBy(asc(runEvents.id));
      return past.map(streamEventOf);
    });
    return reply;
  });

  async function load(params: {id: string}) {
    const run = isPublicId(params.id)
      ? await db.query.runs.findFirst({where: eq(runs.publicId, params.id)})
      : undefined;
    if (!run) throw new PactoraError(ErrorCode.NOT_FOUND, `no run ${params.id}`);
    return run;
  }

  function summarise(run: typeof runs.$inferSelect) {
    const chain = chains[run.chainId];
    return {
      runId: run.publicId,
      chainId: run.chainId,
      network: chain?.name ?? String(run.chainId),
      testnet: chain?.testnet ?? true,
      goal: run.goal,
      state: run.state,
      spent: run.spent,
      spentDisplay: chain ? chain.formatToken(BigInt(run.spent)) : run.spent,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  }
}
