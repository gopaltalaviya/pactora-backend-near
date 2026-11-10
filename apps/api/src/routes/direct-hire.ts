import type {FastifyInstance} from 'fastify';
import {and, asc, eq} from 'drizzle-orm';
import {z} from 'zod';
import {agentCapabilities, agents, jobs, readTrust, type Db} from '@pactora/db';
import {
  AgentId,
  BaseUnits,
  Capability,
  ErrorCode,
  JobSpec,
  PactoraError,
  canonicalize,
} from '@pactora/shared';
import type {ChainConfig} from '@pactora/config';
import {actorOf} from '../actor.js';
import type {BudgetReader, ChainViewer} from '../chain-reads.js';
import {requireClear} from '../compliance.js';
import {specHashOf} from './jobs.js';
import {refuseNotHireableOn} from './listings.js';
import {createJobCall} from './person-actions.js';

/**
 * A person hires an agent directly, without a listing (POST /v1/jobs/hire).
 *
 * The same guards a person's selection of a bid passes (`/v1/listings/:id/
 * decide`), and the same effect: the job row is written before the browser
 * signs, so the indexer can link it, and the create_job call is handed back
 * to sign through person-actions prepare/confirm (`create`). Confirming it
 * records `job.created`, which is how the worker learns it was hired.
 *
 * Agents hire through POST /v1/jobs (the signer funds it); this route is a
 * person's only.
 */

export const DirectHireBody = z.object({
  /** The worker's API agent id. */
  workerAgentId: AgentId,
  /** Token base units. */
  amount: BaseUnits,
  task: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(2000)),
  capability: Capability.optional(),
  idempotencyKey: z.string().min(8).max(128),
});

export interface DirectHireDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  /** The client's on-chain purse: its per-task cap, when it can be read. */
  readBudget?: BudgetReader;
  /** Contract views; `stake_of` says whether the worker is hireable. */
  viewChain?: ChainViewer;
}

/** The capability a direct job names when the person names none and the worker lists none. */
const DEFAULT_CAPABILITY = 'direct-hire';

/** Namespaces the person's key among the job keys of its agent (listing jobs use `listing-application:`). */
const keyOf = (idempotencyKey: string) => `direct-hire:${idempotencyKey}`;

export async function registerDirectHireRoutes(app: FastifyInstance, deps: DirectHireDeps): Promise<void> {
  const {db, chains} = deps;

  app.post('/v1/jobs/hire', async (request, reply) => {
    const actor = await actorOf(db, request);
    if (actor.via !== 'person') {
      throw new PactoraError(ErrorCode.FORBIDDEN, 'direct hire is for people; agents use POST /v1/jobs');
    }
    const body = DirectHireBody.parse(request.body);
    const me = actor.agent;
    await requireClear(db, me.id, 'hire a worker');
    const chainId = me.chainId;
    const chain = chains[chainId];
    if (!chain) throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${chainId} is not enabled`);

    // ── the worker ──
    const workerId = Number(body.workerAgentId);
    const worker = Number.isSafeInteger(workerId)
      ? await db.query.agents.findFirst({where: eq(agents.id, workerId)})
      : undefined;
    if (!worker) throw new PactoraError(ErrorCode.NOT_FOUND, `no agent ${body.workerAgentId}`);
    if (worker.chainId !== chainId) {
      throw new PactoraError(
        ErrorCode.CHAIN_MISMATCH,
        `agent ${body.workerAgentId} is on chain ${worker.chainId}`,
      );
    }
    if (worker.id === me.id) throw new PactoraError(ErrorCode.FORBIDDEN, 'you cannot hire yourself');
    if (!worker.active) {
      throw new PactoraError(
        ErrorCode.AGENT_NOT_HIREABLE,
        `agent ${body.workerAgentId} is not accepting work`,
      );
    }
    if (!worker.chainAgentId || !me.chainAgentId) {
      throw new PactoraError(ErrorCode.AGENT_NOT_HIREABLE, 'an agent has no on-chain agent id yet', 2);
    }
    if (worker.ownerAddress.toLowerCase() === me.ownerAddress.toLowerCase()) {
      // The contract refuses it too (SameOwner): said before anything is signed.
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        'this worker has the same owner as you; the contract refuses that hire',
      );
    }
    await refuseNotHireableOn(db, deps.viewChain, chain, chainId, worker.id);
    const trust = await readTrust(db, {
      chainId,
      agentId: worker.id,
      floor: Number(chain.params['confidenceFloor'] ?? 25),
    });
    if (trust.action === 'block') {
      throw new PactoraError(
        ErrorCode.COUNTERPARTY_BLOCKED,
        `agent ${body.workerAgentId} is blocked (${trust.verdict}): ${trust.reasons.join('; ')}`,
      );
    }

    // ── the amount ──
    const amount = BigInt(body.amount);
    const {minJobAmount, maxJobAmount} = chain.params;
    if (amount < minJobAmount) {
      throw new PactoraError(
        ErrorCode.SCHEMA_MISMATCH,
        `amount ${chain.formatToken(amount)} is below the escrow minimum of ${chain.formatToken(minJobAmount)}`,
      );
    }
    if (amount > maxJobAmount) {
      throw new PactoraError(
        ErrorCode.SCHEMA_MISMATCH,
        `amount ${chain.formatToken(amount)} is above the escrow maximum of ${chain.formatToken(maxJobAmount)}`,
      );
    }
    // The contract enforces the cap on create_job; said here before signing.
    // Unreadable → not checked here.
    const budget = deps.readBudget
      ? await deps.readBudget({chainId, walletAddress: me.walletAddress}).catch(() => null)
      : null;
    if (budget && amount > budget.perTaskCap) {
      throw new PactoraError(
        ErrorCode.BUDGET_EXCEEDED,
        `amount ${chain.formatToken(amount)} is above your per-task cap of ${chain.formatToken(budget.perTaskCap)}`,
      );
    }

    // ── the capability ──
    const offered = (
      await db
        .select({capability: agentCapabilities.capability})
        .from(agentCapabilities)
        .where(eq(agentCapabilities.agentId, worker.id))
        .orderBy(asc(agentCapabilities.capability))
    ).map((r) => r.capability);
    if (body.capability && !offered.includes(body.capability)) {
      throw new PactoraError(
        ErrorCode.SCHEMA_MISMATCH,
        `agent ${body.workerAgentId} does not offer ${body.capability}; it offers ${offered.length ? offered.join(', ') : 'nothing listed'}`,
      );
    }
    const capability =
      body.capability ?? offered.find((c) => Capability.safeParse(c).success) ?? DEFAULT_CAPABILITY;
    const spec = JobSpec.parse({
      capability,
      input: {kind: 'direct', task: body.task},
      deadlineSeconds: Math.min(86_400, Math.max(10, chain.params.workWindowSeconds)),
    });

    // ── the job: idempotent on (client, key) ──
    const key = keyOf(body.idempotencyKey);
    const prior = await db.query.jobs.findFirst({
      where: and(eq(jobs.clientAgentId, me.id), eq(jobs.idempotencyKey, key)),
    });
    const job = prior ?? (await insert());
    if (
      job.workerAgentId !== worker.id ||
      job.amount !== amount.toString() ||
      canonicalize(job.spec) !== canonicalize(spec)
    ) {
      throw new PactoraError(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        `idempotencyKey ${body.idempotencyKey} was already used for a different hire`,
      );
    }

    async function insert() {
      const [inserted] = await db
        .insert(jobs)
        .values({
          chainId,
          clientAgentId: me.id,
          workerAgentId: worker!.id,
          path: 'escrow',
          amount: amount.toString(),
          spec,
          specHash: '',
          traceId: request.id,
          idempotencyKey: key,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted) {
        // A concurrent request with the same key won the insert.
        return (await db.query.jobs.findFirst({
          where: and(eq(jobs.clientAgentId, me.id), eq(jobs.idempotencyKey, key)),
        }))!;
      }
      const [row] = await db
        .update(jobs)
        .set({specHash: specHashOf(spec, inserted.publicId)})
        .where(eq(jobs.id, inserted.id))
        .returning();
      return row!;
    }

    const funding = job.chainJobId
      ? {by: 'person' as const, done: true}
      : {
          by: 'person' as const,
          done: false,
          signerId: me.walletAddress,
          functionCall: await createJobCall(db, chain, job),
          confirm: `/v1/jobs/${job.publicId}/person-actions/confirm`,
        };
    return reply.status(201).send({
      job: {
        jobId: job.publicId,
        chainJobId: job.chainJobId,
        state: job.state,
        amount: job.amount,
        amountDisplay: chain.formatToken(BigInt(job.amount)),
        specHash: job.specHash,
        spec: job.spec,
      },
      funding,
    });
  });
}
