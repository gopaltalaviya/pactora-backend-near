import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {makeTxEventsReader} from '../src/chain-reads.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, person} from './helpers/people.js';

/**
 * Live-probe hygiene (2026-11-09): a NUL byte in text is 422 not 500; an
 * empty PATCH is 422; `bearer` in any case is accepted; a hostile
 * x-request-id is not echoed; unmatched routes are rate limited; the
 * OpenAPI document names NEAR; an unknown transaction hash reads as
 * pending, not a 500.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
const build = (over: Record<string, unknown> = {}) =>
  buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    readBudget: fakeReadBudget,
    rateLimitPerMinute: 100_000,
    liveEvents: false,
    draftSettleSweepMs: 0,
    listingExpirySweepMs: 0,
    sessionKeySweepMs: 0,
    retention: {intervalMs: 0},
    submit: async () => ({txHash: 'unused'}),
    ...over,
  });

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await build();
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE agents, jobs, agent_stats, agent_capabilities, api_keys, registration_challenges, sessions, login_challenges, listings, public_profiles RESTART IDENTITY CASCADE`,
  );
});

describe('request hygiene', () => {
  it('a NUL byte in any text field is 422 SCHEMA_MISMATCH, never 500', async () => {
    const a = await agent(app, 'hy-nul');
    const p = await person(app, 'hy-nul-p');
    const listing = await app.inject({
      method: 'POST',
      url: '/v1/listings',
      headers: {...bearer(a.apiKey), 'idempotency-key': 'hy-nul-listing-1'},
      payload: {
        title: 'Photograph\u0000 three shop fronts',
        description: 'Take clear daytime photos of three shop fronts on the high street.',
        category: 'physical',
        interactionMode: 'capture',
        maxPriceBaseUnits: '40000',
        maxWorkers: 1,
        estimatedMinutes: 60,
        deadline: new Date(Date.now() + 86_400_000).toISOString(),
        criteria: 'Three sharp photos, each showing the full shop front and its sign.',
      },
    });
    expect(listing.statusCode, listing.body).toBe(422);
    expect(listing.json()).toMatchObject({code: 'SCHEMA_MISMATCH'});
    const profile = await app.inject({
      method: 'PUT',
      url: '/v1/me/profile',
      headers: bearer(p.token),
      payload: {displayName: 'Rob\u0000in', bio: 'x'},
    });
    expect(profile.statusCode).toBe(422);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${a.agentId}`,
      headers: bearer(a.apiKey),
      payload: {description: 'nested\u0000'},
    });
    expect(patch.statusCode).toBe(422);
    const query = await app.inject({method: 'GET', url: `/v1/listings?q=${encodeURIComponent('a\u0000b')}`});
    expect(query.statusCode).toBe(422);
  });

  it('PATCH /v1/agents/:id with nothing to change is 422, not 500', async () => {
    const a = await agent(app, 'hy-patch');
    const r = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${a.agentId}`,
      headers: bearer(a.apiKey),
      payload: {},
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toMatch(/nothing to change/);
  });

  it('accepts the Bearer scheme in any case, for keys and sessions', async () => {
    const a = await agent(app, 'hy-bearer');
    const p = await person(app, 'hy-bearer-p');
    for (const scheme of ['bearer', 'BEARER', 'Bearer']) {
      expect(
        (await app.inject({url: '/v1/budget', headers: {authorization: `${scheme} ${a.apiKey}`}})).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({url: '/v1/session', headers: {authorization: `${scheme} ${p.token}`}})).statusCode,
      ).toBe(200);
    }
    expect(
      (await app.inject({url: '/v1/budget', headers: {authorization: `Basic ${a.apiKey}`}})).statusCode,
    ).toBe(401);
  });

  it('echoes a plain x-request-id and replaces anything else', async () => {
    const plain = await app.inject({url: '/health', headers: {'x-request-id': 'trace_abc-123'}});
    expect(plain.headers['x-trace-id']).toBe('trace_abc-123');
    const hostile = await app.inject({
      url: '/v1/nope',
      headers: {'x-request-id': `<script>${'x'.repeat(5000)}</script>`},
    });
    expect(String(hostile.headers['x-trace-id'])).toMatch(/^[0-9a-f-]{36}$/);
    expect(hostile.body).not.toContain('<script>');
    expect(hostile.json().traceId).toBe(hostile.headers['x-trace-id']);
  });

  it('rate limits unmatched routes like every other', async () => {
    const tight = await build({rateLimitPerMinute: 3});
    const codes: number[] = [];
    for (let i = 0; i < 4; i++)
      codes.push((await tight.inject({url: '/v1/nope', remoteAddress: '10.99.0.7'})).statusCode);
    expect(codes).toEqual([404, 404, 404, 429]);
    // The probes stay exempt.
    expect((await tight.inject({url: '/health', remoteAddress: '10.99.0.7'})).statusCode).toBe(200);
    await tight.close();
  });

  it('the OpenAPI document describes NEAR and its payment token', async () => {
    const doc = (await app.inject({url: '/v1/openapi.json'})).json();
    expect(doc.info.description).toMatch(/NEAR/);
    expect(JSON.stringify(doc)).toMatch(/the payment token/);
  });
});

describe('confirming an unknown transaction', () => {
  it('reads as pending (409 with retryAfter at the route), not a 500, whatever the node calls it', async () => {
    const fakeClient = {
      txOutcome: async () => {
        throw Object.assign(new Error('RpcRequestParseError: unknown variant TransactionInfo'), {
          name: 'RpcRequestParseError',
        });
      },
    };
    const read = makeTxEventsReader(config, () => fakeClient as never);
    expect(
      await read({chainId: 'near:sandbox', txHash: 'Tx' + 'A'.repeat(42), signerId: 'a.test.near'}),
    ).toEqual({
      status: 'pending',
    });
    const other = makeTxEventsReader(
      config,
      () =>
        ({
          txOutcome: async () => {
            throw new Error('socket hang up');
          },
        }) as never,
    );
    await expect(
      other({chainId: 'near:sandbox', txHash: 'Tx' + 'A'.repeat(42), signerId: 'a.test.near'}),
    ).rejects.toThrow(/socket/);
  });
});
