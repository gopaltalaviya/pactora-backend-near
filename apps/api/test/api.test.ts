import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@pactora/config';
import {sql} from 'drizzle-orm';
import {sha256Hex} from '@pactora/near';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {addr, chainDeps, signedRegistration} from './helpers/register.js';

/**
 * API behaviour, exercised through real HTTP against a real database.
 *
 * `submit` is injected, so no signer, no chain and no network are involved —
 * the chain path is covered by the contract suite and verify-indexer. What is
 * under test here is authorisation, state transitions, idempotency and the
 * error contract, which is exactly where a demo breaks.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';

let app: FastifyInstance;
let db: Db;
let submitted: {kind: string; spend: bigint; idempotencyKey: string; payload?: Record<string, unknown>}[] =
  [];
/** What the chain reports as a job's dispute bond; null = unreadable. */
let disputeBond: bigint | null = null;
/** When set, the signer refuses the next submit with this error. */
let failSubmit: Error | null = null;

const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    submit: async (args) => {
      if (failSubmit) {
        const err = failSubmit;
        failSubmit = null;
        throw err;
      }
      submitted.push({
        kind: args.kind,
        spend: args.spend,
        idempotencyKey: args.idempotencyKey,
        ...(args.payload !== undefined && {payload: args.payload}),
      });
      return {txHash: '4yJxShz8HXfTyoTMXP9rQSoQUZE8uihkDmnpRrynZeZz', chainJobId: String(submitted.length)};
    },
    readDisputeBond: async () => disputeBond,
  });
});

afterAll(async () => {
  await app.close();
  await closeDb(db);
});

beforeEach(async () => {
  submitted = [];
  disputeBond = null;
  failSubmit = null;
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, token_transfers RESTART IDENTITY CASCADE`,
  );
});

async function register(over: Record<string, unknown> = {}) {
  const res = await signedRegistration(app, {
    name: 'ResearchBot',
    capabilities: ['market-research'],
    pricePerTask: '20000',
    walletAddress: addr('11'),
    ownerAddress: addr('22'),
    ...over,
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as {agentId: number; apiKey: string};

  // Stand in for the indexer observing ERC-8004 `Registered`. Without a
  // chain_agent_id the API refuses to hire, because sending a database serial
  // where the contract expects an ERC-8004 id pays a different agent.
  return body;
}

/** Register an agent that the indexer has NOT yet seen on-chain. */
/**
 * An agent row with no on-chain id. Registration now requires one, so this is
 * a row written some other way (by hand, or before the rule) — the hire path
 * and discovery must still refuse it rather than address agent 0.
 */
async function registerUnconfirmed(over: Record<string, unknown> = {}) {
  const res = await signedRegistration(app, {
    name: 'Unconfirmed',
    capabilities: ['market-research'],
    pricePerTask: '20000',
    walletAddress: addr('99'),
    ownerAddress: addr('88'),
    ...over,
  });
  const agent = res.json() as {agentId: number; apiKey: string};
  await db.execute(sql`UPDATE agents SET chain_agent_id = NULL WHERE id = ${agent.agentId}`);
  return agent;
}

describe('agent registration', () => {
  it('issues an API key exactly once and never stores it', async () => {
    const {agentId, apiKey} = await register();
    expect(apiKey).toMatch(/^ax_/);

    const rows = await db.execute(sql`SELECT key_hash FROM api_keys WHERE agent_id = ${agentId}`);
    const stored = (rows as unknown as {key_hash: string}[])[0]!.key_hash;
    expect(stored).not.toContain(apiKey);
    expect(stored.startsWith('sha256$')).toBe(true);
  });

  /**
   * A uniqueness conflict is the caller's to act on — 409, naming what clashed —
   * not a 500 telling them to retry what can never succeed. drizzle 0.45 moved
   * the Postgres error to `cause`, which silently broke this until a test
   * pinned it.
   */
  it('answers a duplicate registration with 409 ALREADY_EXISTS, not a 500', async () => {
    await register();
    const res = await signedRegistration(app, {
      name: 'Duplicate',
      capabilities: ['market-research'],
      pricePerTask: '20000',
      walletAddress: addr('11'),
      ownerAddress: addr('22'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ALREADY_EXISTS');
  });

  it('rejects a capability that is not kebab-case', async () => {
    const res = await signedRegistration(app, {
      name: 'Bad',
      capabilities: ['Market Research'],
      pricePerTask: '1',
      walletAddress: addr('33'),
      ownerAddress: addr('44'),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('SCHEMA_MISMATCH');
  });

  it('rejects a price that is not an integer string', async () => {
    const res = await signedRegistration(app, {
      name: 'Bad',
      capabilities: ['x-y'],
      pricePerTask: '0.02',
      walletAddress: addr('55'),
      ownerAddress: addr('66'),
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('discovery', () => {
  /**
   * v3: registration is open, and an agent with no confirmed ERC-8004 id can
   * never be hired (the escrow addresses agents by that id). Listing it only
   * let a spam registration crowd the marketplace and hand the orchestrator
   * a candidate whose hire must fail.
   */
  it('lists only agents whose on-chain identity is confirmed', async () => {
    const confirmed = await register({name: 'Real', walletAddress: addr('d1')});
    await registerUnconfirmed({name: 'Spam'});
    const body = (await app.inject({method: 'GET', url: '/v1/agents?chainId=near:sandbox'})).json();
    const names = (body.agents as {name: string}[]).map((a) => a.name);
    expect(names).toContain('Real');
    expect(names).not.toContain('Spam');
    expect(confirmed.agentId).toBeGreaterThan(0);
  });

  it('is browsable without credentials', async () => {
    await register();
    const res = await app.inject({method: 'GET', url: '/v1/agents?capability=market-research'});
    expect(res.statusCode).toBe(200);
    expect(res.json().agents).toHaveLength(1);
  });

  it('states the chain on every response', async () => {
    const res = await app.inject({method: 'GET', url: '/v1/agents'});
    expect(res.json().chainId).toBe('near:sandbox');
    expect(res.json().network).toBe('NEAR Sandbox (local)');
  });

  it('formats prices rather than making the client do decimals', async () => {
    await register();
    const {agents} = await app.inject({method: 'GET', url: '/v1/agents'}).then((r) => r.json());
    expect(agents[0].priceDisplay).toBe('0.02 mUSDC');
  });

  it('filters by capability and by maxPrice', async () => {
    await register({name: 'Cheap', pricePerTask: '10000', walletAddress: addr('aa')});
    await register({name: 'Dear', pricePerTask: '90000', walletAddress: addr('bb')});

    const cheap = await app.inject({method: 'GET', url: '/v1/agents?maxPrice=20000'}).then((r) => r.json());
    expect(cheap.agents.map((a: {name: string}) => a.name)).toEqual(['Cheap']);

    const none = await app
      .inject({method: 'GET', url: '/v1/agents?capability=does-not-exist'})
      .then((r) => r.json());
    expect(none.agents).toHaveLength(0);
  });

  it('ranks cheapest-first only when asked to', async () => {
    await register({name: 'Cheap', pricePerTask: '10000', walletAddress: addr('cc')});
    await register({name: 'Dear', pricePerTask: '90000', walletAddress: addr('dd')});

    const cheapest = await app.inject({method: 'GET', url: '/v1/agents?rank=cheapest'}).then((r) => r.json());
    expect(cheapest.agents[0].name).toBe('Cheap');
  });

  it('reports an unproven agent as 50, not 0 and not 100', async () => {
    await register();
    const {agents} = await app.inject({method: 'GET', url: '/v1/agents'}).then((r) => r.json());
    expect(agents[0].score).toBe(50);
    expect(agents[0].successRate).toBeNull();
  });
});

describe('hiring', () => {
  async function twoAgents() {
    const client = await register({name: 'Client', walletAddress: addr('e1')});
    const worker = await register({name: 'Worker', walletAddress: addr('e2')});
    return {client, worker};
  }

  const hire = (key: string, workerAgentId: number, over: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {authorization: `Bearer ${key}`, 'idempotency-key': 'key-0000001'},
      payload: {
        workerAgentId: String(workerAgentId),
        spec: {capability: 'market-research', input: {}},
        maxPrice: '50000',
        ...over,
      },
    });

  /** Paying up front is a bet on the worker; it is only offered on a record. */
  const proven = (agentId: number, score = 80) =>
    db.execute(sql`UPDATE agent_stats SET score = ${score}, completed = 30 WHERE agent_id = ${agentId}`);

  /**
   * Reads are public by design — a job is shareable evidence — so its id is
   * the only thing between a job and a stranger. v1 used the serial id, and
   * `GET /v1/jobs/1`, `/2`, `/3` walked every job in the system.
   */
  it('names a job by an unguessable public id, and a serial id names nothing', async () => {
    const {client, worker} = await twoAgents();
    const {jobId} = (await hire(client.apiKey, worker.agentId)).json();
    expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    expect((await app.inject({url: `/v1/jobs/${jobId}`})).statusCode).toBe(200);

    for (const guess of ['1', '2', 'NaN', '../1']) {
      const res = await app.inject({url: `/v1/jobs/${guess}`});
      expect(res.statusCode, guess).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    }
    expect((await app.inject({url: '/v1/runs/1'})).statusCode).toBe(404);
  });

  /**
   * v2's escrow refuses any job below `minJobAmount`, so a worker priced below
   * it cannot be hired at all. Said here, before a transaction is paid for
   * and reverts.
   */
  it('refuses to hire a worker priced below the escrow minimum, before submitting', async () => {
    const client = await register();
    const worker = await register({
      name: 'Cheap',
      walletAddress: addr('44'),
      pricePerTask: '5000',
    });
    const res = await hire(client.apiKey, worker.agentId);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AGENT_NOT_HIREABLE');
    expect(res.json().detail).toMatch(/below the escrow minimum/);
    expect(submitted).toHaveLength(0);
  });

  it('takes the fast path below the threshold and says so', async () => {
    const {client, worker} = await twoAgents();
    await proven(worker.agentId);
    const res = await hire(client.apiKey, worker.agentId);
    expect(res.statusCode).toBe(201);

    const body = res.json();
    // fastPathMax is 0.03; the price is 0.02.
    expect(body.path).toBe('direct');
    expect(body.amountDisplay).toBe('0.02 mUSDC');
    expect(body.explorerUrl).toBeTruthy();
    expect(submitted[0]!.kind).toBe('directPay');
  });

  /**
   * `fastPathMinScore` (70) was configured, documented, deployed — and read by
   * nothing. So every cheap hire of an agent with no history at all paid up
   * front, with no recourse if the work was bad. The fast path trades
   * protection for speed, and only a record earns that trade.
   */
  it('uses escrow for an unproven worker, however cheap', async () => {
    const {client, worker} = await twoAgents();
    const res = await hire(client.apiKey, worker.agentId);
    expect(res.json().path).toBe('escrow');
    expect(submitted[0]!.kind).toBe('createJob');
  });

  it('uses escrow for a worker just under the score bar', async () => {
    const {client, worker} = await twoAgents();
    await proven(worker.agentId, 69);
    expect((await hire(client.apiKey, worker.agentId)).json().path).toBe('escrow');
  });

  it('still honours a client that asks for the fast path explicitly', async () => {
    const {client, worker} = await twoAgents();
    expect((await hire(client.apiKey, worker.agentId, {path: 'direct'})).json().path).toBe('direct');
  });

  it('uses escrow above the threshold', async () => {
    const client = await register({name: 'C', walletAddress: addr('f1')});
    const worker = await register({name: 'W', pricePerTask: '90000', walletAddress: addr('f2')});
    const res = await hire(client.apiKey, worker.agentId, {maxPrice: '100000'});
    expect(res.json().path).toBe('escrow');
    expect(submitted[0]!.kind).toBe('createJob');
  });

  /**
   * A retried hire used to INSERT A NEW JOB each time. The signer correctly
   * returned the original transaction — so nothing was paid twice — but the
   * retry's response carried a new job id: the caller then waited on a job no
   * transaction backed, and the worker was offered the same paid-once work a
   * second time. Found by a live end-to-end run, which counted two rows.
   */
  it('returns the original job for a retried hire instead of creating another', async () => {
    const {client, worker} = await twoAgents();
    const first = (await hire(client.apiKey, worker.agentId)).json();
    const retry = await hire(client.apiKey, worker.agentId);

    expect(retry.statusCode).toBe(201);
    expect(retry.json().jobId).toBe(first.jobId);
    expect(retry.json().txHash).toBe(first.txHash);
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM jobs`)) as unknown as {n: number}[];
    expect(rows[0]!.n).toBe(1);
    expect(submitted).toHaveLength(1);
  });

  it('refuses a reused key for a different hire, rather than guessing which was meant', async () => {
    const {client, worker} = await twoAgents();
    await hire(client.apiKey, worker.agentId);
    const other = await hire(client.apiKey, worker.agentId, {
      spec: {capability: 'market-research', input: {q: 'other'}},
    });

    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('refuses without an Idempotency-Key', async () => {
    const {client, worker} = await twoAgents();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {authorization: `Bearer ${client.apiKey}`},
      payload: {
        workerAgentId: String(worker.agentId),
        spec: {capability: 'x-y', input: {}},
        maxPrice: '50000',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('refuses when the price is above maxPrice', async () => {
    const {client, worker} = await twoAgents();
    const res = await hire(client.apiKey, worker.agentId, {maxPrice: '1'});
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PRICE_ABOVE_MAX');
    expect(res.json().detail).toContain('0.02 mUSDC');
  });

  it('refuses to let an agent hire itself', async () => {
    const {client} = await twoAgents();
    const res = await hire(client.apiKey, client.agentId);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('INVALID_STATE');
  });

  it('refuses an inactive worker', async () => {
    const {client, worker} = await twoAgents();
    await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${worker.agentId}`,
      headers: {authorization: `Bearer ${worker.apiKey}`},
      payload: {active: false},
    });
    const res = await hire(client.apiKey, worker.agentId);
    expect(res.json().code).toBe('AGENT_NOT_HIREABLE');
  });

  it('refuses to hire an agent the indexer has not confirmed on-chain', async () => {
    const {client} = await twoAgents();
    const ghost = await registerUnconfirmed();
    const res = await hire(client.apiKey, ghost.agentId);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AGENT_NOT_HIREABLE');
    expect(res.json().detail).toContain('on-chain agent id');
  });

  it('rejects an unknown API key', async () => {
    const {worker} = await twoAgents();
    const res = await hire('ax_not_a_real_key', worker.agentId);
    // 401, not the 409 CHAIN_MISMATCH it used to be: nothing about a bad key
    // is a chain, and a client told "wrong chain" goes looking for a network
    // problem instead of a credential one.
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });
});

describe('GET /v1/agents/:id/trust', () => {
  /**
   * v3: whether a record deserves belief — distinct owners, concentration,
   * and funding from the worker's side just before a client paid. Answered
   * in words with the numbers behind them.
   */
  async function paid(workerId: number, clientId: number, block: number) {
    await db.execute(sql`INSERT INTO payments (chain_id, from_agent_id, to_agent_id, amount, tx_hash, block_number)
        VALUES ('near:sandbox', ${clientId}, ${workerId}, 50000, ${'0x' + String(block).padStart(64, '0')}, ${block})`);
  }

  it('answers new for an agent with no record', async () => {
    const w = await register({name: 'W', walletAddress: addr('b1')});
    const res = await app.inject({method: 'GET', url: `/v1/agents/${w.agentId}/trust`});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({agentId: String(w.agentId), chainId: 'near:sandbox', verdict: 'new'});
    expect(res.json().reasons.length).toBeGreaterThan(0);
  });

  it('names a worker whose clients it funded', async () => {
    const workerOwner = addr('f1');
    const w = await register({name: 'W', walletAddress: addr('b2'), ownerAddress: workerOwner});
    for (let i = 0; i < 3; i++) {
      const wallet = addr(`funded-wallet-${i}`);
      const c = await register({
        name: `C${i}`,
        walletAddress: wallet,
        ownerAddress: addr(`funded-owner-${i}`),
      });
      await db.execute(sql`INSERT INTO token_transfers (chain_id, block_number, tx_hash, receipt_id, log_index, from_address, to_address, amount)
          VALUES ('near:sandbox', ${100 + i}, ${'tx' + String(i + 1)}, ${'receipt' + String(i + 1)}, 0, ${workerOwner}, ${wallet}, 1000000)`);
      await paid(w.agentId, c.agentId, 110 + i);
    }
    const body = (await app.inject({method: 'GET', url: `/v1/agents/${w.agentId}/trust`})).json();
    expect(body.verdict).toBe('self-funded');
    expect(body.metrics).toMatchObject({settled: 3, selfFunded: 3});
    // The counterparty check (AI Security track): allow / warn / block.
    expect(body.action).toBe('block');
  });

  it('answers warn, not block, for an agent with no record', async () => {
    const w = await register({name: 'W', walletAddress: addr('b3')});
    const body = (await app.inject({method: 'GET', url: `/v1/agents/${w.agentId}/trust`})).json();
    expect(body).toMatchObject({verdict: 'new', action: 'warn'});
  });

  /**
   * The guard a prompt-injected agent cannot talk its way past: whatever its
   * model decides, the API refuses to pay a worker whose record is farmed.
   */
  it('refuses to hire a blocked counterparty, and names why', async () => {
    const workerOwner = addr('f9');
    const w = await register({name: 'Farmed', walletAddress: addr('b9'), ownerAddress: workerOwner});
    const wallet = addr('puppet-wallet');
    const puppet = await register({
      name: 'Puppet',
      walletAddress: wallet,
      ownerAddress: addr('puppet-owner'),
    });
    await db.execute(sql`INSERT INTO token_transfers (chain_id, block_number, tx_hash, receipt_id, log_index, from_address, to_address, amount)
        VALUES ('near:sandbox', 200, 'tx-farm', 'receipt-farm', 0, ${workerOwner}, ${wallet}, 1000000)`);
    await paid(w.agentId, puppet.agentId, 210);

    const victim = await register({name: 'Victim', walletAddress: addr('b10')});
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {authorization: `Bearer ${victim.apiKey}`, 'idempotency-key': 'blocked-0001'},
      payload: {
        workerAgentId: String(w.agentId),
        spec: {capability: 'market-research', input: {}},
        maxPrice: '50000',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('COUNTERPARTY_BLOCKED');
    expect(res.json().detail).toContain('self-funded');
    const [{n}] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM jobs WHERE worker_agent_id = ${w.agentId}`,
    )) as unknown as [{n: number}];
    expect(n).toBe(0);
  });

  it('is NOT_FOUND for an agent that does not exist', async () => {
    const res = await app.inject({method: 'GET', url: '/v1/agents/999999/trust'});
    expect(res.statusCode).toBe(404);
  });
});

describe('job lifecycle', () => {
  async function escrowJob() {
    const client = await register({name: 'C', walletAddress: addr('a1')});
    const worker = await register({name: 'W', pricePerTask: '90000', walletAddress: addr('a2')});
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {authorization: `Bearer ${client.apiKey}`, 'idempotency-key': 'lifecycle-1'},
      payload: {
        workerAgentId: String(worker.agentId),
        spec: {capability: 'market-research', input: {q: 'depth'}},
        maxPrice: '100000',
      },
    });
    return {client, worker, jobId: res.json().jobId as string};
  }

  const post = (url: string, key: string, payload: Record<string, unknown> = {}) =>
    app.inject({method: 'POST', url, headers: {authorization: `Bearer ${key}`}, payload});

  it('runs accept -> result -> approve', async () => {
    const {client, worker, jobId} = await escrowJob();

    expect((await post(`/v1/jobs/${jobId}/accept`, worker.apiKey)).statusCode).toBe(200);
    expect(
      (
        await post(`/v1/jobs/${jobId}/result`, worker.apiKey, {
          output: {summary: 'deep'},
          producedAt: new Date().toISOString(),
        })
      ).statusCode,
    ).toBe(200);
    expect((await post(`/v1/jobs/${jobId}/approve`, client.apiKey)).statusCode).toBe(200);

    const job = await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`}).then((r) => r.json());
    expect(job.state).toBe('settled');
    // `result` is the worker's OUTPUT, not the delivery envelope. This used
    // to read `job.result.output.summary`, which encoded the envelope shape
    // and is part of why the mismatch survived: the worker, the API and the
    // orchestrator all check `result` against the job's outputSchema, and an
    // envelope fails that check however good the work was.
    expect(job.result.summary).toBe('deep');
  });

  /**
   * v3: disputing takes the client's dispute bond, so a dispute SPENDS and is
   * measured against the client's caps. Declaring it as zero would skip the
   * signer's early check and turn an actionable 402 into a bare revert.
   */
  it('declares the dispute bond as the spend of a dispute', async () => {
    const {client, worker, jobId} = await escrowJob();
    await post(`/v1/jobs/${jobId}/accept`, worker.apiKey);
    await post(`/v1/jobs/${jobId}/result`, worker.apiKey, {
      output: {summary: 'deep'},
      producedAt: new Date().toISOString(),
    });
    disputeBond = 10_000n;
    expect((await post(`/v1/jobs/${jobId}/dispute`, client.apiKey, {reason: 'bad'})).statusCode).toBe(200);
    expect(submitted.at(-1)).toMatchObject({kind: 'dispute', spend: 10_000n});
  });

  it('still disputes when the bond cannot be read, leaving the cap to the contract', async () => {
    const {client, worker, jobId} = await escrowJob();
    await post(`/v1/jobs/${jobId}/accept`, worker.apiKey);
    await post(`/v1/jobs/${jobId}/result`, worker.apiKey, {
      output: {summary: 'deep'},
      producedAt: new Date().toISOString(),
    });
    expect((await post(`/v1/jobs/${jobId}/dispute`, client.apiKey, {reason: 'bad'})).statusCode).toBe(200);
    expect(submitted.at(-1)).toMatchObject({kind: 'dispute', spend: 0n});
  });

  /**
   * The SDK sends `{reason}`; the encoder commits `payload.reasonHash`, which
   * nothing set — so every dispute committed the job's SPEC hash as its
   * reason on chain, and the reason itself was stored nowhere (the event kept
   * only jobId and txHash), though the MCP tool tells agents it is recorded.
   */
  it('commits the hash of the dispute reason on chain and records the reason', async () => {
    const {client, worker, jobId} = await escrowJob();
    await post(`/v1/jobs/${jobId}/accept`, worker.apiKey);
    await post(`/v1/jobs/${jobId}/result`, worker.apiKey, {
      output: {summary: 'deep'},
      producedAt: new Date().toISOString(),
    });
    const reason = 'the summary contradicts its own sources';
    expect((await post(`/v1/jobs/${jobId}/dispute`, client.apiKey, {reason})).statusCode).toBe(200);

    const {canonicalize} = await import('@pactora/shared');
    const reasonHash = sha256Hex(canonicalize({reason}));
    expect(submitted.at(-1)).toMatchObject({kind: 'dispute', payload: {reasonHash}});

    const job = (await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`})).json();
    expect(job.dispute).toMatchObject({reason, reasonHash});
  });

  it('refuses a dispute with no reason', async () => {
    const {client, worker, jobId} = await escrowJob();
    await post(`/v1/jobs/${jobId}/accept`, worker.apiKey);
    await post(`/v1/jobs/${jobId}/result`, worker.apiKey, {
      output: {summary: 'deep'},
      producedAt: new Date().toISOString(),
    });
    const before = submitted.length;
    expect((await post(`/v1/jobs/${jobId}/dispute`, client.apiKey, {})).statusCode).toBe(422);
    expect(submitted.length).toBe(before);
  });

  it('refuses a transition from the wrong state', async () => {
    const {client, jobId} = await escrowJob();
    const res = await post(`/v1/jobs/${jobId}/approve`, client.apiKey);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('INVALID_STATE');
    expect(res.json().detail).toContain('needs "submitted"');
  });

  it('lets only the worker accept and only the client approve', async () => {
    const {client, worker, jobId} = await escrowJob();

    const notYours = await post(`/v1/jobs/${jobId}/accept`, client.apiKey);
    expect(notYours.statusCode).toBe(403);
    expect(notYours.json().code).toBe('FORBIDDEN');
    await post(`/v1/jobs/${jobId}/accept`, worker.apiKey);
    await post(`/v1/jobs/${jobId}/result`, worker.apiKey, {
      output: {ok: true},
      producedAt: new Date().toISOString(),
    });
    // The worker would love to approve its own work.
    expect((await post(`/v1/jobs/${jobId}/approve`, worker.apiKey)).statusCode).toBe(403);
  });

  it('rejects a result that fails schema validation before storing it', async () => {
    const {worker, jobId} = await escrowJob();
    await post(`/v1/jobs/${jobId}/accept`, worker.apiKey);

    const res = await post(`/v1/jobs/${jobId}/result`, worker.apiKey, {nonsense: true});
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('SCHEMA_MISMATCH');

    const job = await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`}).then((r) => r.json());
    expect(job.result).toBeNull();
    expect(job.state).toBe('accepted');
  });

  /**
   * A worker that will not take a job says so, with its reason. Off-chain and
   * free: the job stays `created`, and the client — told at once instead of
   * after its accept window — cancels and hires someone else.
   */
  describe('a decline', () => {
    it('is recorded with its reason and shown on the job', async () => {
      const {worker, jobId} = await escrowJob();
      const res = await post(`/v1/jobs/${jobId}/decline`, worker.apiKey, {reason: 'needs a private API key'});
      expect(res.statusCode).toBe(200);
      expect(res.json().declined.reason).toBe('needs a private API key');

      const job = await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`}).then((r) => r.json());
      expect(job.state).toBe('created');
      expect(job.declined).toMatchObject({reason: 'needs a private API key'});
      expect(job.events.map((e: {kind: string}) => e.kind)).toContain('job.declined');
    });

    it('is shown as null on a job nobody declined', async () => {
      const {jobId} = await escrowJob();
      const job = await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`}).then((r) => r.json());
      expect(job.declined).toBeNull();
    });

    it('comes only from the hired worker', async () => {
      const {client, jobId} = await escrowJob();
      const stranger = await register({name: 'S', walletAddress: addr('a3')});
      expect((await post(`/v1/jobs/${jobId}/decline`, client.apiKey, {reason: 'x'})).statusCode).toBe(403);
      expect((await post(`/v1/jobs/${jobId}/decline`, stranger.apiKey, {reason: 'x'})).statusCode).toBe(403);
      const anonymous = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/decline`,
        payload: {reason: 'x'},
      });
      expect(anonymous.statusCode).toBe(401);
    });

    it('is refused once the worker has accepted', async () => {
      const {worker, jobId} = await escrowJob();
      await post(`/v1/jobs/${jobId}/accept`, worker.apiKey);
      const res = await post(`/v1/jobs/${jobId}/decline`, worker.apiKey, {reason: 'changed my mind'});
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('INVALID_STATE');
    });

    it('needs a reason, and keeps the first one', async () => {
      const {worker, jobId} = await escrowJob();
      expect((await post(`/v1/jobs/${jobId}/decline`, worker.apiKey, {})).statusCode).toBe(422);
      await post(`/v1/jobs/${jobId}/decline`, worker.apiKey, {reason: 'first'});
      const again = await post(`/v1/jobs/${jobId}/decline`, worker.apiKey, {reason: 'second'});
      expect(again.statusCode).toBe(200);
      expect(again.json().declined.reason).toBe('first');

      const job = await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`}).then((r) => r.json());
      expect(job.events.filter((e: {kind: string}) => e.kind === 'job.declined')).toHaveLength(1);
    });
  });

  it('records an event for every transition', async () => {
    const {client, worker, jobId} = await escrowJob();
    await post(`/v1/jobs/${jobId}/accept`, worker.apiKey);
    await post(`/v1/jobs/${jobId}/result`, worker.apiKey, {
      output: {},
      producedAt: new Date().toISOString(),
    });
    await post(`/v1/jobs/${jobId}/approve`, client.apiKey);

    const job = await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`}).then((r) => r.json());
    expect(job.events.map((e: {kind: string}) => e.kind)).toEqual([
      'job.created',
      'job.accepted',
      'job.submitted',
      'job.settled',
    ]);
  });
});

describe('the error contract agents depend on', () => {
  it('always returns a machine-readable code and a trace id', async () => {
    const res = await app.inject({method: 'GET', url: '/v1/jobs/999999'});
    const body = res.json();
    expect(body.code).toBeTruthy();
    expect(body.type).toContain('pactoragents.com/errors/');
    expect(body.traceId).toBeTruthy();
    expect(res.headers['x-trace-id']).toBe(body.traceId);
  });

  it('uses problem+json so a client can tell an error from a result', async () => {
    const res = await app.inject({method: 'GET', url: '/v1/nope'});
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('reports which chains are live on /health', async () => {
    const health = await app.inject({method: 'GET', url: '/health'}).then((r) => r.json());
    expect(health.ok).toBe(true);
    expect(health.chains[0].chainId).toBe('near:sandbox');
    expect(health.chains[0].contract).toBe('pactora.test.near');
  });
});

/**
 * Audit H1, the API's half: the signer's idempotency key must not be the
 * caller's raw header, nor a guessable serial. Whatever the caller sends, the
 * key the signer sees is bound to that caller, that action and that job.
 */
describe('the key the signer is given', () => {
  async function pair(tag: string) {
    const client = await register({name: `C${tag}`, walletAddress: addr(`c${tag}`)});
    const worker = await register({name: `W${tag}`, walletAddress: addr(`d${tag}`)});
    return {client, worker};
  }

  const hireWith = (apiKey: string, workerAgentId: number, idempotencyKey: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {authorization: `Bearer ${apiKey}`, 'idempotency-key': idempotencyKey},
      payload: {
        workerAgentId: String(workerAgentId),
        spec: {capability: 'market-research', input: {}},
        maxPrice: '50000',
      },
    });

  it('is never the raw Idempotency-Key, and two callers using one header get two keys', async () => {
    const a = await pair('1');
    const b = await pair('2');
    expect((await hireWith(a.client.apiKey, a.worker.agentId, 'chosen-by-caller')).statusCode).toBe(201);
    expect((await hireWith(b.client.apiKey, b.worker.agentId, 'chosen-by-caller')).statusCode).toBe(201);

    const [first, second] = submitted.map((s) => s.idempotencyKey);
    expect(first).not.toBe('chosen-by-caller');
    expect(first).not.toBe(second);
  });

  it('defaults a transition key to something a stranger cannot predict from the serial', async () => {
    const {client, worker} = await pair('3');
    const {jobId} = (await hireWith(client.apiKey, worker.agentId, 'hire-key-0001')).json();
    await db.execute(sql`UPDATE jobs SET chain_job_id = 77`);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/accept`,
      headers: {authorization: `Bearer ${worker.apiKey}`},
    });
    expect(res.statusCode).toBe(200);
    const key = submitted.at(-1)!.idempotencyKey;
    expect(key).not.toMatch(/^accept:\d+:/);
    expect(key).not.toContain(':1:');
  });

  it('refuses an Idempotency-Key longer than the signer accepts, before anything is stored', async () => {
    const {client, worker} = await pair('4');
    const res = await hireWith(client.apiKey, worker.agentId, 'k'.repeat(201));
    expect(res.statusCode).toBe(422);
    expect(submitted).toHaveLength(0);
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM jobs`)) as unknown as {n: number}[];
    expect(rows[0]!.n).toBe(0);
  });

  /** The conflict named the job by its serial — the one id the API otherwise never shows. */
  it('names no internal id when a key is reused for a different hire', async () => {
    const {client, worker} = await pair('5');
    await hireWith(client.apiKey, worker.agentId, 'reused-key-0001');
    const other = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {authorization: `Bearer ${client.apiKey}`, 'idempotency-key': 'reused-key-0001'},
      payload: {
        workerAgentId: String(worker.agentId),
        spec: {capability: 'market-research', input: {q: 'different'}},
        maxPrice: '50000',
      },
    });
    expect(other.statusCode).toBe(409);
    expect(other.json().detail).not.toMatch(/job \d+\b/);
  });
});

/**
 * Audit H2: the job row is written before the signer is asked. A hire the
 * signer refused left a row that looked like owed work, and a worker spent
 * model time producing a result nobody had paid for.
 */
describe('a hire the signer refused', () => {
  it('is never offered to the worker', async () => {
    const client = await register({name: 'Client', walletAddress: addr('a7')});
    const worker = await register({name: 'Worker', walletAddress: addr('a8')});
    await db.execute(
      sql`UPDATE agent_stats SET score = 90, completed = 30 WHERE agent_id = ${worker.agentId}`,
    );

    failSubmit = Object.assign(new Error('BUDGET_EXCEEDED'), {});
    const refused = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {authorization: `Bearer ${client.apiKey}`, 'idempotency-key': 'refused-hire-01'},
      payload: {
        workerAgentId: String(worker.agentId),
        spec: {capability: 'market-research', input: {}},
        maxPrice: '50000',
        path: 'direct',
      },
    });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);

    const offered = await app.inject({
      url: '/v1/jobs?role=worker',
      headers: {authorization: `Bearer ${worker.apiKey}`},
    });
    expect(offered.json().jobs, 'an unpaid job was offered as work').toHaveLength(0);

    // The client's retry under the same key pays — and only then is it work.
    const paid = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {authorization: `Bearer ${client.apiKey}`, 'idempotency-key': 'refused-hire-01'},
      payload: {
        workerAgentId: String(worker.agentId),
        spec: {capability: 'market-research', input: {}},
        maxPrice: '50000',
        path: 'direct',
      },
    });
    expect(paid.statusCode).toBe(201);
    const now = await app.inject({
      url: '/v1/jobs?role=worker',
      headers: {authorization: `Bearer ${worker.apiKey}`},
    });
    expect(now.json().jobs).toHaveLength(1);
  });
});
