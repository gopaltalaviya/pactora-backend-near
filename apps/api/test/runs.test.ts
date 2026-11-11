import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@pactora/config';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import type {RunContext, RunExecutor, RunResult} from '../src/runs.js';
import {addr, chainDeps, signedRegistration} from './helpers/register.js';

/**
 * Orchestrator runs over HTTP.
 *
 * The executor is injected, so these need no model and no chain. What is
 * under test is the contract the live demo page depends on: an id that comes
 * back before any work happens, a trace that is durable rather than only
 * streamed, and a run that always reaches a terminal state — "running
 * forever" is the one outcome a viewer cannot interpret.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';

let app: FastifyInstance;
let db: Db;
/** Swapped per test. Receives the context so a test can emit its own trace. */
let execute: RunExecutor = async () => DELIVERED;

const DELIVERED: RunResult = {answer: 'done', spent: '20000', steps: [], delivered: true};

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
    runExecutor: (ctx) => execute(ctx),
    submit: async () => ({txHash: `0x${'ef'.repeat(32)}`, chainJobId: '1'}),
  });
});

afterAll(async () => {
  await app.close();
  await closeDb(db);
});

beforeEach(async () => {
  execute = async () => DELIVERED;
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, runs, run_events RESTART IDENTITY CASCADE`,
  );
});

async function register(): Promise<{agentId: number; apiKey: string}> {
  const res = await signedRegistration(app, {
    name: 'RunBot',
    capabilities: ['market-research'],
    pricePerTask: '20000',
    walletAddress: addr('11'),
    ownerAddress: addr('22'),
  });
  return res.json() as {agentId: number; apiKey: string};
}

const auth = (apiKey: string) => ({authorization: `Bearer ${apiKey}`});

/** Poll until the run leaves `running`, since starting one returns immediately. */
async function settle(runId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const body = (await app.inject({method: 'GET', url: `/v1/runs/${runId}`})).json();
    if (body.state !== 'running') return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`run ${runId} never left "running"`);
}

describe('POST /v1/runs', () => {
  it('returns an id before the work happens, so a page can subscribe first', async () => {
    const {apiKey} = await register();
    let released: () => void = () => {};
    execute = async () => {
      await new Promise<void>((r) => (released = r));
      return DELIVERED;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'find the deepest NEAR/USDC venue'},
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().runId).toBeTruthy();
    expect(res.json().eventsUrl).toBe(`/v1/runs/${res.json().runId}/events`);

    // Still running, because the executor has not been let go.
    expect((await app.inject({method: 'GET', url: `/v1/runs/${res.json().runId}`})).json().state).toBe(
      'running',
    );
    released();
    await settle(res.json().runId);
  });

  it('requires a key, because starting a run spends', async () => {
    const res = await app.inject({method: 'POST', url: '/v1/runs', payload: {goal: 'x y z'}});
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects an empty goal rather than starting a run that cannot be planned', async () => {
    const {apiKey} = await register();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: ''},
    });
    expect(res.statusCode).toBe(422);
  });

  /**
   * The orchestrator acts AS the caller: it hires under that identity and
   * spends under that agent's on-chain caps. A run carrying anything else
   * would not be bounded by the caps the owner actually set.
   */
  it('carries the caller identity into the run', async () => {
    const {agentId, apiKey} = await register();
    let seen: RunContext | undefined;
    execute = async (ctx) => {
      seen = ctx;
      return DELIVERED;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });
    await settle(res.json().runId);

    expect(seen?.agentId).toBe(agentId);
    expect(seen?.apiKey).toBe(apiKey);
    expect(seen?.goal).toBe('a goal');
  });
});

describe('a run always reaches a terminal state', () => {
  it('records the answer and what it cost', async () => {
    const {apiKey} = await register();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });

    const run = await settle(res.json().runId);
    expect(run.state).toBe('done');
    expect(run.answer).toBe('done');
    expect(run.spent).toBe('20000');
  });

  /** A run that throws must still end somewhere a viewer can read. */
  it('ends as failed with a reason when the orchestrator throws', async () => {
    const {apiKey} = await register();
    execute = async () => {
      throw new Error('every provider is rate limited');
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });

    const run = await settle(res.json().runId);
    expect(run.state).toBe('failed');
    expect(run.error).toMatch(/rate limited/);
  });

  /**
   * A run that hired, waited and delivered nothing used to end `done`, with no
   * error — so the page showed it green and "finished". It failed; say so, and
   * say why, from the steps themselves.
   */
  it('ends as failed, with the reasons, when no agent delivered', async () => {
    const {apiKey} = await register();
    execute = async () => ({
      answer: null,
      spent: '0',
      delivered: false,
      steps: [
        {
          capability: 'market-research',
          status: 'declined',
          detail: 'agent 2 declined: needs a private wallet export — cancelled and refunded',
        },
        {
          capability: 'trade-analysis',
          status: 'failed',
          detail: 'not run: it needed the result of step 1, which was declined',
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });
    const run = await settle(res.json().runId);

    expect(run.state).toBe('failed');
    expect(run.error).toBe(
      'No agent delivered. market-research: agent 2 declined: needs a private wallet export — cancelled and refunded. ' +
        'trade-analysis: not run: it needed the result of step 1, which was declined.',
    );
    // The steps are kept: they are the explanation.
    expect(run.steps).toHaveLength(2);
    const kinds = (run.events as {kind: string}[]).map((e) => e.kind);
    expect(kinds.at(-1)).toBe('failed');
    expect(kinds).not.toContain('finished');
  });

  it('ends as failed with "No plan" when planning failed', async () => {
    const {apiKey} = await register();
    execute = async () => ({
      answer: null,
      spent: '0',
      delivered: false,
      steps: [],
      planError: 'the model could not be reached',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });
    const run = await settle(res.json().runId);
    expect(run.state).toBe('failed');
    expect(run.error).toBe('No plan: the model could not be reached');
  });

  it('stays done when at least one step settled', async () => {
    const {apiKey} = await register();
    execute = async () => ({
      answer: 'partial answer',
      spent: '20000',
      delivered: true,
      steps: [
        {capability: 'market-research', status: 'settled', detail: 'ok'},
        {capability: 'trade-analysis', status: 'declined', detail: 'agent 3 declined: no'},
      ],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });
    const run = await settle(res.json().runId);
    expect(run.state).toBe('done');
    expect(run.error).toBeNull();
  });

  it('emits a terminal event either way', async () => {
    const {apiKey} = await register();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });

    const run = await settle(res.json().runId);
    const kinds = (run.events as {kind: string}[]).map((e) => e.kind);
    expect(kinds).toContain('finished');
  });
});

describe('the trace', () => {
  /**
   * Durable, not merely streamed: the page may be refreshed, opened late, or
   * revisited after the run is over — and a finished run is the artefact
   * worth keeping.
   */
  it('survives the run and is readable afterwards, in order', async () => {
    const {apiKey} = await register();
    execute = async (ctx) => {
      await ctx.emit({kind: 'planned', subtasks: 2});
      await ctx.emit({kind: 'hired', jobId: '1'});
      await ctx.emit({kind: 'settled', jobId: '1'});
      return DELIVERED;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });

    const run = await settle(res.json().runId);
    expect((run.events as {kind: string}[]).map((e) => e.kind)).toEqual([
      'planned',
      'hired',
      'settled',
      'finished',
    ]);
  });

  it('keeps each event payload intact for rendering', async () => {
    const {apiKey} = await register();
    execute = async (ctx) => {
      await ctx.emit({kind: 'hired', jobId: '7', explorerUrl: 'https://explorer/tx/0xabc'});
      return DELIVERED;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });

    const run = await settle(res.json().runId);
    const hired = (run.events as {kind: string; payload: Record<string, unknown>}[]).find(
      (e) => e.kind === 'hired',
    );
    expect(hired?.payload).toEqual({jobId: '7', explorerUrl: 'https://explorer/tx/0xabc'});
  });

  /**
   * Watching a run is the thing being demonstrated. A judge following a link
   * should not need a key for it.
   */
  it('is readable without credentials', async () => {
    const {apiKey} = await register();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });
    await settle(res.json().runId);

    const anonymous = await app.inject({method: 'GET', url: `/v1/runs/${res.json().runId}`});
    expect(anonymous.statusCode).toBe(200);
  });
});

describe('a deployment with no model', () => {
  it('serves everything else and refuses to start a run with a real error', async () => {
    const bare = await buildApp({
      ...chainDeps(config),
      db,
      chains: config.chains,
      defaultChainId: 'near:sandbox',
      bus: new EventBus(),
      submit: async () => ({txHash: '0x', chainJobId: '1'}),
    });

    try {
      expect((await bare.inject({method: 'GET', url: '/health'})).json().orchestrator).toBe(false);

      const {apiKey} = await register();
      const res = await bare.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: auth(apiKey),
        payload: {goal: 'a goal'},
      });

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.json().detail).toMatch(/no orchestrator configured/);
    } finally {
      await bare.close();
    }
  });
});

describe('when the live stream says "finished"', () => {
  // The demo page reads the run the moment `finished` arrives, once. The
  // event used to be published BEFORE the answer and steps were written, so a
  // page that won the race rendered no answer and no "what each step cost" —
  // seen live while recording the guides. The database here is slowed (every
  // UPDATE waits 300 ms) so that race is lost every time, not one run in four.
  it('the record already has the answer and the steps', async () => {
    const slowDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'update') return Reflect.get(target, prop, receiver);
        return (table: Parameters<Db['update']>[0]) => {
          const builder = target.update(table);
          return {
            set: (values: Record<string, unknown>) => ({
              where: (cond: unknown) =>
                new Promise((r) => setTimeout(r, 300)).then(() =>
                  builder.set(values as never).where(cond as never),
                ),
            }),
          };
        };
      },
    }) as Db;

    const steps = [{capability: 'market-research', status: 'settled', detail: 'ok'}];
    const slow = await buildApp({
      ...chainDeps(config),
      db: slowDb,
      chains: config.chains,
      defaultChainId: 'near:sandbox',
      runExecutor: async () => {
        await new Promise((r) => setTimeout(r, 300)); // let the subscriber connect first
        return {...DELIVERED, answer: 'the answer', steps} as unknown as RunResult;
      },
      submit: async () => ({txHash: `0x${'ef'.repeat(32)}`, chainJobId: '1'}),
    });
    await slow.listen({port: 0, host: '127.0.0.1'});
    const base = `http://127.0.0.1:${(slow.server.address() as {port: number}).port}`;
    try {
      const {apiKey} = await register();
      const started = await fetch(`${base}/v1/runs`, {
        method: 'POST',
        headers: {...auth(apiKey), 'content-type': 'application/json'},
        body: JSON.stringify({goal: 'a goal'}),
      });
      const {runId} = (await started.json()) as {runId: string};

      const ac = new AbortController();
      const stream = await fetch(`${base}/v1/runs/${runId}/events`, {signal: ac.signal});
      const reader = stream.body!.getReader();
      let seen = '';
      while (!/event: finished/.test(seen)) {
        const {value, done} = await reader.read();
        if (done) break;
        seen += new TextDecoder().decode(value);
      }
      expect(seen).toMatch(/event: finished/);

      // Exactly what the page does next.
      const record = (await (await fetch(`${base}/v1/runs/${runId}`)).json()) as Record<string, unknown>;
      ac.abort();
      expect(record.answer).toBe('the answer');
      expect(record.steps).toEqual(steps);
    } finally {
      await slow.close();
    }
  }, 20_000);
});

describe('a daily run cap per orchestrator', () => {
  // A hosted orchestrator's key reaches judges, and every run spends the
  // owner's model quota. Without a cap, a leaked key could start runs without
  // end. The cap is per AGENT, over a rolling 24 hours.
  it('refuses the run past the cap with 429 RATE_LIMITED and retry-after; other agents are unaffected', async () => {
    const capped = await buildApp({
      ...chainDeps(config),
      db,
      chains: config.chains,
      defaultChainId: 'near:sandbox',
      runExecutor: async () => DELIVERED,
      runsPerDay: 2,
      submit: async () => ({txHash: `0x${'ef'.repeat(32)}`, chainJobId: '1'}),
    });
    try {
      const a = await register();
      const start = (key: string) =>
        capped.inject({method: 'POST', url: '/v1/runs', headers: auth(key), payload: {goal: 'a goal'}});
      const first = await start(a.apiKey);
      const second = await start(a.apiKey);
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);
      const third = await start(a.apiKey);
      expect(third.statusCode).toBe(429);
      expect(third.json()).toMatchObject({code: 'RATE_LIMITED'});
      expect(third.json().detail).toMatch(/2 runs/);
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);

      const other = (
        await signedRegistration(capped, {
          name: 'OtherBot',
          capabilities: ['market-research'],
          pricePerTask: '20000',
          walletAddress: addr('33'),
          ownerAddress: addr('44'),
        })
      ).json() as {apiKey: string};
      const fourth = await start(other.apiKey);
      expect(fourth.statusCode).toBe(202);
      // Every run started here must END before the next test truncates the
      // tables: a run still writing its events deadlocked that TRUNCATE (CI,
      // 2026-10-08, "deadlock detected").
      for (const r of [first, second, fourth]) await settle(r.json().runId);
    } finally {
      await capped.close();
    }
  });

  it('is off by default', async () => {
    const {apiKey} = await register();
    const started: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: auth(apiKey),
        payload: {goal: 'a goal'},
      });
      expect(res.statusCode).toBe(202);
      started.push(res.json().runId);
    }
    // Let them finish, for the same reason as above.
    for (const id of started) await settle(id);
  });
});
