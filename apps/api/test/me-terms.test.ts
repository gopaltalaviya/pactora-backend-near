import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, fakeReadTxEvents, person, sessionOnly} from './helpers/people.js';

/**
 * Issue 17: the acceptance of the terms at /join was kept only by the
 * browser. The API now records it on the person's record: when, and which
 * version, the first acceptance of a version kept.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;

beforeAll(async () => {
  db = createDb(DB_URL, {max: 5});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    readBudget: fakeReadBudget,
    readTxEvents: fakeReadTxEvents,
    rateLimitPerMinute: 100_000,
    submit: async () => ({txHash: 'Tx'}),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, sessions, login_challenges RESTART IDENTITY CASCADE`,
  );
});

const accept = (token: string, payload: unknown) =>
  app.inject({method: 'POST', url: '/v1/me/terms', headers: bearer(token), payload: payload as object});
const me = async (token: string) => (await app.inject({url: '/v1/me', headers: bearer(token)})).json();

describe('POST /v1/me/terms', () => {
  it('records the acceptance on the person, shows it on /v1/me, and keeps the first one of a version', async () => {
    const p = await person(app, 'terms-sam');
    expect((await me(p.token)).person.terms).toEqual({acceptedAt: null, version: null});

    const first = await accept(p.token, {version: '2026-11-09'});
    expect(first.statusCode, first.body).toBe(201);
    const out = first.json();
    expect(out.version).toBe('2026-11-09');
    expect(Date.parse(out.acceptedAt)).not.toBeNaN();
    expect((await me(p.token)).person.terms).toEqual(out);

    // A repeat of the same version is a replay: the first acceptance stands.
    await new Promise((r) => setTimeout(r, 10));
    const again = await accept(p.token, {version: '2026-11-09'});
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(out);

    // A new version of the terms is a new acceptance.
    const next = await accept(p.token, {version: '2026-12-01'});
    expect(next.statusCode).toBe(201);
    expect(next.json().version).toBe('2026-12-01');
    expect(Date.parse(next.json().acceptedAt)).toBeGreaterThan(Date.parse(out.acceptedAt));
  });

  it('refuses a bad version, a session with no person agent, and an agent key', async () => {
    const p = await person(app, 'terms-olive');
    expect((await accept(p.token, {})).statusCode).toBe(422);
    expect((await accept(p.token, {version: ''})).statusCode).toBe(422);
    expect((await accept(p.token, {version: 'x'.repeat(65)})).statusCode).toBe(422);
    expect((await accept(p.token, {version: 'has space'})).statusCode).toBe(422);

    const bare = await sessionOnly(app, 'terms-nobody');
    const none = await accept(bare, {version: '2026-11-09'});
    expect(none.statusCode).toBe(409);
    expect(none.json().detail).toMatch(/POST \/v1\/people/);

    const a = await agent(app, 'terms-bot');
    expect((await accept(a.apiKey, {version: '2026-11-09'})).statusCode).toBe(401);
    expect(
      (await app.inject({method: 'POST', url: '/v1/me/terms', payload: {version: 'v1'}})).statusCode,
    ).toBe(401);
  });
});
