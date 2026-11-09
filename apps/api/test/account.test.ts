import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, jobFiles, jobMessages, jobs, publicProfiles, type Db} from '@pactora/db';
import {MemoryObjectStore} from '@pactora/storage';
import {buildApp, EventBus} from '../src/app.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, person, purses, sessionOnly} from './helpers/people.js';

/**
 * GDPR (2026-11-09, migration 0029): GET /v1/me/export gives a person
 * everything off chain about them; DELETE /v1/me, confirmed by a nonce,
 * scrubs the personal data and keeps what the other party and the chain
 * need; refused while a job is open.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
const store = new MemoryObjectStore();

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
    liveEvents: false,
    draftSettleSweepMs: 0,
    listingExpirySweepMs: 0,
    sessionKeySweepMs: 0,
    retention: {intervalMs: 0},
    objectStore: store,
    submit: async () => ({txHash: 'unused'}),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  purses.clear();
  store.objects.clear();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, sessions, login_challenges, listings, applications, listing_slots, agent_events, agent_event_seq, public_profiles, job_files, job_messages, job_drafts, channel_links, webhooks, account_delete_challenges RESTART IDENTITY CASCADE`,
  );
});

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
let n = 0;
async function world(jobState: 'accepted' | 'settled') {
  const p = await person(app, `gd-p${++n}`, {capabilities: ['photography']});
  const other = await agent(app, `gd-a${n}`);
  await app.inject({
    method: 'PUT',
    url: '/v1/me/profile',
    headers: bearer(p.token),
    payload: {
      displayName: 'Robin Real',
      bio: 'I photograph shop fronts.',
      published: true,
      skills: ['photography'],
    },
  });
  const l = await app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: {...bearer(p.token), 'idempotency-key': `gd-listing-${n}`},
    payload: {
      title: 'Robin needs a translator',
      description: 'Twelve pages of German into English, legal register.',
      category: 'expertise',
      interactionMode: 'task',
      maxPriceBaseUnits: '40000',
      maxWorkers: 1,
      estimatedMinutes: 60,
      deadline: inDays(7),
      criteria: 'Faithful, legal register, delivered as a PDF.',
    },
  });
  expect(l.statusCode, l.body).toBe(201);
  const [{id: pid}] = (await db.execute(
    sql`SELECT id FROM agents WHERE public_id = ${p.publicId}`,
  )) as unknown as [{id: number}];
  const [j] = await db
    .insert(jobs)
    .values({
      chainId: 'near:sandbox',
      chainJobId: String(600 + n),
      clientAgentId: other.agentId,
      workerAgentId: Number(pid),
      path: 'escrow',
      amount: '20000',
      spec: {capability: 'photography'},
      specHash: 'ab'.repeat(32),
      state: jobState,
      resultHash: 'cd'.repeat(32),
      settledAt: jobState === 'settled' ? new Date() : null,
    })
    .returning({id: jobs.id, publicId: jobs.publicId});
  await db
    .insert(jobMessages)
    .values({jobId: j!.id, authorAgentId: Number(pid), body: 'Here is my first photo, more tomorrow.'});
  await store.put('evidence/x/one.png', new Uint8Array([1, 2, 3]), 'image/png');
  await db.insert(jobFiles).values({
    jobId: j!.id,
    uploaderAgentId: Number(pid),
    objectKey: 'evidence/x/one.png',
    sha256: 'ee'.repeat(32),
    mime: 'image/png',
    size: 3,
  });
  return {
    p,
    other,
    pid: Number(pid),
    jobId: j!.publicId,
    listingId: (l.json() as {listingId: string}).listingId,
  };
}

describe('GET /v1/me/export', () => {
  it('is a JSON file with every off-chain section about the account, and only mine', async () => {
    const {p, jobId, listingId} = await world('accepted');
    const r = await app.inject({method: 'GET', url: '/v1/me/export', headers: bearer(p.token)});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="pactora-export-.*\.json"$/);
    const e = r.json();
    expect(e.account).toBe(p.account);
    expect(e.person).toMatchObject({publicId: p.publicId});
    expect(e.profile).toMatchObject({displayName: 'Robin Real', bio: 'I photograph shop fronts.'});
    expect(e.capabilities).toEqual(['photography']);
    expect(e.listings.map((l: {listingId: string}) => l.listingId)).toEqual([listingId]);
    expect(e.jobs).toEqual([
      expect.objectContaining({jobId, role: 'worker', state: 'accepted', resultHash: 'cd'.repeat(32)}),
    ]);
    expect(e.jobs[0].spec).toBeUndefined(); // the client's words, not mine
    expect(e.messages).toEqual([
      expect.objectContaining({body: 'Here is my first photo, more tomorrow.', jobId}),
    ]);
    expect(e.files).toEqual([
      expect.objectContaining({sha256: 'ee'.repeat(32), url: expect.stringMatching(/^\/v1\/files\//)}),
    ]);
    expect(e.sessions).toEqual([expect.objectContaining({current: true})]);
    expect(e.kyc).toBeNull();
    expect(e.onChain).toMatch(/cannot be deleted/);
    expect(JSON.stringify(e)).not.toContain('ps_');
  });
});

describe('DELETE /v1/me', () => {
  const challenge = (token: string) =>
    app.inject({method: 'POST', url: '/v1/me/delete/challenge', headers: bearer(token)});
  const del = (token: string, nonce: string) =>
    app.inject({method: 'DELETE', url: '/v1/me', headers: bearer(token), payload: {nonce}});

  it('is refused while a job is open, naming the jobs; and without a live nonce', async () => {
    const {p, jobId} = await world('accepted');
    expect((await del(p.token, 'a'.repeat(64))).statusCode).toBe(401);
    const nonce = (await challenge(p.token)).json().nonce as string;
    const r = await del(p.token, nonce);
    expect(r.statusCode).toBe(409);
    expect(r.json().openJobs).toEqual([jobId]);
    expect(r.json().detail).toMatch(/still open/);
    // The nonce was spent by the refused attempt; a new one is needed.
    expect((await del(p.token, nonce)).statusCode).toBe(401);
  });

  it('scrubs the personal data, keeps the job row and hashes, cancels listings and ends every session', async () => {
    const {p, other, pid, jobId, listingId} = await world('settled');
    const second = {token: await sessionOnly(app, `gd-p${n}`)}; // the same account, another session
    const nonce = (await challenge(p.token)).json().nonce as string;
    const r = await del(p.token, nonce);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({deleted: true, account: p.account});
    expect(r.json().scrubbed).toMatchObject({profile: 1, messages: 1, files: 1, listingsCancelled: 1});

    // Personal data gone.
    const [a] = (await db.execute(
      sql`SELECT name, description, location, deleted_at FROM agents WHERE id = ${pid}`,
    )) as unknown as [{name: string; description: string | null; location: string; deleted_at: Date | null}];
    expect(a).toMatchObject({name: 'deleted account', description: null, location: ''});
    expect(a.deleted_at).not.toBeNull();
    expect(await db.select().from(publicProfiles)).toEqual([]);
    expect(store.objects.size).toBe(0);
    const [f] = await db.select().from(jobFiles);
    expect(f!.objectKey).toMatch(/^deleted\//);
    expect(f!.sha256).toBe('ee'.repeat(32)); // the hash stays
    const [m] = await db.select().from(jobMessages);
    expect(m!.body).toBe('[deleted by the account owner]');
    const [{status}] = (await db.execute(
      sql`SELECT status FROM listings WHERE public_id = ${listingId}`,
    )) as unknown as [{status: string}];
    expect(status).toBe('cancelled');
    // The other party's history is intact.
    const job = (await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`})).json();
    expect(job).toMatchObject({jobId, state: 'settled', resultHash: 'cd'.repeat(32)});
    expect(
      (await app.inject({method: 'GET', url: `/v1/jobs?role=client`, headers: bearer(other.apiKey)})).json()
        .count,
    ).toBe(1);
    // Every session of the account ended, with the reason.
    for (const t of [p.token, second.token]) {
      const me = await app.inject({method: 'GET', url: '/v1/session', headers: bearer(t)});
      expect(me.statusCode).toBe(401);
      expect(me.json().detail).toMatch(/deleted/);
    }
  });
});
