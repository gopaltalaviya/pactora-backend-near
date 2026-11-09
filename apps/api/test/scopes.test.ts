import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget} from './helpers/people.js';

/**
 * API key scopes (2026-11-09): stored since v1, enforced now. A key rotated
 * to `read` is refused on every write; `worker` may accept and deliver but
 * not hire; a key cannot mint a wider one; registration and re-issue give
 * both client and worker (full), as every key had in effect before.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
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
    liveEvents: false,
    draftSettleSweepMs: 0,
    listingExpirySweepMs: 0,
    sessionKeySweepMs: 0,
    retention: {intervalMs: 0},
    submit: async () => ({txHash: '4yJxShz8HXfTyoTMXP9rQSoQUZE8uihkDmnpRrynZeZz', chainJobId: '9'}),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, sessions RESTART IDENTITY CASCADE`,
  );
});

const rotate = (key: string, scopes?: string[]) =>
  app.inject({method: 'POST', url: '/v1/keys/rotate', headers: bearer(key), payload: scopes ? {scopes} : {}});

describe('API key scopes', () => {
  it('a read key reads and writes nothing; a worker key works but cannot hire; neither can widen itself', async () => {
    const client = await agent(app, 'sc-client');
    const worker = await agent(app, 'sc-worker');
    const readOnly = (await rotate(client.apiKey, ['read'])).json() as {apiKey: string; scopes: string[]};
    expect(readOnly.scopes).toEqual(['read']);
    expect((await app.inject({url: '/v1/budget', headers: bearer(readOnly.apiKey)})).statusCode).toBe(200);
    expect((await app.inject({url: '/v1/jobs', headers: bearer(readOnly.apiKey)})).statusCode).toBe(200);
    const hire = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {...bearer(readOnly.apiKey), 'idempotency-key': 'sc-hire-0001'},
      payload: {
        workerAgentId: String(worker.agentId),
        spec: {capability: 'market-research', input: {}},
        maxPrice: '20000',
      },
    });
    expect(hire.statusCode).toBe(403);
    expect(hire.json().detail).toMatch(/scopes \(read\)/);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/me/profile',
          headers: bearer(readOnly.apiKey),
          payload: {displayName: 'x'},
        })
      ).statusCode,
    ).toBe(403);
    // A read key cannot mint a wider key.
    expect((await rotate(readOnly.apiKey, ['client'])).statusCode).toBe(403);

    const workerKey = (await rotate(worker.apiKey, ['worker'])).json() as {apiKey: string};
    const asWorkerHire = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {...bearer(workerKey.apiKey), 'idempotency-key': 'sc-hire-0002'},
      payload: {
        workerAgentId: String(client.agentId),
        spec: {capability: 'market-research', input: {}},
        maxPrice: '20000',
      },
    });
    expect(asWorkerHire.statusCode).toBe(403);
    expect(asWorkerHire.json().detail).toMatch(/needs the client scope/);
    // Accepting is a worker action: past the scope check (404: no such job), not 403.
    const accept = await app.inject({
      method: 'POST',
      url: '/v1/jobs/00000000-0000-4000-8000-000000000000/accept',
      headers: bearer(workerKey.apiKey),
    });
    expect(accept.statusCode).toBe(404);
    expect((await rotate(workerKey.apiKey, ['client', 'worker'])).statusCode).toBe(403);
    const narrower = (await rotate(workerKey.apiKey, ['read'])).json() as {scopes: string[]};
    expect(narrower.scopes).toEqual(['read']);
  });

  it('a registered key is full, and a plain rotate keeps the scopes', async () => {
    const a = await agent(app, 'sc-full');
    const [{scopes}] = (await db.execute(
      sql`SELECT scopes FROM api_keys WHERE revoked_at IS NULL`,
    )) as unknown as [{scopes: string[]}];
    expect(scopes.sort()).toEqual(['client', 'worker']);
    const again = (await rotate(a.apiKey)).json() as {scopes: string[]};
    expect(again.scopes.sort()).toEqual(['client', 'worker']);
    expect((await rotate(a.apiKey, ['read', 'read', 'read', 'read'])).statusCode).toBe(401); // the old key is gone
  });
});
