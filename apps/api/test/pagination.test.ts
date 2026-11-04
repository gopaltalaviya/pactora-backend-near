import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {addr, signedRegistration} from './helpers/register.js';

/**
 * Cursor pagination (v3). docs/17: "bounded `limit` only, no cursor" — past
 * the first page a caller could not see its own history at all.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});

let app: FastifyInstance;
let db: Db;

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    db,
    chains: config.chains,
    defaultChainId: 31337,
    bus: new EventBus(),
    submit: async () => ({txHash: '0x'}),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE agents, jobs, runs, api_keys RESTART IDENTITY CASCADE`);
});

async function register(wallet: string): Promise<{agentId: number; apiKey: string}> {
  const res = await signedRegistration(app, {
    name: 'P',
    capabilities: ['market-research'],
    pricePerTask: '20000',
    walletAddress: wallet,
    ownerAddress: wallet,
  });
  return res.json();
}

const get = (url: string, key: string) =>
  app.inject({method: 'GET', url, headers: {authorization: `Bearer ${key}`}});

/** Every page, following nextCursor until it is null. */
async function allPages(path: string, key: string, field: 'jobs' | 'runs'): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard++) {
    const res = await get(`${path}?limit=2${cursor ? `&cursor=${cursor}` : ''}`, key);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown> & {nextCursor: string | null};
    pages.push((body[field] as {jobId?: string; runId?: string}[]).map((x) => (x.jobId ?? x.runId)!));
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return pages;
}

describe('GET /v1/jobs pagination', () => {
  it('walks every job once, oldest first, and ends with a null cursor', async () => {
    const client = await register(addr('c1'));
    const worker = await register(addr('c2'));
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const [row] =
        (await db.execute(sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash)
          VALUES (31337, ${client.agentId}, ${worker.agentId}, 'escrow', 20000, '{}'::jsonb, '0x01') RETURNING public_id`)) as unknown as {
          public_id: string;
        }[];
      ids.push(row!.public_id);
    }
    const pages = await allPages('/v1/jobs', client.apiKey, 'jobs');
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat()).toEqual(ids);
  });

  it('refuses a cursor it did not issue', async () => {
    const c = await register(addr('c3'));
    const res = await get('/v1/jobs?cursor=not-a-cursor', c.apiKey);
    expect(res.statusCode).toBe(422);
  });
});

describe('GET /v1/runs pagination', () => {
  it('walks every run once, newest first', async () => {
    const o = await register(addr('d1'));
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [row] =
        (await db.execute(sql`INSERT INTO runs (chain_id, agent_id, goal) VALUES (31337, ${o.agentId}, ${'g' + i})
          RETURNING public_id`)) as unknown as {public_id: string}[];
      ids.push(row!.public_id);
    }
    const pages = await allPages('/v1/runs', o.apiKey, 'runs');
    expect(pages.flat()).toEqual([...ids].reverse());
    expect(pages.at(-1)!.length).toBeGreaterThan(0);
  });
});
