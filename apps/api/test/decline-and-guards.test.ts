import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {accountStanding, createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {addr, chainDeps, signedRegistration} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, person, purses} from './helpers/people.js';

/**
 * 2026-11-09: a person's decline of an assigned job (off chain, the slot
 * given back), the per-owner agent cap (F25), the faucet's standing gate,
 * and "who before what": a stranger acting on a job is 403 even when the
 * state would also have been wrong.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
let jobSeq = 700;
const faucetCalls: string[] = [];

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
    maxAgentsPerOwner: 2,
    faucetSend: async (receiverId) => {
      faucetCalls.push(receiverId);
      return {txHash: `FAUCETTX${faucetCalls.length}`, registered: false, from: 'faucet.test.near'};
    },
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
  faucetCalls.length = 0;
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, listings, applications, listing_slots, agent_events, agent_event_seq, sessions, login_challenges, person_actions, account_standing, faucet_claims RESTART IDENTITY CASCADE`,
  );
});

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
let keySeq = 0;
async function postListing(token: string, over: Record<string, unknown> = {}) {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: {...bearer(token), 'idempotency-key': `dg-key-${++keySeq}`},
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
const prepare = (token: string, jobId: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/person-actions/prepare`,
    headers: bearer(token),
    payload,
  });

describe('a person declines an assigned job', () => {
  it('is off chain, recorded once, and gives the listing slot back so the listing reopens', async () => {
    const client = await agent(app, 'dg-client');
    const w = await person(app, 'dg-worker', {capabilities: ['photography']});
    const other = await agent(app, 'dg-other', {capabilities: ['photography']});
    const {listingId} = await postListing(client.apiKey);
    const bid = await app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/applications`,
      headers: bearer(w.token),
      payload: {
        action: 'apply',
        priceBaseUnits: '30000',
        proposal: 'I can do this today, with a good camera.',
      },
    });
    expect(bid.statusCode, bid.body).toBe(201);
    const otherBid = await app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/applications`,
      headers: bearer(other.apiKey),
      payload: {
        action: 'apply',
        priceBaseUnits: '35000',
        proposal: 'I can do this tomorrow, with a good camera.',
      },
    });
    expect(otherBid.statusCode, otherBid.body).toBe(201);
    const sel = await app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/decide`,
      headers: bearer(client.apiKey),
      payload: {
        applicationId: (bid.json() as {applicationId: string}).applicationId,
        action: 'select',
        reason: 'Fits the brief well enough.',
      },
    });
    expect(sel.statusCode, sel.body).toBe(200);
    const jobId = (sel.json() as {job: {jobId: string}}).job.jobId;
    expect((await app.inject({method: 'GET', url: `/v1/listings/${listingId}`})).json().status).toBe(
      'filled',
    );

    // The client cannot decline: who before what.
    const notWorker = await prepare(w.token, jobId, {action: 'decline', reason: 'x'});
    expect(notWorker.statusCode, notWorker.body).toBe(200);
    const body = notWorker.json() as {offChain: boolean; declined: {reason: string}; functionCall?: unknown};
    expect(body.offChain).toBe(true);
    expect(body.declined.reason).toBe('x');
    expect(body.functionCall).toBeUndefined();

    // Replay: the same answer, one event.
    const again = await prepare(w.token, jobId, {action: 'decline', reason: 'changed my mind'});
    expect(again.statusCode).toBe(200);
    expect((again.json() as {declined: {reason: string}}).declined.reason).toBe('x');
    const job = (await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`})).json() as {
      declined: {reason: string} | null;
      events: {kind: string}[];
      state: string;
    };
    expect(job.declined?.reason).toBe('x');
    expect(job.events.filter((e) => e.kind === 'job.declined')).toHaveLength(1);
    expect(job.state).toBe('created');

    // The slot is free again: the listing reopened and the set-aside bid is live.
    const listing = (
      await app.inject({method: 'GET', url: `/v1/listings/${listingId}`, headers: bearer(client.apiKey)})
    ).json() as {status: string; slotsFilled: number};
    expect(listing).toMatchObject({status: 'open', slotsFilled: 0});
    const apps = (
      await app.inject({
        method: 'GET',
        url: `/v1/listings/${listingId}/applications`,
        headers: bearer(client.apiKey),
      })
    ).json() as {applications: {status: string; priceBaseUnits: string; reason: string | null}[]};
    expect(apps.applications.map((a) => [a.priceBaseUnits, a.status])).toEqual([
      ['35000', 'pending'],
      ['30000', 'rejected'],
    ]);
    expect(apps.applications[1]!.reason).toMatch(/declined/);
    // Nothing to confirm for a decline.
    const confirm = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/person-actions/confirm`,
      headers: bearer(w.token),
      payload: {action: 'decline', txHash: 'Tx' + 'A'.repeat(42)},
    });
    expect(confirm.statusCode).toBe(409);
  });

  it('refuses a stranger with 403 before the state is looked at, for people and agents alike', async () => {
    const client = await agent(app, 'dg2-client');
    const w = await agent(app, 'dg2-worker');
    const stranger = await agent(app, 'dg2-stranger');
    const bystander = await person(app, 'dg2-bystander');
    const h = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {...bearer(client.apiKey), 'idempotency-key': 'dg2-hire-0001'},
      payload: {
        workerAgentId: String(w.agentId),
        spec: {capability: 'market-research', input: {}},
        maxPrice: '20000',
        path: 'escrow',
      },
    });
    expect(h.statusCode, h.body).toBe(201);
    const jobId = (h.json() as {jobId: string}).jobId;
    // `created`: approve/dispute/result would be 409 for the right party; a stranger gets 403.
    for (const action of ['accept', 'result', 'approve', 'dispute', 'cancel', 'decline']) {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/${action}`,
        headers: bearer(stranger.apiKey),
        payload: {reason: 'x', output: {}},
      });
      expect(r.statusCode, `${action}: ${r.body}`).toBe(403);
    }
    for (const action of ['accept', 'submit', 'approve', 'dispute', 'cancel', 'decline']) {
      const r = await prepare(bystander.token, jobId, {action, reason: 'x', output: {}});
      expect(r.statusCode, `${action}: ${r.body}`).toBe(403);
    }
  });
});

describe('the per-owner agent cap (F25)', () => {
  it('refuses the registration past MAX_AGENTS_PER_OWNER with 409 LIMIT_REACHED', async () => {
    const owner = addr('dg-cap-owner');
    for (const i of [1, 2]) {
      const r = await signedRegistration(app, {
        name: `cap-${i}`,
        capabilities: ['market-research'],
        pricePerTask: '20000',
        walletAddress: addr(`dg-cap-wallet-${i}`),
        ownerAddress: owner,
      });
      expect(r.statusCode, r.body).toBe(201);
    }
    const third = await signedRegistration(app, {
      name: 'cap-3',
      capabilities: ['market-research'],
      pricePerTask: '20000',
      walletAddress: addr('dg-cap-wallet-3'),
      ownerAddress: owner,
    });
    expect(third.statusCode).toBe(409);
    expect(third.json()).toMatchObject({code: 'LIMIT_REACHED'});
    expect(third.json().detail).toMatch(/already owns 2 agents/);
  });
});

describe('the faucet and standing', () => {
  it('a held or blocked person cannot claim, and GET says so', async () => {
    const p = await person(app, 'dg-faucet-held');
    const [{id}] = (await db.execute(
      sql`SELECT id FROM agents WHERE owner_address = ${p.account}`,
    )) as unknown as [{id: number}];
    await db.insert(accountStanding).values({agentId: id, standing: 'hold', reason: 'test'});
    const status = (await app.inject({method: 'GET', url: '/v1/faucet', headers: bearer(p.token)})).json();
    expect(status.standing).toBe('hold');
    const r = await app.inject({
      method: 'POST',
      url: '/v1/faucet',
      headers: bearer(p.token),
      remoteAddress: '10.95.0.1',
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().detail).toMatch(/on hold/);
    expect(faucetCalls).toEqual([]);
  });
});
