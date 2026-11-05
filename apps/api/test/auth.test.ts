import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@pactora/config';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {addr, signedRegistration} from './helpers/register.js';

/**
 * API-key authentication, under load and under attack.
 *
 * v1 loaded EVERY non-revoked key and ran a synchronous scrypt against each
 * one, on the event loop, for every request — so one request with a garbage
 * key cost N blocking hash computations, and the rate limit (keyed on the raw
 * Authorization header) gave an attacker a fresh bucket per request.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});

let app: FastifyInstance;
let db: Db;

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    db,
    chains: config.chains,
    defaultChainId: 31337,
    bus: new EventBus(),
    submit: async () => ({txHash: `0x${'ab'.repeat(32)}`}),
  });
});

afterAll(async () => {
  await app.close();
  await closeDb(db);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE agents, api_keys RESTART IDENTITY CASCADE`);
});

async function register(i: number) {
  const res = await signedRegistration(app, {
    name: `Agent${i}`,
    capabilities: ['market-research'],
    pricePerTask: '20000',
    walletAddress: addr(`agent-${i}`),
    ownerAddress: addr('22'),
  });
  expect(res.statusCode).toBe(201);
  return res.json() as {agentId: number; apiKey: string};
}

const me = (apiKey: string) =>
  app.inject({method: 'GET', url: '/v1/budget', headers: {authorization: `Bearer ${apiKey}`}});

describe('API keys', () => {
  it('issues keys that carry a public lookup id, and stores only a hash', async () => {
    const {apiKey, agentId} = await register(1);
    expect(apiKey).toMatch(/^ax_[0-9a-f]{16}_[A-Za-z0-9_-]{32,}$/);
    const [row] = (await db.execute(
      sql`SELECT key_id, key_hash FROM api_keys WHERE agent_id = ${agentId}`,
    )) as unknown as {key_id: string; key_hash: string}[];
    expect(apiKey).toContain(row!.key_id);
    expect(row!.key_hash).not.toContain(apiKey.split('_').slice(2).join('_'));
  });

  it('authenticates the right key and refuses a wrong secret for a real key id', async () => {
    const {apiKey} = await register(1);
    expect((await me(apiKey)).statusCode).toBe(200);

    const forged = apiKey.slice(0, 20) + 'x'.repeat(apiKey.length - 20);
    const res = await me(forged);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });

  it('refuses a malformed key without touching the database', async () => {
    const res = await me('not-a-key');
    expect(res.statusCode).toBe(401);
  });

  /**
   * The denial-of-service, measured. With 25 keys stored, 20 requests with
   * garbage keys cost v1 500 synchronous scrypt runs (seconds of blocked event
   * loop). A key-id lookup costs one indexed query and no hashing at all.
   */
  it('makes a garbage key cheap, however many keys exist', async () => {
    for (let i = 1; i <= 25; i++) await register(i);
    const started = Date.now();
    for (let i = 0; i < 20; i++) {
      const res = await me(`ax_${'0'.repeat(16)}_${'garbage'.repeat(6)}`);
      expect(res.statusCode).toBe(401);
    }
    expect(Date.now() - started).toBeLessThan(1_500);
  }, 60_000);
});
