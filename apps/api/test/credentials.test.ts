import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {eq, sql} from 'drizzle-orm';
import {loadConfig, PAYMENT_TOKEN_SYMBOL_MAX, type ChainConfig} from '@pactora/config';
import {
  accountStanding,
  closeDb,
  createDb,
  credentials,
  jobDrafts,
  jobReviews,
  jobs,
  type Db,
} from '@pactora/db';
import {canonicalize, ErrorCode, PactoraError} from '@pactora/shared';
import {buildApp, EventBus} from '../src/app.js';
import type {ChainViewer} from '../src/chain-reads.js';
import {credentialBadge} from '../src/routes/credentials.js';
import type {CredentialMint} from '../src/submit.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget} from './helpers/people.js';
// The signer's own bounds: the metadata this API builds must always pass them.
import {MintBody} from '../../signer/src/app.js';

/**
 * Work credentials (feature/work-credentials): the worker of a settled job
 * claims one soulbound NFT that records, on chain, who paid them, how much,
 * for what and the review. Idempotent per job: the claim row is written
 * first; a certain refusal frees it, an unknown outcome keeps it, and any
 * later claim reads `nft_token` before it mints again.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});
const BASE = config.chain('near:sandbox');
const CREDENTIALS = 'credentials.test.near';
const CHAIN: ChainConfig = {...BASE, contracts: {...BASE.contracts, Credentials: CREDENTIALS}};
const NOW = new Date('2026-11-12T10:00:00.000Z');
const SETTLED = new Date('2026-11-11T09:30:00.000Z');

let db: Db;
let app: FastifyInstance;
/** Built per test where a different wiring is needed. */
const extra: FastifyInstance[] = [];

type MintCall = Parameters<CredentialMint>;
const mints: MintCall[] = [];
let mintAnswer: (...a: MintCall) => Promise<Awaited<ReturnType<CredentialMint>>>;
const mint: CredentialMint = async (...a) => {
  mints.push(a);
  return mintAnswer(...a);
};
/** The chain's tokens, by token id: what `nft_token` answers. */
const tokens = new Map<string, {token_id: string; owner_id: string}>();
/** The Pactora contract's review_hash per chain job id: what `get_job` answers (null when none). */
const chainReviews = new Map<string, string | null>();
const views: string[] = [];
let viewFails = false;
const viewChain: ChainViewer = async (_chain, contract, method, args) => {
  views.push(`${contract}.${method}`);
  if (viewFails) throw new Error('fetch failed');
  if (contract === CREDENTIALS && method === 'nft_token') {
    return tokens.get(String((args as {token_id: string}).token_id)) ?? null;
  }
  if (contract !== CREDENTIALS && method === 'get_job') {
    const id = String((args as {job_id: number}).job_id);
    return {state: 'Settled', review_hash: chainReviews.get(id) ?? null};
  }
  throw new Error(`no such view ${contract}.${method}`);
};

async function build(
  over: {chains?: Record<string, ChainConfig>; mint?: CredentialMint | null; perWorkerPerDay?: number} = {},
) {
  const a = await buildApp({
    ...chainDeps(config),
    db,
    chains: over.chains ?? {'near:sandbox': CHAIN},
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    readBudget: fakeReadBudget,
    rateLimitPerMinute: 100_000,
    liveEvents: false,
    draftSettleSweepMs: 0,
    viewChain,
    credentialsNow: () => NOW,
    ...(over.perWorkerPerDay ? {credentialsPerWorkerPerDay: over.perWorkerPerDay} : {}),
    ...(over.mint === null ? {} : {credentialMint: over.mint ?? mint}),
    submit: async () => ({txHash: 'unused'}),
  });
  return a;
}

beforeAll(async () => {
  db = createDb(DB_URL, {max: 4});
  app = await build();
});
afterAll(async () => {
  for (const a of extra) await a.close();
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  mints.length = 0;
  views.length = 0;
  tokens.clear();
  chainReviews.clear();
  viewFails = false;
  mintAnswer = async (tokenId) => ({
    txHash: `MINT${tokenId}`,
    from: 'minter.test.near',
    contract: CREDENTIALS,
  });
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, sessions, login_challenges, account_standing, job_drafts, job_reviews, credentials RESTART IDENTITY CASCADE`,
  );
});

let n = 0;
async function settledJob(state: (typeof jobs.$inferInsert)['state'] = 'settled', withReview = true) {
  const client = await agent(app, `cred-client-${++n}`);
  const worker = await agent(app, `cred-worker-${n}`);
  const stranger = await agent(app, `cred-stranger-${n}`);
  const chainJobId = String(4200 + n);
  const [job] = await db
    .insert(jobs)
    .values({
      chainId: 'near:sandbox',
      chainJobId,
      clientAgentId: client.agentId,
      workerAgentId: worker.agentId,
      path: 'escrow',
      amount: '20000',
      spec: {capability: 'market-research'},
      specHash: 'ab'.repeat(32),
      resultHash: 'cd'.repeat(32),
      state,
      ...(state === 'settled' ? {settledAt: SETTLED} : {}),
    })
    .returning();
  if (withReview) {
    const [draft] = await db
      .insert(jobDrafts)
      .values({
        jobId: job!.id,
        round: 1,
        authorAgentId: worker.agentId,
        snapshot: {},
        snapshotHash: `${n}`.padStart(64, 'e'),
      })
      .returning();
    await db.insert(jobReviews).values({
      draftId: draft!.id,
      jobId: job!.id,
      decision: 'accept_draft',
      reason: 'Everything asked for is there.',
      checks: [{criterion: 'complete', met: true, support: 'yes'}],
      reviewHash: 'f0'.repeat(32),
      decidedBy: client.agentId,
    });
  }
  return {job: job!, client, worker, stranger, chainJobId};
}

/** Another settled escrow job for the same worker and client. */
async function anotherJob(
  from: {job: typeof jobs.$inferSelect},
  over: Partial<typeof jobs.$inferInsert> = {},
) {
  const [job] = await db
    .insert(jobs)
    .values({
      chainId: 'near:sandbox',
      chainJobId: String(4200 + ++n),
      clientAgentId: from.job.clientAgentId,
      workerAgentId: from.job.workerAgentId,
      path: 'escrow',
      amount: '20000',
      spec: {capability: 'market-research'},
      specHash: 'ab'.repeat(32),
      resultHash: 'cd'.repeat(32),
      state: 'settled',
      settledAt: SETTLED,
      ...over,
    })
    .returning();
  return job!;
}

const claim = (a: FastifyInstance, jobId: string, key?: string) =>
  a.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/credential`,
    headers: key ? bearer(key) : {},
    payload: {},
  });
const status = (a: FastifyInstance, jobId: string) =>
  a.inject({method: 'GET', url: `/v1/jobs/${jobId}/credential`});
const rowOf = async (jobId: number) => db.query.credentials.findFirst({where: eq(credentials.jobId, jobId)});

describe('POST /v1/jobs/:id/credential', () => {
  it("mints to the worker's wallet with metadata built from the job, and GET shows it", async () => {
    const {job, client, worker, chainJobId} = await settledJob();
    const res = await claim(app, job.publicId, worker.apiKey);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({
      jobId: job.publicId,
      status: 'minted',
      tokenId: chainJobId,
      contract: CREDENTIALS,
      receiver: worker.wallet,
      txHash: `MINT${chainJobId}`,
      explorerUrl: CHAIN.explorerTx(`MINT${chainJobId}`),
      replayed: false,
    });

    expect(mints).toHaveLength(1);
    const [tokenId, receiverId, metadata] = mints[0]!;
    expect(tokenId).toBe(chainJobId);
    expect(receiverId).toBe(worker.wallet);
    expect(metadata).toEqual({
      title: `Pactora job #${chainJobId}`,
      description:
        `Proof that ${worker.wallet} completed Pactora job #${chainJobId} for ${client.wallet} ` +
        `and was paid ${CHAIN.formatToken(20000n)} through the contract's escrow.`,
      issued_at: String(NOW.getTime()),
      media: credentialBadge(chainJobId),
      extra: canonicalize({
        contract: CHAIN.contracts.Pactora,
        chainJobId,
        client: client.wallet,
        worker: worker.wallet,
        amount: '20000',
        token: CHAIN.contracts.PaymentToken,
        specHash: 'ab'.repeat(32),
        resultHash: 'cd'.repeat(32),
        reviewHash: 'f0'.repeat(32),
        settledAt: SETTLED.toISOString(),
      }),
    });
    expect(metadata.media).toMatch(/^data:image\/svg\+xml;base64,/);
    // Within the signer's bounds (MintBody: description 300, media and extra 1 024).
    expect(metadata.description.length).toBeLessThanOrEqual(300);
    expect(metadata.media.length).toBeLessThanOrEqual(1024);
    expect(metadata.extra.length).toBeLessThanOrEqual(1024);

    const row = await rowOf(job.id);
    expect(row).toMatchObject({status: 'minted', txHash: `MINT${chainJobId}`, receiver: worker.wallet});

    const got = await status(app, job.publicId);
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual({
      jobId: job.publicId,
      available: true,
      status: 'minted',
      tokenId: chainJobId,
      contract: CREDENTIALS,
      receiver: worker.wallet,
      txHash: `MINT${chainJobId}`,
      explorerUrl: CHAIN.explorerTx(`MINT${chainJobId}`),
    });
  });

  // 2026-11-12, live: job 68 was approved on a NEAR AI verdict, its review_hash
  // on chain, but the credential said null: only person-review drafts were read.
  it("takes reviewHash from the chain's job (a judged approval), not only from a review draft", async () => {
    const {job, worker} = await settledJob('settled', false);
    chainReviews.set(job.chainJobId!, 'ab'.repeat(32));
    expect((await claim(app, job.publicId, worker.apiKey)).statusCode).toBe(201);
    expect(JSON.parse(mints[0]![2].extra).reviewHash).toBe('ab'.repeat(32));
  });

  it('refuses to mint when the job cannot be read from the chain, and leaves nothing behind', async () => {
    const {job, worker} = await settledJob('settled', false);
    viewFails = true;
    const r = await claim(app, job.publicId, worker.apiKey);
    viewFails = false;
    expect(r.statusCode).toBe(503);
    expect(mints).toHaveLength(0);
    expect((await app.inject({url: `/v1/jobs/${job.publicId}/credential`})).json().status).toBe('none');
  });

  it('records a null reviewHash when the job had no accepted review', async () => {
    const {job, worker} = await settledJob('settled', false);
    expect((await claim(app, job.publicId, worker.apiKey)).statusCode).toBe(201);
    expect(JSON.parse(mints[0]![2].extra).reviewHash).toBeNull();
  });

  it('only the worker: the client and a stranger are refused, and nothing is minted', async () => {
    const {job, client, stranger} = await settledJob();
    for (const key of [client.apiKey, stranger.apiKey]) {
      const res = await claim(app, job.publicId, key);
      expect(res.statusCode).toBe(403);
      expect(res.json().detail).toMatch(/only the job's worker/);
    }
    expect((await claim(app, job.publicId)).statusCode).toBe(401);
    expect(mints).toHaveLength(0);
    expect(await rowOf(job.id)).toBeUndefined();
  });

  it('refuses a job that has not settled, plainly', async () => {
    const {job, worker} = await settledJob('submitted');
    const res = await claim(app, job.publicId, worker.apiKey);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('INVALID_STATE');
    expect(res.json().detail).toMatch(/after the job settles/);
    expect(mints).toHaveLength(0);
    expect(await rowOf(job.id)).toBeUndefined();
  });

  it('refuses a worker on hold', async () => {
    const {job, worker} = await settledJob();
    await db.insert(accountStanding).values({agentId: worker.agentId, standing: 'hold', reason: 'test'});
    expect((await claim(app, job.publicId, worker.apiKey)).statusCode).toBe(403);
    expect(mints).toHaveLength(0);
  });

  it('is idempotent: a repeat claim answers the same credential and mints nothing', async () => {
    const {job, worker, chainJobId} = await settledJob();
    expect((await claim(app, job.publicId, worker.apiKey)).statusCode).toBe(201);
    const again = await claim(app, job.publicId, worker.apiKey);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({status: 'minted', tokenId: chainJobId, replayed: true});
    expect(mints).toHaveLength(1);
  });

  it('a certain refusal from the signer frees the claim, so it can be tried again', async () => {
    const {job, worker} = await settledJob();
    mintAnswer = async () => {
      throw new PactoraError(ErrorCode.INVALID_STATE, 'the contract refused: NotMinter');
    };
    const res = await claim(app, job.publicId, worker.apiKey);
    expect(res.statusCode).toBe(409);
    expect(await rowOf(job.id)).toBeUndefined();
    expect((await status(app, job.publicId)).json().status).toBe('none');

    mintAnswer = async (t) => ({txHash: `MINT${t}`, from: 'minter.test.near', contract: CREDENTIALS});
    expect((await claim(app, job.publicId, worker.apiKey)).statusCode).toBe(201);
    expect(mints).toHaveLength(2);
  });

  it('an unknown outcome keeps the claim; the retry finds the token on chain and does not mint twice', async () => {
    const {job, worker, chainJobId} = await settledJob();
    mintAnswer = async () => {
      throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'the signer answered 500', 2);
    };
    expect((await claim(app, job.publicId, worker.apiKey)).statusCode).toBe(503);
    expect(await rowOf(job.id)).toMatchObject({status: 'failed'});
    expect((await status(app, job.publicId)).json()).toMatchObject({status: 'pending', txHash: null});

    // It did land.
    tokens.set(chainJobId, {token_id: chainJobId, owner_id: worker.wallet});
    const retry = await claim(app, job.publicId, worker.apiKey);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({status: 'minted', tokenId: chainJobId, txHash: null});
    expect(views).toContain(`${CREDENTIALS}.nft_token`);
    expect(mints).toHaveLength(1);
    expect(await rowOf(job.id)).toMatchObject({status: 'minted'});
  });

  it('an unknown outcome that never landed: the retry checks nft_token, then mints', async () => {
    const {job, worker, chainJobId} = await settledJob();
    mintAnswer = async () => {
      throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'the signer did not answer', 2);
    };
    expect((await claim(app, job.publicId, worker.apiKey)).statusCode).toBe(503);
    mintAnswer = async (t) => ({txHash: `MINT${t}`, from: 'minter.test.near', contract: CREDENTIALS});
    const retry = await claim(app, job.publicId, worker.apiKey);
    expect(retry.statusCode, retry.body).toBe(201);
    expect(retry.json()).toMatchObject({status: 'minted', txHash: `MINT${chainJobId}`});
    expect(views.filter((v) => v === `${CREDENTIALS}.nft_token`).length).toBeGreaterThanOrEqual(1);
    expect(mints).toHaveLength(2);
  });

  it('does not mint again when nft_token cannot be read', async () => {
    const {job, worker} = await settledJob();
    await db.insert(credentials).values({
      chainId: 'near:sandbox',
      jobId: job.id,
      receiver: worker.wallet,
      tokenId: job.chainJobId!,
      status: 'failed',
    });
    viewFails = true;
    expect((await claim(app, job.publicId, worker.apiKey)).statusCode).toBe(503);
    expect(mints).toHaveLength(0);
    expect(await rowOf(job.id)).toMatchObject({status: 'failed'});
  });

  it('refuses a second claim while one is in flight, but takes over a stale one', async () => {
    const {job, worker} = await settledJob();
    await db.insert(credentials).values({
      chainId: 'near:sandbox',
      jobId: job.id,
      receiver: worker.wallet,
      tokenId: job.chainJobId!,
      status: 'pending',
    });
    const busy = await claim(app, job.publicId, worker.apiKey);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().code).toBe('IDEMPOTENCY_CONFLICT');
    expect(mints).toHaveLength(0);

    // The database's clock, not this process's: the takeover compares with now().
    await db.execute(
      sql`UPDATE credentials SET updated_at = now() - interval '5 minutes' WHERE job_id = ${job.id}`,
    );
    expect((await claim(app, job.publicId, worker.apiKey)).statusCode).toBe(201);
    expect(mints).toHaveLength(1);
  });

  it('a duplicate-id refusal while nft_token shows the token: the claim is kept as minted, not freed', async () => {
    const {job, worker, chainJobId} = await settledJob();
    // nft_token was empty when read; the mint raced an earlier one that landed.
    mintAnswer = async () => {
      tokens.set(chainJobId, {token_id: chainJobId, owner_id: worker.wallet});
      throw new PactoraError(ErrorCode.IDEMPOTENCY_CONFLICT, `token ${chainJobId} already exists`);
    };
    const res = await claim(app, job.publicId, worker.apiKey);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({status: 'minted', tokenId: chainJobId, replayed: true});
    expect(await rowOf(job.id)).toMatchObject({status: 'minted', receiver: worker.wallet});
    expect(views.filter((v) => v === `${CREDENTIALS}.nft_token`)).toHaveLength(2);
  });

  it('a "certain" refusal is checked against nft_token too: a token that is there is never freed', async () => {
    const {job, worker, chainJobId} = await settledJob();
    mintAnswer = async () => {
      tokens.set(chainJobId, {token_id: chainJobId, owner_id: worker.wallet});
      throw new PactoraError(ErrorCode.INVALID_STATE, 'the contract refused: token');
    };
    expect((await claim(app, job.publicId, worker.apiKey)).statusCode).toBe(200);
    expect(await rowOf(job.id)).toMatchObject({status: 'minted'});
  });

  it('a duplicate-id refusal for a token held by someone else keeps the claim as failed', async () => {
    const {job, worker, chainJobId} = await settledJob();
    mintAnswer = async () => {
      tokens.set(chainJobId, {token_id: chainJobId, owner_id: 'someone.test.near'});
      throw new PactoraError(ErrorCode.IDEMPOTENCY_CONFLICT, `token ${chainJobId} already exists`);
    };
    const res = await claim(app, job.publicId, worker.apiKey);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/held by someone\.test\.near/);
    expect(await rowOf(job.id)).toMatchObject({status: 'failed'});
  });

  it('a duplicate-id refusal when nft_token still shows nothing: kept as failed, not freed', async () => {
    const {job, worker} = await settledJob();
    mintAnswer = async () => {
      throw new PactoraError(ErrorCode.IDEMPOTENCY_CONFLICT, 'token already exists');
    };
    expect((await claim(app, job.publicId, worker.apiKey)).statusCode).toBe(409);
    expect(await rowOf(job.id)).toMatchObject({status: 'failed'});
  });

  it('refuses a direct-pay job, plainly: credentials are for escrow jobs', async () => {
    const first = await settledJob();
    const direct = await anotherJob(first, {path: 'direct'});
    const res = await claim(app, direct.publicId, first.worker.apiKey);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('INVALID_STATE');
    expect(res.json().detail).toBe('work credentials are issued for escrow jobs only');
    expect(mints).toHaveLength(0);
    expect(await rowOf(direct.id)).toBeUndefined();
  });

  it('caps claims per worker per UTC day; earlier days and replays do not count', async () => {
    const capped = await build({perWorkerPerDay: 2});
    extra.push(capped);
    const first = await settledJob();
    // Yesterday's claim is not today's.
    const old = await anotherJob(first);
    await db.execute(
      sql`INSERT INTO credentials (chain_id, job_id, receiver, token_id, status, created_at)
          VALUES ('near:sandbox', ${old.id}, ${first.worker.wallet}, ${old.chainJobId}, 'minted', now() - interval '1 day')`,
    );
    const second = await anotherJob(first);
    const third = await anotherJob(first);
    expect((await claim(capped, first.job.publicId, first.worker.apiKey)).statusCode).toBe(201);
    expect((await claim(capped, second.publicId, first.worker.apiKey)).statusCode).toBe(201);
    const over = await claim(capped, third.publicId, first.worker.apiKey);
    expect(over.statusCode).toBe(409);
    expect(over.json().code).toBe('LIMIT_REACHED');
    expect(over.json().detail).toMatch(/at most 2 work credentials per worker per UTC day/);
    expect(await rowOf(third.id)).toBeUndefined();
    // A replay of today's claim is still answered.
    expect((await claim(capped, second.publicId, first.worker.apiKey)).statusCode).toBe(200);
    expect(mints).toHaveLength(2);
  });

  it("a taken-over claim is stamped with the database's clock, whatever this process's says", async () => {
    const {job, worker} = await settledJob();
    await db.insert(credentials).values({
      chainId: 'near:sandbox',
      jobId: job.id,
      receiver: worker.wallet,
      tokenId: job.chainJobId!,
      status: 'failed',
    });
    // This process's clock is 10 minutes slow; the row it marks pending must still read as fresh.
    vi.useFakeTimers({toFake: ['Date'], now: Date.now() - 10 * 60_000});
    let freshDuringMint: unknown;
    try {
      mintAnswer = async (t) => {
        const r = await db.execute(
          sql`SELECT updated_at > now() - interval '1 minute' AS fresh FROM credentials WHERE job_id = ${job.id}`,
        );
        freshDuringMint = (r as unknown as Array<{fresh: boolean}>)[0]?.fresh;
        return {txHash: `MINT${t}`, from: 'minter.test.near', contract: CREDENTIALS};
      };
      expect((await claim(app, job.publicId, worker.apiKey)).statusCode).toBe(201);
    } finally {
      vi.useRealTimers();
    }
    expect(freshDuringMint).toBe(true);
  });

  it("a claim superseded by a takeover does not free the newer claim's row", async () => {
    const {job, worker} = await settledJob();
    mintAnswer = async () => {
      // Request A stalled; B took the claim over (a newer stamp) meanwhile.
      await db.execute(
        sql`UPDATE credentials SET status = 'pending', updated_at = updated_at + interval '1 second' WHERE job_id = ${job.id}`,
      );
      throw new PactoraError(ErrorCode.INVALID_STATE, 'the contract refused: Paused');
    };
    const before = await claim(app, job.publicId, worker.apiKey);
    expect(before.statusCode).toBe(409);
    expect(before.json().code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await rowOf(job.id)).toMatchObject({status: 'pending'});
  });

  it("a claim superseded by a takeover does not mark the newer claim's row failed", async () => {
    const {job, worker} = await settledJob();
    mintAnswer = async () => {
      await db.execute(
        sql`UPDATE credentials SET status = 'pending', updated_at = updated_at + interval '1 second' WHERE job_id = ${job.id}`,
      );
      throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'the signer did not answer', 2);
    };
    expect((await claim(app, job.publicId, worker.apiKey)).statusCode).toBe(409);
    expect(await rowOf(job.id)).toMatchObject({status: 'pending'});
  });

  it("a claim superseded by a takeover does not overwrite the newer claim's row as minted", async () => {
    const {job, worker} = await settledJob();
    mintAnswer = async (t) => {
      await db.execute(
        sql`UPDATE credentials SET status = 'pending', updated_at = updated_at + interval '1 second' WHERE job_id = ${job.id}`,
      );
      return {txHash: `MINT${t}`, from: 'minter.test.near', contract: CREDENTIALS};
    };
    const res = await claim(app, job.publicId, worker.apiKey);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({status: 'pending', txHash: null});
    expect(await rowOf(job.id)).toMatchObject({status: 'pending', txHash: null});
  });

  it("the minter's own wallet running dry is an operator problem: 503, plainly, and the claim is retryable", async () => {
    const {job, worker} = await settledJob();
    mintAnswer = async () => {
      throw new PactoraError(
        ErrorCode.INSUFFICIENT_FUNDS,
        'the wallet could not pay for the call — top it up',
      );
    };
    const res = await claim(app, job.publicId, worker.apiKey);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('UPSTREAM_UNAVAILABLE');
    expect(res.json().detail).toBe(
      'the credentials service is out of funds right now; your claim is safe — try again later',
    );
    expect(res.json().detail).not.toMatch(/top it up|wallet/);
    mintAnswer = async (t) => ({txHash: `MINT${t}`, from: 'minter.test.near', contract: CREDENTIALS});
    expect((await claim(app, job.publicId, worker.apiKey)).statusCode).toBe(201);
  });

  it('two claims racing at the cap: the per-worker lock lets exactly as many through as the cap allows', async () => {
    const capped = await build({perWorkerPerDay: 2});
    extra.push(capped);
    const first = await settledJob();
    const more = [first.job, await anotherJob(first), await anotherJob(first), await anotherJob(first)];
    // One already today: cap - 1 left, three racing for it.
    await claim(capped, more[0]!.publicId, first.worker.apiKey);
    // Make them truly concurrent: a SHARE lock on credentials (another
    // connection) lets every racer read its count but blocks every insert,
    // until all three are waiting — on that insert, or on the per-worker lock.
    const side = createDb(DB_URL, {max: 2});
    let pending: Promise<Awaited<ReturnType<typeof claim>>[]> | undefined;
    try {
      await side.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE credentials IN SHARE MODE`);
        pending = Promise.all(more.slice(1).map((j) => claim(capped, j.publicId, first.worker.apiKey)));
        for (let i = 0; ; i++) {
          const [w] = (await side.execute(
            sql`SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE wait_event_type = 'Lock' AND datname = current_database()
                  AND (query ILIKE '%insert into "credentials"%' OR query ILIKE '%pg_advisory_xact_lock%')`,
          )) as unknown as {n: number}[];
          if ((w?.n ?? 0) >= 3) break;
          if (i > 200) throw new Error('the racers never all waited');
          await new Promise((r) => setTimeout(r, 25));
        }
        // The lock is released when this transaction ends.
      });
    } finally {
      await closeDb(side);
    }
    const racing = await pending!;
    const codes = racing.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409]);
    expect(racing.filter((r) => r.statusCode === 409).every((r) => r.json().code === 'LIMIT_REACHED')).toBe(
      true,
    );
    expect(mints).toHaveLength(2);
  });

  it('the cap is per UTC day: a claim at 23:59:59 UTC yesterday does not count today', async () => {
    const capped = await build({perWorkerPerDay: 1});
    extra.push(capped);
    const first = await settledJob();
    const old = await anotherJob(first);
    await db.execute(
      sql`INSERT INTO credentials (chain_id, job_id, receiver, token_id, status, created_at)
          VALUES ('near:sandbox', ${old.id}, ${first.worker.wallet}, ${old.chainJobId}, 'minted',
                  (date_trunc('day', now() AT TIME ZONE 'UTC') - interval '1 second') AT TIME ZONE 'UTC')`,
    );
    expect((await claim(capped, first.job.publicId, first.worker.apiKey)).statusCode).toBe(201);
    const next = await anotherJob(first);
    expect((await claim(capped, next.publicId, first.worker.apiKey)).json().code).toBe('LIMIT_REACHED');
  });

  it("the worst-case metadata this API builds passes the signer's MintBody", async () => {
    expect(PAYMENT_TOKEN_SYMBOL_MAX).toBe(16);
    const long = (tail: string) => `${'a'.repeat(64 - tail.length)}${tail}`;
    const symbol = 'S'.repeat(PAYMENT_TOKEN_SYMBOL_MAX);
    // jobs.amount is numeric(38): 38 nines is the largest amount a job can hold.
    const worst: ChainConfig = {
      ...CHAIN,
      contracts: {...CHAIN.contracts, Pactora: long('.pactora'), PaymentToken: long('.token')},
      formatToken: (a) => CHAIN.formatToken(a).replace(/ \S+$/, ` ${symbol}`),
    };
    const a = await build({chains: {'near:sandbox': worst}});
    extra.push(a);
    const {job, worker, client} = await settledJob();
    const workerWallet = long('.worker');
    const clientWallet = long('.client');
    await db.execute(sql`UPDATE agents SET wallet_address = ${workerWallet} WHERE id = ${worker.agentId}`);
    await db.execute(sql`UPDATE agents SET wallet_address = ${clientWallet} WHERE id = ${client.agentId}`);
    await db.execute(
      sql`UPDATE jobs SET chain_job_id = '18446744073709551615', amount = '99999999999999999999999999999999999999' WHERE id = ${job.id}`,
    );
    expect((await claim(a, job.publicId, worker.apiKey)).statusCode).toBe(201);
    const [tokenId, receiverId, metadata] = mints[0]!;
    expect(receiverId).toHaveLength(64);
    expect(metadata.description).toContain(symbol);
    const parsed = MintBody.safeParse({tokenId, receiverId, metadata});
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it('answers 503 with a plain message when no minter or no credentials contract is configured', async () => {
    const {job, worker} = await settledJob();
    const noMinter = await build({mint: null});
    const noContract = await build({chains: {'near:sandbox': BASE}});
    extra.push(noMinter, noContract);
    for (const a of [noMinter, noContract]) {
      const res = await claim(a, job.publicId, worker.apiKey);
      expect(res.statusCode).toBe(503);
      expect(res.json().detail).toMatch(/work credentials are not available on this network/);
      expect((await status(a, job.publicId)).json()).toMatchObject({available: false, status: 'none'});
    }
    expect(mints).toHaveLength(0);
    expect(await rowOf(job.id)).toBeUndefined();
  });
});

describe('GET /v1/jobs/:id/credential', () => {
  it('is public, and says none before a claim', async () => {
    const {job} = await settledJob();
    const res = await status(app, job.publicId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      jobId: job.publicId,
      available: true,
      status: 'none',
      tokenId: null,
      contract: CREDENTIALS,
      receiver: null,
      txHash: null,
      explorerUrl: null,
    });
  });

  it('404s an unknown job', async () => {
    expect((await status(app, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await status(app, 'nope')).statusCode).toBe(404);
  });
});
