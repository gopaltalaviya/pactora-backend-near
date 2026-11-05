import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {
  addr,
  chainDeps,
  fakeReadIdentity,
  functionCallOnly,
  signChallenge,
  signedRegistration,
} from './helpers/register.js';

/**
 * API keys after issue (v3). docs/17 had rotation and revocation as "SQL
 * only": a leaked key could be stopped only by someone with the database.
 *
 *   - rotate: swap the presented key for a new one, the old revoked at once;
 *   - revoke: the kill switch for a key that leaked;
 *   - re-issue: an owner who lost every key signs a single-use, short-lived
 *     server nonce, checked against the agent's CURRENT on-chain owner.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
/** What the identity registry reports as the on-chain owner; null = not set. */
let chainOwner: string | null = null;

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    submit: async () => ({txHash: '4yJxShz8HXfTyoTMXP9rQSoQUZE8uihkDmnpRrynZeZz'}),
    // The registry, unless a test has the agent change hands on chain.
    readIdentity: async (a) =>
      chainOwner
        ? {owner: chainOwner, wallet: addr('11'), pendingWallet: null, frozen: false}
        : fakeReadIdentity(a),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  chainOwner = null;
  functionCallOnly.clear();
  await db.execute(sql`TRUNCATE agents, api_keys, key_challenges, agent_stats RESTART IDENTITY CASCADE`);
});

const owner = addr('key-owner');
const stranger = addr('key-stranger');

async function register(): Promise<{agentId: number; apiKey: string}> {
  const res = await signedRegistration(app, {
    name: 'K',
    capabilities: ['market-research'],
    pricePerTask: '20000',
    walletAddress: addr('11'),
    ownerAddress: owner,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const whoAmI = (key: string) =>
  app.inject({method: 'GET', url: '/v1/budget', headers: {authorization: `Bearer ${key}`}});
const post = (url: string, key?: string, payload: Record<string, unknown> = {}) =>
  app.inject({method: 'POST', url, payload, headers: key ? {authorization: `Bearer ${key}`} : {}});

describe('POST /v1/keys/rotate', () => {
  it('returns a working key and revokes the one presented', async () => {
    const {apiKey} = await register();
    const res = await post('/v1/keys/rotate', apiKey);
    expect(res.statusCode).toBe(200);
    const fresh = res.json().apiKey as string;
    expect(fresh).toMatch(/^ax_[0-9a-f]{16}_/);
    expect(fresh).not.toBe(apiKey);
    expect((await whoAmI(fresh)).statusCode).toBe(200);
    expect((await whoAmI(apiKey)).statusCode).toBe(401);
  });

  it('needs a valid key', async () => {
    expect((await post('/v1/keys/rotate')).statusCode).toBe(401);
  });
});

describe('POST /v1/keys/revoke', () => {
  it('stops the presented key at once', async () => {
    const {apiKey} = await register();
    expect((await post('/v1/keys/revoke', apiKey)).statusCode).toBe(200);
    expect((await whoAmI(apiKey)).statusCode).toBe(401);
  });
});

describe('re-issue by the owner', () => {
  async function challenge(agentId: number): Promise<{message: string; nonce: string}> {
    const res = await post(`/v1/agents/${agentId}/keys/challenge`);
    expect(res.statusCode).toBe(200);
    return res.json() as {message: string; nonce: string};
  }

  it('issues a new key for a signature over the challenge, and revokes every old one', async () => {
    const {agentId, apiKey} = await register();
    const signed = await signChallenge(owner, await challenge(agentId));
    const res = await post(`/v1/agents/${agentId}/keys`, undefined, signed);
    expect(res.statusCode).toBe(201);
    expect((await whoAmI(res.json().apiKey)).statusCode).toBe(200);
    expect((await whoAmI(apiKey)).statusCode).toBe(401);
  });

  it('refuses anyone but the owner', async () => {
    const {agentId} = await register();
    const res = await post(
      `/v1/agents/${agentId}/keys`,
      undefined,
      await signChallenge(stranger, await challenge(agentId)),
    );
    expect(res.statusCode).toBe(401);
  });

  /** A function-call key, which is what an agent holds, cannot speak for its owner. */
  it('refuses the owner account signing with a function-call key, even with a valid signature', async () => {
    const {agentId} = await register();
    functionCallOnly.add(owner);
    const res = await post(
      `/v1/agents/${agentId}/keys`,
      undefined,
      await signChallenge(owner, await challenge(agentId)),
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toMatch(/full-access key/);
  });

  it('accepts a challenge once: a replayed signature gets nothing', async () => {
    const {agentId} = await register();
    const signed = await signChallenge(owner, await challenge(agentId));
    expect((await post(`/v1/agents/${agentId}/keys`, undefined, signed)).statusCode).toBe(201);
    expect((await post(`/v1/agents/${agentId}/keys`, undefined, signed)).statusCode).toBe(401);
  });

  it('refuses an expired challenge', async () => {
    const {agentId} = await register();
    const c = await challenge(agentId);
    await db.execute(sql`UPDATE key_challenges SET expires_at = now() - interval '1 second'`);
    const res = await post(`/v1/agents/${agentId}/keys`, undefined, await signChallenge(owner, c));
    expect(res.statusCode).toBe(401);
  });

  /** An agent sold on-chain belongs to its new owner; the old one's signature is worthless. */
  it("checks the signer against the agent's CURRENT on-chain owner", async () => {
    const {agentId} = await register();
    await db.execute(sql`UPDATE agents SET chain_agent_id = 77 WHERE id = ${agentId}`);
    chainOwner = stranger;
    const res = await post(
      `/v1/agents/${agentId}/keys`,
      undefined,
      await signChallenge(owner, await challenge(agentId)),
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toMatch(/on-chain owner/);
  });

  /**
   * Audit L2: asking for a challenge needs no credentials, and a new one
   * REPLACED the last — so anyone could invalidate the owner's signature
   * before it arrived, as often as they liked.
   */
  it('is not invalidated by a stranger asking for challenges of their own', async () => {
    const {agentId} = await register();
    const mine = await app.inject({
      method: 'POST',
      url: `/v1/agents/${agentId}/keys/challenge`,
      remoteAddress: '198.51.100.10',
    });
    const mineChallenge = mine.json() as {message: string; nonce: string};
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: `/v1/agents/${agentId}/keys/challenge`,
        remoteAddress: '203.0.113.9',
      });
    }
    const res = await post(`/v1/agents/${agentId}/keys`, undefined, {
      ...(await signChallenge(owner, mineChallenge)),
      nonce: mineChallenge.nonce,
    });
    expect(res.statusCode).toBe(201);
  });

  it('finds the signed challenge among several live ones even without its nonce', async () => {
    const {agentId} = await register();
    const first = await challenge(agentId);
    await challenge(agentId);
    const res = await post(`/v1/agents/${agentId}/keys`, undefined, await signChallenge(owner, first));
    expect(res.statusCode).toBe(201);
  });

  it('keeps only a few live challenges per requester, so asking cannot grow without bound', async () => {
    const {agentId} = await register();
    for (let i = 0; i < 6; i++) await challenge(agentId);
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM key_challenges WHERE agent_id = ${agentId}`,
    )) as unknown as {n: number}[];
    expect(rows[0]!.n).toBeLessThanOrEqual(3);
  });

  it('is NOT_FOUND for an agent that does not exist', async () => {
    expect((await post('/v1/agents/999999/keys/challenge')).statusCode).toBe(404);
  });
});
