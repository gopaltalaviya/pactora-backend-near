import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {signNep413} from '@pactora/near';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {addr, chainDeps, functionCallOnly, keyOf, signChallenge} from './helpers/register.js';
import {buildApp, EventBus} from '../src/app.js';
import type {IdentityReading} from '../src/chain-reads.js';

/**
 * Audit M1: registration had no proof of control.
 *
 * It checked only that the owner and wallet named matched public chain data —
 * which anyone can read. So a front-runner could register the victim's agent
 * and receive its only API key.
 *
 * Now the owner signs a server-issued, single-use challenge that names what
 * is being registered — on NEAR with NEP-413, and with a FULL-ACCESS key of
 * the owner's account (docs/NEAR-WIRE.md §5). The agent's own function-call
 * key, which the signer holds, cannot sign for its owner.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

const owner = addr('reg-owner');
const wallet = addr('reg-wallet');
const attacker = addr('reg-attacker');

let registry: Map<bigint, IdentityReading>;
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
    readIdentity: async ({chainAgentId}) => registry.get(chainAgentId) ?? null,
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  functionCallOnly.clear();
  registry = new Map([[41n, {owner, wallet, pendingWallet: null, frozen: false}]]);
  await db.execute(
    sql`TRUNCATE agents, api_keys, agent_stats, agent_capabilities, registration_challenges RESTART IDENTITY CASCADE`,
  );
});

const details = (over: Record<string, unknown> = {}) => ({
  name: 'ResearchBot',
  capabilities: ['market-research'],
  pricePerTask: '20000',
  walletAddress: wallet,
  ownerAddress: owner,
  chainAgentId: '41',
  ...over,
});

/** Ask for a challenge for these details; returns what to sign and its nonce. */
async function challengeFor(body: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents/challenge',
    payload: {
      ownerAddress: body['ownerAddress'],
      walletAddress: body['walletAddress'],
      chainAgentId: body['chainAgentId'],
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {nonce: string; message: string; recipient: string; expiresAt: string};
}

const post = (payload: Record<string, unknown>) => app.inject({method: 'POST', url: '/v1/agents', payload});

const agentCount = async () =>
  ((await db.execute(sql`SELECT count(*)::int AS n FROM agents`)) as unknown as {n: number}[])[0]!.n;

describe('registering an agent', () => {
  it('refuses a registration that carries no owner signature', async () => {
    const res = await post(details());
    expect(res.statusCode).toBe(422);
    expect(await agentCount()).toBe(0);
  });

  /** The front-run: the victim's id, owner and wallet are all public. */
  it("refuses someone else's agent, though every public fact matches", async () => {
    const body = details();
    const c = await challengeFor(body);
    // The attacker signs with their own key, claiming to be the owner.
    const res = await post({...body, nonce: c.nonce, ...(await signChallenge(attacker, c, owner))});
    expect(res.statusCode).toBe(401);
    expect(await agentCount()).toBe(0);
  });

  it("registers with the owner's NEP-413 signature over a fresh challenge", async () => {
    const body = details();
    const c = await challengeFor(body);
    // The website shows and documents this exact first line.
    expect(c.message.split('\n')[0]).toBe('Pactora: register an agent.');
    expect(c.message).toContain(owner);
    expect(c.message).toContain(wallet);
    expect(c.message).toContain('Agent id: 41');
    expect(c.nonce).toMatch(/^[0-9a-f]{64}$/); // NEP-413: exactly 32 bytes
    expect(c.recipient).toBe('pactora');
    const res = await post({...body, nonce: c.nonce, ...(await signChallenge(owner, c))});
    expect(res.statusCode).toBe(201);
    expect(res.json().apiKey).toMatch(/^ax_/);
  });

  it('accepts a challenge once', async () => {
    const body = details();
    const c = await challengeFor(body);
    const signed = await signChallenge(owner, c);
    expect((await post({...body, nonce: c.nonce, ...signed})).statusCode).toBe(201);
    await db.execute(sql`TRUNCATE agents RESTART IDENTITY CASCADE`);
    expect((await post({...body, nonce: c.nonce, ...signed})).statusCode).toBe(401);
  });

  it('refuses an expired challenge', async () => {
    const body = details();
    const c = await challengeFor(body);
    await db.execute(sql`UPDATE registration_challenges SET expires_at = now() - interval '1 second'`);
    const res = await post({...body, nonce: c.nonce, ...(await signChallenge(owner, c))});
    expect(res.statusCode).toBe(401);
  });

  /** A signature is for the registration it names, not for any registration by that owner. */
  it('refuses a signature made for a different wallet', async () => {
    const signedFor = details();
    const c = await challengeFor(signedFor);
    const swapped = {...signedFor, walletAddress: attacker};
    const res = await post({...swapped, nonce: c.nonce, ...(await signChallenge(owner, c))});
    expect(res.statusCode).toBe(401);
  });
});

describe('what a NEP-413 signature must be', () => {
  /** The agent's own key is a function-call key: it must not be able to speak for its owner. */
  it("refuses the owner's function-call key, though the signature is valid", async () => {
    functionCallOnly.add(owner);
    const body = details();
    const c = await challengeFor(body);
    const res = await post({...body, nonce: c.nonce, ...(await signChallenge(owner, c))});
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toMatch(/full-access key/);
    expect(await agentCount()).toBe(0);
  });

  /** NEP-413's recipient binds a signature to the app it was made for; another app's is worthless here. */
  it('refuses a signature made for another recipient', async () => {
    const body = details();
    const c = await challengeFor(body);
    const elsewhere = await signNep413({
      accountId: owner,
      keyPair: keyOf(owner),
      message: c.message,
      recipient: 'some-other-app',
      nonce: new Uint8Array(Buffer.from(c.nonce, 'hex')),
    });
    const res = await post({
      ...body,
      nonce: c.nonce,
      publicKey: elsewhere.publicKey,
      signature: elsewhere.signature,
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a malformed public key or signature with a 422 that names the field', async () => {
    const body = details();
    const c = await challengeFor(body);
    const bad = await post({...body, nonce: c.nonce, publicKey: '0xabc', signature: 'not base64!'});
    expect(bad.statusCode).toBe(422);
    expect(JSON.stringify(bad.json())).toMatch(/publicKey|signature/);
  });
});
