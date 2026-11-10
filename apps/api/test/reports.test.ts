import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, jobMessages, jobs, standingOf, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, person, purses} from './helpers/people.js';

/**
 * Reports and blocks (2026-11-09, migration 0028): anyone reports a listing,
 * person, agent or message; reviewers hide, warn, block or dismiss; a block
 * writes standing like the sanctions flow; hidden listings leave the board.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
let reviewers: string[] = [];

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
    submit: async () => ({txHash: 'unused'}),
    get complianceReviewers() {
      return reviewers;
    },
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  reviewers = [];
  purses.clear();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, sessions, login_challenges, listings, applications, listing_slots, agent_events, agent_event_seq, public_profiles, account_standing, reports, job_messages RESTART IDENTITY CASCADE`,
  );
});

let n = 0;
let ip = 0;
const nextIp = () => `10.77.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
async function postListing(token: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: {...bearer(token), 'idempotency-key': `rep-key-${++n}`},
    payload: {
      title: 'Photograph three shop fronts',
      description: 'Take clear daytime photos of three shop fronts on the high street.',
      category: 'physical',
      interactionMode: 'capture',
      skills: ['photography'],
      maxPriceBaseUnits: '40000',
      maxWorkers: 1,
      estimatedMinutes: 60,
      deadline: inDays(7),
      criteria: 'Three sharp photos, each showing the full shop front and its sign.',
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as {listingId: string}).listingId;
}
const report = (token: string, payload: Record<string, unknown>, remoteAddress = nextIp()) =>
  app.inject({method: 'POST', url: '/v1/reports', headers: bearer(token), payload, remoteAddress});
async function reviewer() {
  const p = await person(app, `rep-reviewer${++n}`);
  reviewers.push(p.account);
  return p;
}
const resolve = (token: string, id: string, payload: Record<string, unknown>) =>
  app.inject({method: 'POST', url: `/v1/admin/reports/${id}/resolve`, headers: bearer(token), payload});
const queue = async (token: string, status = 'open') =>
  (
    await app.inject({method: 'GET', url: `/v1/admin/reports?status=${status}`, headers: bearer(token)})
  ).json() as {
    reports: {reportId: string; status: string; action: string | null}[];
  };

describe('reports', () => {
  it('a report is filed once per target, validated, and only reviewers see the queue', async () => {
    const client = await agent(app, 'rep-client');
    const listingId = await postListing(client.apiKey);
    const reporter = await person(app, 'rep-reporter');
    const r = await report(reporter.token, {
      targetType: 'listing',
      targetId: listingId,
      reason: 'scam',
      details: 'Asks for payment off platform.',
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({status: 'open', targetType: 'listing', reason: 'scam'});
    const again = await report(reporter.token, {targetType: 'listing', targetId: listingId, reason: 'spam'});
    expect(again.statusCode).toBe(409);
    expect(
      (await report(reporter.token, {targetType: 'listing', targetId: listingId, reason: 'rude'})).statusCode,
    ).toBe(422);
    expect(
      (
        await report(reporter.token, {
          targetType: 'listing',
          targetId: listingId,
          reason: 'spam',
          details: 'x'.repeat(1001),
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await report(reporter.token, {
          targetType: 'listing',
          targetId: '00000000-0000-4000-8000-000000000000',
          reason: 'spam',
        })
      ).statusCode,
    ).toBe(404);
    // Not your own listing.
    expect(
      (await report(client.apiKey, {targetType: 'listing', targetId: listingId, reason: 'spam'})).statusCode,
    ).toBe(409);

    expect(
      (await app.inject({method: 'GET', url: '/v1/admin/reports', headers: bearer(reporter.token)}))
        .statusCode,
    ).toBe(403);
    const rev = await reviewer();
    const q = await queue(rev.token);
    expect(q.reports).toHaveLength(1);
    expect(q.reports[0]).toMatchObject({reportId: r.json().reportId, status: 'open'});
  });

  it('is limited to 10 an hour per client address', async () => {
    const reporter = await person(app, 'rep-flood');
    const addr = '10.78.0.1';
    const targets: string[] = [];
    for (let i = 0; i < 11; i++) targets.push((await agent(app, `rep-t${++n}`)).agentId.toString());
    const codes: number[] = [];
    for (const t of targets)
      codes.push(
        (await report(reporter.token, {targetType: 'agent', targetId: t, reason: 'spam'}, addr)).statusCode,
      );
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('hide takes a listing off the public board (the owner still sees it) and replaces a message', async () => {
    const client = await agent(app, 'rep-hide-client');
    const listingId = await postListing(client.apiKey);
    const reporter = await person(app, 'rep-hide-reporter');
    const rep = (
      await report(reporter.token, {targetType: 'listing', targetId: listingId, reason: 'spam'})
    ).json().reportId;
    const rev = await reviewer();
    const done = await resolve(rev.token, rep, {action: 'hide', note: 'Duplicate of three other listings.'});
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({status: 'resolved', action: 'hide'});
    expect((await resolve(rev.token, rep, {action: 'none', note: 'again'})).statusCode).toBe(409);

    const board = (await app.inject({method: 'GET', url: '/v1/listings'})).json() as {listings: unknown[]};
    expect(board.listings).toHaveLength(0);
    expect((await app.inject({method: 'GET', url: `/v1/listings/${listingId}`})).statusCode).toBe(404);
    const mine = (
      await app.inject({method: 'GET', url: '/v1/listings?mine=true', headers: bearer(client.apiKey)})
    ).json() as {
      listings: {hidden: boolean}[];
    };
    expect(mine.listings).toEqual([expect.objectContaining({hidden: true})]);
    expect(
      (await app.inject({method: 'GET', url: `/v1/listings/${listingId}`, headers: bearer(client.apiKey)}))
        .statusCode,
    ).toBe(200);
    expect((await queue(rev.token, 'resolved')).reports).toHaveLength(1);

    // A message: its words are replaced for both parties.
    const w = await agent(app, 'rep-msg-worker');
    const [j] = await db
      .insert(jobs)
      .values({
        chainId: 'near:sandbox',
        chainJobId: '901',
        clientAgentId: client.agentId,
        workerAgentId: w.agentId,
        path: 'escrow',
        amount: '20000',
        spec: {capability: 'market-research'},
        specHash: 'ab'.repeat(32),
        state: 'accepted',
      })
      .returning({id: jobs.id, publicId: jobs.publicId});
    const [m] = await db
      .insert(jobMessages)
      .values({jobId: j!.id, authorAgentId: w.agentId, body: 'Send the money to my cousin instead.'})
      .returning({publicId: jobMessages.publicId});
    const mr = (
      await report(client.apiKey, {targetType: 'message', targetId: m!.publicId, reason: 'scam'})
    ).json().reportId;
    expect(
      (await resolve(rev.token, mr, {action: 'hide', note: 'Off-platform payment request.'})).statusCode,
    ).toBe(200);
    const convo = (
      await app.inject({method: 'GET', url: `/v1/jobs/${j!.publicId}/messages`, headers: bearer(w.apiKey)})
    ).json() as {
      messages: {body: string}[];
    };
    expect(convo.messages[0]!.body).toBe('[hidden by moderation]');
  });

  it('warn writes an account.warned feed event; block writes standing like the sanctions flow and is audited', async () => {
    const target = await person(app, 'rep-target', {capabilities: ['photography']});
    const reporter = await agent(app, 'rep-warn-reporter');
    const rev = await reviewer();
    const r1 = (
      await report(reporter.apiKey, {targetType: 'person', targetId: target.publicId, reason: 'abuse'})
    ).json().reportId;
    expect(
      (await resolve(rev.token, r1, {action: 'warn', note: 'First warning: keep it civil.'})).statusCode,
    ).toBe(200);
    const feed = (
      await app.inject({method: 'GET', url: '/v1/events', headers: bearer(target.token)})
    ).json() as {
      events: {kind: string; role: string; jobId: null; listingId: null; payload: {note: string}}[];
    };
    expect(feed.events).toEqual([
      expect.objectContaining({kind: 'account.warned', role: 'account', jobId: null, listingId: null}),
    ]);
    expect(feed.events[0]!.payload.note).toBe('First warning: keep it civil.');

    const other = await agent(app, 'rep-block-reporter');
    const r2 = (
      await report(other.apiKey, {
        targetType: 'person',
        targetId: target.publicId,
        reason: 'scam',
        details: 'Took payment, no work.',
      })
    ).json().reportId;
    const [{id}] = (await db.execute(
      sql`SELECT id FROM agents WHERE public_id = ${target.publicId}`,
    )) as unknown as [{id: number}];
    expect(await standingOf(db, Number(id))).toBe('clear');
    expect(
      (await resolve(rev.token, r2, {action: 'block', note: 'Confirmed scam pattern.'})).statusCode,
    ).toBe(200);
    expect(await standingOf(db, Number(id))).toBe('blocked');
    const trail = (await db.execute(
      sql`SELECT action FROM compliance_audit WHERE agent_id = ${Number(id)} ORDER BY id`,
    )) as unknown as {
      action: string;
    }[];
    expect(trail.map((t) => t.action)).toEqual(
      expect.arrayContaining(['report.warn', 'standing.blocked', 'report.block']),
    );
    // Blocked: cannot apply for work (the same gate as a confirmed sanctions match).
    const client = await agent(app, 'rep-block-client');
    const listingId = await postListing(client.apiKey);
    const apply = await app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/applications`,
      headers: bearer(target.token),
      payload: {
        action: 'apply',
        priceBaseUnits: '30000',
        proposal: 'I can do this today, with a good camera.',
      },
    });
    expect(apply.statusCode).toBe(403);
  });

  // Found by the live browser suite (e2e-live, 2026-11-10): a reviewer blocked
  // the poster of a reported listing, and the listing stayed on the board,
  // still asking for bids the blocked account can never hire.
  it("block takes the blocked account's open listings off the public board; its owner still lists them", async () => {
    const poster = await agent(app, 'rep-board-poster');
    const listingId = await postListing(poster.apiKey);
    const bystander = await agent(app, 'rep-board-bystander');
    const otherId = await postListing(bystander.apiKey);
    const board = async () =>
      (
        (await app.inject({method: 'GET', url: '/v1/listings'})).json() as {listings: {listingId: string}[]}
      ).listings
        .map((l) => l.listingId)
        .sort();
    expect(await board()).toEqual([listingId, otherId].sort());

    const reporter = await person(app, 'rep-board-reporter');
    const rep = (
      await report(reporter.token, {targetType: 'listing', targetId: listingId, reason: 'scam'})
    ).json().reportId;
    const rev = await reviewer();
    expect(
      (await resolve(rev.token, rep, {action: 'block', note: 'Fee-first scam, confirmed.'})).statusCode,
    ).toBe(200);

    expect(await board()).toEqual([otherId]);
    const mine = (
      await app.inject({method: 'GET', url: '/v1/listings?mine=true', headers: bearer(poster.apiKey)})
    ).json() as {listings: {listingId: string}[]};
    expect(mine.listings.map((l) => l.listingId)).toEqual([listingId]);
  });
});
