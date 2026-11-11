import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {chainDeps} from './helpers/register.js';
import {buildApp, EventBus} from '../src/app.js';

/**
 * A rate limit shared between replicas. docs/17: "per process, so N×
 * with N replicas". Two app instances stand in for two replicas: with the
 * in-memory store each allows the full limit; with the Postgres store they
 * share one.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let db: Db;
const apps: FastifyInstance[] = [];
beforeAll(() => {
  db = createDb(DB_URL, {max: 4});
});
afterAll(async () => {
  for (const a of apps) await a.close();
  await closeDb(db);
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE rate_limits`);
});

const replica = async (store?: 'postgres') => {
  const app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    submit: async () => ({txHash: '0x'}),
    rateLimitPerMinute: 3,
    ...(store ? {rateLimitStore: store} : {}),
  });
  apps.push(app);
  return app;
};

const hit = (app: FastifyInstance) => app.inject({method: 'GET', url: '/v1/rank-modes'});

describe('the Postgres rate-limit store', () => {
  it('makes two replicas share one limit', async () => {
    const [a, b] = [await replica('postgres'), await replica('postgres')];
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await hit(i % 2 === 0 ? a : b)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  it('starts a fresh window once the old one has passed', async () => {
    const a = await replica('postgres');
    for (let i = 0; i < 3; i++) await hit(a);
    expect((await hit(a)).statusCode).toBe(429);
    await db.execute(sql`UPDATE rate_limits SET window_start = now() - interval '61 seconds'`);
    expect((await hit(a)).statusCode).toBe(200);
  });

  /** The plugin keys by client IP alone; a per-route limit must still count apart. */
  it("keeps a route's own limit separate from the global one", async () => {
    const {postgresRateLimitStore} = await import('../src/rate-store.js');
    const Store = postgresRateLimitStore(db);
    const global = new Store();
    const route = global.child({routeInfo: {method: 'POST', url: '/v1/runs'}});
    const incr = (s: InstanceType<typeof Store>) =>
      new Promise<number>((resolve, reject) =>
        s.incr('203.0.113.9', (err, r) => (err ? reject(err) : resolve(r!.current)), 60_000),
      );
    expect([await incr(global), await incr(global)]).toEqual([1, 2]);
    expect(await incr(route)).toBe(1);
  });

  it('prunes windows that ended long ago, and keeps live ones', async () => {
    const {pruneRateLimits} = await import('../src/rate-store.js');
    await db.execute(sql`INSERT INTO rate_limits (key, count, window_start) VALUES
        ('old', 5, now() - interval '2 hours'), ('live', 1, now())`);
    await pruneRateLimits(db);
    const keys = (
      (await db.execute(sql`SELECT key FROM rate_limits ORDER BY key`)) as unknown as {key: string}[]
    ).map((r) => r.key);
    expect(keys).toEqual(['live']);
  });

  /** The control: the default store counts per process, which is the gap. */
  it('is not what the in-memory store does', async () => {
    const [a, b] = [await replica(), await replica()];
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await hit(i % 2 === 0 ? a : b)).statusCode);
    expect(codes).toEqual([200, 200, 200, 200]);
  });
});
