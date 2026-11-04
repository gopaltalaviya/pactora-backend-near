import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {connect, createServer, type AddressInfo, type Socket} from 'node:net';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {streamEvents, type StreamEvent} from '../src/events.js';
import {listenForEvents} from '../src/live.js';
import {addr, signedRegistration} from './helpers/register.js';

/**
 * Live events across processes (v3). An SSE stream used to carry only what
 * its own API process published: an event the indexer stored reached a
 * client only on its next reconnect, and a second replica never saw the
 * first one's events. A trigger now NOTIFYs every stored event, and each
 * instance LISTENs and publishes it to its own streams.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});

/** Two replicas on one database, each with its own pool — and a third connection playing the indexer. */
let dbA: Db, dbB: Db, indexer: Db;
let appA: FastifyInstance, appB: FastifyInstance;
let baseA: string, baseB: string;

async function replica(db: Db): Promise<{app: FastifyInstance; base: string}> {
  const app = await buildApp({
    db,
    chains: config.chains,
    defaultChainId: 31337,
    bus: new EventBus(),
    submit: async () => ({txHash: '0x'}),
  });
  await app.listen({port: 0, host: '127.0.0.1'});
  return {app, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`};
}

beforeAll(async () => {
  dbA = createDb(DB_URL, {max: 3});
  dbB = createDb(DB_URL, {max: 3});
  indexer = createDb(DB_URL, {max: 1});
  ({app: appA, base: baseA} = await replica(dbA));
  ({app: appB, base: baseB} = await replica(dbB));
});
afterAll(async () => {
  await appA.close();
  await appB.close();
  await Promise.all([closeDb(dbA), closeDb(dbB), closeDb(indexer)]);
});
beforeEach(async () => {
  await dbA.execute(
    sql`TRUNCATE agents, jobs, job_events, runs, run_events, api_keys RESTART IDENTITY CASCADE`,
  );
});

async function register(wallet: string): Promise<{agentId: number; apiKey: string}> {
  const res = await signedRegistration(appA, {
    name: 'L',
    capabilities: ['market-research'],
    pricePerTask: '20000',
    walletAddress: wallet,
    ownerAddress: wallet,
  });
  return res.json();
}

/** A job in `created`; returns its serial id, public id and the worker's key. */
async function seedJob(): Promise<{id: number; publicId: string; workerKey: string}> {
  const client = await register(addr('a1'));
  const worker = await register(addr('a2'));
  const [row] =
    (await dbA.execute(sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash)
      VALUES (31337, ${client.agentId}, ${worker.agentId}, 'escrow', 20000, '{}'::jsonb, '0x01')
      RETURNING id, public_id`)) as unknown as {id: number; public_id: string}[];
  return {id: Number(row!.id), publicId: row!.public_id, workerKey: worker.apiKey};
}

/** An open stream whose text accumulates; `until` waits for a pattern or a timeout. */
function open(url: string): {
  text: () => string;
  until: (re: RegExp, ms?: number) => Promise<string>;
  close: () => void;
} {
  const ac = new AbortController();
  let seen = '';
  void (async () => {
    const res = await fetch(url, {signal: ac.signal});
    const reader = res.body!.getReader();
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
  })().catch(() => undefined); // aborted at close
  return {
    text: () => seen,
    async until(re, ms = 3_000) {
      const deadline = Date.now() + ms;
      while (!re.test(seen) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      return seen;
    },
    close: () => ac.abort(),
  };
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('live events across processes', () => {
  it('delivers a job event the indexer commits to a stream that is already open', async () => {
    const job = await seedJob();
    const stream = open(`${baseA}/v1/jobs/${job.publicId}/events`);
    try {
      expect(await stream.until(/retry: 3000/)).toMatch(/retry: 3000/);

      // As the indexer writes it: a separate connection, inside a transaction.
      const [row] = (await indexer.transaction((tx) =>
        tx.execute(sql`INSERT INTO job_events (chain_id, job_id, kind, payload, tx_hash, block_number, log_index)
          VALUES (31337, ${job.id}, 'job.funded', '{"amount":"20000"}'::jsonb, '0xfeed', 7, 0) RETURNING id`),
      )) as unknown as {id: number}[];

      const seen = await stream.until(/event: job\.funded/);
      expect(seen).toContain(`id: ${row!.id}\nevent: job.funded\ndata: {"amount":"20000"}\n\n`);
    } finally {
      stream.close();
    }
  });

  it('delivers an event recorded through one replica to a stream open on another', async () => {
    const job = await seedJob();
    const stream = open(`${baseB}/v1/jobs/${job.publicId}/events`);
    try {
      await stream.until(/retry: 3000/);
      const res = await appA.inject({
        method: 'POST',
        url: `/v1/jobs/${job.publicId}/decline`,
        headers: {authorization: `Bearer ${job.workerKey}`},
        payload: {reason: 'busy'},
      });
      expect(res.statusCode).toBe(200);

      const seen = await stream.until(/event: job\.declined/);
      expect(seen).toMatch(/id: \d+\nevent: job\.declined\n/);
    } finally {
      stream.close();
    }
  });

  it('delivers an event once, though both the local publish and its NOTIFY echo arrive', async () => {
    const job = await seedJob();
    const stream = open(`${baseA}/v1/jobs/${job.publicId}/events`);
    try {
      await stream.until(/retry: 3000/);
      await appA.inject({
        method: 'POST',
        url: `/v1/jobs/${job.publicId}/decline`,
        headers: {authorization: `Bearer ${job.workerKey}`},
        payload: {reason: 'busy'},
      });
      await stream.until(/event: job\.declined/);
      // Long enough for the echo, which is a round trip through Postgres.
      await new Promise((r) => setTimeout(r, 500));
      const id = /id: (\d+)\nevent: job\.declined/.exec(stream.text())![1];
      expect(count(stream.text(), `id: ${id}\n`)).toBe(1);
    } finally {
      stream.close();
    }
  });

  it('delivers a run event the database commits to a stream that is already open', async () => {
    const [a] =
      (await dbA.execute(sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
        VALUES (31337, '0xo', ${addr('e1')}, 'O', 0) RETURNING id`)) as unknown as {id: number}[];
    const [r] =
      (await dbA.execute(sql`INSERT INTO runs (chain_id, agent_id, goal) VALUES (31337, ${a!.id}, 'g')
        RETURNING id, public_id`)) as unknown as {id: number; public_id: string}[];

    const stream = open(`${baseB}/v1/runs/${r!.public_id}/events`);
    try {
      await stream.until(/retry: 3000/);
      const [e] = (await indexer.execute(sql`INSERT INTO run_events (run_id, kind, payload)
          VALUES (${r!.id}, 'planned', '{"steps":2}'::jsonb) RETURNING id`)) as unknown as {id: number}[];

      const seen = await stream.until(/event: planned/);
      expect(seen).toContain(`id: ${e!.id}\nevent: planned\ndata: {"steps":2}\n\n`);
    } finally {
      stream.close();
    }
  });
});

describe('the listener', () => {
  /** postgres.js re-LISTENs on its own; this is the check that it still does. */
  it('hears events again after its connection is dropped', async () => {
    const job = await seedJob();
    const stream = open(`${baseA}/v1/jobs/${job.publicId}/events`);
    try {
      await stream.until(/retry: 3000/);
      const killed = (await indexer.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE query ILIKE 'listen%agentx_events%'`)) as unknown as unknown[];
      expect(killed.length).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 1_000));

      await indexer.execute(sql`INSERT INTO job_events (chain_id, job_id, kind, payload)
        VALUES (31337, ${job.id}, 'job.accepted', '{}'::jsonb)`);
      expect(await stream.until(/event: job\.accepted/)).toMatch(/event: job\.accepted/);
    } finally {
      stream.close();
    }
  });

  /**
   * The API boots with the database down; a LISTEN that fails then must not
   * block the boot, nor leave the instance deaf once the database is back.
   * The database is behind a proxy that refuses, then forwards.
   */
  it('boots with the database down and listens once it is back', async () => {
    const target = new URL(DB_URL);
    let down = true;
    const sockets = new Set<Socket>();
    const proxy = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      if (down) return void socket.destroy();
      const upstream = connect(Number(target.port), target.hostname);
      sockets.add(upstream);
      upstream.on('close', () => (sockets.delete(upstream), socket.destroy()));
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const via = new URL(DB_URL);
    via.port = String((proxy.address() as AddressInfo).port);

    const own = createDb(via.toString(), {max: 1});
    const bus = new EventBus();
    const errors: string[] = [];
    const log = (_e: unknown, m: string) => errors.push(m);
    const started = Date.now();
    const stop = await listenForEvents({db: own, bus, runBus: new EventBus(), log, listenWaitMs: 500});
    const heard: StreamEvent[] = [];
    try {
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(errors).toContain('live events: database unreachable; listening when it is back');

      const job = await seedJob();
      bus.subscribe(job.id, (e) => heard.push(e));
      down = false;
      await new Promise((r) => setTimeout(r, 3_000)); // the driver's own retry, with backoff

      await indexer.execute(sql`INSERT INTO job_events (chain_id, job_id, kind, payload)
        VALUES (31337, ${job.id}, 'job.accepted', '{}'::jsonb)`);
      const deadline = Date.now() + 3_000;
      while (heard.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(heard.map((e) => e.event)).toEqual(['job.accepted']);
    } finally {
      await stop().catch(() => undefined);
      await closeDb(own);
      for (const s of sockets) s.destroy();
      proxy.close();
    }
  });
});

describe('streamEvents', () => {
  async function server(bus: EventBus, replay: () => Promise<StreamEvent[]>) {
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    app.get('/s', async (_req, reply) => {
      await streamEvents(reply, bus, 1, replay);
      return reply;
    });
    app.addHook('preClose', async () => bus.closeAll());
    await app.listen({port: 0, host: '127.0.0.1'});
    return {app, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/s`};
  }
  const ev = (id: number): StreamEvent => ({event: `e${id}`, data: {id}, id});

  /**
   * The replay query and the subscription are not one step. v2 replayed and
   * THEN subscribed, so an event committed after the query read its snapshot
   * but before the subscribe reached neither: lost for good.
   */
  it('loses nothing committed while the replay runs, and sends nothing twice', async () => {
    const bus = new EventBus();
    const {app, url} = await server(bus, async () => {
      // Published mid-replay: 2 is also in the snapshot below, 3 committed too late for it.
      bus.publish(1, ev(2));
      bus.publish(1, ev(3));
      await new Promise((r) => setTimeout(r, 100));
      return [ev(1), ev(2)];
    });
    const stream = open(url);
    try {
      const seen = await stream.until(/event: e3/);
      expect(seen.match(/id: \d+/g)).toEqual(['id: 1', 'id: 2', 'id: 3']);
    } finally {
      stream.close();
      await app.close();
    }
  });

  it('drops an id it has already sent, and always sends an event without one', async () => {
    const bus = new EventBus();
    const {app, url} = await server(bus, async () => []);
    const stream = open(url);
    try {
      await stream.until(/retry: 3000/);
      bus.publish(1, ev(5));
      bus.publish(1, ev(5));
      bus.publish(1, {event: 'anon', data: {}});
      bus.publish(1, {event: 'anon', data: {}});
      bus.publish(1, {event: 'end', data: {}, id: 6});
      const seen = await stream.until(/event: end/);
      expect(count(seen, 'id: 5\n')).toBe(1);
      expect(count(seen, 'event: anon\n')).toBe(2);
    } finally {
      stream.close();
      await app.close();
    }
  });
});
