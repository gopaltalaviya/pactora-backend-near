import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {sweepChangedKeySessions} from '../src/auth.js';
import {addr, chainDeps, keyOf, signedRegistration} from './helpers/register.js';
import {bearer, sessionOnly} from './helpers/people.js';

/**
 * Session revocation (2026-11-09, migration 0025): every session of an
 * account ends when the account's full-access key set changes on chain,
 * when its agent's API key is rotated or revoked, and (indexer tests) when
 * its agent's wallet is proposed or accepted. The next request with the old
 * token is told why. Also the rotate race from the live probe: N concurrent
 * rotates of one key leave exactly one live key.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
/** The fake chain's full-access keys per account; a test edits it to "rotate" a key. */
const chainKeys = new Map<string, string[]>();

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    rateLimitPerMinute: 100_000,
    sessionKeySweepMs: 0,
    listingExpirySweepMs: 0,
    readAccessKeys: async ({accountId}) =>
      chainKeys.get(accountId) ?? [keyOf(accountId).getPublicKey().toString()],
    submit: async () => ({txHash: '4yJxShz8HXfTyoTMXP9rQSoQUZE8uihkDmnpRrynZeZz'}),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  chainKeys.clear();
  await db.execute(
    sql`TRUNCATE agents, api_keys, agent_stats, agent_capabilities, registration_challenges, sessions, login_challenges RESTART IDENTITY CASCADE`,
  );
});

const me = (token: string) => app.inject({method: 'GET', url: '/v1/session', headers: bearer(token)});
const readKeys = async ({accountId}: {chainId: string; accountId: string}) =>
  chainKeys.get(accountId) ?? [keyOf(accountId).getPublicKey().toString()];

describe('sessions end when the account changes', () => {
  it("the account's full-access key set changes on chain: the sweep ends its sessions and says why", async () => {
    const alice = await sessionOnly(app, 'rev-alice');
    const alice2 = await sessionOnly(app, 'rev-alice');
    const bob = await sessionOnly(app, 'rev-bob');
    expect((await me(alice)).statusCode).toBe(200);

    // Nothing changed: nothing ends.
    expect(await sweepChangedKeySessions(db, readKeys)).toEqual({checked: 2, revoked: 0});
    expect((await me(alice)).statusCode).toBe(200);

    // Alice adds a second full-access key (or rotates): both her sessions end, Bob's stays.
    const account = addr('rev-alice');
    chainKeys.set(account, [
      keyOf(account).getPublicKey().toString(),
      'ed25519:4nQ6oX3xH1cQ1X3xH1cQ1X3xH1cQ1X3xH1cQ1X3xH1cQ',
    ]);
    expect((await sweepChangedKeySessions(db, readKeys)).revoked).toBe(2);
    const refused = await me(alice);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().detail).toMatch(/keys changed/);
    expect((await me(alice2)).statusCode).toBe(401);
    expect((await me(bob)).statusCode).toBe(200);
    // Signing in again works, and the new hash is recorded.
    const again = await sessionOnly(app, 'rev-alice');
    expect((await me(again)).statusCode).toBe(200);
    expect(await sweepChangedKeySessions(db, readKeys)).toEqual({checked: 2, revoked: 0});
  });

  it("rotating or revoking the agent's API key ends the owner account's sessions", async () => {
    const owner = addr('rev-owner');
    const reg = await signedRegistration(app, {
      name: 'R',
      capabilities: ['market-research'],
      pricePerTask: '20000',
      walletAddress: addr('rev-owner-wallet'),
      ownerAddress: owner,
    });
    expect(reg.statusCode, reg.body).toBe(201);
    const apiKey = (reg.json() as {apiKey: string}).apiKey;
    const ownerSession = await sessionOnly(app, 'rev-owner');
    const stranger = await sessionOnly(app, 'rev-stranger');

    const rotated = await app.inject({method: 'POST', url: '/v1/keys/rotate', headers: bearer(apiKey)});
    expect(rotated.statusCode, rotated.body).toBe(200);
    const after = await me(ownerSession);
    expect(after.statusCode).toBe(401);
    expect(after.json().detail).toMatch(/API key .* rotated or revoked/);
    expect((await me(stranger)).statusCode).toBe(200);

    const ownerSession2 = await sessionOnly(app, 'rev-owner');
    const fresh = (rotated.json() as {apiKey: string}).apiKey;
    expect(
      (await app.inject({method: 'POST', url: '/v1/keys/revoke', headers: bearer(fresh)})).statusCode,
    ).toBe(200);
    expect((await me(ownerSession2)).statusCode).toBe(401);
  });

  it('ten concurrent rotates of one key leave exactly one live key, and a second rotate of a dead key is 401', async () => {
    const reg = await signedRegistration(app, {
      name: 'R2',
      capabilities: ['market-research'],
      pricePerTask: '20000',
      walletAddress: addr('rev-race-wallet'),
      ownerAddress: addr('rev-race-owner'),
    });
    const apiKey = (reg.json() as {apiKey: string}).apiKey;
    const results = await Promise.all(
      Array.from({length: 10}, () =>
        app.inject({method: 'POST', url: '/v1/keys/rotate', headers: bearer(apiKey)}),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 401)).toHaveLength(9);
    const [{n}] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM api_keys WHERE revoked_at IS NULL`,
    )) as unknown as [{n: number}];
    expect(n).toBe(1);
    expect(
      (await app.inject({method: 'POST', url: '/v1/keys/revoke', headers: bearer(apiKey)})).statusCode,
    ).toBe(401);
  });
});
