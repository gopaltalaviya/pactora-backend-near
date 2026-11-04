import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@pactora/config';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {addr, signedRegistration} from './helpers/register.js';

/**
 * Reputation per skill. An agent that is excellent at trade analysis and has
 * never done market research must not outrank a proven researcher for a
 * research job on the strength of its analysis record. Figures come from the
 * same settled jobs and refunds the overall score does, split by the job's
 * capability; the overall score is unchanged.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});
const hex = (s: string) => `0x${Buffer.from(s).toString('hex').padEnd(64, '0')}`;

let app: FastifyInstance;
let db: Db;
beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    db,
    chains: config.chains,
    defaultChainId: 31337,
    bus: new EventBus(),
    submit: async () => ({txHash: `0x${'ab'.repeat(32)}`, chainJobId: '1'}),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments RESTART IDENTITY CASCADE`,
  );
});

async function register(name: string, capabilities: string[], wallet: string) {
  const res = await signedRegistration(app, {
    name,
    capabilities,
    pricePerTask: '20000',
    walletAddress: wallet,
    ownerAddress: addr('22'),
  });
  expect(res.statusCode).toBe(201);
  const id = Number(res.json().agentId);
  // Stand in for the chain confirming the ERC-8004 id: since v3 discovery
  // lists only confirmed agents (an unconfirmed one can never be hired).
  await db.execute(sql`UPDATE agents SET chain_agent_id = ${id + 1000} WHERE id = ${id}`);
  return id;
}

/** A job and the indexer's own event for how it ended. */
async function job(
  worker: number,
  client: number,
  capability: string,
  kind: 'settled' | 'refunded',
  payload: object,
) {
  const [row] = (await db.execute(sql`
    INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, state, amount, spec, spec_hash)
    VALUES (31337, ${client}, ${worker}, 'escrow', ${kind}, '20000',
            ${JSON.stringify({capability, input: {}})}::jsonb, '0x')
    RETURNING id`)) as unknown as {id: number}[];
  await db.execute(sql`INSERT INTO job_events (chain_id, job_id, kind, payload)
    VALUES (31337, ${row!.id}, ${kind}, ${JSON.stringify(payload)}::jsonb)`);
}
/** The overall figures the indexer keeps, as it would have after those jobs. */
const stats = (agent: number, completed: number, failed: number, score: number) =>
  db.execute(
    sql`INSERT INTO agent_stats (agent_id, completed, failed, score) VALUES (${agent}, ${completed}, ${failed}, ${score})
        ON CONFLICT (agent_id) DO UPDATE SET completed = EXCLUDED.completed, failed = EXCLUDED.failed, score = EXCLUDED.score`,
  );

describe('per-skill reputation', () => {
  it('ranks the proven specialist first for its skill, even below a stronger generalist overall', async () => {
    const client = await register('Client', ['planning'], addr('01'));
    const generalist = await register('Generalist', ['market-research', 'trade-analysis'], addr('02'));
    const specialist = await register('Specialist', ['market-research'], addr('03'));
    for (let i = 0; i < 12; i++) await job(generalist, client, 'trade-analysis', 'settled', {outcome: 0});
    for (let i = 0; i < 6; i++) await job(specialist, client, 'market-research', 'settled', {outcome: 0});
    await stats(generalist, 12, 0, 74);
    await stats(specialist, 6, 0, 61);

    const overall = (await app.inject({url: '/v1/agents?rank=quality'})).json().agents;
    expect(overall.map((a: {name: string}) => a.name).slice(0, 2)).toEqual(['Generalist', 'Specialist']);

    const forResearch = (await app.inject({url: '/v1/agents?rank=quality&capability=market-research'})).json()
      .agents;
    expect(forResearch.map((a: {name: string}) => a.name)).toEqual(['Specialist', 'Generalist']);
    const [s, g] = forResearch;
    expect(s.skill).toEqual({
      capability: 'market-research',
      completed: 6,
      failed: 0,
      successRate: 1,
      score: expect.any(Number),
    });
    // Six paid jobs in this skill: above unknown (50), by the indexer's formula
    // (pinned in packages/db/test/reputation.test.ts).
    expect(s.skill.score).toBeGreaterThan(50);
    expect(g.skill).toEqual({
      capability: 'market-research',
      completed: 0,
      failed: 0,
      successRate: null,
      score: 50,
    });
    // The overall figures are unchanged.
    expect(g.score).toBe(74);
    expect(g.completed).toBe(12);
  });

  it('counts what the indexer counts, and nothing else', async () => {
    const client = await register('Client', ['planning'], addr('01'));
    const worker = await register('Worker', ['market-research'], addr('04'));
    await job(worker, client, 'market-research', 'settled', {outcome: 0}); // paid: counts
    await job(worker, client, 'market-research', 'settled', {outcome: 1}); // unresolved: no review
    await job(worker, client, 'market-research', 'refunded', {reason: hex('undelivered')}); // worker's fault
    await job(worker, client, 'market-research', 'refunded', {reason: 'dispute'}); // worker's fault
    await job(worker, client, 'market-research', 'refunded', {reason: hex('cancelled')}); // client's own cancel

    const [a] = (await app.inject({url: '/v1/agents?capability=market-research'})).json().agents;
    expect(a.skill).toMatchObject({completed: 1, failed: 2});
  });

  it('lists every skill on the profile', async () => {
    const client = await register('Client', ['planning'], addr('01'));
    const agent = await register('Both', ['market-research', 'trade-analysis'], addr('05'));
    await job(agent, client, 'trade-analysis', 'settled', {outcome: 0});
    const profile = (await app.inject({url: `/v1/agents/${agent}`})).json();
    expect(profile.skills).toEqual([
      {capability: 'market-research', completed: 0, failed: 0, successRate: null, score: 50},
      {capability: 'trade-analysis', completed: 1, failed: 0, successRate: 1, score: expect.any(Number)},
    ]);
  });

  it('adds no skill block when no skill was asked for', async () => {
    await register('Solo', ['market-research'], addr('06'));
    const [a] = (await app.inject({url: '/v1/agents'})).json().agents;
    expect(a.skill).toBeUndefined();
  });
});
