import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, purses} from './helpers/people.js';

/**
 * Text search (2026-11-09): `q` on the listings board and on a caller's jobs,
 * backed by Postgres full-text indexes (migration 0023), and `status` on
 * jobs as a word for a group of states.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
let jobSeq = 100;

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    readBudget: fakeReadBudget,
    rateLimitPerMinute: 100_000,
    submit: async () => ({
      txHash: '4yJxShz8HXfTyoTMXP9rQSoQUZE8uihkDmnpRrynZeZz',
      chainJobId: String(++jobSeq),
    }),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  purses.clear();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, listings, applications, listing_slots RESTART IDENTITY CASCADE`,
  );
});

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
let keySeq = 0;
const postListing = (token: string, over: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: {...bearer(token), 'idempotency-key': `search-key-${++keySeq}`},
    payload: {
      title: 'Photograph three shop fronts',
      description: 'Take clear daytime photos of three shop fronts on the high street.',
      category: 'physical',
      interactionMode: 'capture',
      skills: ['photography'],
      location: 'Berlin',
      maxPriceBaseUnits: '40000',
      maxWorkers: 1,
      estimatedMinutes: 60,
      deadline: inDays(7),
      criteria: 'Three sharp photos, each showing the full shop front and its sign.',
      ...over,
    },
  });

describe('GET /v1/listings?q=', () => {
  it('finds listings by words in the title, the description or a skill, and nothing else', async () => {
    const client = await agent(app, 'srch-client');
    expect((await postListing(client.apiKey, {})).statusCode).toBe(201);
    expect(
      (
        await postListing(client.apiKey, {
          title: 'Translate a lease agreement',
          description: 'Twelve pages of German into English, legal register.',
          category: 'expertise',
          interactionMode: 'task',
          skills: ['translation', 'legal-german'],
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await postListing(client.apiKey, {
          title: 'Review a pricing model',
          description: 'A second opinion on the unit economics of a subscription box.',
          category: 'judgment',
          interactionMode: 'conversation',
          skills: ['pricing'],
        })
      ).statusCode,
    ).toBe(201);

    const titles = async (q: string) =>
      (
        (await app.inject({method: 'GET', url: `/v1/listings?q=${encodeURIComponent(q)}`})).json() as {
          listings: {title: string}[];
        }
      ).listings.map((l) => l.title);

    expect(await titles('shop fronts')).toEqual(['Photograph three shop fronts']);
    expect(await titles('german')).toEqual(['Translate a lease agreement']); // a skill
    expect(await titles('subscription')).toEqual(['Review a pricing model']); // the description
    expect(await titles('nothing-like-this')).toEqual([]);
    // Words are ANDed: both must be in the same listing.
    expect(await titles('lease pricing')).toEqual([]);
  });

  it('refuses a query over 100 characters', async () => {
    const r = await app.inject({method: 'GET', url: `/v1/listings?q=${'a'.repeat(101)}`});
    expect(r.statusCode).toBe(422);
  });
});

describe('GET /v1/jobs?q= and ?status=', () => {
  const hire = (token: string, worker: number, capability: string, key: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {...bearer(token), 'idempotency-key': key},
      payload: {
        workerAgentId: String(worker),
        spec: {capability, input: {q: 'x'}},
        maxPrice: '20000',
        path: 'escrow',
      },
    });

  it("filters the caller's jobs by words in the spec and by a status group", async () => {
    const client = await agent(app, 'srch-jobs-client');
    const w1 = await agent(app, 'srch-w1', {capabilities: ['market-research']});
    const w2 = await agent(app, 'srch-w2', {capabilities: ['risk-review']});
    const h1 = await hire(client.apiKey, w1.agentId, 'market-research', 'srch-hire-0001');
    expect(h1.statusCode, h1.body).toBe(201);
    const h2 = await hire(client.apiKey, w2.agentId, 'risk-review', 'srch-hire-0002');
    expect(h2.statusCode, h2.body).toBe(201);
    await db.execute(
      sql`UPDATE jobs SET state = 'settled', settled_at = now() WHERE spec->>'capability' = 'risk-review'`,
    );

    const caps = async (query: string) => {
      const r = await app.inject({method: 'GET', url: `/v1/jobs${query}`, headers: bearer(client.apiKey)});
      expect(r.statusCode, r.body).toBe(200);
      return (r.json() as {jobs: {spec: {capability: string}}[]}).jobs.map((j) => j.spec.capability);
    };

    expect(await caps('?q=research')).toEqual(['market-research']);
    expect(await caps('?q=risk')).toEqual(['risk-review']);
    expect(await caps('?status=open')).toEqual(['market-research']);
    expect(await caps('?status=closed')).toEqual(['risk-review']);
    expect(await caps('?status=settled')).toEqual(['risk-review']);
    expect(await caps('?status=open&q=risk')).toEqual([]);
    const both = await app.inject({
      method: 'GET',
      url: '/v1/jobs?status=open&state=created',
      headers: bearer(client.apiKey),
    });
    expect(both.statusCode).toBe(422);
  });
});
