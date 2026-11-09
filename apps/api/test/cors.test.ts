import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {sql} from 'drizzle-orm';
import {chainDeps} from './helpers/register.js';
import {buildApp, EventBus} from '../src/app.js';

/**
 * The interface is served from one origin and the API from another — Vercel
 * and Railway in production, two ports locally. The API sent no CORS headers
 * at all, so a browser refused every response: the first time the interface
 * was opened in a real browser, every page said "API unreachable". No test
 * noticed, because no test runs in a browser.
 *
 * Auth is a bearer key, never a cookie, so allowing other origins without
 * credentials gives a hostile page nothing it could not already do with curl.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let db: Db;
let open: FastifyInstance;
let pinned: FastifyInstance;
/** Every method some route of `open` is served on. */
const served = new Set<string>();

beforeAll(async () => {
  db = createDb(DB_URL, {max: 2});
  const base = {
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    submit: async () => ({txHash: '0x'}),
  };
  open = await buildApp({
    ...base,
    onRoute: (r: {method: string | string[]}) => {
      for (const m of [r.method].flat()) if (!['HEAD', 'OPTIONS'].includes(m)) served.add(m);
    },
  });
  pinned = await buildApp({...base, corsOrigins: ['https://pactora.example']});
});

afterAll(async () => {
  await open.close();
  await pinned.close();
  await closeDb(db);
});

const UI = 'http://127.0.0.1:3117';

describe('a browser on another origin', () => {
  it('can read the API', async () => {
    const res = await open.inject({method: 'GET', url: '/v1/network', headers: {origin: UI}});
    expect(res.headers['access-control-allow-origin']).toBeDefined();
  });

  it('may send the headers an agent needs, on a preflight', async () => {
    const res = await open.inject({
      method: 'OPTIONS',
      url: '/v1/jobs',
      headers: {
        origin: UI,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,idempotency-key',
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    const allowed = String(res.headers['access-control-allow-headers']).toLowerCase();
    for (const h of ['authorization', 'content-type', 'idempotency-key']) expect(allowed).toContain(h);
  });

  // Every method a route uses must pass a preflight: an API test calls the
  // route with inject, which never asks, so only this catches a method the
  // browser would be refused (PUT /v1/me/profile was, at first).
  it('allows, on a preflight, every method the API serves', async () => {
    expect(served).toContain('PUT');
    for (const method of served) {
      const res = await open.inject({
        method: 'OPTIONS',
        url: '/v1/me/profile',
        headers: {origin: UI, 'access-control-request-method': method},
      });
      expect(res.statusCode, method).toBeLessThan(300);
      expect(String(res.headers['access-control-allow-methods']), method).toContain(method);
    }
  });

  it('never allows credentials, which is what makes allowing origins safe', async () => {
    const res = await open.inject({method: 'GET', url: '/v1/network', headers: {origin: UI}});
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('can see the trace id, so a failed request can be reported', async () => {
    const res = await open.inject({method: 'GET', url: '/v1/network', headers: {origin: UI}});
    expect(String(res.headers['access-control-expose-headers']).toLowerCase()).toContain('x-trace-id');
  });

  it("can read a download's file name (the audit-log CSV, the /me export)", async () => {
    const res = await open.inject({method: 'GET', url: '/v1/network', headers: {origin: UI}});
    expect(String(res.headers['access-control-expose-headers']).toLowerCase()).toContain(
      'content-disposition',
    );
  });

  it('can be pinned to named origins', async () => {
    const other = await pinned.inject({method: 'GET', url: '/v1/network', headers: {origin: UI}});
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    const ours = await pinned.inject({
      method: 'GET',
      url: '/v1/network',
      headers: {origin: 'https://pactora.example'},
    });
    expect(ours.headers['access-control-allow-origin']).toBe('https://pactora.example');
  });
});

/**
 * Found in a real browser against the real API: the live trace never arrived.
 * The event stream writes its headers straight to the socket, which skipped
 * the CORS headers every other route gets — so a site on another origin (all
 * of them, in production) had EventSource blocked, and a run looked frozen.
 * The mock API the interface's smoke test uses sends `*` for everything, so
 * nothing but a real browser on a real API could see it.
 */
describe('a live event stream from another origin', () => {
  it('carries the CORS headers, so the browser lets EventSource read it', async () => {
    await db.execute(sql`TRUNCATE agents, runs, run_events RESTART IDENTITY CASCADE`);
    const [agent] = (await db.execute(
      sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task, chain_agent_id)
          VALUES ('near:sandbox', '0xaa', '0xaa', 'Orchestrator', '0', 1) RETURNING id`,
    )) as unknown as {id: number}[];
    const [run] = (await db.execute(
      sql`INSERT INTO runs (chain_id, agent_id, goal)
          VALUES ('near:sandbox', ${agent!.id}, 'a goal') RETURNING public_id`,
    )) as unknown as {public_id: string}[];

    const address = await pinned.listen({port: 0, host: '127.0.0.1'});
    const controller = new AbortController();
    try {
      const res = await fetch(`${address}/v1/runs/${run!.public_id}/events`, {
        headers: {origin: 'https://pactora.example', accept: 'text/event-stream'},
        signal: controller.signal,
      });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('access-control-allow-origin')).toBe('https://pactora.example');
    } finally {
      controller.abort();
    }
  });
});
