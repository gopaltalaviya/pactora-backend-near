import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {AddressInfo} from 'node:net';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {createMetrics} from '@pactora/service';
import {buildApp, EventBus} from '../src/app.js';
import {streamEvents} from '../src/events.js';

/**
 * Production hardening of the HTTP surface: headers, readiness, metrics,
 * bounded streams, and a shutdown that does not wait on them.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});

let db: Db;
beforeAll(() => {
  db = createDb(DB_URL, {max: 2});
});
afterAll(async () => {
  await closeDb(db);
});

const build = (over: Record<string, unknown> = {}) =>
  buildApp({
    db,
    chains: config.chains,
    defaultChainId: 31337,
    submit: async () => ({txHash: '0x'}),
    ...over,
  });

describe('the HTTP surface', () => {
  it('sends security headers that forbid rendering or framing a response', async () => {
    const app = await build();
    const res = await app.inject({url: '/health'});
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    await app.close();
  });

  it('is live while not ready, and names the dependency that is down', async () => {
    const app = await build({
      readiness: {
        database: async () => 1,
        signer: async () => {
          throw new Error('connection refused');
        },
      },
    });
    expect((await app.inject({url: '/health'})).statusCode).toBe(200);
    const ready = await app.inject({url: '/ready'});
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.signer).toEqual({ok: false});
    await app.close();
  });

  it('serves request-duration metrics by route template', async () => {
    const app = await build({metrics: createMetrics('api-test')});
    await app.inject({url: '/v1/jobs/00000000-0000-4000-8000-000000000000'});
    const body = (await app.inject({url: '/metrics'})).body;
    expect(body).toMatch(/route="\/v1\/jobs\/:id"/);
    await app.close();
  });

  /** Found by the operations audit: `Number('abc')` reached Postgres as NaN and answered 500. */
  it('answers a non-numeric agent id as an unknown agent, not a 500', async () => {
    const app = await build();
    const res = await app.inject({url: '/v1/agents/abc'});
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
    await app.close();
  });

  /**
   * A lookup of an agent that does not exist is a 404. It was 409
   * AGENT_NOT_HIREABLE — a hiring refusal — so the site's agent page, which
   * says "there is no agent #N" on NOT_FOUND, showed "could not load" and a
   * pointless retry instead. Its mock API had always said 404.
   */
  it('answers an unknown numeric agent id with 404 NOT_FOUND', async () => {
    const app = await build();
    const res = await app.inject({url: '/v1/agents/999999'});
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
    await app.close();
  });

  it('refuses a malformed list limit with 422, not a 500 from Postgres', async () => {
    const app = await build();
    const res = await app.inject({url: '/v1/runs?limit=abc', headers: {authorization: 'Bearer x'}});
    expect(res.statusCode).not.toBe(500);
    await app.close();
  });
});

describe('server-sent event streams', () => {
  async function server(bus: EventBus): Promise<{app: FastifyInstance; url: string}> {
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    app.get('/s', async (_req, reply) => {
      await streamEvents(reply, bus, 1);
      return reply;
    });
    app.addHook('preClose', async () => bus.closeAll());
    await app.listen({port: 0, host: '127.0.0.1'});
    return {app, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/s`};
  }

  it('refuses a stream beyond the cap with 503, rather than holding sockets without limit', async () => {
    const bus = new EventBus(1);
    const {app, url} = await server(bus);
    const first = await fetch(url);
    expect(first.status).toBe(200);
    const second = await fetch(url);
    expect(second.status).toBe(503);
    expect(bus.streamCount).toBe(1);
    await first.body?.cancel();
    await app.close();
  });

  /**
   * The cap was a per-instance total, so one client could hold all of it and
   * every other watcher got 503. Each address now has a share.
   */
  it('caps the streams one client address may hold, leaving room for everyone else', async () => {
    const bus = new EventBus(100, 2);
    const Fastify = (await import('fastify')).default;
    // Trusted, so the test can speak as two addresses through X-Forwarded-For.
    const app = Fastify({trustProxy: true});
    app.get('/s', async (_req, reply) => {
      await streamEvents(reply, bus, 1);
      return reply;
    });
    app.addHook('preClose', async () => bus.closeAll());
    await app.listen({port: 0, host: '127.0.0.1'});
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/s`;
    const as = (ip: string) => fetch(url, {headers: {'x-forwarded-for': ip}});

    const held = [await as('198.51.100.1'), await as('198.51.100.1')];
    expect(held.map((r) => r.status)).toEqual([200, 200]);
    const third = await as('198.51.100.1');
    expect(third.status).toBe(503);
    const other = await as('198.51.100.2');
    expect(other.status).toBe(200);

    // A closed stream gives its slot back.
    await held[0]!.body?.cancel();
    await new Promise((r) => setTimeout(r, 100));
    const again = await as('198.51.100.1');
    expect(again.status).toBe(200);

    for (const r of [held[1]!, other, again]) await r.body?.cancel();
    await app.close();
  });

  /**
   * Node holds response headers until the first write. With nothing to replay
   * and nothing published yet, v1's stream sent NO response until the first
   * heartbeat — a client watching a quiet run waited 25 s to be connected.
   */
  it('answers a new subscriber at once, even when there is nothing to send yet', async () => {
    const bus = new EventBus();
    const {app, url} = await server(bus);
    const started = Date.now();
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    await res.body?.cancel();
    await app.close();
  });

  /** v1 had no way to end a stream, so a deploy waited out its full shutdown timeout. */
  it('ends open streams on close, so shutdown does not wait on them', async () => {
    const bus = new EventBus();
    const {app, url} = await server(bus);
    const res = await fetch(url);
    expect(bus.streamCount).toBe(1);

    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(bus.streamCount).toBe(0);
    await res.body?.cancel().catch(() => undefined);
  });
});

describe('the rate limit', () => {
  // A client that exhausts its budget must not make the instance look dead:
  // health and readiness are what a load balancer reads, and on a single
  // shared egress IP a 429 there takes a healthy instance out of rotation.
  it('limits the API but never the health and readiness probes', async () => {
    const app = await build({rateLimitPerMinute: 2, readiness: {}});
    for (let i = 0; i < 2; i++) expect((await app.inject({url: '/v1/rank-modes'})).statusCode).toBe(200);
    const limited = await app.inject({url: '/v1/rank-modes'});
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({code: 'RATE_LIMITED'});
    for (const url of ['/health', '/ready', '/health', '/ready']) {
      expect((await app.inject({url})).statusCode, url).toBe(200);
    }
    await app.close();
  });
});

describe('a database outage', () => {
  // A dependency being down is not a bug in the API: 500 told every client
  // "do not retry, this is ours", and the site showed a bare failure. It is a
  // 503 with retry-after, and the body names no host.
  it('is a 503 UPSTREAM_UNAVAILABLE with retry-after, never a 500, and leaks no address', async () => {
    const dead = createDb('postgres://agentx:agentx@127.0.0.1:1/agentx', {max: 1});
    try {
      const app = await build({db: dead});
      const res = await app.inject({url: '/v1/agents'});
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.json()).toMatchObject({code: 'UPSTREAM_UNAVAILABLE', status: 503});
      expect(res.body).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|postgres:\/\//);
      await app.close();
    } finally {
      await closeDb(dead);
    }
  }, 20_000);
});
