import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, jobEvents, jobs, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {recordEvent} from '../src/routes/jobs.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, person, purses} from './helpers/people.js';

/**
 * The UI audit's read model (2026-11-09): notifications fold the chain's
 * echo into the API's event and skip the reader's own actions, mark one item
 * read, and name the job; jobs carry a title and their listing; a worker
 * lists their bids; the home page has its figures, people counted too.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
const bus = new EventBus();
beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus,
    readBudget: fakeReadBudget,
    rateLimitPerMinute: 100_000,
    liveEvents: false,
    draftSettleSweepMs: 0,
    listingExpirySweepMs: 0,
    sessionKeySweepMs: 0,
    retention: {intervalMs: 0},
    submit: async () => ({txHash: 'unused'}),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  purses.clear();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, sessions, login_challenges, listings, applications, listing_slots, agent_events, agent_event_seq, agent_event_reads, agent_event_item_reads RESTART IDENTITY CASCADE`,
  );
});

let n = 0;
async function listingJob(clientId: number, workerId: number) {
  const [j] = await db
    .insert(jobs)
    .values({
      chainId: 'near:sandbox',
      chainJobId: String(700 + ++n),
      clientAgentId: clientId,
      workerAgentId: workerId,
      path: 'escrow',
      amount: '20000',
      spec: {
        capability: 'photography',
        input: {
          listing: {listingId: '11111111-1111-4111-8111-111111111111', title: 'Photograph three shop fronts'},
        },
      },
      specHash: 'ab'.repeat(32),
      state: 'created',
    })
    .returning();
  return j!;
}

describe('notifications', () => {
  it('fold the chain echo and the reader’s own action, name the job, and mark one item read', async () => {
    const c = await agent(app, `rm-c${++n}`);
    const w = await person(app, `rm-w${n}`);
    const [{id: wid}] = (await db.execute(
      sql`SELECT id FROM agents WHERE public_id = ${w.publicId}`,
    )) as unknown as [{id: number}];
    const job = await listingJob(c.agentId, Number(wid));
    await recordEvent(db, bus, job.id, 'near:sandbox', 'job.created', {jobId: job.publicId}); // the client's act
    await db.insert(jobEvents).values({
      chainId: 'near:sandbox',
      jobId: job.id,
      kind: 'created',
      txHash: 'TX1',
      receiptId: 'R1',
      logIndex: 0,
    }); // its echo
    await recordEvent(db, bus, job.id, 'near:sandbox', 'job.accepted', {jobId: job.publicId}); // the worker's own act
    await recordEvent(db, bus, job.id, 'near:sandbox', 'job.message', {from: 'client'});

    const list = async (q = '') =>
      (await app.inject({url: `/v1/notifications${q}`, headers: bearer(w.token)})).json() as {
        unread: number;
        notifications: {
          seq: number;
          kind: string;
          actor: string;
          confirmation: boolean;
          jobTitle: string;
          listingId: string;
          read: boolean;
        }[];
      };
    const folded = await list();
    expect(folded.notifications.map((x) => x.kind)).toEqual(['job.message', 'job.created']);
    expect(folded.notifications[1]).toMatchObject({
      actor: 'counterparty',
      confirmation: false,
      jobTitle: 'Photograph three shop fronts',
      listingId: '11111111-1111-4111-8111-111111111111',
    });
    const all = await list('?fold=false');
    expect(all.notifications.map((x) => [x.kind, x.actor, x.confirmation])).toEqual([
      ['job.message', 'counterparty', false],
      ['job.accepted', 'me', false],
      ['created', 'system', true],
      ['job.created', 'counterparty', false],
    ]);

    expect(folded.unread).toBe(4);
    const one = await app.inject({
      method: 'POST',
      url: `/v1/notifications/${folded.notifications[0]!.seq}/read`,
      headers: bearer(w.token),
    });
    expect(one.json()).toEqual({seq: folded.notifications[0]!.seq, read: true});
    const after = await list();
    expect(after.unread).toBe(3);
    expect(after.notifications.map((x) => x.read)).toEqual([true, false]);
    expect(
      (await app.inject({method: 'POST', url: '/v1/notifications/9999/read', headers: bearer(w.token)}))
        .statusCode,
    ).toBe(404);
  });
});

describe('jobs, bids and the home page', () => {
  it('a job carries its title and listing; my bids list across listings; stats count people too', async () => {
    const c = await agent(app, `rm2-c${++n}`);
    const w = await person(app, `rm2-w${n}`, {capabilities: ['photography']});
    const [{id: wid}] = (await db.execute(
      sql`SELECT id FROM agents WHERE public_id = ${w.publicId}`,
    )) as unknown as [{id: number}];
    const job = await listingJob(c.agentId, Number(wid));
    const detail = (await app.inject({url: `/v1/jobs/${job.publicId}`})).json();
    expect(detail).toMatchObject({
      title: 'Photograph three shop fronts',
      listingId: '11111111-1111-4111-8111-111111111111',
      listingTitle: 'Photograph three shop fronts',
    });
    const listed = (await app.inject({url: '/v1/jobs?role=client', headers: bearer(c.apiKey)})).json();
    expect(listed.jobs[0]).toMatchObject({title: 'Photograph three shop fronts'});

    const l = await app.inject({
      method: 'POST',
      url: '/v1/listings',
      headers: {...bearer(c.apiKey), 'idempotency-key': `rm2-listing-${n}`},
      payload: {
        title: 'Translate a lease agreement',
        description: 'Twelve pages of German into English, legal register.',
        category: 'expertise',
        interactionMode: 'task',
        maxPriceBaseUnits: '40000',
        maxWorkers: 1,
        estimatedMinutes: 60,
        deadline: new Date(Date.now() + 86_400_000).toISOString(),
        criteria: 'Faithful, legal register, delivered as a PDF.',
      },
    });
    const listingId = (l.json() as {listingId: string}).listingId;
    await app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/applications`,
      headers: bearer(w.token),
      payload: {
        action: 'apply',
        priceBaseUnits: '30000',
        proposal: 'Native German speaker, legal background.',
      },
    });
    const bids = (await app.inject({url: '/v1/me/applications', headers: bearer(w.token)})).json();
    expect(bids).toMatchObject({count: 1, nextCursor: null});
    expect(bids.applications[0]).toMatchObject({
      status: 'pending',
      priceBaseUnits: '30000',
      listing: {listingId, title: 'Translate a lease agreement', status: 'open'},
    });

    // Settled on chain: the indexer's event with its transaction.
    await db
      .update(jobs)
      .set({state: 'settled', settledAt: new Date()})
      .where(sql`id = ${job.id}`);
    await db.insert(jobEvents).values({
      chainId: 'near:sandbox',
      jobId: job.id,
      kind: 'settled',
      txHash: 'TX9',
      receiptId: 'R9',
      logIndex: 0,
    });
    const stats = (await app.inject({url: '/v1/stats'})).json();
    expect(stats).toMatchObject({
      jobsSettledOnChain: 1,
      volumeSettledBaseUnits: '20000',
      agentsWithRecord: 1,
      peopleWithRecord: 1,
      participantsWithRecord: 2,
      agents: 1,
      people: 1,
      openListings: 1,
    });
  });
});
