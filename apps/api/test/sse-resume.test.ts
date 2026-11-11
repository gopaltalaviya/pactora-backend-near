import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {AddressInfo} from 'node:net';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {chainDeps} from './helpers/register.js';
import {buildApp, EventBus} from '../src/app.js';

/**
 * Resumable streams. docs/17: "no event ids (`Last-Event-ID` ignored)".
 * A reconnecting EventSource sends the id of the last event it saw; without
 * ids it got the whole history again and a page drew every step twice. Each
 * event's id is its row id — stored first, so ids are unique and ordered.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
let base: string;

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    submit: async () => ({txHash: '0x'}),
  });
  await app.listen({port: 0, host: '127.0.0.1'});
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE agents, runs, run_events RESTART IDENTITY CASCADE`);
});

/** A run with three stored events; returns its public id and the event row ids. */
async function runWithEvents(): Promise<{publicId: string; ids: number[]}> {
  const [a] =
    (await db.execute(sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
      VALUES ('near:sandbox', '0xo', ${'0x' + 'e1'.repeat(20)}, 'O', 0) RETURNING id`)) as unknown as {
      id: number;
    }[];
  const [r] =
    (await db.execute(sql`INSERT INTO runs (chain_id, agent_id, goal) VALUES ('near:sandbox', ${a!.id}, 'g')
      RETURNING id, public_id`)) as unknown as {id: number; public_id: string}[];
  const ids: number[] = [];
  for (const kind of ['planned', 'discovered', 'selected']) {
    const [e] = (await db.execute(sql`INSERT INTO run_events (run_id, kind, payload)
        VALUES (${r!.id}, ${kind}, ${JSON.stringify({kind})}::jsonb) RETURNING id`)) as unknown as {
      id: number;
    }[];
    ids.push(Number(e!.id));
  }
  return {publicId: r!.public_id, ids};
}

/** Read the stream until `until` matches or the time runs out, then disconnect. */
async function readStream(url: string, headers: Record<string, string>, until: RegExp): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3_000);
  let seen = '';
  try {
    const res = await fetch(url, {headers, signal: ac.signal});
    const reader = res.body!.getReader();
    while (!until.test(seen)) {
      const {value, done} = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
  } catch {
    // aborted by the timer: return what arrived
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return seen;
}

describe('GET /v1/runs/:id/events', () => {
  it('gives every event its stored id', async () => {
    const {publicId, ids} = await runWithEvents();
    const seen = await readStream(`${base}/v1/runs/${publicId}/events`, {}, /event: selected/);
    for (const id of ids) expect(seen).toContain(`id: ${id}\n`);
  });

  it('resumes after Last-Event-ID instead of replaying everything', async () => {
    const {publicId, ids} = await runWithEvents();
    const seen = await readStream(
      `${base}/v1/runs/${publicId}/events`,
      {'last-event-id': String(ids[0])},
      /event: selected/,
    );
    expect(seen).not.toMatch(/event: planned/);
    expect(seen).toMatch(/event: discovered/);
    expect(seen).toMatch(/event: selected/);
  });

  it('ignores a Last-Event-ID that is not a number', async () => {
    const {publicId} = await runWithEvents();
    const seen = await readStream(
      `${base}/v1/runs/${publicId}/events`,
      {'last-event-id': 'nonsense'},
      /event: selected/,
    );
    expect(seen).toMatch(/event: planned/);
  });
});
