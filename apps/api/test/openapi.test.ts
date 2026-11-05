import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {createMetrics} from '@pactora/service';
import {buildApp} from '../src/app.js';
import {addr} from './helpers/register.js';

/**
 * GET /v1/openapi.json — generated from the zod schemas the handlers validate
 * with. Two things keep it honest: it lists exactly the routes the API serves
 * (as docs/15 must), and what it says is required, the API really requires.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});
const BUILD = {service: 'api', version: '9.9.9', commit: 'a1b2c3d4e5f6', builtAt: '2026-10-25T12:00:00Z'};

type Operation = {
  requestBody?: {content: {'application/json': {schema: {required?: string[]}}}};
  parameters: {name: string; in: string; required: boolean}[];
  responses: Record<string, unknown>;
  security?: unknown[];
};
type Spec = {
  openapi: string;
  info: {title: string; version: string};
  paths: Record<string, Record<string, Operation>>;
};

let db: Db;
let app: FastifyInstance;
let spec: Spec;
const served = new Set<string>();

beforeAll(async () => {
  db = createDb(DB_URL, {max: 2});
  app = await buildApp({
    db,
    chains: config.chains,
    defaultChainId: 31337,
    submit: async () => ({txHash: '0x'}),
    build: BUILD,
    metrics: createMetrics('api-openapi'),
    onRoute: (r) => {
      for (const m of [r.method].flat()) {
        if (['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(m)) served.add(`${m} ${r.url}`);
      }
    },
  });
  await app.ready();
  spec = (await app.inject({url: '/v1/openapi.json'})).json() as Spec;
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});

const listed = () =>
  new Set(
    Object.entries(spec.paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`),
    ),
  );
const op = (method: string, path: string) => spec.paths[path.replace(/:(\w+)/g, '{$1}')]![method]!;
const requiredOf = (o: Operation) => o.requestBody?.content['application/json'].schema.required ?? [];

describe('GET /v1/openapi.json', () => {
  it('is an OpenAPI 3.0 document stamped with the build', () => {
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info.version).toBe('9.9.9');
    expect(spec.info.title).toBe('Pactora API');
  });

  it('lists exactly the routes the API serves', () => {
    expect(served.size).toBeGreaterThan(30);
    expect([...served].filter((r) => !listed().has(r)).sort()).toEqual([]);
    expect([...listed()].filter((r) => !served.has(r)).sort()).toEqual([]);
  });

  it('gives every operation a success and an error response, and every path parameter', () => {
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const o of Object.values(ops)) {
        expect(Object.keys(o.responses)).toContain('default');
        expect(Object.keys(o.responses).some((c) => /^2\d\d$/.test(c))).toBe(true);
        for (const [, name] of path.matchAll(/\{(\w+)\}/g)) {
          expect(o.parameters.some((p) => p.in === 'path' && p.name === name && p.required)).toBe(true);
        }
      }
    }
  });

  /**
   * `/v1/network` is the one response whose shape the spec states exactly:
   * it is what a client reads before spending. The live response must carry
   * every field the spec requires and nothing the spec does not name.
   */
  it('describes the GET /v1/network response, fees and limits included, as the API sends it', async () => {
    const ok = op('get', '/v1/network').responses['200'] as {
      content: {'application/json': {schema: {properties?: Record<string, unknown>; required?: string[]}}};
    };
    const schema = ok.content['application/json'].schema;
    const named = Object.keys(schema.properties ?? {});
    for (const f of [
      'minJobAmount',
      'minFee',
      'protocolFeeBps',
      'windows',
      'bondBps',
      'minBond',
      'disputeBondBps',
      'minDisputeBond',
      'maxJobAmount',
      'defaultPerTaskCap',
      'defaultDailyCap',
      'minStake',
      'withdrawDelaySeconds',
    ]) {
      expect(named, f).toContain(f);
    }
    const body = (await app.inject({url: '/v1/network'})).json() as Record<string, unknown>;
    expect(Object.keys(body).filter((k) => !named.includes(k))).toEqual([]);
    expect((schema.required ?? []).filter((k) => !(k in body))).toEqual([]);
  });

  it('marks the money-moving routes as needing an Idempotency-Key', () => {
    for (const [m, p] of [
      ['post', '/v1/jobs'],
      ['post', '/v1/x402/settle'],
    ] as const) {
      expect(op(m, p).parameters).toContainEqual(
        expect.objectContaining({name: 'Idempotency-Key', in: 'header', required: true}),
      );
    }
  });
});

describe('what the spec requires, the API requires', () => {
  /**
   * Registration validates before anything else, so each field the spec calls
   * required can be dropped in turn: the API must refuse each, naming it.
   */
  it('POST /v1/agents refuses a body missing any field the spec requires', async () => {
    const required = requiredOf(op('post', '/v1/agents'));
    expect(required.length).toBeGreaterThan(0);
    const full = {
      name: 'SpecBot',
      capabilities: ['market-research'],
      pricePerTask: '20000',
      walletAddress: addr('51'),
      ownerAddress: addr('52'),
    };
    for (const field of required) {
      const body: Record<string, unknown> = {...full};
      delete body[field];
      // Unsigned on purpose: a body missing a field fails validation first.
      const res = await app.inject({method: 'POST', url: '/v1/agents', payload: body});
      expect(res.statusCode, field).toBe(422);
      expect(res.json().detail, field).toContain(field);
    }
  });

  it('query limits in the spec are the ones the API enforces', async () => {
    const limit = op('get', '/v1/agents').parameters.find((p) => p.name === 'limit') as unknown as {
      schema: {maximum: number};
    };
    const over = await app.inject({url: `/v1/agents?limit=${limit.schema.maximum + 1}`});
    expect(over.statusCode).toBe(422);
    const at = await app.inject({url: `/v1/agents?limit=${limit.schema.maximum}`});
    expect(at.statusCode).toBe(200);
  });
});
