import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import type {ChainViewer} from '../src/chain-reads.js';
import {agentModeOf} from '../src/routes/meta.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, person} from './helpers/people.js';

/**
 * Read fields the interface builds against (2026-11-10): an agent renames
 * itself; GET /v1/me/agents; whether each bidder is hireable on chain; a
 * job's deadlines from the chain; the network's agent mode; discovery's
 * limit clamped rather than refused.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});
const PACTORA = config.chain('near:sandbox').contracts.Pactora;

let app: FastifyInstance;
let db: Db;
/** Per contract agent id: what `stake_of` reports; absent → hireable; 'throw' → the read fails. */
const stakes = new Map<string, {hireable: boolean} | null | 'throw'>();
/** Per contract job id: what `get_job` reports. */
const chainJobs = new Map<string, Record<string, unknown> | 'throw'>();
const view: ChainViewer = async (_c, contract, method, args) => {
  if (contract === PACTORA && method === 'stake_of') {
    const id = String((args as {agent_id: number}).agent_id);
    const s = stakes.get(id);
    if (s === 'throw') throw new Error('rpc down');
    return stakes.has(id) ? s : {locked: '0', unlocked: '100000000', hireable: true};
  }
  if (contract === PACTORA && method === 'get_job') {
    const j = chainJobs.get(String((args as {job_id: number}).job_id));
    if (j === 'throw') throw new Error('rpc down');
    return j ?? null;
  }
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
    viewChain: view,
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
  stakes.clear();
  chainJobs.clear();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, sessions, login_challenges, listings, applications, listing_slots, agent_events, agent_event_seq, account_standing RESTART IDENTITY CASCADE`,
  );
});

let n = 0;

describe('PATCH /v1/agents/:id — rename', () => {
  it('takes a name (as registration validates it) and answers name and description', async () => {
    const a = await agent(app, `rd-rename${++n}`);
    const patch = (payload: Record<string, unknown>) =>
      app.inject({method: 'PATCH', url: `/v1/agents/${a.agentId}`, headers: bearer(a.apiKey), payload});
    const res = await patch({name: 'Renamed Researcher'});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      agentId: a.agentId,
      name: 'Renamed Researcher',
      description: null,
      active: true,
    });
    const read = await app.inject({url: `/v1/agents/${a.agentId}`});
    expect(read.json().name).toBe('Renamed Researcher');

    const both = await patch({name: 'Again', description: 'Market research, done quickly.'});
    expect(both.json()).toMatchObject({name: 'Again', description: 'Market research, done quickly.'});
    expect((await patch({name: ''})).statusCode).toBe(422);
    expect((await patch({name: 'x'.repeat(65)})).statusCode).toBe(422);
  });
});

describe('GET /v1/me/agents', () => {
  it("lists the agents a session's account owns, person included", async () => {
    const p = await person(app, `rd-owner${++n}`);
    const mine = await agent(app, `rd-mine${n}`, {
      ownerAddress: p.account,
      capabilities: ['market-research'],
    });
    await agent(app, `rd-theirs${n}`);
    const res = await app.inject({url: '/v1/me/agents', headers: bearer(p.token)});
    expect(res.statusCode, res.body).toBe(200);
    const agents = (res.json() as {agents: Record<string, unknown>[]}).agents;
    expect(agents).toHaveLength(2);
    const a = agents.find((x) => x['kind'] === 'agent')!;
    expect(a).toEqual({
      agentId: String(mine.agentId),
      chainAgentId: mine.chainAgentId,
      name: `rd-mine${n}`,
      kind: 'agent',
      active: true,
      capabilities: ['market-research'],
      pricePerTask: '20000',
    });
    expect(agents.find((x) => x['kind'] === 'person')).toMatchObject({
      chainAgentId: p.chainAgentId,
      kind: 'person',
      active: false,
    });
  });

  it("for a key: the agents of the key's agent's owner", async () => {
    const one = await agent(app, `rd-k1${++n}`);
    const owner = (
      (await db.execute(sql`SELECT owner_address FROM agents WHERE id = ${one.agentId}`)) as unknown as {
        owner_address: string;
      }[]
    )[0]!.owner_address;
    const two = await agent(app, `rd-k2${n}`, {ownerAddress: owner});
    await agent(app, `rd-k3${n}`);
    const res = await app.inject({url: '/v1/me/agents', headers: bearer(one.apiKey)});
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as {agents: {agentId: string}[]}).agents.map((a) => a.agentId).sort()).toEqual(
      [String(one.agentId), String(two.agentId)].sort(),
    );
  });

  it('refuses no credential', async () => {
    expect((await app.inject({url: '/v1/me/agents'})).statusCode).toBe(401);
  });
});

describe('application rows say whether the bidder is hireable on chain', () => {
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
  async function listingWithBids() {
    const client = await person(app, `rd-lc${++n}`);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/listings',
      headers: {...bearer(client.token), 'idempotency-key': `rd-listing-${n}`},
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
    const listingId = (r.json() as {listingId: string}).listingId;
    const bidders = [];
    for (const label of ['ok', 'no', 'err']) {
      const w = await agent(app, `rd-w${label}${n}`, {capabilities: ['photography']});
      const b = await app.inject({
        method: 'POST',
        url: `/v1/listings/${listingId}/applications`,
        headers: bearer(w.apiKey),
        payload: {
          action: 'apply',
          priceBaseUnits: '30000',
          proposal: 'I can do this today, with a good camera.',
        },
      });
      expect(b.statusCode, b.body).toBe(201);
      bidders.push(w);
    }
    stakes.set(bidders[1]!.chainAgentId, {hireable: false});
    stakes.set(bidders[2]!.chainAgentId, 'throw');
    return {client, listingId, bidders};
  }

  it("in the owner's GET /v1/listings/:id/applications: true, false, or null when the chain cannot be read", async () => {
    const {client, listingId, bidders} = await listingWithBids();
    const res = await app.inject({
      url: `/v1/listings/${listingId}/applications`,
      headers: bearer(client.token),
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = (res.json() as {applications: {hireable: boolean | null; applicant: {agentId: string}}[]})
      .applications;
    const of = (id: number) => rows.find((r) => r.applicant.agentId === String(id))!.hireable;
    expect(of(bidders[0]!.agentId)).toBe(true);
    expect(of(bidders[1]!.agentId)).toBe(false);
    expect(of(bidders[2]!.agentId)).toBeNull();
  });

  it("in the listing detail's applications (the bidder's own view)", async () => {
    const {listingId, bidders} = await listingWithBids();
    const read = async (key: string) =>
      (
        (await app.inject({url: `/v1/listings/${listingId}`, headers: bearer(key)})).json() as {
          viewer: {applications: {hireable: boolean | null}[]};
        }
      ).viewer.applications[0]!.hireable;
    expect(await read(bidders[0]!.apiKey)).toBe(true);
    expect(await read(bidders[1]!.apiKey)).toBe(false);
    expect(await read(bidders[2]!.apiKey)).toBeNull();
  });
});

describe('GET /v1/jobs/:id — deadlines', () => {
  async function jobIn(state: string, chainJobId: string | null): Promise<string> {
    const c = await agent(app, `rd-jc${++n}`);
    const w = await agent(app, `rd-jw${n}`);
    const rows = (await db.execute(sql`
      INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash, chain_job_id, state)
      VALUES ('near:sandbox', ${c.agentId}, ${w.agentId}, 'escrow', '20000', ${JSON.stringify({capability: 'market-research', input: {}})}::jsonb,
              ${'ab'.repeat(32)}, ${chainJobId}, ${state})
      RETURNING public_id`)) as unknown as {public_id: string}[];
    return rows[0]!.public_id;
  }
  const T = 1_800_000_000; // seconds, as the contract keeps them
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const onChainJob = (over: Record<string, unknown>) => ({
    id: 0,
    accept_deadline: T,
    work_deadline: T + 1800,
    review_deadline: 0,
    dispute_deadline: 0,
    ...over,
  });
  const deadlinesOf = async (id: string) =>
    ((await app.inject({url: `/v1/jobs/${id}`})).json() as {deadlines: Record<string, string | null>})
      .deadlines;

  it('created: acceptBy and workBy, from get_job', async () => {
    chainJobs.set('101', onChainJob({state: 'Created'}));
    expect(await deadlinesOf(await jobIn('created', '101'))).toEqual({
      acceptBy: iso(T),
      workBy: iso(T + 1800),
      reviewBy: null,
      disputeBy: null,
    });
  });

  it('accepted: workBy only; submitted: reviewBy; disputed: disputeBy', async () => {
    chainJobs.set('102', onChainJob({state: 'Accepted'}));
    expect(await deadlinesOf(await jobIn('accepted', '102'))).toEqual({
      acceptBy: null,
      workBy: iso(T + 1800),
      reviewBy: null,
      disputeBy: null,
    });
    chainJobs.set('103', onChainJob({state: 'Submitted', review_deadline: T + 2000}));
    expect(await deadlinesOf(await jobIn('submitted', '103'))).toEqual({
      acceptBy: null,
      workBy: null,
      reviewBy: iso(T + 2000),
      disputeBy: null,
    });
    chainJobs.set(
      '104',
      onChainJob({state: 'Disputed', review_deadline: T + 2000, dispute_deadline: T + 3000}),
    );
    expect(await deadlinesOf(await jobIn('disputed', '104'))).toEqual({
      acceptBy: null,
      workBy: null,
      reviewBy: null,
      disputeBy: iso(T + 3000),
    });
  });

  it('all null when settled, not on chain yet, or the chain cannot be read', async () => {
    const none = {acceptBy: null, workBy: null, reviewBy: null, disputeBy: null};
    chainJobs.set('105', onChainJob({state: 'Settled', review_deadline: T + 2000}));
    expect(await deadlinesOf(await jobIn('settled', '105'))).toEqual(none);
    expect(await deadlinesOf(await jobIn('created', null))).toEqual(none);
    chainJobs.set('106', 'throw');
    expect(await deadlinesOf(await jobIn('created', '106'))).toEqual(none);
  });
});

describe('GET /v1/network — agentMode', () => {
  it('says whether the agents replay recordings or spend tokens', async () => {
    const res = await app.inject({url: '/v1/network'});
    expect(res.json().agentMode).toBe(agentModeOf(process.env));
    expect(['cached', 'live', 'record']).toContain(res.json().agentMode);
    expect(agentModeOf({})).toBe('cached');
    expect(agentModeOf({AGENT_MODE: 'cached'})).toBe('cached');
    expect(agentModeOf({AGENT_MODE: 'live'})).toBe('live');
  });

  // `record` calls the providers (and saves what they say): it spends
  // tokens, so it must not be reported as `cached` (2026-11-10).
  it('reports record as record, and any other value the way the factory reads it', () => {
    expect(agentModeOf({AGENT_MODE: 'record'})).toBe('record');
    // agent-core's buildBrain replays only for exactly `cached`; anything
    // else reaches the providers, as `live` does.
    expect(agentModeOf({AGENT_MODE: 'something-else'})).toBe('live');
  });
});

describe('GET /v1/agents — limit', () => {
  it('clamps a limit above 100 to 100 instead of refusing it', async () => {
    await agent(app, `rd-disc${++n}`);
    const res = await app.inject({url: '/v1/agents?limit=500'});
    expect(res.statusCode, res.body).toBe(200);
    expect((await app.inject({url: '/v1/agents?limit=0'})).statusCode).toBe(422);
  });
});
