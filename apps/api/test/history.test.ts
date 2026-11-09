import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {eq, sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {agents, closeDb, createDb, jobEvents, jobs, partyReviews, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, person} from './helpers/people.js';

/**
 * Round 3 (2026-11-09): a participant's public history for a score-over-time
 * chart. 52 weeks, settled and refunded per week, amount buckets, the rating
 * of reviews shown now. Never the counterparty, a job id or an exact amount;
 * an unpublished person is 404 on both routes (the 917b232 privacy rule).
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

const DAY = 86_400_000;
let n = 0;
const ago = (days: number) => new Date(Date.now() - days * DAY - 1000);
const mondayOf = (d: Date) => {
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
    .toISOString()
    .slice(0, 10);
};

async function closedJob(
  clientId: number,
  workerId: number,
  opts: {daysAgo: number; state: 'settled' | 'refunded'; amount: string},
) {
  const at = ago(opts.daysAgo);
  const [j] = await db
    .insert(jobs)
    .values({
      chainId: 'near:sandbox',
      clientAgentId: clientId,
      workerAgentId: workerId,
      path: 'escrow',
      amount: opts.amount,
      spec: {capability: 'market-research'},
      specHash: 'ab'.repeat(32),
      state: opts.state,
      settledAt: opts.state === 'settled' ? at : null,
      createdAt: new Date(at.getTime() - DAY),
    })
    .returning({id: jobs.id, publicId: jobs.publicId});
  await db.insert(jobEvents).values({
    chainId: 'near:sandbox',
    jobId: j!.id,
    kind: opts.state,
    txHash: `TXH${++n}`,
    occurredAt: at,
  });
  return j!;
}

const get = (url: string) => app.inject({method: 'GET', url});
const idOf = async (publicId: string) =>
  (await db.query.agents.findFirst({where: eq(agents.publicId, publicId)}))!.id;

describe('GET /v1/agents/:id/history', () => {
  it('52 zero-filled weeks; settled and refunded per week, buckets, visible ratings; nothing about the other side', async () => {
    const worker = await agent(app, `hw${++n}`);
    const client = await agent(app, `hc${++n}`);
    // 6 decimals: 0.02, 5, 50 and 500 mUSDC.
    const a = await closedJob(client.agentId, worker.agentId, {
      daysAgo: 0,
      state: 'settled',
      amount: '20000',
    });
    await closedJob(client.agentId, worker.agentId, {daysAgo: 0, state: 'refunded', amount: '5000000'});
    await closedJob(client.agentId, worker.agentId, {daysAgo: 14, state: 'settled', amount: '50000000'});
    await closedJob(worker.agentId, client.agentId, {daysAgo: 14, state: 'settled', amount: '500000000'});
    await closedJob(client.agentId, worker.agentId, {daysAgo: 400, state: 'settled', amount: '20000'}); // outside
    // An open job is not history.
    await db.insert(jobs).values({
      chainId: 'near:sandbox',
      clientAgentId: client.agentId,
      workerAgentId: worker.agentId,
      path: 'escrow',
      amount: '20000',
      spec: {capability: 'market-research'},
      specHash: 'ab'.repeat(32),
      state: 'accepted',
    });
    // Both parties reviewed job a: both shown; only the one about the worker counts here.
    await db.insert(partyReviews).values([
      {
        jobId: a.id,
        authorAgentId: client.agentId,
        subjectAgentId: worker.agentId,
        authorRole: 'client',
        rating: 4,
        body: 'Good work, on time.',
      },
      {
        jobId: a.id,
        authorAgentId: worker.agentId,
        subjectAgentId: client.agentId,
        authorRole: 'worker',
        rating: 2,
        body: 'Slow to answer.',
      },
    ]);

    const res = await get(`/v1/agents/${worker.agentId}/history`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.subject).toEqual({kind: 'agent', agentId: String(worker.agentId), profileId: null});
    expect(body.weeks).toBe(52);
    expect(body.series).toHaveLength(52);
    expect(body.amountBuckets).toEqual(['lt1', '1to10', '10to100', 'gte100']);
    const now = body.series[51];
    expect(now.week).toBe(mondayOf(new Date()));
    expect(now).toMatchObject({
      settled: 1,
      refunded: 1,
      asWorker: 2,
      asClient: 0,
      amounts: {lt1: 1, '1to10': 1, '10to100': 0, gte100: 0},
      rating: {average: 4, count: 1},
    });
    const two = body.series.find((w: {week: string}) => w.week === mondayOf(ago(14)));
    expect(two).toMatchObject({
      settled: 2,
      refunded: 0,
      asWorker: 1,
      asClient: 1,
      amounts: {'10to100': 1, gte100: 1},
    });
    expect(body.totals).toEqual({settled: 3, refunded: 1, rating: {average: 4, count: 1}});
    // Weeks are consecutive Mondays.
    expect(new Date(body.series[1].week).getTime() - new Date(body.series[0].week).getTime()).toBe(7 * DAY);
    expect(body.from).toBe(`${body.series[0].week}T00:00:00.000Z`);
    // No counterparty, no job id, no exact amount anywhere in the response.
    const text = res.body;
    expect(text).not.toContain(a.publicId);
    expect(text).not.toContain(client.wallet);
    expect(text).not.toContain(`"${client.agentId}"`);
    expect(text).not.toMatch(/20000|5000000|50000000|500000000/);
    expect(text).not.toContain('Good work');
  });

  it('a person: 404 while the profile is unpublished, on both routes; history once published', async () => {
    const p = await person(app, `hp${++n}`);
    const pid = await idOf(p.publicId);
    const client = await agent(app, `hpc${++n}`);
    await closedJob(client.agentId, pid, {daysAgo: 3, state: 'settled', amount: '20000'});

    expect((await get(`/v1/agents/${pid}/history`)).statusCode).toBe(404);
    expect((await get(`/v1/profiles/${p.publicId}/history`)).statusCode).toBe(404);
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/me/profile',
      headers: bearer(p.token),
      payload: {displayName: 'Asha', published: true},
    });
    expect(put.statusCode, put.body).toBe(200);

    const viaProfile = await get(`/v1/profiles/${p.publicId}/history`);
    expect(viaProfile.statusCode, viaProfile.body).toBe(200);
    expect(viaProfile.json().subject).toEqual({kind: 'person', agentId: null, profileId: p.publicId});
    expect(viaProfile.json().totals.settled).toBe(1);
    expect(viaProfile.body).not.toContain(p.account);
    const viaAgent = await get(`/v1/agents/${pid}/history`);
    expect(viaAgent.statusCode).toBe(200);
    expect(viaAgent.json().totals.settled).toBe(1);

    // Unpublished again: gone again.
    await app.inject({
      method: 'PUT',
      url: '/v1/me/profile',
      headers: bearer(p.token),
      payload: {displayName: 'Asha', published: false},
    });
    expect((await get(`/v1/profiles/${p.publicId}/history`)).statusCode).toBe(404);
    expect((await get(`/v1/agents/${pid}/history`)).statusCode).toBe(404);
  });

  it('unknown or malformed ids are 404, never 500', async () => {
    expect((await get('/v1/agents/999999/history')).statusCode).toBe(404);
    expect((await get('/v1/agents/abc/history')).statusCode).toBe(404);
    expect((await get('/v1/profiles/not-a-uuid/history')).statusCode).toBe(404);
    expect((await get('/v1/profiles/11111111-1111-4111-8111-111111111111/history')).statusCode).toBe(404);
  });
});
