import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {sha256Hex} from '@pactora/near';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {canonicalize} from '@pactora/shared';
import {buildApp, EventBus} from '../src/app.js';
import {chainDeps} from './helpers/register.js';
import {
  agent,
  bearer,
  fakeReadBudget,
  fakeReadTxEvents,
  onChainTx,
  person,
  purses,
  sessionOnly,
  txHash,
} from './helpers/people.js';

/**
 * Listings (docs/26 F4, F5, F6-a, F31): work offered to many, priced by bids.
 * Each selected bid — or instant claim — becomes an ordinary 1:1 job at the
 * bid's price, funded by the signer for an agent client and signed in the
 * browser by a person client.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});
const chain = config.chain('near:sandbox');

let app: FastifyInstance;
let db: Db;
let submitted: {kind: string; spend: bigint; payload?: Record<string, unknown>}[] = [];

beforeAll(async () => {
  db = createDb(DB_URL, {max: 5});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    readBudget: fakeReadBudget,
    readTxEvents: fakeReadTxEvents,
    rateLimitPerMinute: 100_000,
    submit: async (args) => {
      submitted.push({kind: args.kind, spend: args.spend, ...(args.payload ? {payload: args.payload} : {})});
      return {
        txHash: '4yJxShz8HXfTyoTMXP9rQSoQUZE8uihkDmnpRrynZeZz',
        chainJobId: String(100 + submitted.length),
      };
    },
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  submitted = [];
  purses.clear();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, token_transfers, registration_challenges RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`
    DO $$ BEGIN
      IF to_regclass('sessions') IS NOT NULL THEN TRUNCATE sessions RESTART IDENTITY; END IF;
      IF to_regclass('login_challenges') IS NOT NULL THEN TRUNCATE login_challenges; END IF;
      IF to_regclass('listings') IS NOT NULL THEN TRUNCATE listings, applications, listing_slots, person_actions RESTART IDENTITY CASCADE; END IF;
    END $$`);
});

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

const terms = (over: Record<string, unknown> = {}) => ({
  title: 'Photograph three shop fronts',
  description: 'Take clear daytime photos of three shop fronts on the high street.',
  category: 'physical',
  interactionMode: 'capture',
  skills: ['Photography'],
  location: 'Berlin',
  maxPriceBaseUnits: '40000',
  maxWorkers: 2,
  hiringMode: 'applications',
  estimatedMinutes: 60,
  deadline: inDays(7),
  criteria: 'Three sharp photos, each showing the full shop front and its sign.',
  acceptWindowSeconds: 600,
  workWindowSeconds: 7200,
  ...over,
});

let keySeq = 0;
const post = (token: string, body: unknown, key = `listing-key-${++keySeq}`) =>
  app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: {...bearer(token), 'idempotency-key': key},
    payload: body as Record<string, unknown>,
  });

async function posted(token: string, over: Record<string, unknown> = {}) {
  const res = await post(token, terms(over));
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as {listingId: string; reservedBaseUnits: string; status: string};
}

const apply = (
  token: string,
  listingId: string,
  price = '30000',
  proposal = 'I can do this today, with a good camera.',
) =>
  app.inject({
    method: 'POST',
    url: `/v1/listings/${listingId}/applications`,
    headers: bearer(token),
    payload: {action: 'apply', priceBaseUnits: price, proposal},
  });

const withdraw = (token: string, listingId: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/listings/${listingId}/applications`,
    headers: bearer(token),
    payload: {action: 'withdraw'},
  });

const decide = (
  token: string,
  listingId: string,
  applicationId: string,
  action: 'select' | 'reject',
  reason = 'Your proposal fits the brief well.',
) =>
  app.inject({
    method: 'POST',
    url: `/v1/listings/${listingId}/decide`,
    headers: bearer(token),
    payload: {applicationId, action, reason},
  });

const action = (token: string, listingId: string, what: 'close' | 'reopen' | 'claim', payload?: unknown) =>
  app.inject({
    method: 'POST',
    url: `/v1/listings/${listingId}/${what}`,
    headers: bearer(token),
    ...(payload !== undefined ? {payload: payload as Record<string, unknown>} : {}),
  });

describe('posting a listing', () => {
  it('reserves max_workers × ceiling, and shows the fee the worker pays', async () => {
    const client = await agent(app, 'lst-client');
    const res = await post(client.apiKey, terms());
    expect(res.statusCode).toBe(201);
    const l = res.json();
    expect(l).toMatchObject({
      title: 'Photograph three shop fronts',
      category: 'physical',
      interactionMode: 'capture',
      skills: ['photography'],
      maxPriceBaseUnits: '40000',
      maxWorkers: 2,
      reservedBaseUnits: '80000',
      // max(40000 × 100 / 10000, 100) = 400, from the worker's payout.
      feeAtCeilingBaseUnits: '400',
      workerReceivesAtCeilingBaseUnits: '39600',
      status: 'open',
      slotsFilled: 0,
      acceptWindowSeconds: 600,
      workWindowSeconds: 7200,
    });
    expect(l.client).toMatchObject({kind: 'agent', name: 'lst-client'});
  });

  it('replays the same key and body as the same listing, and refuses a changed body with 409', async () => {
    const client = await agent(app, 'lst-idem');
    const body = terms();
    const first = await post(client.apiKey, body, 'idem-key-0001');
    expect(first.statusCode).toBe(201);
    const again = await post(client.apiKey, body, 'idem-key-0001');
    expect(again.statusCode).toBe(200);
    expect(again.json().listingId).toBe(first.json().listingId);
    const changed = await post(client.apiKey, terms({title: 'Something else entirely'}), 'idem-key-0001');
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe('IDEMPOTENCY_CONFLICT');
    const [{n}] = (await db.execute(sql`SELECT count(*)::int AS n FROM listings`)) as unknown as [
      {n: number},
    ];
    expect(n).toBe(1);
  });

  it('requires an Idempotency-Key', async () => {
    const client = await agent(app, 'lst-nokey');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/listings',
      headers: bearer(client.apiKey),
      payload: terms(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it.each([
    ['maxWorkers', 20, 21],
    ['title', 'x'.repeat(140), 'x'.repeat(141)],
    ['description', 'd'.repeat(5000), 'd'.repeat(5001)],
    ['criteria', 'c'.repeat(3000), 'c'.repeat(3001)],
    ['location', 'L'.repeat(120), 'L'.repeat(121)],
    [
      'skills',
      Array.from({length: 20}, (_, i) => `skill-${i}`),
      Array.from({length: 21}, (_, i) => `skill-${i}`),
    ],
  ])('accepts %s at its cap and refuses cap + 1', async (field, atCap, over) => {
    const client = await agent(app, `lst-cap-${field}`);
    // Small enough that 20 workers fit the fake purse.
    const base = {maxPriceBaseUnits: '20000', maxWorkers: 1};
    expect((await post(client.apiKey, terms({...base, [field]: atCap}))).statusCode).toBe(201);
    const res = await post(client.apiKey, terms({...base, [field]: over}));
    expect(res.statusCode).toBe(422);
  });

  it('refuses a title below 5 characters, a proposal-free skill below 2, and a deadline past 90 days', async () => {
    const client = await agent(app, 'lst-mins');
    expect((await post(client.apiKey, terms({title: 'abcd'}))).statusCode).toBe(422);
    expect((await post(client.apiKey, terms({skills: ['a']}))).statusCode).toBe(422);
    expect((await post(client.apiKey, terms({deadline: inDays(91)}))).statusCode).toBe(422);
    expect((await post(client.apiKey, terms({deadline: inDays(-1)}))).statusCode).toBe(422);
  });

  it("refuses a work window above the contract's max_work_window, naming it", async () => {
    const client = await agent(app, 'lst-window');
    const max = chain.params.maxWorkWindowSeconds;
    expect(max).toBe(18_000);
    expect((await post(client.apiKey, terms({workWindowSeconds: max}))).statusCode).toBe(201);
    const res = await post(client.apiKey, terms({workWindowSeconds: max + 1}));
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain('18000');
    const acc = await post(
      client.apiKey,
      terms({acceptWindowSeconds: chain.params.maxAcceptWindowSeconds + 1}),
    );
    expect(acc.statusCode).toBe(422);
  });

  it("refuses a reservation above the client's on-chain daily allowance, counting its other open listings", async () => {
    const client = await agent(app, 'lst-budget');
    purses.set(client.wallet, {dailyRemaining: 100_000n});
    // 2 × 40000 = 80000 fits; a second 2 × 40000 does not (80000 already held).
    expect((await post(client.apiKey, terms())).statusCode).toBe(201);
    const second = await post(client.apiKey, terms());
    expect(second.statusCode).toBe(402);
    expect(second.json().code).toBe('BUDGET_EXCEEDED');
    // One worker at 20000 fits in what is left.
    expect((await post(client.apiKey, terms({maxWorkers: 1, maxPriceBaseUnits: '20000'}))).statusCode).toBe(
      201,
    );
  });

  it("refuses a ceiling above the client's per-task cap", async () => {
    const client = await agent(app, 'lst-pertask');
    purses.set(client.wallet, {perTaskCap: 39_999n});
    const res = await post(client.apiKey, terms());
    expect(res.statusCode).toBe(402);
    expect(res.json().detail).toContain('per-task cap');
  });

  it('may be posted by a person, but not by a session with no person agent', async () => {
    const p = await person(app, 'lst-person-client');
    const l = await posted(p.token);
    expect((await app.inject({url: `/v1/listings/${l.listingId}`})).json().client.kind).toBe('person');
    const nobody = await sessionOnly(app, 'lst-nobody');
    expect((await post(nobody, terms())).statusCode).toBe(403);
  });
});

describe('applying', () => {
  it('refuses a price above the ceiling and a proposal under 20 characters', async () => {
    const client = await agent(app, 'ap-client');
    const worker = await agent(app, 'ap-worker');
    const l = await posted(client.apiKey);
    const high = await apply(worker.apiKey, l.listingId, '40001');
    expect(high.statusCode).toBe(409);
    expect(high.json().code).toBe('PRICE_ABOVE_MAX');
    expect((await apply(worker.apiKey, l.listingId, '30000', 'x'.repeat(19))).statusCode).toBe(422);
    expect((await apply(worker.apiKey, l.listingId, '40000', 'x'.repeat(20))).statusCode).toBe(201);
  });

  it('keeps one live bid per applicant', async () => {
    const client = await agent(app, 'ap1-client');
    const worker = await agent(app, 'ap1-worker');
    const l = await posted(client.apiKey);
    expect((await apply(worker.apiKey, l.listingId)).statusCode).toBe(201);
    const second = await apply(worker.apiKey, l.listingId, '25000');
    expect(second.statusCode).toBe(409);
    expect(second.json().detail).toContain('live bid');
    expect((await withdraw(worker.apiKey, l.listingId)).json().status).toBe('withdrawn');
    expect((await apply(worker.apiKey, l.listingId, '25000')).statusCode).toBe(201);
  });

  it('allows 3 bids per applicant per listing and refuses the 4th', async () => {
    const client = await agent(app, 'ap3-client');
    const worker = await agent(app, 'ap3-worker');
    const l = await posted(client.apiKey);
    for (let i = 0; i < 3; i++) {
      expect((await apply(worker.apiKey, l.listingId)).statusCode, `bid ${i + 1}`).toBe(201);
      expect((await withdraw(worker.apiKey, l.listingId)).statusCode).toBe(200);
    }
    const fourth = await apply(worker.apiKey, l.listingId);
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().code).toBe('LIMIT_REACHED');
  });

  it('does not count bids set aside because hiring closed (the reopenable flag)', async () => {
    const client = await agent(app, 'apr-client');
    const worker = await agent(app, 'apr-worker');
    const l = await posted(client.apiKey);
    await db.execute(sql`
      INSERT INTO applications (listing_id, applicant_agent_id, price, proposal, status, reopenable, reason)
      SELECT 1, ${worker.agentId}, 30000, 'an earlier bid, set aside at close', 'rejected', true, 'whatever the text says'
        FROM generate_series(1, 3)`);
    expect((await apply(worker.apiKey, l.listingId)).statusCode).toBe(201);
  });

  it('allows 1000 applications per listing and refuses the 1001st', async () => {
    const client = await agent(app, 'ap1k-client');
    const filler = await agent(app, 'ap1k-filler');
    const late = await agent(app, 'ap1k-late');
    const l = await posted(client.apiKey);
    await db.execute(sql`
      INSERT INTO applications (listing_id, applicant_agent_id, price, proposal, status)
      SELECT 1, ${filler.agentId}, 30000, 'a filler bid of twenty+ chars', 'withdrawn' FROM generate_series(1, 999)`);
    expect((await apply(late.apiKey, l.listingId)).statusCode).toBe(201);
    await withdraw(late.apiKey, l.listingId);
    const another = await agent(app, 'ap1k-another');
    const over = await apply(another.apiKey, l.listingId);
    expect(over.statusCode).toBe(409);
    expect(over.json().code).toBe('LIMIT_REACHED');
  });

  it('refuses the listing owner and an agent of the same owner', async () => {
    const client = await agent(app, 'apo-client');
    const l = await posted(client.apiKey);
    expect((await apply(client.apiKey, l.listingId)).statusCode).toBe(403);
    const sibling = await agent(app, 'apo-sibling', {ownerAddress: (await ownerOf(client.agentId))!});
    expect((await apply(sibling.apiKey, l.listingId)).statusCode).toBe(403);
  });

  it('lets people apply: their person row is hidden from discovery but can bid', async () => {
    const client = await agent(app, 'app-client');
    const p = await person(app, 'app-worker');
    const l = await posted(client.apiKey);
    expect((await apply(p.token, l.listingId)).statusCode).toBe(201);
  });
});

async function ownerOf(agentId: number): Promise<string | undefined> {
  const rows = (await db.execute(sql`SELECT owner_address FROM agents WHERE id = ${agentId}`)) as unknown as {
    owner_address: string;
  }[];
  return rows[0]?.owner_address;
}

describe('who sees which bids', () => {
  it('shows the client every bid, sorted and paged by 20; applicants see only their own', async () => {
    const client = await agent(app, 'see-client');
    const a = await agent(app, 'see-a');
    const b = await agent(app, 'see-b');
    const l = await posted(client.apiKey);
    await apply(a.apiKey, l.listingId, '35000');
    await apply(b.apiKey, l.listingId, '21000');

    const list = (sort: string, page = 1, token = client.apiKey) =>
      app.inject({
        url: `/v1/listings/${l.listingId}/applications?sort=${sort}&page=${page}`,
        headers: bearer(token),
      });
    expect(
      (await list('price_low')).json().applications.map((x: {priceBaseUnits: string}) => x.priceBaseUnits),
    ).toEqual(['21000', '35000']);
    expect(
      (await list('price_high')).json().applications.map((x: {priceBaseUnits: string}) => x.priceBaseUnits),
    ).toEqual(['35000', '21000']);
    expect((await list('recent')).json().applications[0].priceBaseUnits).toBe('21000');
    expect((await list('rating')).statusCode).toBe(200);
    expect((await list('cheapest')).statusCode).toBe(422);

    // Applicants never read the list.
    const forbidden = await list('recent', 1, a.apiKey);
    expect(forbidden.statusCode).toBe(403);
    // Their view of the listing holds their bid alone.
    const mine = (await app.inject({url: `/v1/listings/${l.listingId}`, headers: bearer(a.apiKey)})).json();
    expect(mine.viewer.applications).toHaveLength(1);
    expect(mine.viewer.applications[0].priceBaseUnits).toBe('35000');
    expect(JSON.stringify(mine)).not.toContain('21000');

    // 20 a page.
    await db.execute(sql`
      INSERT INTO applications (listing_id, applicant_agent_id, price, proposal, status)
      SELECT 1, ${a.agentId}, 30000 + g, 'a paged bid of twenty+ chars', 'withdrawn' FROM generate_series(1, 23) g`);
    const p1 = (await list('recent')).json();
    expect(p1.total).toBe(25);
    expect(p1.applications).toHaveLength(20);
    expect((await list('recent', 2)).json().applications).toHaveLength(5);
  });
});

describe('deciding', () => {
  it('select creates an ordinary job at the bid price, with the listing windows and a spec hash over terms + bid + price', async () => {
    const client = await agent(app, 'dec-client');
    const worker = await agent(app, 'dec-worker');
    const l = await posted(client.apiKey);
    const bid = (await apply(worker.apiKey, l.listingId, '27500')).json();

    const res = await decide(client.apiKey, l.listingId, bid.applicationId, 'select');
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json();
    expect(out.application.status).toBe('selected');
    expect(out.job.amount).toBe('27500');
    expect(out.funding.by).toBe('signer');

    // The signer was asked to create_job at the bid price, in the listing's windows.
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({kind: 'createJob', spend: 27_500n});
    expect(submitted[0]!.payload).toMatchObject({
      amount: '27500',
      acceptWindowSeconds: 600,
      workWindowSeconds: 7200,
      workerChainAgentId: worker.chainAgentId,
      clientChainAgentId: client.chainAgentId,
    });

    const job = (await app.inject({url: `/v1/jobs/${out.job.jobId}`})).json();
    expect(job.amount).toBe('27500');
    expect(job.path).toBe('escrow');
    expect(job.spec.input.listing.title).toBe('Photograph three shop fronts');
    expect(job.spec.input.application).toEqual({applicationId: bid.applicationId, proposal: bid.proposal});
    expect(job.spec.input.priceBaseUnits).toBe('27500');
    expect(job.specHash).toBe(sha256Hex(`${canonicalize(job.spec)}:${out.job.jobId}`));
    expect(submitted[0]!.payload!['specHash']).toBe(job.specHash);

    // The same decision again is a replay: no second job, no second transaction.
    const again = await decide(client.apiKey, l.listingId, bid.applicationId, 'select');
    expect(again.json()).toMatchObject({replayed: true, job: {jobId: out.job.jobId}});
    expect(submitted).toHaveLength(1);
    // A different decision on it is a conflict.
    expect((await decide(client.apiKey, l.listingId, bid.applicationId, 'reject')).statusCode).toBe(409);
  });

  it('reject needs a 10-2000 character reason, shows it to the applicant, and is idempotent', async () => {
    const client = await agent(app, 'rej-client');
    const worker = await agent(app, 'rej-worker');
    const l = await posted(client.apiKey);
    const bid = (await apply(worker.apiKey, l.listingId)).json();
    expect(
      (await decide(client.apiKey, l.listingId, bid.applicationId, 'reject', 'too short')).statusCode,
    ).toBe(422);
    expect(
      (await decide(client.apiKey, l.listingId, bid.applicationId, 'reject', 'r'.repeat(2001))).statusCode,
    ).toBe(422);
    const r = await decide(
      client.apiKey,
      l.listingId,
      bid.applicationId,
      'reject',
      'We need someone closer by.',
    );
    expect(r.json().application).toMatchObject({status: 'rejected', reason: 'We need someone closer by.'});
    expect(
      (
        await decide(client.apiKey, l.listingId, bid.applicationId, 'reject', 'We need someone closer by.')
      ).json().replayed,
    ).toBe(true);
    const seen = (
      await app.inject({url: `/v1/listings/${l.listingId}`, headers: bearer(worker.apiKey)})
    ).json();
    expect(seen.viewer.applications[0].reason).toBe('We need someone closer by.');
  });

  it('fills at max_workers: the listing is filled and the remaining bids set aside', async () => {
    const client = await agent(app, 'fill-client');
    const [a, b, c] = [await agent(app, 'fill-a'), await agent(app, 'fill-b'), await agent(app, 'fill-c')];
    const l = await posted(client.apiKey);
    const bids = [
      (await apply(a.apiKey, l.listingId, '30000')).json(),
      (await apply(b.apiKey, l.listingId, '31000')).json(),
      (await apply(c.apiKey, l.listingId, '32000')).json(),
    ];
    expect((await decide(client.apiKey, l.listingId, bids[0].applicationId, 'select')).statusCode).toBe(200);
    expect((await decide(client.apiKey, l.listingId, bids[1].applicationId, 'select')).statusCode).toBe(200);
    expect((await app.inject({url: `/v1/listings/${l.listingId}`})).json()).toMatchObject({
      status: 'filled',
      slotsFilled: 2,
    });
    const third = await decide(client.apiKey, l.listingId, bids[2].applicationId, 'select');
    expect(third.statusCode).toBe(409);
    // Two jobs, at the two bid prices.
    expect(submitted.map((s) => s.spend)).toEqual([30_000n, 31_000n]);
  });

  it('selects without re-checking skills or location: selection is no stricter than application', async () => {
    const client = await agent(app, 'nostrict-client');
    // No photography skill, no location: still allowed to bid, so still selectable.
    const worker = await agent(app, 'nostrict-worker', {capabilities: ['data-analysis']});
    const l = await posted(client.apiKey, {skills: ['welding'], location: 'Lisbon, PT'});
    const bid = (await apply(worker.apiKey, l.listingId)).json();
    expect((await decide(client.apiKey, l.listingId, bid.applicationId, 'select')).statusCode).toBe(200);
  });

  it('hires a person worker from a listing — the agent path refuses inactive rows, this one does not', async () => {
    const client = await agent(app, 'pw-client');
    const p = await person(app, 'pw-worker');
    const l = await posted(client.apiKey);
    const bid = (await apply(p.token, l.listingId, '26000')).json();
    const res = await decide(client.apiKey, l.listingId, bid.applicationId, 'select');
    expect(res.statusCode, res.body).toBe(200);
    expect(submitted[0]!.payload).toMatchObject({workerChainAgentId: p.chainAgentId, amount: '26000'});
  });

  it('a person client gets the create_job call to sign, the job row written first, and confirms it', async () => {
    const p = await person(app, 'pc-client');
    const worker = await agent(app, 'pc-worker');
    const l = await posted(p.token);
    const bid = (await apply(worker.apiKey, l.listingId, '33000')).json();
    const res = await decide(p.token, l.listingId, bid.applicationId, 'select');
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json();
    expect(submitted).toHaveLength(0);
    expect(out.funding).toMatchObject({by: 'person', done: false, signerId: p.account});
    const job = (await app.inject({url: `/v1/jobs/${out.job.jobId}`})).json();
    expect(job).toMatchObject({state: 'created', chainJobId: null, amount: '33000'});
    expect(out.funding.functionCall).toEqual({
      receiverId: chain.contracts.Pactora,
      methodName: 'create_job',
      args: {
        client_id: Number(p.chainAgentId),
        worker_id: Number(worker.chainAgentId),
        amount: '33000',
        spec_hash: job.specHash,
        accept_window: 600,
        work_window: 7200,
      },
      gas: '100000000000000',
      deposit: '0',
    });

    const hash = onChainTx(txHash(), p.account, [
      {
        event: 'job_created',
        data: {
          job_id: 77,
          client: Number(p.chainAgentId),
          worker: Number(worker.chainAgentId),
          amount: '33000',
          spec_hash: job.specHash,
        },
      },
    ]);
    const confirm = await app.inject({
      method: 'POST',
      url: out.funding.confirm,
      headers: bearer(p.token),
      payload: {action: 'create', txHash: hash},
    });
    expect(confirm.statusCode, confirm.body).toBe(200);
    expect(confirm.json()).toMatchObject({state: 'created', chainJobId: '77', replayed: false});
  });

  it('refuses to edit after a selection, and to cancel', async () => {
    const client = await agent(app, 'edit-client');
    const worker = await agent(app, 'edit-worker');
    const l = await posted(client.apiKey);
    const bid = (await apply(worker.apiKey, l.listingId)).json();
    await decide(client.apiKey, l.listingId, bid.applicationId, 'select');
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/listings/${l.listingId}`,
      headers: bearer(client.apiKey),
      payload: {title: 'A changed title for this'},
    });
    expect(patch.statusCode).toBe(409);
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/listings/${l.listingId}`,
      headers: bearer(client.apiKey),
    });
    expect(del.statusCode).toBe(409);
  });
});

describe('editing, cancelling, closing and reopening', () => {
  it('edits before selection, never below the highest live bid', async () => {
    const client = await agent(app, 'ed-client');
    const worker = await agent(app, 'ed-worker');
    const l = await posted(client.apiKey);
    await apply(worker.apiKey, l.listingId, '35000');
    const patch = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/listings/${l.listingId}`,
        headers: bearer(client.apiKey),
        payload,
      });
    expect((await patch({maxPriceBaseUnits: '34999'})).statusCode).toBe(409);
    const ok = await patch({maxPriceBaseUnits: '35000', title: 'Photograph four shop fronts'});
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      maxPriceBaseUnits: '35000',
      title: 'Photograph four shop fronts',
      reservedBaseUnits: '70000',
    });
    expect((await patch({workWindowSeconds: 18_001})).statusCode).toBe(422);
    const other = await agent(app, 'ed-other');
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/listings/${l.listingId}`,
          headers: bearer(other.apiKey),
          payload: {title: 'Not mine to change'},
        })
      ).statusCode,
    ).toBe(403);
  });

  it('cancels before selection, rejecting live bids with the reason', async () => {
    const client = await agent(app, 'cx-client');
    const worker = await agent(app, 'cx-worker');
    const l = await posted(client.apiKey);
    await apply(worker.apiKey, l.listingId);
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/listings/${l.listingId}`,
      headers: bearer(client.apiKey),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().status).toBe('cancelled');
    const seen = (
      await app.inject({url: `/v1/listings/${l.listingId}`, headers: bearer(worker.apiKey)})
    ).json();
    expect(seen.viewer.applications[0]).toMatchObject({status: 'rejected', reopenable: false});
    expect(seen.viewer.applications[0].reason).toContain('cancelled');
    // The reservation is released.
    expect(seen.reservedBaseUnits).toBe('0');
  });

  it('close sets pending bids aside as reopenable; reopen revives exactly those', async () => {
    const client = await agent(app, 'cl-client');
    const a = await agent(app, 'cl-a');
    const b = await agent(app, 'cl-b');
    const l = await posted(client.apiKey);
    const bidA = (await apply(a.apiKey, l.listingId)).json();
    const bidB = (await apply(b.apiKey, l.listingId)).json();
    await decide(client.apiKey, l.listingId, bidB.applicationId, 'reject', 'Not the right fit for this.');

    expect((await action(client.apiKey, l.listingId, 'close')).json().status).toBe('closed');
    expect((await apply(await agent(app, 'cl-late').then((x) => x.apiKey), l.listingId)).statusCode).toBe(
      409,
    );
    const list = async () =>
      (
        await app.inject({url: `/v1/listings/${l.listingId}/applications`, headers: bearer(client.apiKey)})
      ).json().applications as {applicationId: string; status: string; reopenable: boolean}[];
    expect((await list()).find((x) => x.applicationId === bidA.applicationId)).toMatchObject({
      status: 'rejected',
      reopenable: true,
    });

    expect((await action(client.apiKey, l.listingId, 'reopen')).json().status).toBe('open');
    const after = await list();
    expect(after.find((x) => x.applicationId === bidA.applicationId)).toMatchObject({
      status: 'pending',
      reopenable: false,
    });
    // A bid the client rejected stays rejected.
    expect(after.find((x) => x.applicationId === bidB.applicationId)!.status).toBe('rejected');
  });

  it('reopens only before the deadline', async () => {
    const client = await agent(app, 'rd-client');
    const l = await posted(client.apiKey);
    await action(client.apiKey, l.listingId, 'close');
    await db.execute(sql`UPDATE listings SET deadline = now() - interval '1 minute'`);
    const res = await action(client.apiKey, l.listingId, 'reopen');
    expect(res.statusCode).toBe(410);
  });

  it('only the client closes or reopens', async () => {
    const client = await agent(app, 'oc-client');
    const other = await agent(app, 'oc-other');
    const l = await posted(client.apiKey);
    expect((await action(other.apiKey, l.listingId, 'close')).statusCode).toBe(403);
  });
});

describe('instant mode', () => {
  it('gives one slot to exactly one of two concurrent claimers', async () => {
    const client = await agent(app, 'in-client');
    const a = await agent(app, 'in-a');
    const b = await agent(app, 'in-b');
    const l = await posted(client.apiKey, {hiringMode: 'instant', maxWorkers: 1});
    const results = await Promise.all([
      action(a.apiKey, l.listingId, 'claim'),
      action(b.apiKey, l.listingId, 'claim'),
    ]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().code).toBe('LIMIT_REACHED');
    // The winner's job is at the ceiling.
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.spend).toBe(40_000n);
    expect((await app.inject({url: `/v1/listings/${l.listingId}`})).json().status).toBe('filled');
    const [{n}] = (await db.execute(sql`SELECT count(*)::int AS n FROM jobs`)) as unknown as [{n: number}];
    expect(n).toBe(1);
  });

  it('answers a retried claim with the same job, refuses claims on an application listing and after the deadline', async () => {
    const client = await agent(app, 'in2-client');
    const a = await agent(app, 'in2-a');
    const l = await posted(client.apiKey, {hiringMode: 'instant', maxWorkers: 2});
    const first = (await action(a.apiKey, l.listingId, 'claim')).json();
    const again = await action(a.apiKey, l.listingId, 'claim');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({replayed: true, job: {jobId: first.job.jobId}});
    expect(submitted).toHaveLength(1);

    const bids = await posted(client.apiKey);
    expect((await action(a.apiKey, bids.listingId, 'claim')).statusCode).toBe(409);
    expect((await apply(a.apiKey, l.listingId)).statusCode).toBe(409);

    const late = await agent(app, 'in2-late');
    await db.execute(
      sql`UPDATE listings SET deadline = now() - interval '1 minute' WHERE public_id = ${l.listingId}`,
    );
    expect((await action(late.apiKey, l.listingId, 'claim')).statusCode).toBe(410);
  });
});

describe('the board', () => {
  it('filters on the server and matches the caller by skills and city-first location', async () => {
    const client = await agent(app, 'bd-client');
    await posted(client.apiKey, {title: 'Berlin photos job', skills: ['photography'], location: 'Berlin'});
    await posted(client.apiKey, {title: 'Paris photos job', skills: ['photography'], location: 'Paris, FR'});
    await posted(client.apiKey, {
      title: 'Anywhere review job',
      category: 'judgment',
      interactionMode: 'task',
      skills: [],
      location: '',
    });
    const p = await person(app, 'bd-worker', {location: 'Paris', capabilities: ['photography']});

    const titles = async (q: string, token?: string) =>
      (
        (await app.inject({url: `/v1/listings${q}`, ...(token ? {headers: bearer(token)} : {})})).json()
          .listings as {
          title: string;
        }[]
      )
        .map((x) => x.title)
        .sort();
    expect(await titles('')).toHaveLength(3);
    expect(await titles('?category=judgment')).toEqual(['Anywhere review job']);
    expect(await titles('?skill=photography')).toEqual(['Berlin photos job', 'Paris photos job']);
    expect(await titles('?location=Berlin')).toEqual(['Anywhere review job', 'Berlin photos job']);
    expect(await titles('?match=me', p.token)).toEqual(['Anywhere review job', 'Paris photos job']);
    expect((await app.inject({url: '/v1/listings?match=me'})).statusCode).toBe(401);
    expect(await titles('?mine=true', client.apiKey)).toHaveLength(3);
  });

  it('pages newest first with a cursor', async () => {
    const client = await agent(app, 'pg-client');
    for (let i = 0; i < 3; i++)
      await posted(client.apiKey, {title: `Paged listing ${i}`, maxWorkers: 1, maxPriceBaseUnits: '20000'});
    const first = (await app.inject({url: '/v1/listings?limit=2'})).json();
    expect(first.listings.map((l: {title: string}) => l.title)).toEqual([
      'Paged listing 2',
      'Paged listing 1',
    ]);
    const second = (await app.inject({url: `/v1/listings?limit=2&cursor=${first.nextCursor}`})).json();
    expect(second.listings.map((l: {title: string}) => l.title)).toEqual(['Paged listing 0']);
    expect(second.nextCursor).toBeNull();
  });
});
