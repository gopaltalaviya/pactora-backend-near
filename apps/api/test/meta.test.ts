import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@pactora/config';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import type {BudgetReader, BudgetReading} from '../src/chain-reads.js';
import {addr, chainDeps, signedRegistration} from './helpers/register.js';

/**
 * `/v1/network` and `/v1/budget` — the two things an autonomous agent must be
 * able to learn before it spends.
 *
 * The budget reader is injected, so these run without an RPC. What is under
 * test is the part that is ours: which source answered, how the two caps
 * combine, and that a failing chain read degrades instead of erroring.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';

let app: FastifyInstance;
let db: Db;
/** Swapped per test; `null` means "not an AgentAccount, or RPC down". */
let reading: BudgetReading | null | 'throw' = null;

const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

const readBudget: BudgetReader = async () => {
  if (reading === 'throw') throw new Error('RPC unreachable');
  return reading;
};

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    readBudget,
    submit: async () => ({txHash: '5zJxShz8HXfTyoTMXP9rQSoQUZE8uihkDmnpRrynZeZz', chainJobId: '1'}),
  });
});

afterAll(async () => {
  await app.close();
  await closeDb(db);
});

beforeEach(async () => {
  reading = null;
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, spend_policies RESTART IDENTITY CASCADE`,
  );
});

async function register(): Promise<{agentId: number; apiKey: string}> {
  const res = await signedRegistration(app, {
    name: 'BudgetBot',
    capabilities: ['market-research'],
    pricePerTask: '20000',
    walletAddress: addr('11'),
    ownerAddress: addr('22'),
  });
  expect(res.statusCode).toBe(201);
  return res.json() as {agentId: number; apiKey: string};
}

const auth = (apiKey: string) => ({authorization: `Bearer ${apiKey}`});

describe('GET /v1/network', () => {
  it('answers without credentials, because a client checks the network before holding a key', async () => {
    const res = await app.inject({method: 'GET', url: '/v1/network'});
    expect(res.statusCode).toBe(200);
    expect(res.json().chainId).toBe('near:sandbox');
  });

  /** The field that stops an agent treating real money as play money. */
  it('states whether the money is real', async () => {
    const body = (await app.inject({method: 'GET', url: '/v1/network'})).json();
    expect(typeof body.testnet).toBe('boolean');
  });

  /** Null here made a hosted x402 worker refuse to start: "no payment token". */
  it('names the payment token the escrow is paid in', async () => {
    const {paymentToken, contracts} = (await app.inject({method: 'GET', url: '/v1/network'})).json();
    expect(paymentToken.accountId).toBe('musdc.test.near');
    expect(paymentToken.accountId).toBe(contracts.PaymentToken);
  });

  it('reports the windows an agent must plan against, in seconds', async () => {
    const {windows} = (await app.inject({method: 'GET', url: '/v1/network'})).json();
    expect(windows.accept).toBeGreaterThan(0);
    expect(windows.work).toBeGreaterThan(0);
    expect(windows.review).toBeGreaterThan(0);
  });

  it('reports the fast-path threshold, so a caller can predict which path a hire takes', async () => {
    const body = (await app.inject({method: 'GET', url: '/v1/network'})).json();
    expect(BigInt(body.fastPathMax)).toBeGreaterThan(0n);
    expect(body.fastPathMaxDisplay).toMatch(/\d/);
  });

  /** Everything a client calls on NEAR lives in these accounts (docs/NEAR-PORT.md §4). */
  it('names the Pactora contract, the token and the arbiter, and the NEAR network id', async () => {
    const body = (await app.inject({method: 'GET', url: '/v1/network'})).json();
    expect(body.chainId).toBe('near:sandbox');
    expect(body.nearNetworkId).toBe('sandbox');
    expect(body.contracts).toEqual({
      Pactora: 'pactora.test.near',
      PaymentToken: 'musdc.test.near',
      Arbiter: 'arbiter.test.near',
    });
    expect(body.nativeCurrency).toEqual({name: 'NEAR', symbol: 'NEAR', decimals: 24});
    expect(body).not.toHaveProperty('erc8004');
    expect(body).not.toHaveProperty('confirmations');
  });

  /**
   * A private RPC endpoint carries its credential in the URL. Publishing the
   * resolved endpoint would hand it to every browser that loads the page.
   */
  it('publishes the public RPC list, never an env-configured private endpoint', async () => {
    const configured = loadConfig({
      contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
      env: {
        ENABLED_CHAINS: 'near:sandbox',
        RPC_URL_SANDBOX: 'https://paid-provider.example/v2/SECRET-KEY',
      },
    });
    const withPrivateRpc = await buildApp({
      ...chainDeps(config),
      db,
      chains: configured.chains,
      defaultChainId: 'near:sandbox',
      bus: new EventBus(),
      submit: async () => ({txHash: '0x', chainJobId: '1'}),
    });

    try {
      const body = (await withPrivateRpc.inject({method: 'GET', url: '/v1/network'})).json();
      expect(JSON.stringify(body)).not.toContain('SECRET-KEY');
      expect(body.rpcUrls).toEqual(['http://127.0.0.1:3030']);
    } finally {
      await withPrivateRpc.close();
    }
  });

  /**
   * Every fee and limit a user meets, straight from the chain params the
   * drift checker keeps equal to the contracts — so a site can show the real
   * numbers for the chain it is on instead of a hand-copied table that drifts.
   */
  it('reports every user-facing fee and limit, from the chain params', async () => {
    const body = (await app.inject({method: 'GET', url: '/v1/network'})).json();
    const p = config.chain('near:sandbox').params;
    expect(body).toMatchObject({
      bondBps: Number(p.bondBps),
      minBond: String(p.minBond),
      disputeBondBps: Number(p.disputeBondBps),
      minDisputeBond: String(p.minDisputeBond),
      maxJobAmount: String(p.maxJobAmount),
      defaultPerTaskCap: String(p.defaultPerTaskCap),
      defaultDailyCap: String(p.defaultDailyCap),
      minStake: String(p.minStake),
      withdrawDelaySeconds: Number(p.withdrawDelaySeconds),
    });
    for (const k of [
      'minBond',
      'minDisputeBond',
      'maxJobAmount',
      'defaultPerTaskCap',
      'defaultDailyCap',
      'minStake',
    ]) {
      expect(body[k], `${k} is a base-unit decimal string`).toMatch(/^\d+$/);
    }
  });

  it('falls back to the default chain rather than erroring on an unknown one', async () => {
    const body = (await app.inject({method: 'GET', url: '/v1/network?chainId=99999'})).json();
    expect(body.chainId).toBe('near:sandbox');
  });
});

describe('GET /v1/budget', () => {
  /**
   * The bug the first live demo run found. A newly registered agent had no
   * spend policy, so the budget read fell back to a cache with nothing in it
   * and reported zero — and the orchestrator, correctly refusing to hire
   * beyond its budget, refused to hire at all. The marketplace did not work
   * for anyone who had just joined it.
   */
  it('gives a newly registered agent a usable budget, not zero', async () => {
    const {apiKey} = await register();
    reading = null; // no AgentAccount on chain, as for any EOA-backed agent

    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(BigInt(body.perTaskCap), 'per-task cap must not be zero').toBeGreaterThan(0n);
    expect(BigInt(body.dailyRemaining), 'a new agent must be able to spend something').toBeGreaterThan(0n);
    expect(BigInt(body.maxSingleSpend)).toBeGreaterThan(0n);
  });

  it('takes the starting policy from chain config, not from a literal', async () => {
    const {apiKey} = await register();
    reading = null;
    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(body.perTaskCap).toBe(String(config.chain('near:sandbox').params.defaultPerTaskCap));
    expect(body.dailyCap).toBe(String(config.chain('near:sandbox').params.defaultDailyCap));
  });

  it('requires a key — a budget is not public information', async () => {
    const res = await app.inject({method: 'GET', url: '/v1/budget'});
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('prefers the chain and says so', async () => {
    const {apiKey} = await register();
    reading = {
      perTaskCap: 50_000n,
      dailyCap: 500_000n,
      dailyRemaining: 300_000n,
      allowlistOnly: false,
      tokenBalance: 1_000_000n,
      nextReleaseAt: 0n,
    };

    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(body.source).toBe('chain');
    expect(body.dailyRemaining).toBe('300000');
    expect(body.tokenBalance).toBe('1000000');
  });

  /**
   * The number an agent actually plans against. Reporting the caps separately
   * and leaving the agent to combine them is how you get a hire that passes
   * the per-task check and reverts on the daily one.
   */
  it('reports the tighter of the two caps as the most one hire can cost', async () => {
    const {apiKey} = await register();
    reading = {
      perTaskCap: 50_000n,
      dailyCap: 500_000n,
      dailyRemaining: 20_000n, // today's remainder is now the binding limit
      allowlistOnly: false,
      tokenBalance: 0n,
      nextReleaseAt: 0n,
    };

    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(body.maxSingleSpend).toBe('20000');
  });

  it('falls back to the cached policy when the wallet is not an AgentAccount', async () => {
    const {agentId, apiKey} = await register();
    reading = null;
    await db.execute(
      // Registration now creates the row, so a test that wants different
      // numbers updates it rather than inserting a second one.
      sql`UPDATE spend_policies SET per_task_cap='40000', daily_cap='400000', spent_today='150000'
          WHERE agent_id = ${agentId}`,
    );

    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(body.source).toBe('cache');
    expect(body.dailyRemaining).toBe('250000');
  });

  /**
   * The failure that matters: an unreachable RPC must not take the budget
   * endpoint down with it, because an agent that cannot read its budget
   * reverts to learning it from 402s.
   */
  it('degrades to the cache when the chain read throws, rather than failing', async () => {
    const {apiKey} = await register();
    reading = 'throw';

    const res = await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)});
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe('cache');
  });

  /**
   * The signer rolls the window over after 24 hours, and so must the report
   * of it. This read `daily_cap - spent_today` whatever the window's age, so
   * an agent that spent yesterday was told today's budget was already used —
   * and an orchestrator that trusts my_budget stops hiring for no reason.
   */
  it('reports a full budget once the 24-hour window has passed', async () => {
    const {agentId, apiKey} = await register();
    reading = null;
    await db.execute(
      sql`UPDATE spend_policies SET per_task_cap='40000', daily_cap='400000', spent_today='390000',
          day_start = now() - interval '25 hours' WHERE agent_id = ${agentId}`,
    );

    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(body.dailyRemaining).toBe('400000');
    expect(body.resetsInSeconds).toBe(0);
  });

  it('never reports a negative remainder when spending has overrun the cache', async () => {
    const {agentId, apiKey} = await register();
    await db.execute(
      sql`UPDATE spend_policies SET per_task_cap='40000', daily_cap='100000', spent_today='150000'
          WHERE agent_id = ${agentId}`,
    );

    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(body.dailyRemaining).toBe('0');
    expect(body.maxSingleSpend).toBe('0');
  });

  /**
   * v3: the contract's cap ROLLS — no 24 hours may exceed it — and the
   * account says when its oldest counted spend leaves the window. That is
   * when capacity next returns; "UTC midnight" or "24h after the first spend"
   * would both send an agent to sleep for the wrong duration.
   */
  it('reports when capacity returns, from the contract clock', async () => {
    const {apiKey} = await register();
    const inTwoHours = BigInt(Math.floor(Date.now() / 1000) + 2 * 3600);
    reading = {
      perTaskCap: 50_000n,
      dailyCap: 500_000n,
      dailyRemaining: 100_000n,
      allowlistOnly: false,
      tokenBalance: 0n,
      nextReleaseAt: inTwoHours,
    };

    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(body.resetsInSeconds).toBeGreaterThan(2 * 3600 - 60);
    expect(body.resetsInSeconds).toBeLessThanOrEqual(2 * 3600);
  });

  it('reports nothing to wait for when the account has counted no spend', async () => {
    const {apiKey} = await register();
    reading = {
      perTaskCap: 50_000n,
      dailyCap: 500_000n,
      dailyRemaining: 500_000n,
      allowlistOnly: false,
      tokenBalance: 0n,
      nextReleaseAt: 0n,
    };
    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(body.resetsInSeconds).toBe(0);
  });

  it('reports a full window as already reset when nothing has been spent', async () => {
    const {apiKey} = await register();
    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(body.resetsInSeconds).toBe(0);
  });
});
