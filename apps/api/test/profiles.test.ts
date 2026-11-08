import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {eq, sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {agents, closeDb, createDb, jobEvents, jobs, partyReviews, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {hideReview} from '../src/routes/profiles.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, fakeReadTxEvents, person} from './helpers/people.js';

/** docs/26 F16, F17: public profiles, the directory, and blind two-way reviews. */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;

beforeAll(async () => {
  db = createDb(DB_URL, {max: 10});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    readBudget: fakeReadBudget,
    readTxEvents: fakeReadTxEvents,
    rateLimitPerMinute: 100_000,
    liveEvents: false,
    draftSettleSweepMs: 0,
    submit: async () => ({txHash: 'unused'}),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, token_transfers, registration_challenges, sessions, login_challenges, listings, applications, listing_slots, person_actions, agent_events, agent_event_seq, public_profiles, party_reviews RESTART IDENTITY CASCADE`,
  );
});

let n = 0;
const DAY = 86_400_000;

/** A job between two agents, settled `daysAgo` days ago — on chain (an indexer event) unless `chain: false`. */
async function settledJob(
  clientId: number,
  workerId: number,
  opts: {daysAgo?: number; chain?: boolean; state?: string} = {},
) {
  const settledAt = new Date(Date.now() - (opts.daysAgo ?? 0) * DAY - 1000);
  const [j] = await db
    .insert(jobs)
    .values({
      chainId: 'near:sandbox',
      clientAgentId: clientId,
      workerAgentId: workerId,
      path: 'escrow',
      amount: '20000',
      spec: {capability: 'market-research'},
      specHash: 'ab'.repeat(32),
      state: (opts.state ?? 'settled') as 'settled',
      settledAt: (opts.state ?? 'settled') === 'settled' ? settledAt : null,
    })
    .returning({id: jobs.id, publicId: jobs.publicId});
  if (opts.chain !== false) {
    await db.insert(jobEvents).values({
      chainId: 'near:sandbox',
      jobId: j!.id,
      kind: 'settled',
      txHash: `TX${++n}`,
      occurredAt: settledAt,
    });
  }
  return j!;
}

const put = (token: string, payload: Record<string, unknown>) =>
  app.inject({method: 'PUT', url: '/v1/me/profile', headers: bearer(token), payload});
const review = (token: string, jobId: string, payload: Record<string, unknown>) =>
  app.inject({method: 'POST', url: `/v1/jobs/${jobId}/party-reviews`, headers: bearer(token), payload});
const profileOf = async (publicId: string) => app.inject({method: 'GET', url: `/v1/profiles/${publicId}`});
const publicIdOf = async (agentId: number) =>
  (await db.query.agents.findFirst({where: eq(agents.id, agentId)}))!.publicId;

describe('profiles', () => {
  it('nothing is public until published; the account shows only by choice', async () => {
    const p = await person(app, `pp${++n}`);
    const before = (
      await app.inject({method: 'GET', url: '/v1/me/profile', headers: bearer(p.token)})
    ).json();
    expect(before).toMatchObject({exists: false, published: false, displayName: `pp${n}`});

    expect((await put(p.token, {displayName: 'Priya', headline: 'Photos in Pune'})).statusCode).toBe(200);
    expect((await profileOf(p.publicId)).statusCode).toBe(404);
    expect((await app.inject({method: 'GET', url: '/v1/profiles'})).json().total).toBe(0);

    await put(p.token, {displayName: 'Priya', headline: 'Photos in Pune', published: true});
    const shown = (await profileOf(p.publicId)).json();
    expect(shown).toMatchObject({
      displayName: 'Priya',
      kind: 'person',
      account: null,
      rating: {average: null, count: 0},
    });

    await put(p.token, {displayName: 'Priya', published: true, showAccount: true});
    expect((await profileOf(p.publicId)).json().account).toBe(p.account);

    await put(p.token, {displayName: 'Priya', published: false});
    expect((await profileOf(p.publicId)).statusCode).toBe(404);
  });

  it('keeps the first publish time across edits, and validates every field', async () => {
    const a = await agent(app, `pa${++n}`);
    await put(a.apiKey, {displayName: 'ResearchBot', published: true});
    const first = (await profileOf(await publicIdOf(a.agentId))).json().publishedAt;
    await new Promise((r) => setTimeout(r, 20));
    await put(a.apiKey, {displayName: 'ResearchBot 2', published: true});
    const again = (await profileOf(await publicIdOf(a.agentId))).json();
    expect(again.publishedAt).toBe(first);
    expect(again.displayName).toBe('ResearchBot 2');
    expect(again.chainAgentId).toBe(a.chainAgentId);

    for (const bad of [
      {displayName: '   '},
      {displayName: 'x'.repeat(61)},
      {displayName: 'ok', bio: 'x'.repeat(2001)},
      {displayName: 'ok', headline: 'x'.repeat(141)},
    ]) {
      expect((await put(a.apiKey, bad)).statusCode, JSON.stringify(bad).slice(0, 40)).toBe(422);
    }
    expect(
      (await app.inject({method: 'PUT', url: '/v1/me/profile', payload: {displayName: 'x'}})).statusCode,
    ).toBe(401);
  });

  it('the directory searches (wildcards literal), filters by kind, sorts and pages by 20', async () => {
    const made: {token: string; name: string}[] = [];
    for (let i = 0; i < 23; i++) {
      const a = await agent(app, `dir${++n}`);
      made.push({token: a.apiKey, name: `Agent ${String(i).padStart(2, '0')}`});
      await put(a.apiKey, {
        displayName: `Agent ${String(i).padStart(2, '0')}`,
        published: true,
        headline: i === 7 ? '100% reliable' : '',
      });
    }
    const p = await person(app, `dirp${++n}`);
    await put(p.token, {displayName: 'Zoe Person', published: true});

    const page1 = (await app.inject({method: 'GET', url: '/v1/profiles?sort=name'})).json();
    expect(page1.total).toBe(24);
    expect(page1.profiles).toHaveLength(20);
    expect(page1.profiles[0].displayName).toBe('Agent 00');
    const page2 = (await app.inject({method: 'GET', url: '/v1/profiles?sort=name&page=2'})).json();
    expect(page2.profiles.map((x: {displayName: string}) => x.displayName).at(-1)).toBe('Zoe Person');

    const people = (await app.inject({method: 'GET', url: '/v1/profiles?kind=person'})).json();
    expect(people.profiles.map((x: {displayName: string}) => x.displayName)).toEqual(['Zoe Person']);
    const pct = (await app.inject({method: 'GET', url: '/v1/profiles?q=100%25'})).json();
    expect(pct.profiles.map((x: {displayName: string}) => x.displayName)).toEqual(['Agent 07']);
    // "%" alone is a literal: it matches only text containing a percent sign.
    expect((await app.inject({method: 'GET', url: '/v1/profiles?q=%25'})).json().total).toBe(1);
    expect((await app.inject({method: 'GET', url: '/v1/profiles?q=_'})).json().total).toBe(0);
    const recent = (await app.inject({method: 'GET', url: '/v1/profiles?sort=recent'})).json();
    expect(recent.profiles[0].displayName).toBe('Zoe Person');
    expect((await app.inject({method: 'GET', url: '/v1/profiles?sort=best'})).statusCode).toBe(422);
  });
});

describe('two-way reviews', () => {
  async function pair() {
    const c = await agent(app, `rc${++n}`);
    const w = await agent(app, `rw${n}`);
    for (const x of [c, w]) await put(x.apiKey, {displayName: `Name ${x.agentId}`, published: true});
    return {c, w, cPublic: await publicIdOf(c.agentId), wPublic: await publicIdOf(w.agentId)};
  }

  it('is blind until both are in, then both show and count', async () => {
    const {c, w, wPublic, cPublic} = await pair();
    const job = await settledJob(c.agentId, w.agentId);
    const r1 = await review(c.apiKey, job.publicId, {rating: 5, body: 'Fast, careful, exactly as asked.'});
    expect(r1.statusCode, r1.body).toBe(201);

    // The worker's profile does not show it yet; the worker knows only that one exists.
    expect((await profileOf(wPublic)).json().rating).toEqual({average: null, count: 0});
    const asWorker = (
      await app.inject({
        method: 'GET',
        url: `/v1/jobs/${job.publicId}/party-reviews`,
        headers: bearer(w.apiKey),
      })
    ).json();
    expect(asWorker).toMatchObject({role: 'worker', mine: null, theirs: {submitted: true}, revealed: false});
    expect(JSON.stringify(asWorker)).not.toContain('Fast, careful');

    await review(w.apiKey, job.publicId, {rating: 3, body: 'Clear brief, slow to reply.'});
    const wp = (await profileOf(wPublic)).json();
    expect(wp.rating).toEqual({average: 5, count: 1});
    expect(wp.reviews[0]).toMatchObject({
      rating: 5,
      authorRole: 'client',
      author: `Name ${c.agentId}`,
      jobId: job.publicId,
    });
    expect((await profileOf(cPublic)).json().rating).toEqual({average: 3, count: 1});
    const now = (
      await app.inject({
        method: 'GET',
        url: `/v1/jobs/${job.publicId}/party-reviews`,
        headers: bearer(w.apiKey),
      })
    ).json();
    expect(now.revealed).toBe(true);
    expect(now.theirs.body).toBe('Fast, careful, exactly as asked.');
  });

  it('averages over the shown reviews, and names an author only if their profile is published', async () => {
    const {c, w, wPublic} = await pair();
    const c2 = await agent(app, `rc2${++n}`); // no published profile
    for (const [client, rating] of [
      [c, 4],
      [c2, 2],
    ] as const) {
      const job = await settledJob(client.agentId, w.agentId);
      await review(client.apiKey, job.publicId, {rating, body: 'Did the job as described.'});
      await review(w.apiKey, job.publicId, {rating: 5, body: 'Good client to work with.'});
    }
    const wp = (await profileOf(wPublic)).json();
    expect(wp.rating).toEqual({average: 3, count: 2});
    expect(wp.settledJobs).toBe(2);
    expect(wp.reviews.map((r: {author: string | null}) => r.author).sort()).toEqual(
      [`Name ${c.agentId}`, null].sort(),
    );
  });

  it('only for a job the chain settled, by its parties, once, within 14 days', async () => {
    const {c, w} = await pair();
    const stranger = await agent(app, `rs${++n}`);
    const open = await settledJob(c.agentId, w.agentId, {state: 'accepted', chain: false});
    const ok = {rating: 4, body: 'Good work overall, thanks.'};
    expect((await review(c.apiKey, open.publicId, ok)).json().code).toBe('INVALID_STATE');
    // Settled in our database but no chain event: not proof enough.
    const noProof = await settledJob(c.agentId, w.agentId, {chain: false});
    expect((await review(c.apiKey, noProof.publicId, ok)).json().code).toBe('INVALID_STATE');
    const late = await settledJob(c.agentId, w.agentId, {daysAgo: 15});
    const tooLate = await review(c.apiKey, late.publicId, ok);
    expect(tooLate.statusCode).toBe(410);

    const job = await settledJob(c.agentId, w.agentId);
    expect((await review(stranger.apiKey, job.publicId, ok)).statusCode).toBe(403);
    expect((await review(c.apiKey, job.publicId, {rating: 6, body: 'Too good to be true.'})).statusCode).toBe(
      422,
    );
    expect((await review(c.apiKey, job.publicId, {rating: 3, body: 'short'})).statusCode).toBe(422);
    expect((await review(c.apiKey, job.publicId, {rating: 3.5, body: 'Half a star more.'})).statusCode).toBe(
      422,
    );
    expect((await review(c.apiKey, job.publicId, ok)).statusCode).toBe(201);
    expect((await review(c.apiKey, job.publicId, ok)).json()).toMatchObject({replayed: true});
    const changed = await review(c.apiKey, job.publicId, {...ok, rating: 1});
    expect(changed.statusCode).toBe(409);
  });

  it('a lone review shows once the window has closed', async () => {
    const {c, w, wPublic} = await pair();
    const job = await settledJob(c.agentId, w.agentId, {daysAgo: 20});
    await db.insert(partyReviews).values({
      jobId: job.id,
      authorAgentId: c.agentId,
      subjectAgentId: w.agentId,
      authorRole: 'client',
      rating: 2,
      body: 'Late, and only half done.',
      createdAt: new Date(Date.now() - 19 * DAY),
    });
    expect((await profileOf(wPublic)).json().rating).toEqual({average: 2, count: 1});
  });

  it('a hidden review is neither shown nor counted, and hiding needs a reason', async () => {
    const {c, w, wPublic} = await pair();
    const job = await settledJob(c.agentId, w.agentId);
    const id = (await review(c.apiKey, job.publicId, {rating: 1, body: 'Abusive words here, say.'})).json()
      .reviewId;
    await review(w.apiKey, job.publicId, {rating: 5, body: 'Fine client, paid fast.'});
    expect((await profileOf(wPublic)).json().rating.count).toBe(1);
    await expect(hideReview(db, id, '  ')).rejects.toThrow(/why/);
    expect(await hideReview(db, id, 'abusive language')).toBe(true);
    const wp = (await profileOf(wPublic)).json();
    expect(wp.rating).toEqual({average: null, count: 0});
    expect(wp.reviews).toEqual([]);
  });

  it('the database refuses a review of an unsettled job, or by someone not on it', async () => {
    const {c, w} = await pair();
    const stranger = await agent(app, `rx${++n}`);
    const open = await settledJob(c.agentId, w.agentId, {state: 'accepted', chain: false});
    const settled = await settledJob(c.agentId, w.agentId);
    const row = (jobId: number, author: number, subject: number, role = 'client') => ({
      jobId,
      authorAgentId: author,
      subjectAgentId: subject,
      authorRole: role,
      rating: 4,
      body: 'Written past the API.',
    });
    // drizzle wraps the database's words in `cause`.
    const refused = async (values: ReturnType<typeof row>) =>
      db
        .insert(partyReviews)
        .values(values)
        .then(
          () => 'inserted',
          (e: {cause?: {message?: string}}) => e.cause?.message ?? String(e),
        );
    expect(await refused(row(open.id, c.agentId, w.agentId))).toMatch(/not settled/);
    expect(await refused(row(settled.id, stranger.agentId, w.agentId))).toMatch(/two parties/);
    expect(await refused(row(settled.id, w.agentId, c.agentId, 'client'))).toMatch(/two parties/);
    expect(await refused({...row(settled.id, c.agentId, w.agentId), rating: 9})).toMatch(/rating_range/);
  });
});
