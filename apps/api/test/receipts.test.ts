import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {eq, sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {agents, closeDb, createDb, jobEvents, jobs, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {chainDeps} from './helpers/register.js';
import {agent, fakeReadBudget, person} from './helpers/people.js';

/**
 * GET /v1/receipts (2026-11-11): the recent agent-to-agent jobs settled on
 * chain, so a judge sees work done without an API key. Newest first; only
 * settled jobs; never a job with a person on either side.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
beforeAll(async () => {
  db = createDb(DB_URL, {max: 4});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    readBudget: fakeReadBudget,
    rateLimitPerMinute: 100_000,
    liveEvents: false,
    draftSettleSweepMs: 0,
    submit: async () => ({txHash: 'unused'}),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, sessions, login_challenges, agent_events, agent_event_seq, public_profiles, party_reviews RESTART IDENTITY CASCADE`,
  );
});

let n = 0;

async function job(
  clientId: number,
  workerId: number,
  opts: {state: 'settled' | 'refunded' | 'accepted'; minutesAgo: number; title?: string},
) {
  const at = new Date(Date.now() - opts.minutesAgo * 60_000);
  const [j] = await db
    .insert(jobs)
    .values({
      chainId: 'near:sandbox',
      clientAgentId: clientId,
      workerAgentId: workerId,
      path: 'escrow',
      amount: '20000',
      fee: '1000',
      spec: opts.title
        ? {capability: 'market-research', input: {listing: {title: opts.title}}}
        : {capability: 'market-research'},
      specHash: 'ab'.repeat(32),
      resultHash: 'cd'.repeat(32),
      state: opts.state,
      settledAt: opts.state === 'settled' ? at : null,
      createdAt: new Date(at.getTime() - 60_000),
    })
    .returning({id: jobs.id, publicId: jobs.publicId});
  await db.insert(jobEvents).values([
    {chainId: 'near:sandbox', jobId: j!.id, kind: 'created', txHash: `HIRE${++n}`, occurredAt: at},
    {chainId: 'near:sandbox', jobId: j!.id, kind: 'note', txHash: null, occurredAt: at},
    {chainId: 'near:sandbox', jobId: j!.id, kind: opts.state, txHash: `SETTLE${n}`, occurredAt: at},
  ]);
  return {...j!, settleTx: `SETTLE${n}`};
}

const get = (url: string) => app.inject({method: 'GET', url});

describe('GET /v1/receipts', () => {
  it('lists settled agent-to-agent jobs, newest first, with names, hashes and the settling transaction', async () => {
    const orchestrator = await agent(app, `orc${++n}`);
    const worker = await agent(app, `wrk${++n}`);
    const older = await job(orchestrator.agentId, worker.agentId, {state: 'settled', minutesAgo: 30});
    const newer = await job(orchestrator.agentId, worker.agentId, {
      state: 'settled',
      minutesAgo: 1,
      title: 'Depth of NEAR/USDC',
    });

    const res = await get('/v1/receipts');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(2);
    expect(body.receipts.map((r: {jobId: string}) => r.jobId)).toEqual([newer.publicId, older.publicId]);
    expect(body.receipts[0]).toMatchObject({
      jobId: newer.publicId,
      chainId: 'near:sandbox',
      path: 'escrow',
      title: 'Depth of NEAR/USDC',
      amount: '20000',
      // 2026-11-12: the protocol fee and what the worker received, in words too.
      fee: '1000',
      workerReceived: '19000',
      client: {agentId: String(orchestrator.agentId), name: expect.stringMatching(/^orc/)},
      worker: {agentId: String(worker.agentId), name: expect.stringMatching(/^wrk/)},
      specHash: 'ab'.repeat(32),
      resultHash: 'cd'.repeat(32),
      transactions: 2,
      judged: false,
    });
    expect(body.receipts[0].settleExplorerUrl).toContain(newer.settleTx);
    expect(body.receipts[0].amountDisplay).toMatch(/0\.02/);
    expect(body.receipts[0].feeDisplay).toMatch(/0\.001/);
  });

  it('flags a job whose approval carried a NEAR AI judge attestation', async () => {
    const a = await agent(app, `a${++n}`);
    const b = await agent(app, `b${++n}`);
    const j = await job(a.agentId, b.agentId, {state: 'settled', minutesAgo: 1});
    const row = (await db.query.jobs.findFirst({where: eq(jobs.publicId, j.publicId)}))!;
    await db.insert(jobEvents).values({
      chainId: 'near:sandbox',
      jobId: row.id,
      kind: 'job.settled',
      payload: {judge: {provider: 'near-ai', model: 'm'}},
      occurredAt: new Date(),
    });
    expect((await get('/v1/receipts')).json().receipts[0].judged).toBe(true);
  });

  it('leaves out jobs that are not settled', async () => {
    const a = await agent(app, `a${++n}`);
    const b = await agent(app, `b${++n}`);
    await job(a.agentId, b.agentId, {state: 'refunded', minutesAgo: 2});
    await job(a.agentId, b.agentId, {state: 'accepted', minutesAgo: 3});
    expect((await get('/v1/receipts')).json()).toEqual({count: 0, receipts: []});
  });

  it('never shows a job with a person on either side, even a person with a published profile', async () => {
    const a = await agent(app, `a${++n}`);
    const p = await person(app, `p${++n}`);
    const personId = (await db.query.agents.findFirst({where: eq(agents.publicId, p.publicId)}))!.id;
    await db.execute(
      sql`INSERT INTO public_profiles (agent_id, display_name, published, published_at) VALUES (${personId}, 'Pat', true, now())`,
    );
    await job(a.agentId, personId, {state: 'settled', minutesAgo: 1});
    await job(personId, a.agentId, {state: 'settled', minutesAgo: 2});

    const body = (await get('/v1/receipts')).json();
    expect(body.count).toBe(0);
    expect(JSON.stringify(body)).not.toContain('Pat');
  });

  it('caps the page at the limit asked for, and refuses a limit out of range', async () => {
    const a = await agent(app, `a${++n}`);
    const b = await agent(app, `b${++n}`);
    for (let i = 0; i < 3; i++) await job(a.agentId, b.agentId, {state: 'settled', minutesAgo: i + 1});
    expect((await get('/v1/receipts?limit=2')).json().count).toBe(2);
    expect((await get('/v1/receipts?limit=0')).statusCode).toBe(422);
    expect((await get('/v1/receipts?limit=51')).statusCode).toBe(422);
  });

  it('answers an empty list for a chain that is not enabled', async () => {
    expect((await get('/v1/receipts?chainId=near:mainnet')).json()).toEqual({count: 0, receipts: []});
  });

  it('needs no API key', async () => {
    const res = await get('/v1/receipts');
    expect(res.statusCode).toBe(200);
  });
});
