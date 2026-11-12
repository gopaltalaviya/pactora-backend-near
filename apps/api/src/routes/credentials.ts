import type {FastifyInstance} from 'fastify';
import {and, desc, eq, lt, or, sql} from 'drizzle-orm';
import {agents, credentials, jobReviews, jobs, type Db} from '@pactora/db';
import type {ChainConfig} from '@pactora/config';
import {canonicalize, ErrorCode, PactoraError} from '@pactora/shared';
import {actorOf} from '../actor.js';
import {requireClear} from '../compliance.js';
import type {ChainViewer} from '../chain-reads.js';
import type {CredentialMetadata, CredentialMint} from '../submit.js';
import {isPublicId} from './jobs.js';

/**
 * Work credentials (feature/work-credentials).
 *
 * When a job settles, its worker may claim one soulbound NEP-171 token on
 * the chain's `Credentials` contract: token id = the chain job id, minted to
 * the worker's wallet, its metadata recording who paid, how much, for what
 * (spec and result hashes) and the review hash. The metadata is built here,
 * from the job row, its accepted review and the two agents — never from
 * anything the caller sends.
 *
 * Idempotent per job, with the faucet's claim lifecycle (routes/faucet.ts):
 * the claim row is written FIRST (unique per job), a mint the signer
 * certainly did not make frees it, and one whose outcome is unknown keeps it
 * as `failed`. Before any mint, `nft_token` is read: a token that is already
 * there is recorded, never minted twice.
 *
 * A refused mint is checked against `nft_token` again before the claim is
 * freed: a duplicate id (or a race with an earlier attempt that landed) means
 * the token exists, and a token held by the worker is recorded as minted.
 *
 * Escrow jobs only: a direct-pay job is `settled` the moment it is created,
 * so it proves no completed work, and would let two agents of one owner
 * drain the minter's storage NEAR. On top, at most `perWorkerPerDay` new
 * claims per worker agent per UTC day.
 *
 * Optional: no `Credentials` contract in the chain config, or no minter on
 * the signer, and the claim answers 503 while GET says `available: false`.
 */

export interface CredentialRouteDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  mint?: CredentialMint;
  viewChain?: ChainViewer;
  now?: () => Date;
  /** New claims per worker agent per UTC day (CREDENTIALS_PER_WORKER_PER_DAY). Default 20. */
  perWorkerPerDay?: number;
}

export const DEFAULT_CREDENTIALS_PER_WORKER_PER_DAY = 20;

/**
 * The codes after which the signer's own call minted nothing (the contract
 * refused, or nothing was sent). A duplicate id is IDEMPOTENCY_CONFLICT —
 * deliberately not here: that token exists. Even so, `nft_token` is read
 * again before a claim is freed.
 */
const NOT_MINTED = new Set<string>([
  ErrorCode.INVALID_STATE,
  ErrorCode.INSUFFICIENT_FUNDS,
  ErrorCode.SCHEMA_MISMATCH,
  ErrorCode.FORBIDDEN,
  ErrorCode.BUDGET_EXCEEDED,
]);

/**
 * A claim's stamp: `updated_at` at millisecond precision, so the value this
 * request read back (a JS Date) compares EQUAL to the row. Every write after
 * the claim is guarded by it: a request that stalled past STALE_PENDING_MS
 * and was taken over finds a newer stamp, and its write touches nothing.
 */
const STAMP = sql`date_trunc('milliseconds', now())`;

/** A `pending` claim older than this was left by a crash and may be taken over. */
const STALE_PENDING_MS = 2 * 60_000;

/** The badge: a small inline SVG, base64 so it is a valid `media` URI as it stands. */
export function credentialBadge(chainJobId: string): string {
  const id = chainJobId.replace(/\D/g, '');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">' +
    '<rect width="240" height="240" rx="28" fill="#0f172a"/>' +
    '<circle cx="120" cy="92" r="40" fill="none" stroke="#38bdf8" stroke-width="8"/>' +
    '<path d="M100 92l14 14 26-28" fill="none" stroke="#38bdf8" stroke-width="8"/>' +
    '<text x="120" y="170" font-family="sans-serif" font-size="22" fill="#f8fafc" text-anchor="middle">PACTORA</text>' +
    `<text x="120" y="200" font-family="sans-serif" font-size="16" fill="#94a3b8" text-anchor="middle">job #${id}</text>` +
    '</svg>';
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

type JobRow = typeof jobs.$inferSelect;
type CredentialRow = typeof credentials.$inferSelect;

export async function registerCredentialRoutes(
  app: FastifyInstance,
  deps: CredentialRouteDeps,
): Promise<void> {
  const {db} = deps;
  const now = deps.now ?? (() => new Date());
  const perWorkerPerDay = deps.perWorkerPerDay ?? DEFAULT_CREDENTIALS_PER_WORKER_PER_DAY;

  const loadJob = async (id: string): Promise<JobRow> => {
    if (!isPublicId(id)) throw new PactoraError(ErrorCode.NOT_FOUND, `no job ${id}`);
    const job = await db.query.jobs.findFirst({where: eq(jobs.publicId, id)});
    if (!job) throw new PactoraError(ErrorCode.NOT_FOUND, `no job ${id}`);
    return job;
  };
  const contractOf = (job: JobRow) => deps.chains[job.chainId]?.contracts['Credentials'] ?? null;
  const available = (job: JobRow) => Boolean(deps.mint && deps.viewChain && contractOf(job));

  const view = (job: JobRow, row: CredentialRow | undefined) => {
    const chain = deps.chains[job.chainId];
    const txHash = row?.txHash ?? null;
    return {
      jobId: job.publicId,
      status: !row ? 'none' : row.status === 'minted' ? 'minted' : 'pending',
      tokenId: row?.tokenId ?? null,
      contract: contractOf(job),
      receiver: row?.receiver ?? null,
      txHash,
      explorerUrl: txHash && chain ? chain.explorerTx(txHash) : null,
    };
  };

  /** NEP-177 metadata from the job, its accepted review and the two agents' wallets. */
  const metadataOf = async (job: JobRow, chain: ChainConfig, worker: string): Promise<CredentialMetadata> => {
    const client = await db.query.agents.findFirst({where: eq(agents.id, job.clientAgentId)});
    if (!client) throw new PactoraError(ErrorCode.NOT_FOUND, `the job's client agent is gone`);
    const [review] = await db
      .select({reviewHash: jobReviews.reviewHash})
      .from(jobReviews)
      .where(and(eq(jobReviews.jobId, job.id), eq(jobReviews.decision, 'accept_draft')))
      .orderBy(desc(jobReviews.id))
      .limit(1);
    const id = job.chainJobId!;
    const amount = String(job.amount);
    // The contract's own record is the truth for the review hash: a judged
    // approval (NEAR AI verdict) puts it there, with no review draft in our DB.
    // Unreadable → no mint: a credential must never carry guessed data.
    const onChain = (await deps.viewChain!(job.chainId, chain.contracts.Pactora, 'get_job', {
      job_id: Number(id),
    }).catch(() => undefined)) as {review_hash?: string | null} | null | undefined;
    if (!onChain) {
      throw new PactoraError(
        ErrorCode.UPSTREAM_UNAVAILABLE,
        'the job could not be read from the chain right now; nothing was minted — try again in a minute',
      );
    }
    const reviewHash = onChain.review_hash ?? review?.reviewHash ?? null;
    return {
      title: `Pactora job #${id}`,
      description:
        `Proof that ${worker} completed Pactora job #${id} for ${client.walletAddress} ` +
        `and was paid ${chain.formatToken(BigInt(amount))} through the contract's escrow.`,
      issued_at: String(now().getTime()),
      media: credentialBadge(id),
      extra: canonicalize({
        contract: chain.contracts.Pactora,
        chainJobId: id,
        client: client.walletAddress,
        worker,
        amount,
        token: chain.contracts.PaymentToken,
        specHash: job.specHash,
        resultHash: job.resultHash ?? null,
        reviewHash,
        settledAt: job.settledAt ? job.settledAt.toISOString() : null,
      }),
    };
  };

  app.get('/v1/jobs/:id/credential', async (request) => {
    const job = await loadJob((request.params as {id: string}).id);
    const row = await db.query.credentials.findFirst({where: eq(credentials.jobId, job.id)});
    return {...view(job, row), available: available(job)};
  });

  app.post('/v1/jobs/:id/credential', async (request, reply) => {
    const actor = await actorOf(db, request);
    const job = await loadJob((request.params as {id: string}).id);
    if (job.workerAgentId !== actor.agent.id) {
      throw new PactoraError(ErrorCode.FORBIDDEN, "only the job's worker claims its work credential");
    }
    if (job.state !== 'settled' || !job.chainJobId) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        `a work credential is claimed after the job settles; this job is ${job.state}`,
      );
    }
    if (job.path !== 'escrow') {
      throw new PactoraError(ErrorCode.INVALID_STATE, 'work credentials are issued for escrow jobs only');
    }
    await requireClear(db, actor.agent.id, 'claim a work credential');
    const chain = deps.chains[job.chainId];
    const contract = contractOf(job);
    if (!chain || !contract || !deps.mint || !deps.viewChain) {
      throw new PactoraError(
        ErrorCode.UPSTREAM_UNAVAILABLE,
        'work credentials are not available on this network yet: no credentials contract or minter is configured',
      );
    }
    const receiver = actor.agent.walletAddress;
    const tokenId = job.chainJobId;
    const metadata = await metadataOf(job, chain, receiver);

    // The claim, first. A fresh row is ours; an existing one is replayed
    // (minted), taken over (failed, or a stale pending), or busy.
    // A NEW claim counts against the worker's daily cap, checked and written
    // under one lock per worker so two at once cannot both pass it.
    let row: CredentialRow | undefined;
    const fresh = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`credentials:worker:${actor.agent.id}`}))`,
      );
      const existing = await tx.query.credentials.findFirst({where: eq(credentials.jobId, job.id)});
      if (!existing) {
        const [today] = await tx
          .select({n: sql<number>`count(*)::int`})
          .from(credentials)
          .innerJoin(jobs, eq(jobs.id, credentials.jobId))
          .where(
            and(
              eq(jobs.workerAgentId, actor.agent.id),
              sql`${credentials.createdAt} >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
            ),
          );
        if ((today?.n ?? 0) >= perWorkerPerDay) {
          throw new PactoraError(
            ErrorCode.LIMIT_REACHED,
            `at most ${perWorkerPerDay} work credentials per worker per UTC day; claim the rest tomorrow`,
          );
        }
      }
      const [inserted] = await tx
        .insert(credentials)
        .values({chainId: job.chainId, jobId: job.id, receiver, tokenId, updatedAt: STAMP})
        .onConflictDoNothing()
        .returning();
      return inserted;
    });
    if (fresh) {
      row = fresh;
    } else {
      const prior = await db.query.credentials.findFirst({where: eq(credentials.jobId, job.id)});
      if (prior?.status === 'minted') return reply.status(200).send({...view(job, prior), replayed: true});
      [row] = await db
        .update(credentials)
        .set({status: 'pending', updatedAt: STAMP})
        .where(
          and(
            eq(credentials.jobId, job.id),
            or(
              eq(credentials.status, 'failed'),
              and(
                eq(credentials.status, 'pending'),
                lt(credentials.updatedAt, sql`now() - ${`${STALE_PENDING_MS} milliseconds`}::interval`),
              ),
            ),
          ),
        )
        .returning();
      if (!row) {
        throw new PactoraError(
          ErrorCode.IDEMPOTENCY_CONFLICT,
          'a claim for this work credential is already in progress; try again in a minute',
          30,
        );
      }
    }
    const claim = row;
    // Still ours: the stamp this request wrote. A takeover changed it → 0 rows.
    const ours = and(eq(credentials.id, claim.id), eq(credentials.updatedAt, claim.updatedAt));
    const superseded = () =>
      new PactoraError(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        'a newer claim for this work credential took over and is in progress; check its status shortly',
        30,
      );
    const free = async () => {
      const gone = await db.delete(credentials).where(ours).returning({id: credentials.id});
      if (gone.length === 0) throw superseded();
    };
    const markFailed = async () => {
      const kept = await db
        .update(credentials)
        .set({status: 'failed'})
        .where(ours)
        .returning({id: credentials.id});
      if (kept.length === 0) throw superseded();
    };
    const readToken = async () =>
      (await deps.viewChain!(job.chainId, contract, 'nft_token', {token_id: tokenId})) as {
        owner_id?: string;
      } | null;
    const recordMinted = async (txHash?: string) => {
      const [done] = await db
        .update(credentials)
        .set({status: 'minted', updatedAt: sql`now()`, ...(txHash ? {txHash} : {})})
        .where(ours)
        .returning();
      // Superseded: the newer claim owns the row; answer what it holds now.
      return done ?? (await db.query.credentials.findFirst({where: eq(credentials.jobId, job.id)}));
    };
    const heldByAnother = (owner: string | undefined) =>
      new PactoraError(
        ErrorCode.INVALID_STATE,
        `credential #${tokenId} already exists on chain, held by ${owner ?? 'another account'}`,
      );

    // Is the token already on chain (an earlier attempt that landed)?
    let onChain: {owner_id?: string} | null;
    try {
      onChain = await readToken();
    } catch (err) {
      // A fresh claim tried nothing yet; a taken-over one still does not know.
      if (fresh) await free();
      else await markFailed();
      request.log.warn({err, job: job.publicId}, 'credential: nft_token could not be read');
      throw new PactoraError(
        ErrorCode.UPSTREAM_UNAVAILABLE,
        'the credentials contract could not be read to check for an earlier mint; try again shortly',
        5,
      );
    }
    if (onChain) {
      if (onChain.owner_id !== receiver) {
        await markFailed();
        throw heldByAnother(onChain.owner_id);
      }
      return reply.status(200).send({...view(job, await recordMinted()), replayed: true});
    }

    try {
      const sent = await deps.mint(tokenId, receiver, metadata, request.id);
      const done = await recordMinted(sent.txHash);
      const mine = done?.status === 'minted' && done.txHash === sent.txHash;
      return reply.status(mine ? 201 : 200).send({...view(job, done), replayed: !mine});
    } catch (err) {
      if (!(err instanceof PactoraError) || err.code === ErrorCode.UPSTREAM_UNAVAILABLE) {
        // Outcome unknown: keep the claim; the next one reads nft_token first.
        await markFailed();
        throw err;
      }
      // The contract refused. Before freeing, look again: a duplicate id, or a
      // race with an earlier attempt that landed, means the token is there.
      let after: {owner_id?: string} | null;
      try {
        after = await readToken();
      } catch {
        await markFailed();
        throw err;
      }
      if (after) {
        if (after.owner_id !== receiver) {
          await markFailed();
          throw heldByAnother(after.owner_id);
        }
        return reply.status(200).send({...view(job, await recordMinted()), replayed: true});
      }
      if (NOT_MINTED.has(err.code)) await free();
      else await markFailed();
      if (err.code === ErrorCode.INSUFFICIENT_FUNDS) {
        // The MINTER's account could not pay (the worker pays nothing): an
        // operator problem, not the worker's wallet. Nothing was minted.
        throw new PactoraError(
          ErrorCode.UPSTREAM_UNAVAILABLE,
          'the credentials service is out of funds right now; your claim is safe — try again later',
          60,
        );
      }
      throw err;
    }
  });
}
