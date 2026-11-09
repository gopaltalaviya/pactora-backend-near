import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {accountStanding, createDb, closeDb, identityVerifications, type Db} from '@pactora/db';
import {open, parseSecretKey} from '@pactora/service';
import {buildApp, EventBus} from '../src/app.js';
import type {ChainViewer} from '../src/chain-reads.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, person, purses} from './helpers/people.js';

/**
 * Live-probe and UI-audit fixes (2026-11-09): a cleared sanctions hold no
 * longer blocks the identity check; a person's row is public only through a
 * published profile; reviewers read the dispute list when the arbiter is a
 * plain account; a webhook's secret rotates; a party sees whether the other
 * side is in good standing (a yes/no); a worker the chain calls not hireable
 * cannot be selected; an unfunded selection can be released.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});
const PACTORA = config.chain('near:sandbox').contracts.Pactora;
const KEY = parseSecretKey('72464bbd8c9347b2a1c1c7f400e27dd662a5fd36ff4f8ccca97a05d0ad9b965d');

let app: FastifyInstance;
let db: Db;
let arbiter: string | null = 'arbiter.test.near';
let reviewers: string[] = [];
/** Per contract agent id: what `stake_of` reports; absent → hireable. */
const stakes = new Map<string, {hireable: boolean} | null>();
const view: ChainViewer = async (_c, contract, method, args) => {
  if (contract === PACTORA && method === 'get_roles') return {arbiter, owner: 'test.near'};
  if (contract === PACTORA && method === 'stake_of') {
    const id = String((args as {agent_id: number}).agent_id);
    return stakes.has(id) ? stakes.get(id) : {locked: '0', unlocked: '1000000', hireable: true};
  }
  if (method === 'get_policy') return null; // the plain-account arbiter has no policy
  throw new Error(`no such view ${contract}.${method}`);
};

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
    webhookSecretKey: KEY,
    viewChain: view,
    adminCouncilCacheMs: 0,
    get complianceReviewers() {
      return reviewers;
    },
    submit: async () => ({txHash: 'unused'}),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  purses.clear();
  stakes.clear();
  reviewers = [];
  arbiter = 'arbiter.test.near';
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, sessions, login_challenges, listings, applications, listing_slots, agent_events, agent_event_seq, public_profiles, account_standing, identity_verifications, webhooks, webhook_deliveries RESTART IDENTITY CASCADE`,
  );
});

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
let n = 0;
async function postListing(token: string, over: Record<string, unknown> = {}) {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: {...bearer(token), 'idempotency-key': `pf-key-${++n}`},
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
      ...over,
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as {listingId: string}).listingId;
}
const apply = async (token: string, listingId: string) => {
  const r = await app.inject({
    method: 'POST',
    url: `/v1/listings/${listingId}/applications`,
    headers: bearer(token),
    payload: {action: 'apply', priceBaseUnits: '30000', proposal: 'I can do this today, with a good camera.'},
  });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as {applicationId: string}).applicationId;
};
const decide = (token: string, listingId: string, applicationId: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/listings/${listingId}/decide`,
    headers: bearer(token),
    payload: {applicationId, action: 'select', reason: 'Fits the brief well enough.'},
  });

describe('a cleared sanctions hold (UI audit A)', () => {
  it('no longer blocks the identity check: GET /v1/kyc closes the held row and start opens a fresh one', async () => {
    const p = await person(app, `pf-kyc${++n}`);
    const [{id}] = (await db.execute(
      sql`SELECT id FROM agents WHERE public_id = ${p.publicId}`,
    )) as unknown as [{id: number}];
    // As screening left it: a held verification and standing on hold, then the reviewers cleared the standing.
    await db
      .insert(identityVerifications)
      .values({agentId: Number(id), provider: 'simulated', legalName: 'Abu Abbas', status: 'held'});
    await db
      .insert(accountStanding)
      .values({agentId: Number(id), standing: 'clear', reason: 'cleared by review'});
    const k = (await app.inject({method: 'GET', url: '/v1/kyc', headers: bearer(p.token)})).json();
    expect(k.standing).toBe('clear');
    expect(k.verification.status).toBe('expired');
    // While the hold stands, the held row is kept as is.
    const q = await person(app, `pf-kyc${++n}`);
    const [{id: qid}] = (await db.execute(
      sql`SELECT id FROM agents WHERE public_id = ${q.publicId}`,
    )) as unknown as [{id: number}];
    await db
      .insert(identityVerifications)
      .values({agentId: Number(qid), provider: 'simulated', legalName: 'Abu Abbas', status: 'held'});
    await db.insert(accountStanding).values({agentId: Number(qid), standing: 'hold', reason: 'under review'});
    expect(
      (await app.inject({method: 'GET', url: '/v1/kyc', headers: bearer(q.token)})).json().verification
        .status,
    ).toBe('held');
  });
});

describe("a person's row (live probe 6)", () => {
  it('is 404 on GET /v1/agents/:id and /trust until their profile is published, then shows only what the profile shows', async () => {
    const p = await person(app, `pf-priv${++n}`);
    const [{id}] = (await db.execute(
      sql`SELECT id FROM agents WHERE public_id = ${p.publicId}`,
    )) as unknown as [{id: number}];
    expect((await app.inject({url: `/v1/agents/${id}`})).statusCode).toBe(404);
    expect((await app.inject({url: `/v1/agents/${id}/trust`})).statusCode).toBe(404);
    await app.inject({
      method: 'PUT',
      url: '/v1/me/profile',
      headers: bearer(p.token),
      payload: {displayName: 'Robin R.', published: true},
    });
    const shown = await app.inject({url: `/v1/agents/${id}`});
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toMatchObject({kind: 'person', name: 'Robin R.', profileId: p.publicId});
    expect(shown.body).not.toContain(p.account);
    expect((await app.inject({url: `/v1/agents/${id}/trust`})).statusCode).toBe(200);
    // The profile says whether they can be hired, from the chain's stake_of (live probe 14b).
    expect((await app.inject({url: `/v1/profiles/${p.publicId}`})).json()).toMatchObject({
      hireable: true,
      stake: '1000000',
    });
    stakes.set(p.chainAgentId, null);
    const q = await person(app, `pf-priv-q${n}`);
    stakes.set(q.chainAgentId, null);
    await app.inject({
      method: 'PUT',
      url: '/v1/me/profile',
      headers: bearer(q.token),
      payload: {displayName: 'Q', published: true},
    });
    expect((await app.inject({url: `/v1/profiles/${q.publicId}`})).json()).toMatchObject({
      hireable: false,
      stake: '0',
    });
    await app.inject({
      method: 'PUT',
      url: '/v1/me/profile',
      headers: bearer(p.token),
      payload: {displayName: 'Robin R.', published: true, showAccount: true},
    });
    expect((await app.inject({url: `/v1/agents/${id}`})).json().ownerAddress).toBe(p.account);
    // Agents stay public as before.
    const a = await agent(app, `pf-priv-a${n}`);
    expect((await app.inject({url: `/v1/agents/${a.agentId}`})).statusCode).toBe(200);
  });
});

describe('the dispute desk with a plain-account arbiter (live probe 14)', () => {
  it('lets a compliance reviewer read the list, read-only, instead of refusing everyone', async () => {
    const r = await person(app, `pf-rev${++n}`);
    reviewers = [r.account];
    const list = await app.inject({url: '/v1/admin/disputes', headers: bearer(r.token)});
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject({
      arbiterDao: null,
      arbiter: 'arbiter.test.near',
      readOnly: true,
      disputes: [],
    });
    expect((await app.inject({url: '/v1/admin/me', headers: bearer(r.token)})).json()).toMatchObject({
      arbiter: 'arbiter.test.near',
      roles: ['reviewer'],
    });
    const stranger = await person(app, `pf-str${n}`);
    expect((await app.inject({url: '/v1/admin/disputes', headers: bearer(stranger.token)})).statusCode).toBe(
      403,
    );
  });
});

describe('webhook secret rotation (live probe 14)', () => {
  it('answers a new secret once and the row holds only the new one', async () => {
    const a = await agent(app, `pf-hook${++n}`);
    const made = (
      await app.inject({
        method: 'POST',
        url: '/v1/webhooks',
        headers: bearer(a.apiKey),
        payload: {url: 'https://93.184.216.34/hook'},
      })
    ).json();
    const rotated = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/${made.webhookId}/rotate`,
      headers: bearer(a.apiKey),
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.json().secret).toMatch(/^whsec_/);
    expect(rotated.json().secret).not.toBe(made.secret);
    const [{secret_enc}] = (await db.execute(sql`SELECT secret_enc FROM webhooks`)) as unknown as [
      {secret_enc: string},
    ];
    expect(open(KEY, secret_enc, `webhook:${made.webhookId}`)).toBe(rotated.json().secret);
    const other = await agent(app, `pf-hook-o${n}`);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/webhooks/${made.webhookId}/rotate`,
          headers: bearer(other.apiKey),
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('counterparty standing as a yes/no (live probe 14)', () => {
  it('the client sees it per applicant, the applicant for the client, never the reason', async () => {
    const client = await agent(app, `pf-cc${++n}`);
    const w = await agent(app, `pf-cw${n}`, {capabilities: ['photography']});
    const listingId = await postListing(client.apiKey);
    await apply(w.apiKey, listingId);
    await db.insert(accountStanding).values({
      agentId: w.agentId,
      standing: 'hold',
      reason: 'a strong sanctions-list match is under review',
    });
    const apps = (
      await app.inject({url: `/v1/listings/${listingId}/applications`, headers: bearer(client.apiKey)})
    ).json();
    expect(apps.applications[0].applicant.counterpartyClear).toBe(false);
    expect(JSON.stringify(apps)).not.toContain('sanctions');
    const mine = (await app.inject({url: `/v1/listings/${listingId}`, headers: bearer(w.apiKey)})).json();
    expect(mine.viewer.counterpartyClear).toBe(true);
  });
});

describe('a worker the chain reports as not hireable (live probe 2)', () => {
  it('cannot be selected (409 AGENT_NOT_HIREABLE, nothing taken), and an unfunded selection can be released', async () => {
    const client = await person(app, `pf-hc${++n}`);
    const w = await agent(app, `pf-hw${n}`, {capabilities: ['photography']});
    const other = await agent(app, `pf-ho${n}`, {capabilities: ['photography']});
    const listingId = await postListing(client.token);
    const bid = await apply(w.apiKey, listingId);
    const otherBid = await apply(other.apiKey, listingId);
    stakes.set(w.chainAgentId, {hireable: false});
    const refused = await decide(client.token, listingId, bid);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe('AGENT_NOT_HIREABLE');
    const after = (
      await app.inject({url: `/v1/listings/${listingId}`, headers: bearer(client.token)})
    ).json();
    expect(after).toMatchObject({status: 'open', slotsFilled: 0});

    // A hireable worker is selected; the person client never signs, so the job has no chain id.
    const sel = await decide(client.token, listingId, otherBid);
    expect(sel.statusCode, sel.body).toBe(200);
    expect(sel.json().funding.done).toBe(false);
    expect((await app.inject({url: `/v1/listings/${listingId}`})).json().status).toBe('filled');
    const un = await app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/unselect`,
      headers: bearer(client.token),
      payload: {applicationId: otherBid},
    });
    expect(un.statusCode, un.body).toBe(200);
    expect(un.json()).toMatchObject({released: true, reopened: true, application: {status: 'rejected'}});
    expect((await app.inject({url: `/v1/listings/${listingId}`})).json()).toMatchObject({
      status: 'open',
      slotsFilled: 0,
    });
    const [{c}] = (await db.execute(sql`SELECT count(*)::int AS c FROM jobs`)) as unknown as [{c: number}];
    expect(c).toBe(0);
    // The hold-free bid set aside by the fill is live again; the released one is not.
    const list = (
      await app.inject({url: `/v1/listings/${listingId}/applications`, headers: bearer(client.token)})
    ).json();
    expect(
      list.applications.map((a: {applicationId: string; status: string}) => [
        a.applicationId === bid,
        a.status,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [true, 'pending'],
        [false, 'rejected'],
      ]),
    );
  });
});
