import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {eq, sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {
  agents,
  closeDb,
  createDb,
  faucetClaims,
  jobEvents,
  jobs,
  webhookDeliveries,
  webhooks,
  type Db,
} from '@pactora/db';
import {open, parseSecretKey} from '@pactora/service';
import {ErrorCode, PactoraError} from '@pactora/shared';
import {buildApp, EventBus} from '../src/app.js';
import {recordEvent} from '../src/routes/jobs.js';
import type {FaucetSend} from '../src/submit.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, fakeReadTxEvents, person} from './helpers/people.js';

/**
 * docs/26 F9, F10, F23: the per-agent event feed (written by a trigger on
 * job_events), notifications, webhooks, and the test-token faucet.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});
const KEY = parseSecretKey('5a'.repeat(32));

let app: FastifyInstance;
let noHooks: FastifyInstance;
let db: Db;
const bus = new EventBus();
let faucetCalls: {receiverId: string; amount: bigint}[] = [];
let faucetBehaviour: 'ok' | 'refuse' | 'lost' = 'ok';

const send: FaucetSend = async (receiverId, amount) => {
  faucetCalls.push({receiverId, amount});
  if (faucetBehaviour === 'refuse')
    throw new PactoraError(ErrorCode.BUDGET_EXCEEDED, 'above the per-send cap');
  if (faucetBehaviour === 'lost')
    throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'the signer did not answer');
  return {txHash: `FAUCETTX${faucetCalls.length}`, registered: false, from: 'faucet.test.near'};
};

const build = (over: Record<string, unknown> = {}) =>
  buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus,
    readBudget: fakeReadBudget,
    readTxEvents: fakeReadTxEvents,
    rateLimitPerMinute: 100_000,
    liveEvents: false,
    draftSettleSweepMs: 0,
    eventsPollMs: 50,
    submit: async () => ({txHash: 'unused'}),
    ...over,
  });

beforeAll(async () => {
  db = createDb(DB_URL, {max: 50});
  app = await build({
    webhookSecretKey: KEY,
    faucetSend: send,
    faucet: {amount: 5_000_000n, perIpPerDay: 2, dailyCap: 12_000_000n},
  });
  noHooks = await build();
});
afterAll(async () => {
  await app.close();
  await noHooks.close();
  await closeDb(db);
});
beforeEach(async () => {
  faucetCalls = [];
  faucetBehaviour = 'ok';
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, token_transfers, registration_challenges, sessions, login_challenges, listings, applications, listing_slots, person_actions, agent_events, agent_event_seq, agent_event_reads, webhooks, webhook_deliveries, faucet_claims RESTART IDENTITY CASCADE`,
  );
});

let n = 0;
async function pair() {
  const k = ++n;
  const c = await agent(app, `evc${k}`);
  const w = await agent(app, `evw${k}`);
  return {c, w};
}

async function jobBetween(
  clientAgentId: number,
  workerAgentId: number,
): Promise<{id: number; publicId: string}> {
  const [row] = await db
    .insert(jobs)
    .values({
      chainId: 'near:sandbox',
      clientAgentId,
      workerAgentId,
      path: 'escrow',
      amount: '20000',
      spec: {capability: 'market-research', input: {}},
      specHash: 'ab'.repeat(32),
    })
    .returning({id: jobs.id, publicId: jobs.publicId});
  return row!;
}

const events = (token: string, q = '') =>
  app.inject({method: 'GET', url: `/v1/events${q}`, headers: bearer(token)});

describe('the per-agent event feed', () => {
  it('gives each party its own numbering, from the API and from the indexer alike', async () => {
    const {c, w} = await pair();
    const job = await jobBetween(c.agentId, w.agentId);
    await recordEvent(db, bus, job.id, 'near:sandbox', 'job.created', {jobId: job.publicId});
    // The indexer writes job_events directly, not through recordEvent.
    await db
      .insert(jobEvents)
      .values({chainId: 'near:sandbox', jobId: job.id, kind: 'settled', txHash: 'T1'});

    const forClient = (await events(c.apiKey)).json();
    expect(
      forClient.events.map((e: {seq: number; kind: string; role: string}) => [e.seq, e.kind, e.role]),
    ).toEqual([
      [1, 'job.created', 'client'],
      [2, 'settled', 'client'],
    ]);
    expect(forClient.events[1].jobId).toBe(job.publicId);
    expect(forClient.latest).toBe(2);
    const forWorker = (await events(w.apiKey)).json();
    expect(forWorker.events.map((e: {role: string}) => e.role)).toEqual(['worker', 'worker']);
  });

  it('has no gaps under concurrent writers, and a rolled-back write takes its number back', async () => {
    const {c} = await pair();
    const workers = await Promise.all(Array.from({length: 8}, (_, i) => agent(app, `gw${n}-${i}`)));
    const jobsList = await Promise.all(workers.map((w) => jobBetween(c.agentId, w.agentId)));
    // 40 events on 8 jobs that all share one client, written at once.
    await Promise.all(
      Array.from({length: 40}, (_, i) =>
        recordEvent(db, bus, jobsList[i % 8]!.id, 'near:sandbox', 'job.message', {i}),
      ),
    );
    await db
      .transaction(async (tx) => {
        await tx.insert(jobEvents).values({chainId: 'near:sandbox', jobId: jobsList[0]!.id, kind: 'doomed'});
        throw new Error('roll back');
      })
      .catch(() => undefined);
    await recordEvent(db, bus, jobsList[1]!.id, 'near:sandbox', 'job.after', {});

    const all = (await events(c.apiKey, '?limit=200')).json();
    expect(all.events.map((e: {seq: number}) => e.seq)).toEqual(Array.from({length: 41}, (_, i) => i + 1));
    expect(all.events.some((e: {kind: string}) => e.kind === 'doomed')).toBe(false);
    expect(all.events.at(-1).kind).toBe('job.after');
  });

  it('pages with after/limit, says when there is more, and never shows another agent its events', async () => {
    const {c, w} = await pair();
    const other = await agent(app, `outsider${n}`);
    const job = await jobBetween(c.agentId, w.agentId);
    for (let i = 0; i < 5; i++) await recordEvent(db, bus, job.id, 'near:sandbox', 'job.message', {i});

    const first = (await events(c.apiKey, '?limit=2')).json();
    expect(first.events.map((e: {seq: number}) => e.seq)).toEqual([1, 2]);
    expect(first.more).toBe(true);
    expect(first.next).toBe(2);
    const rest = (await events(c.apiKey, `?after=${first.next}&limit=10`)).json();
    expect(rest.events.map((e: {seq: number}) => e.seq)).toEqual([3, 4, 5]);
    expect(rest.more).toBe(false);
    const empty = (await events(c.apiKey, '?after=5')).json();
    expect(empty).toMatchObject({events: [], next: 5, more: false, latest: 5});

    expect((await events(other.apiKey)).json().events).toEqual([]);
    expect((await app.inject({method: 'GET', url: '/v1/events'})).statusCode).toBe(401);
    expect((await events(c.apiKey, '?limit=500')).statusCode).toBe(422);
    expect((await events(c.apiKey, '?wait=31')).statusCode).toBe(422);
  });

  it('long-polls: a waiting read returns as soon as an event arrives, and gives up at the deadline', async () => {
    const {c, w} = await pair();
    const job = await jobBetween(c.agentId, w.agentId);
    const t0 = Date.now();
    const waiting = events(c.apiKey, '?wait=10');
    setTimeout(() => void recordEvent(db, bus, job.id, 'near:sandbox', 'job.accepted', {}), 300);
    const got = (await waiting).json();
    expect(got.events.map((e: {kind: string}) => e.kind)).toEqual(['job.accepted']);
    expect(Date.now() - t0).toBeLessThan(5000);

    const t1 = Date.now();
    const none = (await events(c.apiKey, '?after=1&wait=1')).json();
    expect(none.events).toEqual([]);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(900);
  });

  it('a person reads the feed of their person agent with their session', async () => {
    const p = await person(app, `evp${++n}`);
    const w = await agent(app, `evpw${n}`);
    const pRow = await db.query.agents.findFirst({where: eq(agents.publicId, p.publicId)});
    const job = await jobBetween(pRow!.id, w.agentId);
    await recordEvent(db, bus, job.id, 'near:sandbox', 'job.created', {});
    const got = (await events(p.token)).json();
    expect(got.agentId).toBe(p.publicId);
    expect(got.events).toHaveLength(1);
  });
});

describe('notifications', () => {
  it('counts unread, marks read forward only, and never past the latest', async () => {
    const p = await person(app, `np${++n}`);
    const w = await agent(app, `npw${n}`);
    const pRow = await db.query.agents.findFirst({where: eq(agents.publicId, p.publicId)});
    const job = await jobBetween(pRow!.id, w.agentId);
    for (let i = 0; i < 4; i++) await recordEvent(db, bus, job.id, 'near:sandbox', 'job.message', {i});

    const list = async (q = '') =>
      (await app.inject({method: 'GET', url: `/v1/notifications${q}`, headers: bearer(p.token)})).json();
    const mark = (upTo: number) =>
      app.inject({method: 'POST', url: '/v1/notifications/read', headers: bearer(p.token), payload: {upTo}});

    let l = await list();
    expect(l.unread).toBe(4);
    expect(l.notifications.map((x: {seq: number}) => x.seq)).toEqual([4, 3, 2, 1]);
    expect((await mark(2)).json()).toMatchObject({readSeq: 2, unread: 2});
    l = await list();
    expect(l.notifications.map((x: {read: boolean}) => x.read)).toEqual([false, false, true, true]);
    // A stale tab cannot un-read; a mark past the latest stops at it.
    expect((await mark(1)).json().readSeq).toBe(2);
    expect((await mark(999)).json()).toMatchObject({readSeq: 4, unread: 0});

    const page = await list('?limit=2');
    expect(page.notifications.map((x: {seq: number}) => x.seq)).toEqual([4, 3]);
    expect(page.before).toBe(3);
    expect((await list('?limit=2&before=3')).notifications.map((x: {seq: number}) => x.seq)).toEqual([2, 1]);
  });
});

describe('webhooks', () => {
  const create = (token: string, payload: Record<string, unknown>, on = app) =>
    on.inject({method: 'POST', url: '/v1/webhooks', headers: bearer(token), payload});

  it('needs the server key; without it the route says so instead of storing a secret in the clear', async () => {
    const {c} = await pair();
    const r = await create(c.apiKey, {url: 'https://93.184.216.34/hook'}, noHooks);
    expect(r.statusCode).toBe(503);
  });

  it('shows the secret once, stores it only sealed to its own row, and lists without it', async () => {
    const {c} = await pair();
    const r = await create(c.apiKey, {
      url: 'https://93.184.216.34/hook',
      kinds: ['job.settled', 'job.settled'],
    });
    expect(r.statusCode, r.body).toBe(201);
    const made = r.json();
    expect(made.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(made.kinds).toEqual(['job.settled']);
    const row = await db.query.webhooks.findFirst({where: eq(webhooks.publicId, made.webhookId)});
    expect(row!.secretEnc).not.toContain(made.secret);
    expect(open(KEY, row!.secretEnc, `webhook:${made.webhookId}`)).toBe(made.secret);
    // Bound to its row: the same ciphertext does not open as another hook's.
    expect(() => open(KEY, row!.secretEnc, 'webhook:00000000-0000-4000-8000-000000000000')).toThrow();

    const list = (await app.inject({method: 'GET', url: '/v1/webhooks', headers: bearer(c.apiKey)})).json();
    expect(list.webhooks).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(made.secret);
  });

  it.each([
    ['http://93.184.216.34/hook', /https/],
    ['https://127.0.0.1/hook', /non-public/],
    ['https://169.254.169.254/latest', /non-public/],
    ['https://[::ffff:10.0.0.1]/hook', /non-public/],
    ['https://user:pw@93.184.216.34/', /credentials/],
    ['https://localhost/hook', /non-public/],
  ])('refuses %s', async (url, why) => {
    const {c} = await pair();
    const r = await create(c.apiKey, {url});
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toMatch(why);
  });

  it('allows at most 5 per agent, and deleting one frees a place and stops its deliveries', async () => {
    const {c, w} = await pair();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push((await create(c.apiKey, {url: `https://93.184.216.34/h${i}`})).json().webhookId);
    const sixth = await create(c.apiKey, {url: 'https://93.184.216.34/h6'});
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().code).toBe('LIMIT_REACHED');

    const job = await jobBetween(c.agentId, w.agentId);
    await recordEvent(db, bus, job.id, 'near:sandbox', 'job.created', {});
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/webhooks/${ids[0]}`,
      headers: bearer(c.apiKey),
    });
    expect(del.json()).toMatchObject({deleted: true});
    const [hook] = await db.select().from(webhooks).where(eq(webhooks.publicId, ids[0]!));
    const left = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hook!.id));
    expect(left.map((d) => d.status)).toEqual(['failed']);
    expect((await create(c.apiKey, {url: 'https://93.184.216.34/h7'})).statusCode).toBe(201);
    // Another agent cannot delete or read it.
    const stranger = await agent(app, `stranger${n}`);
    expect(
      (await app.inject({method: 'DELETE', url: `/v1/webhooks/${ids[1]}`, headers: bearer(stranger.apiKey)}))
        .statusCode,
    ).toBe(404);
  });

  it('queues one delivery per matching event, in the same transaction as the event', async () => {
    const {c, w} = await pair();
    const all = (await create(c.apiKey, {url: 'https://93.184.216.34/all'})).json();
    const settledOnly = (
      await create(c.apiKey, {url: 'https://93.184.216.34/s', kinds: ['job.settled']})
    ).json();
    const workerHook = (await create(w.apiKey, {url: 'https://93.184.216.34/w'})).json();
    const job = await jobBetween(c.agentId, w.agentId);
    await recordEvent(db, bus, job.id, 'near:sandbox', 'job.created', {});
    await recordEvent(db, bus, job.id, 'near:sandbox', 'job.settled', {});

    const count = async (publicId: string) => {
      const [h] = await db.select().from(webhooks).where(eq(webhooks.publicId, publicId));
      return (await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, h!.id))).map(
        (d) => d.seq,
      );
    };
    expect(await count(all.webhookId)).toEqual([1, 2]);
    expect(await count(settledOnly.webhookId)).toEqual([2]);
    expect(await count(workerHook.webhookId)).toEqual([1, 2]);
    const seen = await app.inject({
      method: 'GET',
      url: `/v1/webhooks/${all.webhookId}/deliveries`,
      headers: bearer(c.apiKey),
    });
    expect(seen.json().deliveries.map((d: {status: string}) => d.status)).toEqual(['pending', 'pending']);
  });
});

describe('the test-token faucet', () => {
  const claim = (token: string, ip = '10.90.0.1') =>
    app.inject({method: 'POST', url: '/v1/faucet', headers: bearer(token), remoteAddress: ip});

  it('sends once per account per day, to the signed-in account only', async () => {
    const p = await person(app, `fp${++n}`);
    const r = await claim(p.token);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({account: p.account, amount: '5000000', txHash: 'FAUCETTX1'});
    expect(faucetCalls).toEqual([{receiverId: p.account, amount: 5_000_000n}]);
    const again = await claim(p.token, '10.90.0.2');
    expect(again.statusCode).toBe(409);
    expect(again.json().detail).toMatch(/already claimed today/);
    expect(faucetCalls).toHaveLength(1);
    const status = (await app.inject({method: 'GET', url: '/v1/faucet', headers: bearer(p.token)})).json();
    expect(status).toMatchObject({available: true, testnet: true, claimedToday: true});
  });

  it('limits claims per address and in total per day', async () => {
    const a = await person(app, `fa${++n}`);
    const b = await person(app, `fb${n}`);
    const c = await person(app, `fc${n}`);
    expect((await claim(a.token, '10.91.0.1')).statusCode).toBe(201);
    expect((await claim(b.token, '10.91.0.1')).statusCode).toBe(201);
    const third = await claim(c.token, '10.91.0.1');
    expect(third.json().detail).toMatch(/per address/);
    // Cap 12 000 000 at 5 000 000 a claim: the third claim anywhere would pass the cap.
    const d = await person(app, `fd${n}`);
    const capped = await claim(d.token, '10.91.0.9');
    expect(capped.statusCode).toBe(409);
    expect(capped.json().detail).toMatch(/all it may today/);
    expect(faucetCalls).toHaveLength(2);
  });

  it('two claims at once from one account send once', async () => {
    const p = await person(app, `fx${++n}`);
    const [r1, r2] = await Promise.all([claim(p.token, '10.92.0.1'), claim(p.token, '10.92.0.2')]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 409]);
    expect(faucetCalls).toHaveLength(1);
  });

  it('a definite refusal frees the claim; an unknown outcome keeps it, so nothing is paid twice', async () => {
    const p = await person(app, `fr${++n}`);
    faucetBehaviour = 'refuse';
    expect((await claim(p.token)).statusCode).toBe(402);
    faucetBehaviour = 'ok';
    expect((await claim(p.token)).statusCode).toBe(201);

    const q = await person(app, `fl${n}`);
    faucetBehaviour = 'lost';
    expect((await claim(q.token)).statusCode).toBe(503);
    faucetBehaviour = 'ok';
    expect((await claim(q.token)).statusCode).toBe(409);
    const rows = await db.select().from(faucetClaims).where(eq(faucetClaims.account, q.account));
    expect(rows.map((r) => r.status)).toEqual(['failed']);
  });

  it('is for people: an agent key is refused, and so is a server without a faucet', async () => {
    const {c} = await pair();
    const r = await claim(c.apiKey);
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('WRONG_CREDENTIAL');
    const p = await person(noHooks, `fn${++n}`);
    expect(
      (await noHooks.inject({method: 'POST', url: '/v1/faucet', headers: bearer(p.token)})).statusCode,
    ).toBe(503);
  });
});

describe('the webhook signature recipe', () => {
  it('the SDK verifier accepts exactly what the notifier signs', async () => {
    const {verifyWebhook} = await import('@pactora/sdk');
    const {webhookSignature} = await import('@pactora/service');
    const body = JSON.stringify({deliveryId: 'd-1', seq: 3, kind: 'job.settled'});
    const t = 1_762_600_000;
    const sig = webhookSignature('whsec_k', t, 'd-1', body);
    expect(verifyWebhook('whsec_k', sig, 'd-1', body, {nowS: t + 10})).toBe(true);
    expect(verifyWebhook('whsec_k', sig, 'd-2', body, {nowS: t + 10})).toBe(false);
    expect(verifyWebhook('whsec_x', sig, 'd-1', body, {nowS: t + 10})).toBe(false);
    expect(verifyWebhook('whsec_k', sig, 'd-1', `${body} `, {nowS: t + 10})).toBe(false);
    expect(verifyWebhook('whsec_k', sig, 'd-1', body, {nowS: t + 301})).toBe(false);
    expect(verifyWebhook('whsec_k', 't=abc,v1=zz', 'd-1', body)).toBe(false);
    expect(verifyWebhook('whsec_k', '', 'd-1', body)).toBe(false);
  });
});
