import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {eq, sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, webhookDeliveries, webhooks, type Db} from '@pactora/db';
import {parseSecretKey} from '@pactora/service';
import {buildApp, EventBus} from '../src/app.js';
import {sweepExpiredListings} from '../src/routes/listings.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, purses} from './helpers/people.js';

/**
 * Listing and application events in the per-agent feed (2026-11-09):
 * a bid, a selection, a rejection, a close, a reopen, a cancel, a claim and
 * an expiry reach the feed, notifications and webhooks exactly like job
 * events, exactly once. Before this, routes/listings.ts published nothing.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
let jobSeq = 500;

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
    webhookSecretKey: parseSecretKey('6b'.repeat(32)),
    listingExpirySweepMs: 0,
    submit: async () => ({
      txHash: '4yJxShz8HXfTyoTMXP9rQSoQUZE8uihkDmnpRrynZeZz',
      chainJobId: String(++jobSeq),
    }),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  purses.clear();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, listings, applications, listing_slots, agent_events, agent_event_seq, webhooks, webhook_deliveries RESTART IDENTITY CASCADE`,
  );
});

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
let keySeq = 0;
async function postListing(token: string, over: Record<string, unknown> = {}) {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: {...bearer(token), 'idempotency-key': `lev-key-${++keySeq}`},
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
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as {listingId: string};
}
const apply = async (token: string, listingId: string, price = '30000') => {
  const r = await app.inject({
    method: 'POST',
    url: `/v1/listings/${listingId}/applications`,
    headers: bearer(token),
    payload: {action: 'apply', priceBaseUnits: price, proposal: 'I can do this today, with a good camera.'},
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as {applicationId: string};
};
const decide = (token: string, listingId: string, applicationId: string, action: 'select' | 'reject') =>
  app.inject({
    method: 'POST',
    url: `/v1/listings/${listingId}/decide`,
    headers: bearer(token),
    payload: {applicationId, action, reason: 'Your proposal fits the brief well enough.'},
  });
const feed = async (token: string) =>
  (
    (await app.inject({method: 'GET', url: '/v1/events', headers: bearer(token)})).json() as {
      events: {
        seq: number;
        kind: string;
        role: string;
        jobId: string | null;
        listingId: string | null;
        payload: Record<string, unknown>;
      }[];
    }
  ).events;
const kinds = async (token: string) => (await feed(token)).map((e) => e.kind);

describe('listing events in the feed', () => {
  it('a bid reaches the client; selecting and rejecting reach the applicants, with the listing and job ids', async () => {
    const client = await agent(app, 'lev-client');
    const w1 = await agent(app, 'lev-w1', {capabilities: ['photography']});
    const w2 = await agent(app, 'lev-w2', {capabilities: ['photography']});
    const hook = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: bearer(client.apiKey),
      payload: {url: 'https://93.184.216.34/hook'},
    });
    expect(hook.statusCode, hook.body).toBe(201);

    const {listingId} = await postListing(client.apiKey);
    const a1 = await apply(w1.apiKey, listingId, '30000');
    const a2 = await apply(w2.apiKey, listingId, '35000');

    const bids = await feed(client.apiKey);
    expect(bids.map((e) => e.kind)).toEqual(['listing.bid', 'listing.bid']);
    expect(bids[0]).toMatchObject({
      seq: 1,
      role: 'client',
      jobId: null,
      listingId,
      payload: {listingId, applicationId: a1.applicationId, priceBaseUnits: '30000'},
    });
    expect((bids[0]!.payload['applicant'] as {name: string}).name).toBe('lev-w1');
    // Queued for the client's webhook in the same transaction.
    const [h] = await db.select().from(webhooks);
    const queued = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, h!.id));
    expect(queued.map((d) => d.seq)).toEqual([1, 2]);

    const sel = await decide(client.apiKey, listingId, a1.applicationId, 'select');
    expect(sel.statusCode, sel.body).toBe(200);
    const jobId = (sel.json() as {job: {jobId: string}}).job.jobId;
    // Selecting the one slot fills the listing: the other bid is set aside.
    // The hire's own job.created comes first (the job_events trigger), then the listing event.
    const w1Feed = await feed(w1.apiKey);
    expect(w1Feed.map((e) => e.kind)).toEqual(['job.created', 'application.selected']);
    expect(w1Feed[1]).toMatchObject({
      role: 'applicant',
      listingId,
      payload: {jobId, applicationId: a1.applicationId},
    });
    expect(await kinds(w2.apiKey)).toEqual(['listing.closed']);
    expect((await feed(w2.apiKey))[0]!.payload).toMatchObject({
      applicationId: a2.applicationId,
      reason: 'filled',
    });

    // A replayed decision writes nothing twice.
    expect((await decide(client.apiKey, listingId, a1.applicationId, 'select')).statusCode).toBe(200);
    expect(await kinds(w1.apiKey)).toEqual(['job.created', 'application.selected']);

    const notes = (
      await app.inject({method: 'GET', url: '/v1/notifications', headers: bearer(w2.apiKey)})
    ).json() as {
      unread: number;
      notifications: {kind: string; listingId: string | null; jobId: string | null}[];
    };
    expect(notes.unread).toBe(1);
    expect(notes.notifications[0]).toMatchObject({kind: 'listing.closed', listingId, jobId: null});
  });

  it('reject, close, reopen and cancel each tell exactly the bidders they concern, once', async () => {
    const client = await agent(app, 'lev2-client');
    const w1 = await agent(app, 'lev2-w1', {capabilities: ['photography']});
    const w2 = await agent(app, 'lev2-w2', {capabilities: ['photography']});
    const {listingId} = await postListing(client.apiKey, {maxWorkers: 3});
    const a1 = await apply(w1.apiKey, listingId);
    await apply(w2.apiKey, listingId);

    expect((await decide(client.apiKey, listingId, a1.applicationId, 'reject')).statusCode).toBe(200);
    expect(await kinds(w1.apiKey)).toEqual(['application.rejected']);

    const act = (what: string) =>
      app.inject({method: 'POST', url: `/v1/listings/${listingId}/${what}`, headers: bearer(client.apiKey)});
    expect((await act('close')).statusCode).toBe(200);
    expect((await act('close')).statusCode).toBe(200); // a replay
    expect(await kinds(w2.apiKey)).toEqual(['listing.closed']);
    expect(await kinds(w1.apiKey)).toEqual(['application.rejected']); // not set aside: it was rejected
    expect((await act('reopen')).statusCode).toBe(200);
    expect(await kinds(w2.apiKey)).toEqual(['listing.closed', 'listing.reopened']);
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/listings/${listingId}`,
      headers: bearer(client.apiKey),
    });
    expect(del.statusCode, del.body).toBe(200);
    expect(await kinds(w2.apiKey)).toEqual(['listing.closed', 'listing.reopened', 'listing.cancelled']);
    // The client's own feed has the two bids and nothing it did itself.
    expect(await kinds(client.apiKey)).toEqual(['listing.bid', 'listing.bid']);
  });

  it('an instant claim tells the client, and an expired listing tells everyone once per sweep', async () => {
    const client = await agent(app, 'lev3-client');
    const w1 = await agent(app, 'lev3-w1', {capabilities: ['photography']});
    const w2 = await agent(app, 'lev3-w2', {capabilities: ['photography']});
    const instant = await postListing(client.apiKey, {hiringMode: 'instant', maxWorkers: 2});
    const claim = await app.inject({
      method: 'POST',
      url: `/v1/listings/${instant.listingId}/claim`,
      headers: bearer(w1.apiKey),
      payload: {},
    });
    expect(claim.statusCode, claim.body).toBe(201);
    expect(await kinds(client.apiKey)).toEqual(['job.created', 'listing.claimed']);
    expect(await kinds(w1.apiKey)).toEqual(['job.created', 'application.selected']);

    const open = await postListing(client.apiKey, {maxWorkers: 2});
    await apply(w2.apiKey, open.listingId);
    await db.execute(
      sql`UPDATE listings SET deadline = now() - interval '1 minute' WHERE public_id = ${open.listingId}`,
    );
    expect(await sweepExpiredListings(db)).toBe(2);
    expect(await sweepExpiredListings(db)).toBe(0);
    expect(await kinds(client.apiKey)).toEqual([
      'job.created',
      'listing.claimed',
      'listing.bid',
      'listing.expired',
    ]);
    expect(await kinds(w2.apiKey)).toEqual(['listing.expired']);
    const last = (await feed(client.apiKey)).at(-1)!;
    expect(last).toMatchObject({
      listingId: open.listingId,
      jobId: null,
      payload: {title: 'Photograph three shop fronts'},
    });
  });
});
