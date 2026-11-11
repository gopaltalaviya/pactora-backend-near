import type {FastifyInstance, FastifyRequest} from 'fastify';
import {and, asc, desc, eq, inArray, sql} from 'drizzle-orm';
import {z} from 'zod';
import type {ChainConfig} from '@pactora/config';
import {agents, jobs, poolShares, pools} from '@pactora/db';
import {AgentId, BaseUnits, Capability, ErrorCode, PactoraError} from '@pactora/shared';
import {authenticate} from '../auth.js';
import type {BudgetReader} from '../chain-reads.js';
import {requireClear} from '../compliance.js';
import {hire, type JobRouteDeps} from './jobs.js';

/**
 * Collective purchasing (2026-11-11): several agents buy ONE piece of work
 * from one worker together, each paying an equal share.
 *
 * Nothing new on chain. Each member's share is an ordinary escrow job
 * (`create_job`) from that member's own wallet, so every share is bound by
 * that member's own per-task and daily caps, and the counterparty check, the
 * minimums and idempotency are the hire path's own code (`hire()`). The
 * worker accepts every share and submits the same output to each; a job's
 * result hash is the sha256 of its output, so the shares carry the same
 * result hash on chain: one delivery, provably the same, paid once per
 * member. Each member approves (or disputes) only its own share.
 *
 * Why it matters: a piece of work can cost more than any one buyer's
 * per-task cap allows. Pooling buys it without raising anyone's cap.
 *
 * Agents only, on both sides. Reads are public: a pool is shareable evidence,
 * like a job.
 */

export const PoolBody = z.object({
  /** The worker's API agent id. */
  workerAgentId: AgentId,
  title: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(3).max(140)),
  capability: Capability,
  /** Task input, the same for every share. Opaque to the protocol. */
  input: z.record(z.string(), z.unknown()).default({}),
  /** What each member pays, in token base units. */
  shareAmount: BaseUnits,
  /** How many members (2–10), the lead included. */
  shares: z.number().int().min(2).max(10),
  acceptWindowSeconds: z.number().int().positive().optional(),
  workWindowSeconds: z.number().int().positive().optional(),
});

export const PoolListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type PoolRouteDeps = Pick<JobRouteDeps, 'db' | 'bus' | 'submit' | 'chains'> & {
  readBudget?: BudgetReader;
};

type PoolRow = typeof pools.$inferSelect;

/** How long a share may be held with no job behind it before another member can take it. */
export const STALE_SLOT_MS = 10 * 60_000;

/** What a pool is now, from its shares' jobs. */
export function poolState(
  shares: number,
  jobStates: readonly string[],
): 'open' | 'funded' | 'delivered' | 'settled' | 'disputed' | 'unwound' {
  const live = jobStates.filter((s) => s !== 'refunded' && s !== 'settled');
  // Refunded shares end a pool only once nothing else is still running.
  if (jobStates.some((s) => s === 'refunded') && live.length === 0) return 'unwound';
  if (jobStates.some((s) => s === 'disputed')) return 'disputed';
  if (jobStates.length < shares) return 'open';
  if (jobStates.every((s) => s === 'settled')) return 'settled';
  if (jobStates.every((s) => s === 'submitted' || s === 'settled')) return 'delivered';
  return 'funded';
}

/** The job spec every share commits to: the same task, tagged with the pool. */
function shareSpec(pool: Pick<PoolRow, 'publicId' | 'spec' | 'shares' | 'shareAmount'>) {
  const spec = pool.spec as {capability: string; input: Record<string, unknown>};
  return {
    capability: spec.capability,
    input: {
      ...spec.input,
      pool: {id: pool.publicId, shares: pool.shares, shareAmount: pool.shareAmount},
    },
  };
}

export async function registerPoolRoutes(app: FastifyInstance, deps: PoolRouteDeps): Promise<void> {
  const {db, chains} = deps;

  const chainOf = (chainId: string): ChainConfig => {
    const chain = chains[chainId];
    if (!chain) throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${chainId} is not enabled`);
    return chain;
  };

  async function agentRow(id: number) {
    return Number.isSafeInteger(id) ? db.query.agents.findFirst({where: eq(agents.id, id)}) : undefined;
  }

  /** Refused before anything is signed: what the contract or the hire path would refuse later. */
  async function checkMember(
    me: NonNullable<Awaited<ReturnType<typeof agentRow>>>,
    worker: NonNullable<Awaited<ReturnType<typeof agentRow>>>,
    shareAmount: bigint,
  ) {
    if (me.kind !== 'agent') {
      throw new PactoraError(ErrorCode.FORBIDDEN, 'pools are for agents; a person hires through a listing');
    }
    if (me.id === worker.id)
      throw new PactoraError(ErrorCode.FORBIDDEN, 'the worker cannot buy into its own pool');
    if (me.ownerAddress.toLowerCase() === worker.ownerAddress.toLowerCase()) {
      // The contract refuses it too (SameOwner).
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        'this worker has the same owner as you; the contract refuses that hire',
      );
    }
    const budget = deps.readBudget
      ? await deps.readBudget({chainId: me.chainId, walletAddress: me.walletAddress}).catch(() => null)
      : null;
    if (budget && shareAmount > budget.perTaskCap) {
      const chain = chainOf(me.chainId);
      throw new PactoraError(
        ErrorCode.BUDGET_EXCEEDED,
        `a share of ${chain.formatToken(shareAmount)} is above your per-task cap of ${chain.formatToken(budget.perTaskCap)}`,
      );
    }
  }

  /** Take a share and fund it: a slot first (so a full pool refuses), then the hire. */
  async function join(
    request: FastifyRequest,
    caller: Awaited<ReturnType<typeof authenticate>>,
    pool: PoolRow,
  ) {
    const me = await agentRow(caller.agentId);
    const worker = await agentRow(pool.workerAgentId);
    if (!me || !worker) throw new PactoraError(ErrorCode.NOT_FOUND, 'agent not found');
    if (me.chainId !== pool.chainId) {
      throw new PactoraError(ErrorCode.CHAIN_MISMATCH, `this pool is on chain ${pool.chainId}`);
    }
    await requireClear(db, me.id, 'buy into a pool');
    // The worker may have stopped taking work since the pool opened: no share
    // is funded to it then (hire() is called with the pool's terms, which
    // skips its own active check).
    if (worker.kind !== 'agent' || !worker.active) {
      throw new PactoraError(
        ErrorCode.AGENT_NOT_HIREABLE,
        `agent ${pool.workerAgentId} is not accepting work`,
      );
    }
    const shareAmount = BigInt(pool.shareAmount);
    await checkMember(me, worker, shareAmount);

    // A member that already holds a share retries ITS share (same job,
    // same idempotency key): a lost answer is never a second payment.
    let share = await db.query.poolShares.findFirst({
      where: and(eq(poolShares.poolId, pool.id), eq(poolShares.agentId, me.id)),
    });
    if (!share) {
      // A slot whose hire never produced a job (the member gave up after a
      // refusal) is freed after STALE_SLOT_MS, so it cannot block the pool.
      await db.execute(sql`
        DELETE FROM pool_shares s
         WHERE s.pool_id = ${pool.id} AND s.job_id IS NULL
           AND s.created_at < now() - make_interval(secs => ${STALE_SLOT_MS / 1000})
           AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.client_agent_id = s.agent_id
                           AND j.idempotency_key = ${`pool:${pool.publicId}`})`);
      const taken = await db
        .select({slot: poolShares.slot})
        .from(poolShares)
        .where(eq(poolShares.poolId, pool.id));
      const used = new Set(taken.map((t) => t.slot));
      for (let slot = 1; slot <= pool.shares && !share; slot++) {
        if (used.has(slot)) continue;
        const [row] = await db
          .insert(poolShares)
          .values({poolId: pool.id, slot, agentId: me.id})
          .onConflictDoNothing()
          .returning();
        if (row) share = row;
        else {
          // Lost the slot to a concurrent join, or this member joined twice at once.
          const mine = await db.query.poolShares.findFirst({
            where: and(eq(poolShares.poolId, pool.id), eq(poolShares.agentId, me.id)),
          });
          if (mine) share = mine;
        }
      }
      if (!share) throw new PactoraError(ErrorCode.INVALID_STATE, 'this pool is full');
    }

    const chain = chainOf(pool.chainId);
    const held = share;
    const release = async () => {
      // A refused hire must not keep the slot: another member could fund it.
      if (!held.jobId) {
        await db
          .delete(poolShares)
          .where(
            and(
              eq(poolShares.poolId, pool.id),
              eq(poolShares.slot, held.slot),
              sql`${poolShares.jobId} IS NULL`,
            ),
          );
      }
    };
    const funded = await hire(
      {db: deps.db, bus: deps.bus, submit: deps.submit},
      {
        caller,
        chainId: pool.chainId,
        chain,
        idempotencyKey: `pool:${pool.publicId}`,
        traceId: request.id,
      },
      {
        workerAgentId: String(pool.workerAgentId),
        spec: {...shareSpec(pool), deadlineSeconds: 120},
        maxPrice: pool.shareAmount,
        path: 'escrow',
      },
      {
        amount: shareAmount,
        acceptWindowSeconds: pool.acceptWindowSeconds,
        workWindowSeconds: pool.workWindowSeconds,
      },
    ).catch(async (err: unknown) => {
      // A hire whose row exists (signer refused after insert) keeps its slot
      // for the retry under the same key; one that never got a row frees it.
      const prior = await db.query.jobs.findFirst({
        where: and(eq(jobs.clientAgentId, me.id), eq(jobs.idempotencyKey, `pool:${pool.publicId}`)),
      });
      if (!prior) await release();
      throw err;
    });
    const job = await db.query.jobs.findFirst({where: eq(jobs.publicId, funded.jobId)});
    if (job && share.jobId !== job.id) {
      await db
        .update(poolShares)
        .set({jobId: job.id})
        .where(and(eq(poolShares.poolId, pool.id), eq(poolShares.slot, share.slot)));
    }
    return {slot: share.slot, ...funded};
  }

  async function view(pool: PoolRow) {
    const chain = chains[pool.chainId];
    const rows = await db
      .select({
        slot: poolShares.slot,
        agentId: poolShares.agentId,
        name: agents.name,
        jobId: jobs.publicId,
        chainJobId: jobs.chainJobId,
        state: jobs.state,
        resultHash: jobs.resultHash,
      })
      .from(poolShares)
      .innerJoin(agents, eq(agents.id, poolShares.agentId))
      .leftJoin(jobs, eq(jobs.id, poolShares.jobId))
      .where(eq(poolShares.poolId, pool.id))
      .orderBy(asc(poolShares.slot));
    const worker = await agentRow(pool.workerAgentId);
    const lead = await agentRow(pool.leadAgentId);
    const funded = rows.filter((r) => r.state);
    const hashes = new Set(funded.map((r) => r.resultHash).filter((h): h is string => Boolean(h)));
    const shareAmount = BigInt(pool.shareAmount);
    return {
      poolId: pool.publicId,
      chainId: pool.chainId,
      network: chain?.name ?? pool.chainId,
      title: pool.title,
      capability: (pool.spec as {capability?: string}).capability ?? null,
      lead: {agentId: String(pool.leadAgentId), name: lead?.name ?? null},
      worker: {agentId: String(pool.workerAgentId), name: worker?.name ?? null},
      shares: pool.shares,
      filled: rows.length,
      shareAmount: pool.shareAmount,
      shareAmountDisplay: chain ? chain.formatToken(shareAmount) : pool.shareAmount,
      total: (shareAmount * BigInt(pool.shares)).toString(),
      totalDisplay: chain ? chain.formatToken(shareAmount * BigInt(pool.shares)) : null,
      state: poolState(
        pool.shares,
        funded.map((r) => r.state as string),
      ),
      /** The one result hash every delivered share carries; null until delivered, or if they differ. */
      resultHash: hashes.size === 1 && funded.every((r) => r.resultHash) ? [...hashes][0]! : null,
      sameDelivery: hashes.size <= 1,
      members: rows.map((r) => ({
        slot: r.slot,
        agentId: String(r.agentId),
        name: r.name,
        jobId: r.jobId ?? null,
        chainJobId: r.chainJobId ?? null,
        state: r.state ?? 'funding',
      })),
      createdAt: pool.createdAt,
    };
  }

  async function poolByPublicId(id: string) {
    if (!z.uuid().safeParse(id).success) throw new PactoraError(ErrorCode.NOT_FOUND, 'no such pool');
    const pool = await db.query.pools.findFirst({where: eq(pools.publicId, id)});
    if (!pool) throw new PactoraError(ErrorCode.NOT_FOUND, 'no such pool');
    return pool;
  }

  /** Open a pool and take the first share (the lead funds its own share now). */
  app.post('/v1/pools', async (request, reply) => {
    const caller = await authenticate(db, request);
    await requireClear(db, caller.agentId, 'open a pool');
    const body = PoolBody.parse(request.body);
    const me = await agentRow(caller.agentId);
    const worker = await agentRow(Number(body.workerAgentId));
    if (!me) throw new PactoraError(ErrorCode.NOT_FOUND, 'agent not found');
    if (!worker) throw new PactoraError(ErrorCode.NOT_FOUND, `no agent ${body.workerAgentId}`);
    if (worker.chainId !== me.chainId) {
      throw new PactoraError(
        ErrorCode.CHAIN_MISMATCH,
        `agent ${body.workerAgentId} is on chain ${worker.chainId}`,
      );
    }
    if (worker.kind !== 'agent' || !worker.active) {
      throw new PactoraError(
        ErrorCode.AGENT_NOT_HIREABLE,
        `agent ${body.workerAgentId} is not accepting work`,
      );
    }
    const chain = chainOf(me.chainId);
    const shareAmount = BigInt(body.shareAmount);
    const {minJobAmount, maxJobAmount} = chain.params;
    if (shareAmount < minJobAmount || shareAmount > maxJobAmount) {
      throw new PactoraError(
        ErrorCode.SCHEMA_MISMATCH,
        `a share must be between ${chain.formatToken(minJobAmount)} and ${chain.formatToken(maxJobAmount)}`,
      );
    }
    const accept = body.acceptWindowSeconds ?? chain.params.acceptWindowSeconds;
    const work = body.workWindowSeconds ?? chain.params.workWindowSeconds;
    if (accept > chain.params.maxAcceptWindowSeconds || work > chain.params.maxWorkWindowSeconds) {
      throw new PactoraError(
        ErrorCode.SCHEMA_MISMATCH,
        `windows must be at most ${chain.params.maxAcceptWindowSeconds} s to accept and ${chain.params.maxWorkWindowSeconds} s to work on this chain`,
      );
    }
    await checkMember(me, worker, shareAmount);

    const [pool] = await db
      .insert(pools)
      .values({
        chainId: me.chainId,
        leadAgentId: me.id,
        workerAgentId: worker.id,
        title: body.title,
        spec: {capability: body.capability, input: {...body.input, title: body.title}},
        shareAmount: body.shareAmount,
        shares: body.shares,
        acceptWindowSeconds: accept,
        workWindowSeconds: work,
      })
      .returning();
    let share;
    try {
      share = await join(request, caller, pool!);
    } catch (err) {
      // The lead's share is what opens the pool: refused, there is no pool.
      // Only if no job exists under its key: a hire that broadcast and then
      // failed to answer keeps the pool, so the lead's retry finds its share.
      const job = await db.query.jobs.findFirst({
        where: and(eq(jobs.clientAgentId, caller.agentId), eq(jobs.idempotencyKey, `pool:${pool!.publicId}`)),
      });
      if (!job) await db.delete(pools).where(eq(pools.id, pool!.id));
      throw err;
    }
    return reply.status(201).send({pool: await view(pool!), share});
  });

  /** Take a share: fund it from your own wallet, into escrow. */
  app.post('/v1/pools/:id/join', async (request, reply) => {
    const caller = await authenticate(db, request);
    const pool = await poolByPublicId((request.params as {id: string}).id);
    const share = await join(request, caller, pool);
    return reply.status(201).send({pool: await view(pool), share});
  });

  /** Public, like a job: the shares, their jobs, and whether one delivery reached them all. */
  app.get('/v1/pools/:id', async (request) =>
    view(await poolByPublicId((request.params as {id: string}).id)),
  );

  /** Public: the latest pools, newest first. */
  app.get('/v1/pools', async (request) => {
    const {limit} = PoolListQuery.parse(request.query ?? {});
    const enabled = Object.keys(chains);
    if (enabled.length === 0) return {count: 0, pools: []};
    const rows = await db
      .select()
      .from(pools)
      .where(inArray(pools.chainId, enabled))
      .orderBy(desc(pools.createdAt), desc(pools.id))
      .limit(limit);
    const out = [];
    for (const p of rows) out.push(await view(p));
    return {count: out.length, pools: out};
  });
}
