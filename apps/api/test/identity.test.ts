import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@pactora/config';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import type {IdentityReading} from '../src/chain-reads.js';
import {addr, signedRegistration} from './helpers/register.js';

/**
 * Linking a Pactora record to its ERC-8004 identity.
 *
 * Nothing did. The route said `chain_agent_id` "stays NULL until the indexer
 * observes the registration", and the indexer only watches TaskEscrow — so
 * every agent registered through the API or the /register page could never
 * be hired, and the only agents that ever worked were the demo's, whose
 * scripts wrote the column with raw SQL. The other tests in this suite do the
 * same, which is how it went unnoticed.
 *
 * The chain confirms the id before it is stored: it must exist, belong to the
 * registrant, and pay out to the wallet given.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';

const OWNER = addr('22');
const WALLET_A = addr('11');
const WALLET_B = addr('33');

/** What the fake registry holds: ERC-8004 id → identity. */
let registry: Map<bigint, IdentityReading>;

let app: FastifyInstance;
let blind: FastifyInstance;
let db: Db;

const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  const base = {
    db,
    chains: config.chains as Record<number, never>,
    defaultChainId: 31337,
    bus: new EventBus(),
    submit: async () => ({txHash: `0x${'ab'.repeat(32)}`, chainJobId: '1'}),
  };
  app = await buildApp({...base, readIdentity: async ({chainAgentId}) => registry.get(chainAgentId) ?? null});
  blind = await buildApp(base);
});

afterAll(async () => {
  await app.close();
  await blind.close();
  await closeDb(db);
});

beforeEach(async () => {
  registry = new Map([
    [41n, {owner: OWNER, wallet: WALLET_A}],
    [42n, {owner: OWNER, wallet: WALLET_B}],
  ]);
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments RESTART IDENTITY CASCADE`,
  );
});

const register = (server: FastifyInstance, over: Record<string, unknown>) =>
  signedRegistration(server, {
    name: 'ResearchBot',
    capabilities: ['market-research'],
    pricePerTask: '20000',
    walletAddress: WALLET_A,
    ownerAddress: OWNER,
    ...over,
  });

const storedIds = async () =>
  (
    (await db.execute(sql`SELECT chain_agent_id FROM agents ORDER BY id`)) as unknown as {
      chain_agent_id: string | null;
    }[]
  ).map((r) => r.chain_agent_id);

describe('registering with an ERC-8004 id', () => {
  it('stores a verified id, and the agent can be hired straight away', async () => {
    const client = await register(app, {chainAgentId: '41', name: 'Client'});
    const worker = await register(app, {chainAgentId: '42', walletAddress: WALLET_B});
    expect(client.statusCode).toBe(201);
    expect(worker.statusCode).toBe(201);
    expect(await storedIds()).toEqual(['41', '42']);

    const hire = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {authorization: `Bearer ${client.json().apiKey}`, 'idempotency-key': 'identity-0001'},
      payload: {
        workerAgentId: String(worker.json().agentId),
        spec: {capability: 'market-research', input: {}},
        maxPrice: '50000',
      },
    });
    expect(hire.statusCode).toBe(201);
  });

  /** Otherwise anyone could claim an identity, and its reputation, by naming its id. */
  it('refuses an id owned by someone else', async () => {
    const res = await register(app, {chainAgentId: '41', ownerAddress: addr('44')});
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/owned by/);
    expect(await storedIds()).toEqual([]);
  });

  /** The escrow pays the registry's wallet; a mismatch sends money elsewhere. */
  it('refuses an id whose payout wallet is not the one given', async () => {
    const res = await register(app, {chainAgentId: '41', walletAddress: WALLET_B});
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/pays out to/);
    expect(await storedIds()).toEqual([]);
  });

  it('refuses an id that does not exist', async () => {
    const res = await register(app, {chainAgentId: '999'});
    expect(res.statusCode).toBe(409);
    expect(await storedIds()).toEqual([]);
  });

  it('refuses rather than trusts an id it has no way to check', async () => {
    const res = await register(blind, {chainAgentId: '41'});
    expect(res.statusCode).toBe(409);
    expect(await storedIds()).toEqual([]);
  });

  it('still registers without one, unhireable until linked', async () => {
    const res = await register(app, {});
    expect(res.statusCode).toBe(201);
    expect(await storedIds()).toEqual([null]);
  });
});
