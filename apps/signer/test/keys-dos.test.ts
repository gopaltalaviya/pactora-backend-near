import {monitorEventLoopDelay} from 'node:perf_hooks';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildSignerApp} from '../src/app.js';
import {DbKeyStore} from '../src/keystore.js';

/**
 * Audit M1. `POST /keys` is reachable through the API's unauthenticated
 * `POST /v1/agents/wallet-key`. Each key cost a synchronous scrypt (N = 2^15)
 * on the event loop — thirty requests stalled the signer for ~200 ms, during
 * which nothing else (a /sign, /health) was served — and every made-up
 * account left a permanent row the wallet watch then read on every tick.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near_signer';
const CHAIN = 'near:sandbox';
const PASS = 'p'.repeat(40);

let db: Db;
beforeAll(() => {
  db = createDb(DB_URL, {max: 5});
});
afterAll(() => closeDb(db));
beforeEach(async () => {
  await db.execute(sql`TRUNCATE signer_keys RESTART IDENTITY`);
});

describe('a burst of key creations', () => {
  it('does not stall the event loop: /health keeps answering while keys are derived', async () => {
    const keys = new DbKeyStore(db, CHAIN, PASS); // the production KDF cost
    const app = buildSignerApp({
      service: {sign: async () => ({}) as never, acceptWallet: async () => ({}) as never},
      keys,
      chainId: CHAIN,
      keysKind: 'db',
      checks: {},
    });
    await app.inject({method: 'GET', url: '/health'});
    const monitor = monitorEventLoopDelay({resolution: 5});
    monitor.enable();
    const burst = Array.from({length: 30}, (_, i) =>
      app.inject({method: 'POST', url: '/keys', payload: {walletAddress: `spam-${i}.testnet`}}),
    );
    const health = new Promise<number>((resolve) => {
      setTimeout(() => {
        const t = performance.now();
        void app.inject({method: 'GET', url: '/health'}).then(() => resolve(performance.now() - t));
      }, 20);
    });
    const answers = await Promise.all(burst);
    const healthMs = await health;
    monitor.disable();
    expect(answers.every((r) => r.statusCode === 200)).toBe(true);
    const stallMs = monitor.max / 1e6;
    // A synchronous KDF per key stalls the loop for the whole burst (~1.5 s
    // at 2^15); an asynchronous one leaves it free between requests.
    expect(stallMs, `the event loop stalled ${stallMs.toFixed(0)} ms`).toBeLessThan(150);
    expect(healthMs, `/health waited ${healthMs.toFixed(0)} ms behind the burst`).toBeLessThan(500);
    await app.close();
  });
});
