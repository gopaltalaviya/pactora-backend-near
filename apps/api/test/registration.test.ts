import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import type {IdentityReading} from '../src/chain-reads.js';

/**
 * Audit M1: registration had no proof of control.
 *
 * It checked only that the owner and wallet named matched public chain data —
 * which anyone can read. So a front-runner could register the victim's
 * ERC-8004 agent and receive its only API key; or claim the victim's wallet
 * with no ERC-8004 id at all, so that the victim's own registration hit the
 * unique index, and key re-issue then trusted the attacker's owner address.
 *
 * Now the owner signs a server-issued, single-use challenge that names what
 * is being registered; and a wallet with no ERC-8004 id behind it must sign
 * too, unless it IS the owner.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});

const owner = privateKeyToAccount(generatePrivateKey());
const wallet = privateKeyToAccount(generatePrivateKey());
const attacker = privateKeyToAccount(generatePrivateKey());

let registry: Map<bigint, IdentityReading>;
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
    readIdentity: async ({chainAgentId}) => registry.get(chainAgentId) ?? null,
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  registry = new Map([[41n, {owner: owner.address, wallet: wallet.address}]]);
  await db.execute(
    sql`TRUNCATE agents, api_keys, agent_stats, agent_capabilities, registration_challenges RESTART IDENTITY CASCADE`,
  );
});

const details = (over: Record<string, unknown> = {}) => ({
  name: 'ResearchBot',
  capabilities: ['market-research'],
  pricePerTask: '20000',
  walletAddress: wallet.address,
  ownerAddress: owner.address,
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
      ...(body['chainAgentId'] !== undefined ? {chainAgentId: body['chainAgentId']} : {}),
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {nonce: string; message: string; expiresAt: string};
}

const post = (payload: Record<string, unknown>) => app.inject({method: 'POST', url: '/v1/agents', payload});

const agentCount = async () =>
  ((await db.execute(sql`SELECT count(*)::int AS n FROM agents`)) as unknown as {n: number}[])[0]!.n;

describe('registering an agent', () => {
  it('refuses a registration that carries no owner signature', async () => {
    const res = await post(details({chainAgentId: '41'}));
    expect(res.statusCode).toBe(422);
    expect(await agentCount()).toBe(0);
  });

  /** The front-run: the victim's id, owner and wallet are all public. */
  it("refuses someone else's ERC-8004 agent, though every public fact matches", async () => {
    const body = details({chainAgentId: '41'});
    const {nonce, message} = await challengeFor(body);
    const res = await post({...body, nonce, signature: await attacker.signMessage({message})});
    expect(res.statusCode).toBe(401);
    expect(await agentCount()).toBe(0);
  });

  it("registers with the owner's signature over a fresh challenge", async () => {
    const body = details({chainAgentId: '41'});
    const {nonce, message} = await challengeFor(body);
    // The website shows and documents this exact first line.
    expect(message.split('\n')[0]).toBe('Pactora: register an agent.');
    expect(message).toContain(owner.address.toLowerCase());
    expect(message).toContain(wallet.address.toLowerCase());
    const res = await post({...body, nonce, signature: await owner.signMessage({message})});
    expect(res.statusCode).toBe(201);
    expect(res.json().apiKey).toMatch(/^ax_/);
  });

  it('accepts a challenge once', async () => {
    const body = details({chainAgentId: '41'});
    const {nonce, message} = await challengeFor(body);
    const signature = await owner.signMessage({message});
    expect((await post({...body, nonce, signature})).statusCode).toBe(201);
    await db.execute(sql`TRUNCATE agents RESTART IDENTITY CASCADE`);
    expect((await post({...body, nonce, signature})).statusCode).toBe(401);
  });

  it('refuses an expired challenge', async () => {
    const body = details({chainAgentId: '41'});
    const {nonce, message} = await challengeFor(body);
    await db.execute(sql`UPDATE registration_challenges SET expires_at = now() - interval '1 second'`);
    const res = await post({...body, nonce, signature: await owner.signMessage({message})});
    expect(res.statusCode).toBe(401);
  });

  /** A signature is for the registration it names, not for any registration by that owner. */
  it('refuses a signature made for a different wallet', async () => {
    const signed = details({chainAgentId: '41'});
    const {nonce, message} = await challengeFor(signed);
    const swapped = {...signed, walletAddress: attacker.address};
    const res = await post({...swapped, nonce, signature: await owner.signMessage({message})});
    expect(res.statusCode).toBe(401);
  });
});

describe('claiming a wallet with no ERC-8004 id behind it', () => {
  it("is refused on the owner's signature alone", async () => {
    const body = details();
    const {nonce, message} = await challengeFor(body);
    const res = await post({...body, nonce, signature: await owner.signMessage({message})});
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toMatch(/walletSignature/);
    expect(await agentCount()).toBe(0);
  });

  it('is allowed when the wallet signs the same challenge', async () => {
    const body = details();
    const {nonce, message} = await challengeFor(body);
    const res = await post({
      ...body,
      nonce,
      signature: await owner.signMessage({message}),
      walletSignature: await wallet.signMessage({message}),
    });
    expect(res.statusCode).toBe(201);
  });

  it('needs one signature when the wallet IS the owner', async () => {
    const body = details({walletAddress: owner.address});
    const {nonce, message} = await challengeFor(body);
    const res = await post({...body, nonce, signature: await owner.signMessage({message})});
    expect(res.statusCode).toBe(201);
  });

  it("is refused when the 'wallet' signature is someone else's", async () => {
    const body = details();
    const {nonce, message} = await challengeFor(body);
    const res = await post({
      ...body,
      nonce,
      signature: await owner.signMessage({message}),
      walletSignature: await attacker.signMessage({message}),
    });
    expect(res.statusCode).toBe(401);
  });
});
