import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {accountStanding, createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, person, purses} from './helpers/people.js';

/**
 * Profiles (2026-11-09, migration 0026): skills, location, availability,
 * the task list and alerts on PUT /v1/me/profile; `available` and `skill`
 * filters on the directory; match=me reads profile skills; a new listing
 * alerts the available, verified people it matches (listing.match), once.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    readBudget: fakeReadBudget,
    rateLimitPerMinute: 100_000,
    listingExpirySweepMs: 0,
    sessionKeySweepMs: 0,
    submit: async () => ({txHash: '4yJxShz8HXfTyoTMXP9rQSoQUZE8uihkDmnpRrynZeZz'}),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  purses.clear();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, sessions, login_challenges, listings, applications, listing_slots, agent_events, agent_event_seq, public_profiles, account_standing RESTART IDENTITY CASCADE`,
  );
});

const put = (token: string, payload: Record<string, unknown>) =>
  app.inject({method: 'PUT', url: '/v1/me/profile', headers: bearer(token), payload});
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
let keySeq = 0;
const postListing = (token: string, over: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: {...bearer(token), 'idempotency-key': `pm-key-${++keySeq}`},
    payload: {
      title: 'Photograph three shop fronts',
      description: 'Take clear daytime photos of three shop fronts on the high street.',
      category: 'physical',
      interactionMode: 'capture',
      skills: ['photography'],
      location: 'Berlin',
      maxPriceBaseUnits: '40000',
      maxWorkers: 1,
      estimatedMinutes: 60,
      deadline: inDays(7),
      criteria: 'Three sharp photos, each showing the full shop front and its sign.',
      ...over,
    },
  });
const kinds = async (token: string) =>
  (
    (await app.inject({method: 'GET', url: '/v1/events', headers: bearer(token)})).json() as {
      events: {kind: string}[];
    }
  ).events.map((e) => e.kind);

describe('profile fields', () => {
  it('stores skills, location, availability, task list and alerts, and shows them; limits hold', async () => {
    const p = await person(app, 'pf-person');
    const w = await put(p.token, {
      displayName: 'Robin',
      published: true,
      skills: ['Photography', 'photography', 'Legal German'],
      location: '  Berlin,  DE ',
      availability: true,
      showTaskList: true,
      alerts: true,
    });
    expect(w.statusCode, w.body).toBe(200);
    const mine = (await app.inject({method: 'GET', url: '/v1/me/profile', headers: bearer(p.token)})).json();
    expect(mine).toMatchObject({
      skills: ['photography', 'legal german'],
      location: 'Berlin, DE',
      availability: true,
      showTaskList: true,
      alerts: true,
    });
    const pub = (await app.inject({method: 'GET', url: `/v1/profiles/${p.publicId}`})).json();
    expect(pub).toMatchObject({
      skills: ['photography', 'legal german'],
      location: 'Berlin, DE',
      availability: true,
    });
    expect(pub.taskList).toEqual({listings: [], jobs: {open: 0, settled: 0}});
    // The agent's matching location follows the profile.
    const [{location}] = (await db.execute(
      sql`SELECT location FROM agents WHERE public_id = ${p.publicId}`,
    )) as unknown as [{location: string}];
    expect(location).toBe('Berlin, DE');

    expect(
      (await put(p.token, {displayName: 'Robin', skills: Array.from({length: 21}, (_, i) => `skill-${i}`)}))
        .statusCode,
    ).toBe(422);
    expect((await put(p.token, {displayName: 'Robin', location: 'x'.repeat(121)})).statusCode).toBe(422);
    // Task list off: not shown.
    await put(p.token, {displayName: 'Robin', published: true, showTaskList: false});
    expect((await app.inject({method: 'GET', url: `/v1/profiles/${p.publicId}`})).json().taskList).toBeNull();
  });

  it('the directory filters by availability and by skill (profile skills or capabilities)', async () => {
    const a = await agent(app, 'pf-a', {capabilities: ['market-research']});
    const b = await agent(app, 'pf-b', {capabilities: ['risk-review']});
    await put(a.apiKey, {
      displayName: 'Avail A',
      published: true,
      availability: true,
      skills: ['photography'],
    });
    await put(b.apiKey, {displayName: 'Busy B', published: true, availability: false});
    const names = async (q: string) =>
      (
        (await app.inject({method: 'GET', url: `/v1/profiles${q}`})).json() as {
          profiles: {displayName: string}[];
        }
      ).profiles.map((x) => x.displayName);
    expect(await names('?available=true')).toEqual(['Avail A']);
    expect(await names('?available=false')).toEqual(['Busy B']);
    expect(await names('?skill=photography')).toEqual(['Avail A']);
    expect(await names('?skill=risk-review')).toEqual(['Busy B']); // a capability counts as a skill
    expect(await names('?skill=nothing')).toEqual([]);
  });
});

describe('matching', () => {
  it('match=me uses profile skills; a new listing alerts the available, verified people it matches, once', async () => {
    const client = await agent(app, 'pm-client');
    const match = await person(app, 'pm-match');
    const noAlerts = await person(app, 'pm-noalerts');
    const busy = await person(app, 'pm-busy');
    const elsewhere = await person(app, 'pm-elsewhere');
    const held = await person(app, 'pm-held');
    const on = {displayName: 'x', published: true, availability: true, alerts: true, skills: ['photography']};
    await put(match.token, {...on, location: 'Berlin'});
    await put(noAlerts.token, {...on, alerts: false, location: 'Berlin'});
    await put(busy.token, {...on, availability: false, location: 'Berlin'});
    await put(elsewhere.token, {...on, location: 'Paris'});
    await put(held.token, {...on, location: 'Berlin'});
    const [{id: heldId}] = (await db.execute(
      sql`SELECT id FROM agents WHERE public_id = ${held.publicId}`,
    )) as unknown as [{id: number}];
    await db.insert(accountStanding).values({agentId: heldId, standing: 'hold', reason: 'test'});

    const r = await postListing(client.apiKey);
    expect(r.statusCode, r.body).toBe(201);
    const listingId = (r.json() as {listingId: string}).listingId;
    expect(await kinds(match.token)).toEqual(['listing.match']);
    const ev = (
      (await app.inject({method: 'GET', url: '/v1/events', headers: bearer(match.token)})).json() as {
        events: {role: string; listingId: string; payload: Record<string, unknown>}[];
      }
    ).events[0]!;
    expect(ev).toMatchObject({
      role: 'match',
      listingId,
      payload: {listingId, title: 'Photograph three shop fronts', skills: ['photography']},
    });
    for (const t of [noAlerts.token, busy.token, elsewhere.token, held.token, client.apiKey])
      expect(await kinds(t)).toEqual([]);

    // A listing naming no skills alerts nobody; a replayed post alerts nobody twice.
    expect((await postListing(client.apiKey, {skills: []})).statusCode).toBe(201);
    expect(await kinds(match.token)).toEqual(['listing.match']);

    // match=me: the person's profile skill finds the listing (no capability needed).
    const board = (
      await app.inject({method: 'GET', url: '/v1/listings?match=me', headers: bearer(match.token)})
    ).json() as {
      listings: {listingId: string}[];
    };
    expect(board.listings.map((l) => l.listingId)).toContain(listingId);
    const far = (
      await app.inject({method: 'GET', url: '/v1/listings?match=me', headers: bearer(elsewhere.token)})
    ).json() as {
      listings: {listingId: string}[];
    };
    expect(far.listings.map((l) => l.listingId)).not.toContain(listingId);
  });
});
