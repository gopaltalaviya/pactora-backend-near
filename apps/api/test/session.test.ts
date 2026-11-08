import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {authenticateCaller, sweepExpiredSessions} from '../src/auth.js';
import {
  addr,
  chainDeps,
  functionCallOnly,
  onChain,
  signChallenge,
  signedRegistration,
} from './helpers/register.js';

/**
 * People sign in (docs/26 F1, F2).
 *
 * A person proves control of a NEAR account by signing a single-use server
 * challenge with NEP-413, using a FULL-ACCESS key of that account — the same
 * check an agent's owner passes to register. They get a bearer session token,
 * `ps_<id>_<secret>`, never a cookie: the site and the API are on different
 * domains, and a bearer token carries no ambient credential a hostile page
 * could ride (so no CSRF defence is needed). Only its sha256 is stored.
 *
 * Sessions and agent keys are separate credentials: a session cannot call an
 * agent-key route, and an agent key cannot call a person route.
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
    submit: async () => ({txHash: '4yJxShz8HXfTyoTMXP9rQSoQUZE8uihkDmnpRrynZeZz'}),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  functionCallOnly.clear();
  await db.execute(
    sql`TRUNCATE agents, api_keys, agent_stats, agent_capabilities, registration_challenges RESTART IDENTITY CASCADE`,
  );
  // Tables this feature adds; absent on code that predates it.
  await db.execute(sql`
    DO $$ BEGIN
      IF to_regclass('sessions') IS NOT NULL THEN TRUNCATE sessions RESTART IDENTITY; END IF;
      IF to_regclass('login_challenges') IS NOT NULL THEN TRUNCATE login_challenges; END IF;
    END $$`);
});

const person = addr('ses-person');
const other = addr('ses-other');
const attacker = addr('ses-attacker');

let ip = 0;
/** A fresh client address per call, so the per-route limit only bites the test that wants it. */
const nextIp = () => `10.20.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;

async function challenge(accountId: string, remoteAddress = nextIp()) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/session/challenge',
    payload: {accountId},
    remoteAddress,
  });
  return res;
}

/** Sign in as `accountId`; `signer` holds the key that signs (an attacker's, in one test). */
async function signIn(accountId: string, signer = accountId) {
  const c = await challenge(accountId);
  expect(c.statusCode).toBe(201);
  const body = c.json() as {nonce: string; message: string};
  const signed = await signChallenge(signer, body, accountId);
  const payload = {accountId, nonce: body.nonce, ...signed};
  const res = await app.inject({method: 'POST', url: '/v1/session', payload, remoteAddress: nextIp()});
  return {res, payload};
}

async function tokenFor(accountId: string): Promise<string> {
  const {res} = await signIn(accountId);
  expect(res.statusCode).toBe(201);
  return (res.json() as {token: string}).token;
}

const bearer = (token: string) => ({authorization: `Bearer ${token}`});
const me = (token: string) => app.inject({method: 'GET', url: '/v1/session', headers: bearer(token)});

describe('the sign-in challenge', () => {
  it('names the account, chain and nonce, and starts with the line the site shows', async () => {
    const res = await challenge(person);
    expect(res.statusCode).toBe(201);
    const c = res.json() as {nonce: string; message: string; recipient: string; expiresAt: string};
    expect(c.message.split('\n')[0]).toBe('Pactora: sign in.');
    expect(c.message).toContain(person);
    expect(c.message).toContain('near:sandbox');
    expect(c.message).toContain(c.nonce);
    expect(c.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(c.recipient).toBe('pactora');
    const ttl = new Date(c.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60_000);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000);
  });

  it('keeps at most three live challenges per requester and account', async () => {
    for (let i = 0; i < 5; i++) expect((await challenge(person, '10.30.0.1')).statusCode).toBe(201);
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM login_challenges WHERE account_id = ${person}`,
    )) as unknown as {n: number}[];
    expect(rows[0]!.n).toBe(3);
  });

  it('refuses an account id that is not a NEAR account', async () => {
    expect((await challenge('Not An Account!')).statusCode).toBe(422);
  });
});

describe('signing in', () => {
  it('issues a ps_ session token for a full-access signature over a fresh challenge', async () => {
    const {res} = await signIn(person);
    expect(res.statusCode).toBe(201);
    const s = res.json() as {
      token: string;
      account: string;
      chainId: string;
      expiresAt: string;
      person: unknown;
    };
    expect(s.token).toMatch(/^ps_[0-9a-f]{16}_[A-Za-z0-9_-]{32}$/);
    expect(s.account).toBe(person);
    expect(s.chainId).toBe('near:sandbox');
    expect(s.person).toBeNull();
    const ttl = new Date(s.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(ttl).toBeLessThanOrEqual(7 * 86_400_000);

    // Only a hash is stored: the token itself is nowhere in the table.
    const rows = (await db.execute(sql`SELECT * FROM sessions`)) as unknown as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(s.token.split('_')[2]);
    expect(String(rows[0]!['secret_hash'])).toMatch(/^sha256\$[0-9a-f]{64}$/);

    const who = await me(s.token);
    expect(who.statusCode).toBe(200);
    expect(who.json()).toMatchObject({account: person, chainId: 'near:sandbox', person: null});
    expect(who.json()).not.toHaveProperty('token');
  });

  it('refuses a replayed challenge', async () => {
    const {res, payload} = await signIn(person);
    expect(res.statusCode).toBe(201);
    const again = await app.inject({method: 'POST', url: '/v1/session', payload});
    expect(again.statusCode).toBe(401);
  });

  it('refuses an expired challenge', async () => {
    const c = (await challenge(person)).json() as {nonce: string; message: string};
    await db.execute(sql`UPDATE login_challenges SET expires_at = now() - interval '1 second'`);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/session',
      payload: {accountId: person, nonce: c.nonce, ...(await signChallenge(person, c))},
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses another account's signature", async () => {
    const {res} = await signIn(person, attacker);
    expect(res.statusCode).toBe(401);
    expect((await db.execute(sql`SELECT 1 FROM sessions`)) as unknown as unknown[]).toHaveLength(0);
  });

  it('refuses a challenge issued for another account, though signed by the claimed one', async () => {
    const c = (await challenge(other)).json() as {nonce: string; message: string};
    const res = await app.inject({
      method: 'POST',
      url: '/v1/session',
      payload: {accountId: person, nonce: c.nonce, ...(await signChallenge(person, c))},
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a function-call key — an agent key cannot speak for the account', async () => {
    functionCallOnly.add(person);
    const {res} = await signIn(person);
    expect(res.statusCode).toBe(401);
  });
});

describe('a session', () => {
  it('stops working when it expires', async () => {
    const token = await tokenFor(person);
    expect((await me(token)).statusCode).toBe(200);
    await db.execute(sql`UPDATE sessions SET expires_at = now() - interval '1 second'`);
    expect((await me(token)).statusCode).toBe(401);
  });

  it('refuses a missing or malformed token', async () => {
    expect((await app.inject({method: 'GET', url: '/v1/session'})).statusCode).toBe(401);
    expect((await me('ps_0000000000000000_' + 'a'.repeat(32))).statusCode).toBe(401);
    expect((await me('nonsense')).statusCode).toBe(401);
  });

  it('logs out one session, or every session of the account', async () => {
    const a = await tokenFor(person);
    const b = await tokenFor(person);
    const c = await tokenFor(person);
    const elsewhere = await tokenFor(other);

    const one = await app.inject({method: 'DELETE', url: '/v1/session', headers: bearer(a)});
    expect(one.statusCode).toBe(204);
    expect((await me(a)).statusCode).toBe(401);
    expect((await me(b)).statusCode).toBe(200);

    const all = await app.inject({method: 'DELETE', url: '/v1/sessions', headers: bearer(b)});
    expect(all.statusCode).toBe(204);
    expect((await me(b)).statusCode).toBe(401);
    expect((await me(c)).statusCode).toBe(401);
    // Someone else's session is untouched.
    expect((await me(elsewhere)).statusCode).toBe(200);
  });

  it('cannot call an agent-key route', async () => {
    const token = await tokenFor(person);
    const res = await app.inject({method: 'GET', url: '/v1/budget', headers: bearer(token)});
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toMatch(/session/i);
  });

  it('cannot be stood in for by an agent API key', async () => {
    const reg = await signedRegistration(app, {
      name: 'SesBot',
      capabilities: ['market-research'],
      pricePerTask: '20000',
      walletAddress: addr('ses-bot-wallet'),
      ownerAddress: addr('ses-bot-owner'),
    });
    expect(reg.statusCode).toBe(201);
    const apiKey = (reg.json() as {apiKey: string}).apiKey;
    expect((await me(apiKey)).statusCode).toBe(401);
    const people = await app.inject({
      method: 'POST',
      url: '/v1/people',
      headers: bearer(apiKey),
      payload: {chainAgentId: '1', name: 'X'},
    });
    expect(people.statusCode).toBe(401);
    expect(
      (await app.inject({method: 'DELETE', url: '/v1/sessions', headers: bearer(apiKey)})).statusCode,
    ).toBe(401);
  });
});

describe('registering a person', () => {
  const join = (token: string, payload: Record<string, unknown>) =>
    app.inject({method: 'POST', url: '/v1/people', headers: bearer(token), payload});

  const counts = async () =>
    (
      (await db.execute(sql`
        SELECT (SELECT count(*)::int FROM agents) AS agents, (SELECT count(*)::int FROM api_keys) AS keys
      `)) as unknown as {agents: number; keys: number}[]
    )[0]!;

  it('records the account as a person — its own wallet and owner — and issues no API key', async () => {
    const chainAgentId = onChain({owner: person, wallet: person});
    const token = await tokenFor(person);
    const res = await join(token, {
      chainAgentId,
      name: 'Asha',
      description: 'Field photos',
      capabilities: ['market-research'],
    });
    expect(res.statusCode).toBe(201);
    const p = res.json() as {publicId: string; chainAgentId: string; name: string; kind: string};
    expect(p.publicId).toMatch(/^[0-9a-f-]{36}$/);
    expect(p).toMatchObject({chainAgentId, name: 'Asha', kind: 'person'});
    expect(res.json()).not.toHaveProperty('apiKey');
    expect(await counts()).toEqual({agents: 1, keys: 0});

    const rows = (await db.execute(
      sql`SELECT kind, owner_address, wallet_address FROM agents`,
    )) as unknown as {
      kind: string;
      owner_address: string;
      wallet_address: string;
    }[];
    expect(rows[0]).toEqual({kind: 'person', owner_address: person, wallet_address: person});

    // The session now names the person, and so does a new sign-in.
    expect((await me(token)).json().person).toEqual({publicId: p.publicId, chainAgentId, name: 'Asha'});
    const {res: again} = await signIn(person);
    expect(again.json().person).toEqual({publicId: p.publicId, chainAgentId, name: 'Asha'});

    // A person is not an agent: not in agent discovery.
    const listed = (await app.inject({url: '/v1/agents'})).json() as {agents: unknown[]};
    expect(listed.agents).toHaveLength(0);
  });

  it('answers a retry with the same record, not a second one', async () => {
    const chainAgentId = onChain({owner: person, wallet: person});
    const token = await tokenFor(person);
    const first = await join(token, {chainAgentId, name: 'Asha'});
    expect(first.statusCode).toBe(201);
    const second = await join(token, {chainAgentId, name: 'Asha'});
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect((await counts()).agents).toBe(1);
  });

  it('refuses an on-chain agent whose wallet is not the owner itself', async () => {
    const chainAgentId = onChain({owner: person, wallet: other});
    const res = await join(await tokenFor(person), {chainAgentId, name: 'Asha'});
    expect(res.statusCode).toBe(409);
    expect((await counts()).agents).toBe(0);
  });

  it('refuses a wallet that is only proposed, not accepted', async () => {
    const chainAgentId = onChain({owner: person, wallet: null, pendingWallet: person});
    const res = await join(await tokenFor(person), {chainAgentId, name: 'Asha'});
    expect(res.statusCode).toBe(409);
  });

  it("refuses someone else's on-chain agent", async () => {
    const chainAgentId = onChain({owner: other, wallet: other});
    const res = await join(await tokenFor(person), {chainAgentId, name: 'Asha'});
    expect(res.statusCode).toBe(409);
    expect((await counts()).agents).toBe(0);
  });

  it('refuses an agent id already registered as an agent', async () => {
    const chainAgentId = onChain({owner: person, wallet: person});
    const reg = await signedRegistration(app, {
      name: 'Bot',
      capabilities: ['market-research'],
      pricePerTask: '20000',
      walletAddress: person,
      ownerAddress: person,
      chainAgentId,
    });
    expect(reg.statusCode).toBe(201);
    const res = await join(await tokenFor(person), {chainAgentId, name: 'Asha'});
    expect(res.statusCode).toBe(409);
    const kinds = (await db.execute(sql`SELECT kind FROM agents`)) as unknown as {kind: string}[];
    expect(kinds).toEqual([{kind: 'agent'}]);
  });

  it('needs a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/people',
      payload: {chainAgentId: '1', name: 'X'},
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('abuse limits', () => {
  it('limits sign-in challenges to 40 a minute per client', async () => {
    const from = '10.40.0.1';
    for (let i = 0; i < 40; i++) {
      expect((await challenge(`ses-rl-${i}.test.near`, from)).statusCode, `request ${i + 1}`).toBe(201);
    }
    const over = await challenge(person, from);
    expect(over.statusCode).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
    // Another client is not affected.
    expect((await challenge(person, '10.40.0.2')).statusCode).toBe(201);
  });

  it('limits session creation to 40 a minute per client', async () => {
    const from = '10.41.0.1';
    const attempt = () => app.inject({method: 'POST', url: '/v1/session', payload: {}, remoteAddress: from});
    for (let i = 0; i < 40; i++) expect((await attempt()).statusCode).toBe(422);
    expect((await attempt()).statusCode).toBe(429);
  });

  it('allows DELETE from a browser on another origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/session',
      headers: {
        origin: 'http://127.0.0.1:3117',
        'access-control-request-method': 'DELETE',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(String(res.headers['access-control-allow-methods'])).toContain('DELETE');
  });
});

describe('either credential', () => {
  const asRequest = (token?: string) =>
    ({headers: token ? {authorization: `Bearer ${token}`} : {}}) as unknown as Parameters<
      typeof authenticateCaller
    >[1];

  it('resolves an agent key to the agent and a session to the person', async () => {
    const reg = await signedRegistration(app, {
      name: 'EitherBot',
      capabilities: ['market-research'],
      pricePerTask: '20000',
      walletAddress: addr('ses-either-wallet'),
      ownerAddress: addr('ses-either-owner'),
    });
    const {apiKey, agentId} = reg.json() as {apiKey: string; agentId: number};
    expect(await authenticateCaller(db, asRequest(apiKey))).toMatchObject({kind: 'agent', agentId});

    const token = await tokenFor(person);
    expect(await authenticateCaller(db, asRequest(token))).toMatchObject({
      kind: 'person',
      account: person,
      chainId: 'near:sandbox',
    });
    await expect(authenticateCaller(db, asRequest())).rejects.toMatchObject({code: 'UNAUTHORIZED'});
  });
});

describe('the hourly sweep', () => {
  it('deletes expired sessions and challenges, and nothing live', async () => {
    const live = await tokenFor(person);
    await tokenFor(other);
    await challenge(person);
    await db.execute(
      sql`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE account_id = ${other}`,
    );
    await db.execute(sql`UPDATE login_challenges SET expires_at = now() - interval '1 second'`);

    expect(await sweepExpiredSessions(db)).toEqual({sessions: 1, challenges: 1});
    const left = (await db.execute(sql`SELECT account_id FROM sessions`)) as unknown as {
      account_id: string;
    }[];
    expect(left).toEqual([{account_id: person}]);
    expect((await me(live)).statusCode).toBe(200);
  });
});
