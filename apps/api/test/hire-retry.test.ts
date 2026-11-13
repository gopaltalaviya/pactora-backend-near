import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {and, eq, sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, signerTxs, type Db} from '@pactora/db';
import {ErrorCode, PactoraError} from '@pactora/shared';
import {buildApp, EventBus} from '../src/app.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, fakeReadTxEvents, purses} from './helpers/people.js';

/**
 * Issue 22: a create_job the contract DEFINITELY refused (a panic: nothing
 * changed) must be retryable once its cause is fixed. The signer replays a
 * known idempotency key's outcome forever, so a retry under the same key
 * replayed the refusal — and the selected bid's slot stayed taken. An outcome
 * that is NOT known (a lost broadcast) must still replay: never a second spend.
 *
 * The signer here is a fake with the real one's ledger semantics: one
 * `signer_txs` row per (chain, agent, key), and a known key answers from it.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

const PANIC = JSON.stringify({
  ActionError: {
    index: 0,
    kind: {FunctionCallError: {ExecutionError: 'Smart contract panicked: InsufficientStorage'}},
  },
});

/** What the next NEW transaction does on the fake chain. */
let chainSays: 'panic' | 'lack-balance' | 'unknown' | 'ok' = 'ok';
/** Whether an unknown outcome turns out to have landed when asked again. */
let unknownLanded = false;
let keysSeen: string[] = [];
let txSeq = 0;
let db: Db;
let app: FastifyInstance;

const refusal = (failure: string, txHash: string) =>
  /Smart contract panicked: ([A-Za-z]+)/.test(failure)
    ? new PactoraError(
        ErrorCode.INSUFFICIENT_FUNDS,
        `the contract refused: InsufficientStorage (transaction ${txHash}, nothing changed)`,
      )
    : new PactoraError(ErrorCode.INVALID_STATE, `the transaction ${txHash} failed on chain: ${failure}`);

async function fakeSigner(args: {agentId: number; chainId: string; idempotencyKey: string}) {
  keysSeen.push(args.idempotencyKey);
  const where = and(
    eq(signerTxs.chainId, args.chainId),
    eq(signerTxs.agentId, args.agentId),
    eq(signerTxs.idempotencyKey, args.idempotencyKey),
  );
  const row = await db.query.signerTxs.findFirst({where});
  if (row) {
    if (row.status === 'final') return {txHash: row.txHash!, chainJobId: String(row.result)};
    if (row.status === 'reverted') throw refusal(row.failure ?? '', row.txHash!);
    // signed, outcome unknown: ask the chain again.
    if (!unknownLanded) {
      throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, `outcome of ${row.txHash} unknown`, 2);
    }
    await db.update(signerTxs).set({status: 'final', result: 77}).where(where);
    return {txHash: row.txHash!, chainJobId: '77'};
  }
  const txHash = `Tx${++txSeq}`;
  const base = {
    chainId: args.chainId,
    agentId: args.agentId,
    idempotencyKey: args.idempotencyKey,
    payloadHash: 'p',
    nonce: txSeq,
    txHash,
  };
  if (chainSays === 'panic' || chainSays === 'lack-balance') {
    const failure = chainSays === 'panic' ? PANIC : '{"ActionError":{"kind":"LackBalanceForState"}}';
    await db.insert(signerTxs).values({...base, status: 'reverted', failure});
    throw refusal(failure, txHash);
  }
  if (chainSays === 'unknown') {
    await db.insert(signerTxs).values({...base, status: 'signed'});
    throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, `outcome of ${txHash} unknown`, 2);
  }
  await db.insert(signerTxs).values({...base, status: 'final', result: 100 + txSeq});
  return {txHash, chainJobId: String(100 + txSeq)};
}

beforeAll(async () => {
  db = createDb(DB_URL, {max: 5});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    readBudget: fakeReadBudget,
    readTxEvents: fakeReadTxEvents,
    rateLimitPerMinute: 100_000,
    submit: fakeSigner,
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  chainSays = 'ok';
  unknownLanded = false;
  keysSeen = [];
  txSeq = 0;
  purses.clear();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, token_transfers, registration_challenges, signer_txs RESTART IDENTITY CASCADE`,
  );
  await db.execute(
    sql`TRUNCATE listings, applications, listing_slots, person_actions RESTART IDENTITY CASCADE`,
  );
});

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

async function selectedBid(label: string) {
  const client = await agent(app, `${label}-client`);
  const worker = await agent(app, `${label}-worker`);
  const posted = await app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: {...bearer(client.apiKey), 'idempotency-key': `${label}-listing`},
    payload: {
      title: 'Photograph three shop fronts',
      description: 'Take clear daytime photos of three shop fronts on the high street.',
      category: 'physical',
      interactionMode: 'capture',
      skills: ['Photography'],
      location: 'Berlin',
      maxPriceBaseUnits: '40000',
      maxWorkers: 1,
      hiringMode: 'applications',
      estimatedMinutes: 60,
      deadline: inDays(7),
      criteria: 'Three sharp photos, each showing the full shop front and its sign.',
      acceptWindowSeconds: 600,
      workWindowSeconds: 7200,
    },
  });
  expect(posted.statusCode, posted.body).toBe(201);
  const listingId = posted.json().listingId as string;
  const bid = await app.inject({
    method: 'POST',
    url: `/v1/listings/${listingId}/applications`,
    headers: bearer(worker.apiKey),
    payload: {action: 'apply', priceBaseUnits: '30000', proposal: 'I can do this today, with a good camera.'},
  });
  expect(bid.statusCode, bid.body).toBe(201);
  const select = () =>
    app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/decide`,
      headers: bearer(client.apiKey),
      payload: {
        applicationId: bid.json().applicationId,
        action: 'select',
        reason: 'Your proposal fits the brief well.',
      },
    });
  return {client, select};
}

const rows = (agentId: number) => db.select().from(signerTxs).where(eq(signerTxs.agentId, agentId));

describe('a create_job the contract refused, retried after the cause is fixed', () => {
  it('is sent again under a fresh signer key and succeeds', async () => {
    const {client, select} = await selectedBid('refused');
    chainSays = 'panic';
    const first = await select();
    expect(first.statusCode).toBe(402);
    expect(first.json().detail).toMatch(/InsufficientStorage \(transaction Tx1, nothing changed\)/);

    // The cause is fixed (storage topped up). The same decision again funds the job.
    chainSays = 'ok';
    const second = await select();
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().funding).toMatchObject({by: 'signer', txHash: 'Tx2'});
    expect(new Set(keysSeen).size).toBe(2);

    // Once funded, a further retry replays: no third transaction.
    const third = await select();
    expect(third.statusCode, third.body).toBe(200);
    expect(third.json()).toMatchObject({replayed: true, funding: {txHash: 'Tx2'}});
    const sent = await rows(client.agentId);
    expect(sent.map((r) => r.status).sort()).toEqual(['final', 'reverted']);
  });

  it('the refusal tells the client it is retryable, and how', async () => {
    const {select} = await selectedBid('told');
    chainSays = 'panic';
    expect((await select()).json().detail).toMatch(/send the same request again/);
  });

  it('a refusal repeated while the cause is not fixed is a new attempt each time, never a stuck replay', async () => {
    const {select} = await selectedBid('twice');
    chainSays = 'panic';
    expect((await select()).json().detail).toMatch(/transaction Tx1,/);
    expect((await select()).json().detail).toMatch(/transaction Tx2,/);
    chainSays = 'ok';
    expect((await select()).json().funding).toMatchObject({txHash: 'Tx3'});
  });
});

describe('an outcome that is not a definite refusal', () => {
  it('unknown (lost broadcast): the retry replays the same key, and pays once', async () => {
    const {client, select} = await selectedBid('unknown');
    chainSays = 'unknown';
    expect((await select()).statusCode).toBe(503);
    // It had in fact landed. The retry must find it, not send another.
    chainSays = 'ok';
    unknownLanded = true;
    const retry = await select();
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().funding).toMatchObject({txHash: 'Tx1'});
    expect(keysSeen[1]).toBe(keysSeen[0]);
    expect(await rows(client.agentId)).toHaveLength(1);
  });

  it('a failure that is not a contract panic still replays (nothing proves nothing changed)', async () => {
    const {select} = await selectedBid('lackbal');
    chainSays = 'lack-balance';
    expect((await select()).statusCode).toBe(409);
    chainSays = 'ok';
    expect((await select()).statusCode).toBe(409);
    expect(keysSeen[1]).toBe(keysSeen[0]);
  });
});
