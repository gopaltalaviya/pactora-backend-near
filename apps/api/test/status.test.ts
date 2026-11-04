import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {createMetrics} from '@pactora/service';
import {buildApp} from '../src/app.js';
import {addr, signedRegistration} from './helpers/register.js';

/**
 * The operational surface: `/v1/status` for a public status page, build
 * metadata on `/health`, readiness that names a failing dependency without
 * describing the network it lives on, and `/metrics` that is not public by
 * accident in production.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});

const BUILD = {service: 'api', version: '0.0.1', commit: 'a1b2c3d4e5f6', builtAt: '2026-09-30T12:00:00Z'};
/** What a real driver error looks like: it names the internal host. */
const LEAKY = 'connect ECONNREFUSED postgres.railway.internal:5432 (10.0.0.12)';

let db: Db;
beforeAll(() => {
  db = createDb(DB_URL, {max: 2});
});
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE indexer_cursor`);
});

const cursorAt = (block: number, secondsAgo = 1) =>
  db.execute(sql`INSERT INTO indexer_cursor (chain_id, contract, last_block, last_block_hash, updated_at)
    VALUES (31337, 'TaskEscrow', ${block}, '0xabc', now() - make_interval(secs => ${secondsAgo}))`);

type StatusDeps = {
  signer?: () => Promise<unknown>;
  headBlock?: (chainId: number) => Promise<bigint>;
  maxIndexerLagBlocks?: number;
  cacheMs?: number;
  timeoutMs?: number;
};

const build = (status: StatusDeps = {}, over: Record<string, unknown> = {}) =>
  buildApp({
    db,
    chains: config.chains,
    defaultChainId: 31337,
    submit: async () => ({txHash: '0x'}),
    build: BUILD,
    status: {
      signer: async () => undefined,
      headBlock: async () => 1_010n,
      cacheMs: 0,
      ...status,
    },
    ...over,
  });

describe('GET /v1/status', () => {
  it('is public and reports every component operational, with the build and indexer lag', async () => {
    await cursorAt(1_000);
    const app = await build();
    const res = await app.inject({url: '/v1/status'});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('operational');
    expect(body.build).toEqual(BUILD);
    expect(body.components).toEqual({
      api: 'up',
      database: 'up',
      signer: 'up',
      rpc: 'up',
      indexer: 'up',
    });
    expect(body.chains).toEqual([
      {
        chainId: 31337,
        name: config.chains[31337]!.name,
        testnet: true,
        rpc: 'up',
        headBlock: 1_010,
        indexer: {
          status: 'up',
          indexedBlock: 1_000,
          lagBlocks: 10,
          lastIndexedAt: expect.any(String),
          secondsSinceIndexed: expect.any(Number),
        },
      },
    ]);
    expect(new Date(body.checkedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    await app.close();
  });

  it('is degraded when the indexer trails the chain by more than the allowed lag', async () => {
    await cursorAt(100);
    const app = await build({headBlock: async () => 10_000n, maxIndexerLagBlocks: 150});
    const body = (await app.inject({url: '/v1/status'})).json();
    expect(body.status).toBe('degraded');
    expect(body.components.indexer).toBe('degraded');
    expect(body.chains[0].indexer.lagBlocks).toBe(9_900);
    await app.close();
  });

  // A stopped indexer and one catching up both trail the head, and both read
  // "degraded" — an operator could not tell "wait" from "go and restart it".
  // Stopped means: there are blocks to index, and nothing has been indexed for
  // longer than the indexer's own worst-case backoff.
  it('is down when the indexer has blocks to index and has not progressed for over two minutes', async () => {
    await cursorAt(1_000, 300);
    const app = await build({headBlock: async () => 1_500n});
    const body = (await app.inject({url: '/v1/status'})).json();
    expect(body.components.indexer).toBe('down');
    expect(body.chains[0].indexer.status).toBe('down');
    expect(body.status).toBe('degraded'); // the marketplace still serves
    await app.close();
  });

  it('is not down when a caught-up indexer is idle on a quiet chain', async () => {
    await cursorAt(1_000, 300);
    const app = await build({headBlock: async () => 1_000n});
    const body = (await app.inject({url: '/v1/status'})).json();
    expect(body.components.indexer).toBe('up');
    await app.close();
  });

  it('says the indexer is unknown when it has never indexed anything', async () => {
    const app = await build();
    const body = (await app.inject({url: '/v1/status'})).json();
    expect(body.components.indexer).toBe('unknown');
    expect(body.chains[0].indexer).toEqual({
      status: 'unknown',
      indexedBlock: null,
      lagBlocks: null,
      lastIndexedAt: null,
      secondsSinceIndexed: null,
    });
    expect(body.status).toBe('degraded');
    await app.close();
  });

  it('is degraded, not failed, when the signer or the RPC is down — and never says why in public', async () => {
    await cursorAt(1_000);
    const app = await build({
      signer: async () => {
        throw new Error(`signer at http://signer.railway.internal:7070 refused: ${LEAKY}`);
      },
      headBlock: async () => {
        throw new Error('HTTP request failed. URL: https://rpc.example/v2/SECRETKEY123');
      },
    });
    const res = await app.inject({url: '/v1/status'});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.components).toMatchObject({signer: 'down', rpc: 'down', database: 'up'});
    // Without a head the lag cannot be computed; the last indexed block still can.
    expect(body.chains[0].indexer).toMatchObject({status: 'unknown', indexedBlock: 1_000, lagBlocks: null});
    expect(res.body).not.toMatch(/railway\.internal|10\.0\.0|SECRETKEY|rpc\.example|ECONNREFUSED|refused/);
    await app.close();
  });

  it('is down when the database is unreachable', async () => {
    const dead = createDb('postgres://agentx:agentx@127.0.0.1:1/agentx', {max: 1});
    const app = await buildApp({
      db: dead,
      chains: config.chains,
      defaultChainId: 31337,
      submit: async () => ({txHash: '0x'}),
      build: BUILD,
      status: {signer: async () => undefined, headBlock: async () => 1n, cacheMs: 0, timeoutMs: 1_000},
    });
    const res = await app.inject({url: '/v1/status'});
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('down');
    expect(res.json().components.database).toBe('down');
    expect(res.body).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
    await app.close();
    await closeDb(dead).catch(() => undefined);
  });

  /** A status page that hangs because the RPC hangs is worse than no status page. */
  it('answers within its timeout when a dependency never answers', async () => {
    await cursorAt(1_000);
    const app = await build({
      signer: () => new Promise(() => {}),
      headBlock: () => new Promise(() => {}),
      timeoutMs: 200,
    });
    const started = Date.now();
    const body = (await app.inject({url: '/v1/status'})).json();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(body.components).toMatchObject({signer: 'down', rpc: 'down'});
    await app.close();
  });

  /** It is public: a burst of page loads must not become a burst of RPC calls. */
  it('caches one result for a short window, shared by concurrent callers', async () => {
    await cursorAt(1_000);
    let calls = 0;
    const app = await build({
      headBlock: async () => {
        calls++;
        return 1_010n;
      },
      cacheMs: 60_000,
    });
    await Promise.all([1, 2, 3, 4, 5].map(() => app.inject({url: '/v1/status'})));
    await app.inject({url: '/v1/status'});
    expect(calls).toBe(1);
    await app.close();
  });
});

describe('/health and /ready', () => {
  it('reports the build on /health', async () => {
    const app = await build();
    expect((await app.inject({url: '/health'})).json().build).toEqual(BUILD);
    await app.close();
  });

  /** /ready is public on the API: it names the dependency, never the host it could not reach. */
  it('names a failed dependency on /ready without echoing its error', async () => {
    const app = await build(
      {},
      {
        readiness: {
          database: async () => {
            throw new Error(LEAKY);
          },
        },
      },
    );
    const res = await app.inject({url: '/ready'});
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.database).toEqual({ok: false});
    expect(res.body).not.toMatch(/railway\.internal|10\.0\.0|ECONNREFUSED/);
    await app.close();
  });
});

describe('/metrics in production', () => {
  it('is not served without METRICS_TOKEN when a token is required', async () => {
    const app = await build({}, {metrics: createMetrics('api-status-1'), requireMetricsToken: true});
    expect((await app.inject({url: '/metrics'})).statusCode).toBe(404);
    await app.close();
  });

  it('is served behind the token when one is set', async () => {
    const app = await build(
      {},
      {metrics: createMetrics('api-status-2'), requireMetricsToken: true, metricsToken: 'tok'},
    );
    expect((await app.inject({url: '/metrics'})).statusCode).toBe(401);
    expect((await app.inject({url: '/metrics', headers: {authorization: 'Bearer tok'}})).statusCode).toBe(
      200,
    );
    await app.close();
  });
});

/**
 * docs/15-api.md is hand-written. This keeps it honest: every route the API
 * serves has a row in its endpoint index, and every row names a real route.
 * The doc lives in the agentx-docs repo: PACTORA_DOCS_DIR, else the checkout
 * beside this one (CI checks it out there). A missing file fails the test.
 */
const DOCS_DIR =
  process.env.PACTORA_DOCS_DIR ?? fileURLToPath(new URL('../../../../agentx-docs', import.meta.url));
describe('gas (v3)', () => {
  /**
   * docs/17: "wallet balance monitoring: none; checked by hand before demos".
   * The signer now reports its wallets' gas from a background reading; the
   * status page says which is low before a run fails on it. Reported beside
   * the components, like the model: a signer that reports nothing is not a
   * fault, a wallet that is low is.
   */
  const healthWith = (anyLow: boolean) => async () => ({
    ok: true,
    wallets: {
      checkedAt: '2026-10-25T10:00:00.000Z',
      anyLow,
      wallets: [
        {
          address: addr('a1'),
          role: 'keeper',
          balanceWei: anyLow ? '1000' : '900000000000000000',
          low: anyLow,
        },
      ],
    },
  });

  it('names the low wallet and degrades the status', async () => {
    await cursorAt(1_005);
    const app = await build({signer: healthWith(true)});
    const body = (await app.inject({url: '/v1/status'})).json();
    expect(body.gas).toMatchObject({state: 'low', checkedAt: '2026-10-25T10:00:00.000Z'});
    expect(body.gas.wallets[0]).toMatchObject({role: 'keeper', low: true});
    expect(body.status).toBe('degraded');
    await app.close();
  });

  it('is ok, and leaves the status operational, when every wallet has gas', async () => {
    await cursorAt(1_005);
    const app = await build({signer: healthWith(false)});
    const body = (await app.inject({url: '/v1/status'})).json();
    expect(body.gas.state).toBe('ok');
    expect(body.status).toBe('operational');
    await app.close();
  });

  it('is unknown, not a fault, when the signer reports no wallets', async () => {
    await cursorAt(1_005);
    const app = await build();
    const body = (await app.inject({url: '/v1/status'})).json();
    expect(body.gas).toMatchObject({state: 'unknown', wallets: []});
    expect(body.status).toBe('operational');
    await app.close();
  });
});

describe('docs/15-api.md', () => {
  it('lists exactly the routes the API serves', async () => {
    const served = new Set<string>();
    const app = await build(
      {},
      {
        metrics: createMetrics('api-status-docs'),
        onRoute: (r: {method: string | string[]; url: string}) => {
          for (const m of [r.method].flat()) {
            if (['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(m)) served.add(`${m} ${r.url}`);
          }
        },
      },
    );
    await app.ready();
    const doc = readFileSync(join(DOCS_DIR, 'docs', '15-api.md'), 'utf8');
    const documented = new Set(
      [...doc.matchAll(/^\| `(GET|POST|PATCH|PUT|DELETE) (\/[^`]*)` \|/gm)].map((m) => `${m[1]} ${m[2]}`),
    );
    expect(served.size).toBeGreaterThan(10);
    expect([...served].filter((r) => !documented.has(r)).sort()).toEqual([]);
    expect([...documented].filter((r) => !served.has(r)).sort()).toEqual([]);
    await app.close();
  });
});

/**
 * The AI model behind the hosted demo has a free daily quota. When it is used
 * up, a judge pressing Run sees a failed run and could read the product as
 * broken. The status says so plainly — from real run outcomes, never by
 * calling the model (that would spend the quota) — and names the last run
 * that delivered, as proof the protocol works.
 */
describe('GET /v1/status — the AI model', () => {
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE agents, runs, run_events RESTART IDENTITY CASCADE`);
  });

  async function agent(app: Awaited<ReturnType<typeof build>>) {
    const res = await signedRegistration(app, {
      name: 'StatusBot',
      capabilities: ['market-research'],
      pricePerTask: '20000',
      walletAddress: addr('31'),
      ownerAddress: addr('32'),
    });
    return Number(res.json().agentId);
  }
  const run = (agentId: number, state: 'done' | 'failed', minutesAgo: number, error: string | null = null) =>
    db.execute(sql`INSERT INTO runs (chain_id, agent_id, goal, state, error, finished_at, started_at)
      VALUES (31337, ${agentId}, 'g', ${state}, ${error},
              now() - make_interval(mins => ${minutesAgo}), now() - make_interval(mins => ${minutesAgo + 1}))`);

  it('is unknown before any run', async () => {
    await cursorAt(1_000);
    const app = await build();
    const body = (await app.inject({url: '/v1/status'})).json();
    expect(body.model).toEqual({state: 'unknown', since: null, detail: null, lastDelivered: null});
  });

  it('is limited when the latest run failed for the model, and names the last delivered run', async () => {
    await cursorAt(1_000);
    const app = await build();
    const id = await agent(app);
    await run(id, 'done', 30);
    await run(id, 'failed', 5, 'No plan: AI model unavailable: its free request quota is used up for now');
    const body = (await app.inject({url: '/v1/status'})).json();
    expect(body.model.state).toBe('limited');
    expect(body.model.detail).toBe('AI model unavailable: its free request quota is used up for now');
    expect(body.model.since).toEqual(expect.any(String));
    expect(body.model.lastDelivered).toEqual({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      at: expect.any(String),
    });
    // The protocol is not down because a model is out of quota.
    expect(body.status).toBe('operational');
  });

  it('is ok once a run reaches the model again', async () => {
    await cursorAt(1_000);
    const app = await build();
    const id = await agent(app);
    await run(id, 'failed', 30, 'No plan: AI model unavailable: its free request quota is used up for now');
    await run(id, 'done', 2);
    expect((await app.inject({url: '/v1/status'})).json().model.state).toBe('ok');
  });

  it('is ok when the latest run failed for a reason that is not the model', async () => {
    await cursorAt(1_000);
    const app = await build();
    const id = await agent(app);
    await run(
      id,
      'failed',
      2,
      'No agent delivered. market-research: agent 2 declined: needs a private statement',
    );
    expect((await app.inject({url: '/v1/status'})).json().model.state).toBe('ok');
  });

  it('forgets a limit after 12 hours: daily quotas reset', async () => {
    await cursorAt(1_000);
    const app = await build();
    const id = await agent(app);
    await run(
      id,
      'failed',
      13 * 60,
      'No plan: AI model unavailable: its free request quota is used up for now',
    );
    expect((await app.inject({url: '/v1/status'})).json().model.state).toBe('unknown');
  });
});
