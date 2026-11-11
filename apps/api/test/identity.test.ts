import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@pactora/config';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import type {IdentityReading} from '../src/chain-reads.js';
import {accepted, addr, fakeOwnerVerifier, fakeWalletKeys, signedRegistration} from './helpers/register.js';

/**
 * Linking a Pactora record to its on-chain agent (docs/NEAR-WIRE.md §5).
 *
 * Leaving it to the indexer ("`chain_agent_id` stays NULL until the indexer
 * observes the registration") would mean an agent registered through the API
 * could never be hired if the indexer missed it. So the id is
 * REQUIRED, and the contract confirms it before it is stored: the agent must
 * exist, belong to the registrant, not be frozen, and name the wallet given —
 * accepted, or proposed and then accepted by the signer with the wallet's own
 * key.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';

const OWNER = addr('22');
const WALLET_A = addr('11');
const WALLET_B = addr('33');
const WALLET_C = addr('55');

/** What the fake contract's registry holds: agent id → agent. */
let registry: Map<bigint, IdentityReading>;

let app: FastifyInstance;
let blind: FastifyInstance;
let keyless: FastifyInstance;
let db: Db;

const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  const base = {
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    verifyOwner: fakeOwnerVerifier(config),
    submit: async () => ({txHash: '4yJxShz8HXfTyoTMXP9rQSoQUZE8uihkDmnpRrynZeZz', chainJobId: '1'}),
  };
  const readIdentity = async ({chainAgentId}: {chainAgentId: bigint}) => registry.get(chainAgentId) ?? null;
  // The accepting signer of the shared helper, against this file's registry.
  const walletKeys = {
    ...fakeWalletKeys,
    accept: async (args: {chainId: string; walletAddress: string; chainAgentId: string}) => {
      const a = registry.get(BigInt(args.chainAgentId));
      if (a && a.pendingWallet === args.walletAddress) {
        a.wallet = args.walletAddress;
        a.pendingWallet = null;
      }
      accepted.push(args);
      return {txHash: 'AcceptTx1111111111111111111111111111111111111', alreadyAccepted: false};
    },
  };
  app = await buildApp({...base, readIdentity, walletKeys});
  blind = await buildApp(base);
  keyless = await buildApp({...base, readIdentity});
});

afterAll(async () => {
  await app.close();
  await blind.close();
  await keyless.close();
  await closeDb(db);
});

beforeEach(async () => {
  accepted.length = 0;
  registry = new Map([
    [41n, {owner: OWNER, wallet: WALLET_A, pendingWallet: null, frozen: false}],
    [42n, {owner: OWNER, wallet: WALLET_B, pendingWallet: null, frozen: false}],
    [43n, {owner: OWNER, wallet: null, pendingWallet: WALLET_C, frozen: false}],
    [44n, {owner: OWNER, wallet: WALLET_A, pendingWallet: null, frozen: true}],
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

describe('registering an on-chain agent', () => {
  it('stores a verified id, and the agent can be hired straight away', async () => {
    const client = await register(app, {chainAgentId: '41', name: 'Client'});
    const worker = await register(app, {chainAgentId: '42', walletAddress: WALLET_B});
    expect(client.statusCode).toBe(201);
    expect(worker.statusCode).toBe(201);
    expect(await storedIds()).toEqual(['41', '42']);
    expect(accepted).toEqual([]); // both wallets had already accepted

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

  /** The contract lets only its wallet act for the agent; a mismatch hands the agent to someone else. */
  it('refuses an id whose wallet is not the one given', async () => {
    const res = await register(app, {chainAgentId: '41', walletAddress: WALLET_B});
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/wallet is/);
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

  it('refuses a frozen agent: the owner pulled its kill switch', async () => {
    const res = await register(app, {chainAgentId: '44'});
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/frozen/);
    expect(await storedIds()).toEqual([]);
  });

  it('has the signer accept a proposed wallet first, then stores the agent', async () => {
    const res = await register(app, {chainAgentId: '43', walletAddress: WALLET_C});
    expect(res.statusCode).toBe(201);
    expect(accepted).toEqual([{chainId: 'near:sandbox', walletAddress: WALLET_C, chainAgentId: '43'}]);
    expect(registry.get(43n)!.wallet).toBe(WALLET_C);
    expect(await storedIds()).toEqual(['43']);
  });

  it('refuses a proposed wallet when there is no signer to accept for it', async () => {
    const res = await register(keyless, {chainAgentId: '43', walletAddress: WALLET_C});
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/has not accepted/);
    expect(await storedIds()).toEqual([]);
  });

  it('requires the id: an agent that is not on chain can never be hired', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/challenge',
      payload: {ownerAddress: OWNER, walletAddress: WALLET_A},
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toMatch(/chainAgentId/);
  });
});

describe('POST /v1/agents/wallet-key', () => {
  it('hands out the public half of the key the signer holds for a wallet', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/wallet-key',
      payload: {walletAddress: WALLET_C},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      chainId: 'near:sandbox',
      walletAddress: WALLET_C,
      walletPublicKey: expect.stringMatching(/^ed25519:/),
    });
  });

  it('refuses something that is not a NEAR account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/wallet-key',
      payload: {walletAddress: '0x14b93e928aabd1aa9b3479c84bf168358eb27dC6'},
    });
    expect(res.statusCode).toBe(422);
  });

  it('says plainly when there is no signer to hold keys', async () => {
    const res = await blind.inject({
      method: 'POST',
      url: '/v1/agents/wallet-key',
      payload: {walletAddress: WALLET_C},
    });
    expect(res.statusCode).toBe(409);
  });

  /**
   * Audit M1: the route needs no credentials and every new wallet costs the
   * signer a key derivation and a row. One client gets ten a minute,
   * whatever the app-wide limit.
   */
  it('allows one client 10 wallet keys a minute, then 429', async () => {
    const own = await buildApp({
      db,
      chains: config.chains,
      defaultChainId: 'near:sandbox',
      bus: new EventBus(),
      verifyOwner: fakeOwnerVerifier(config),
      submit: async () => ({txHash: 'unused'}),
      walletKeys: fakeWalletKeys,
      rateLimitPerMinute: 100_000,
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) {
        codes.push(
          (
            await own.inject({
              method: 'POST',
              url: '/v1/agents/wallet-key',
              payload: {walletAddress: `burst-${i}.test.near`},
            })
          ).statusCode,
        );
      }
      expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
      expect(codes[10]).toBe(429);
    } finally {
      await own.close();
    }
  });
});
