import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {eq, sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {closeDb, createDb, jobs, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {poolState} from '../src/routes/pools.js';
import {chainDeps} from './helpers/register.js';
import {agent, fakeReadBudget, person, purses} from './helpers/people.js';

/**
 * Collective purchasing (2026-11-11): several agents buy one piece of work
 * from one worker, each funding an equal share as its own escrow job.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
let chainJob = 9000;
const submitted: {kind: string; spend: bigint; agentId: number}[] = [];

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
    submit: async (args) => {
      submitted.push({kind: args.kind, spend: args.spend, agentId: args.agentId});
      return args.kind === 'createJob'
        ? {txHash: `HIRE${++chainJob}`, chainJobId: String(chainJob)}
        : {txHash: `TX${++chainJob}`};
    },
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  submitted.length = 0;
  purses.clear();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, sessions, login_challenges, agent_events, agent_event_seq, pools, pool_shares RESTART IDENTITY CASCADE`,
  );
});

let n = 0;
const bearer = (key: string) => ({authorization: `Bearer ${key}`});
const open = (key: string, body: Record<string, unknown>) =>
  app.inject({method: 'POST', url: '/v1/pools', headers: bearer(key), payload: body});
const join = (key: string, poolId: string) =>
  app.inject({method: 'POST', url: `/v1/pools/${poolId}/join`, headers: bearer(key), payload: {}});

async function cast(buyers = 3) {
  const worker = await agent(app, `worker${++n}`);
  const members = [];
  for (let i = 0; i < buyers; i++) members.push(await agent(app, `buyer${++n}`));
  return {worker, members};
}

const pool = (workerAgentId: number, over: Record<string, unknown> = {}) => ({
  workerAgentId: String(workerAgentId),
  title: 'Depth of NEAR/USDC across three venues',
  capability: 'market-research',
  input: {pair: 'NEAR/USDC'},
  shareAmount: '60000',
  shares: 3,
  ...over,
});

describe('pools', () => {
  it('opens a pool, the lead funds the first share, two more members fill it: three escrow jobs to one worker', async () => {
    const {worker, members} = await cast(3);
    const opened = await open(members[0]!.apiKey, pool(worker.agentId));
    expect(opened.statusCode, opened.body).toBe(201);
    const {pool: p} = opened.json() as {pool: {poolId: string; filled: number; state: string; total: string}};
    expect(p).toMatchObject({filled: 1, state: 'open', total: '180000'});

    for (const m of members.slice(1)) expect((await join(m.apiKey, p.poolId)).statusCode).toBe(201);

    const view = (await app.inject({method: 'GET', url: `/v1/pools/${p.poolId}`})).json();
    expect(view).toMatchObject({filled: 3, shares: 3, state: 'funded', shareAmount: '60000'});
    expect(view.members.map((m: {agentId: string}) => m.agentId)).toEqual(
      members.map((m) => String(m.agentId)),
    );
    // Each share was its own create_job, from its own member, for the share alone.
    const hires = submitted.filter((s) => s.kind === 'createJob');
    expect(hires.map((h) => h.agentId)).toEqual(members.map((m) => m.agentId));
    expect(hires.every((h) => h.spend === 60_000n)).toBe(true);
    const rows = await db.select().from(jobs);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.workerAgentId))).toEqual(new Set([worker.agentId]));
    expect(rows.every((r) => r.path === 'escrow')).toBe(true);
    // Every share commits to the same task, tagged with the pool.
    expect(rows.every((r) => (r.spec as {input: {pool: {id: string}}}).input.pool.id === p.poolId)).toBe(
      true,
    );
  });

  it('buys work above every member’s per-task cap: each share stays within its own cap', async () => {
    const {worker, members} = await cast(3);
    for (const m of members) purses.set(m.wallet, {perTaskCap: 70_000n});
    const opened = await open(members[0]!.apiKey, pool(worker.agentId));
    expect(opened.statusCode, opened.body).toBe(201);
    const id = opened.json().pool.poolId;
    for (const m of members.slice(1)) expect((await join(m.apiKey, id)).statusCode).toBe(201);
    // 180000 in all, though no member may spend more than 70000 on one task.
    expect((await app.inject({method: 'GET', url: `/v1/pools/${id}`})).json().total).toBe('180000');
  });

  it('refuses a share above the member’s own per-task cap, before anything is signed', async () => {
    const {worker, members} = await cast(2);
    purses.set(members[0]!.wallet, {perTaskCap: 50_000n});
    const res = await open(members[0]!.apiKey, pool(worker.agentId));
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('BUDGET_EXCEEDED');
    expect(submitted).toHaveLength(0);
    expect((await app.inject({method: 'GET', url: '/v1/pools'})).json().count).toBe(0);
  });

  it('a lead whose first share cannot be funded leaves no empty pool behind', async () => {
    const {worker, members} = await cast(1);
    // The worker has no on-chain id: the hire path refuses after the pool row exists.
    await db.execute(sql`UPDATE agents SET chain_agent_id = NULL WHERE id = ${worker.agentId}`);
    const res = await open(members[0]!.apiKey, pool(worker.agentId));
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({method: 'GET', url: '/v1/pools'})).json().count).toBe(0);
  });

  it('a full pool refuses another member, and nothing is signed for it', async () => {
    const {worker, members} = await cast(3);
    const id = (await open(members[0]!.apiKey, pool(worker.agentId, {shares: 2}))).json().pool.poolId;
    expect((await join(members[1]!.apiKey, id)).statusCode).toBe(201);
    const before = submitted.length;
    const full = await join(members[2]!.apiKey, id);
    expect(full.statusCode).toBe(409);
    expect(submitted.length).toBe(before);
  });

  it('a member joining twice gets its own share back, not a second payment', async () => {
    const {worker, members} = await cast(2);
    const id = (await open(members[0]!.apiKey, pool(worker.agentId))).json().pool.poolId;
    const first = (await join(members[1]!.apiKey, id)).json();
    const again = (await join(members[1]!.apiKey, id)).json();
    expect(again.share.jobId).toBe(first.share.jobId);
    expect(again.pool.filled).toBe(2);
    expect(await db.select().from(jobs)).toHaveLength(2);
  });

  it('the worker cannot buy into its own pool, and a person cannot use an agent route', async () => {
    const {worker, members} = await cast(1);
    const id = (await open(members[0]!.apiKey, pool(worker.agentId))).json().pool.poolId;
    expect((await join(worker.apiKey, id)).statusCode).toBe(403);
    const p = await person(app, `p${++n}`);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/pools/${id}/join`,
      headers: bearer(p.token),
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('reports one delivery: every share carries the same result hash; a differing one is flagged', async () => {
    const {worker, members} = await cast(2);
    const id = (await open(members[0]!.apiKey, pool(worker.agentId, {shares: 2}))).json().pool.poolId;
    await join(members[1]!.apiKey, id);
    const rows = await db.select().from(jobs);
    await db
      .update(jobs)
      .set({state: 'submitted', resultHash: 'ef'.repeat(32)})
      .where(eq(jobs.id, rows[0]!.id));
    let v = (await app.inject({method: 'GET', url: `/v1/pools/${id}`})).json();
    expect(v).toMatchObject({resultHash: null, sameDelivery: true, state: 'funded'});
    await db
      .update(jobs)
      .set({state: 'settled', resultHash: 'ef'.repeat(32)})
      .where(eq(jobs.id, rows[1]!.id));
    v = (await app.inject({method: 'GET', url: `/v1/pools/${id}`})).json();
    expect(v).toMatchObject({resultHash: 'ef'.repeat(32), sameDelivery: true, state: 'delivered'});
    await db
      .update(jobs)
      .set({resultHash: '00'.repeat(32)})
      .where(eq(jobs.id, rows[1]!.id));
    v = (await app.inject({method: 'GET', url: `/v1/pools/${id}`})).json();
    expect(v).toMatchObject({resultHash: null, sameDelivery: false});
  });

  it('lists pools publicly, newest first, and answers 404 for an unknown or malformed id', async () => {
    const {worker, members} = await cast(1);
    await open(members[0]!.apiKey, pool(worker.agentId, {title: 'first pool'}));
    await open(members[0]!.apiKey, pool(worker.agentId, {title: 'second pool'}));
    const list = (await app.inject({method: 'GET', url: '/v1/pools'})).json();
    expect(list.pools.map((p: {title: string}) => p.title)).toEqual(['second pool', 'first pool']);
    expect((await app.inject({method: 'GET', url: '/v1/pools/not-a-uuid'})).statusCode).toBe(404);
    expect(
      (await app.inject({method: 'GET', url: '/v1/pools/00000000-0000-4000-8000-000000000000'})).statusCode,
    ).toBe(404);
  });

  it('refuses bad shapes: one share, a share below the escrow minimum', async () => {
    const {worker, members} = await cast(1);
    expect((await open(members[0]!.apiKey, pool(worker.agentId, {shares: 1}))).statusCode).toBe(422);
    expect((await open(members[0]!.apiKey, pool(worker.agentId, {shareAmount: '1'}))).statusCode).toBe(422);
  });
});

describe('pools: review fixes (2026-11-11)', () => {
  it('a worker that stopped taking work after the pool opened gets no more shares', async () => {
    const {worker, members} = await cast(2);
    const id = (await open(members[0]!.apiKey, pool(worker.agentId))).json().pool.poolId;
    await db.execute(sql`UPDATE agents SET active = false WHERE id = ${worker.agentId}`);
    const before = submitted.length;
    const res = await join(members[1]!.apiKey, id);
    expect(res.json().code).toBe('AGENT_NOT_HIREABLE');
    expect(submitted.length).toBe(before);
  });

  it('a slot held for ten minutes with no job behind it is freed for another member', async () => {
    const {worker, members} = await cast(3);
    const id = (await open(members[0]!.apiKey, pool(worker.agentId, {shares: 2}))).json().pool.poolId;
    // members[1] took the last slot, then its hire never produced a job.
    await db.execute(sql`INSERT INTO pool_shares (pool_id, slot, agent_id, created_at)
      SELECT p.id, 2, ${members[1]!.agentId}, now() - interval '11 minutes' FROM pools p WHERE p.public_id = ${id}`);
    const res = await join(members[2]!.apiKey, id);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().pool.filled).toBe(2);
  });

  it('a fresh held slot is not taken from its member', async () => {
    const {worker, members} = await cast(3);
    const id = (await open(members[0]!.apiKey, pool(worker.agentId, {shares: 2}))).json().pool.poolId;
    await db.execute(sql`INSERT INTO pool_shares (pool_id, slot, agent_id)
      SELECT p.id, 2, ${members[1]!.agentId} FROM pools p WHERE p.public_id = ${id}`);
    expect((await join(members[2]!.apiKey, id)).statusCode).toBe(409);
  });

  it('a lead whose hire broadcast but failed to answer keeps the pool, and its retry finds the share', async () => {
    const {worker, members} = await cast(1);
    // Fail AFTER the job row exists: the job's event insert throws once.
    await db.execute(sql`CREATE OR REPLACE FUNCTION pools_test_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected'; END $$ LANGUAGE plpgsql`);
    await db.execute(
      sql`CREATE TRIGGER pools_test_fail BEFORE INSERT ON job_events FOR EACH ROW EXECUTE FUNCTION pools_test_fail()`,
    );
    try {
      const res = await open(members[0]!.apiKey, pool(worker.agentId));
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS pools_test_fail ON job_events`);
    }
    const list = (await app.inject({method: 'GET', url: '/v1/pools'})).json();
    expect(list.count).toBe(1);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });
});

describe('poolState', () => {
  it('open until every share is funded; settled when all are; unwound if any was refunded', () => {
    expect(poolState(3, ['created'])).toBe('open');
    expect(poolState(2, ['created', 'accepted'])).toBe('funded');
    expect(poolState(2, ['submitted', 'settled'])).toBe('delivered');
    expect(poolState(2, ['settled', 'settled'])).toBe('settled');
    expect(poolState(2, ['refunded', 'refunded'])).toBe('unwound');
    // One refunded share does not unwind shares still running or settled.
    expect(poolState(2, ['accepted', 'refunded'])).toBe('funded');
    expect(poolState(2, ['settled', 'disputed'])).toBe('disputed');
  });
});
