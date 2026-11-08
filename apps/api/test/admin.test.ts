import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {eq, sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {
  agents,
  closeDb,
  complianceAudit,
  createDb,
  jobEvents,
  jobs,
  partyReviews,
  sessions,
  type Db,
} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import type {ChainViewer} from '../src/chain-reads.js';
import {PROPOSAL_BOND_YOCTO, rulingKind, rulingOf} from '../src/routes/admin.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, fakeReadTxEvents, person} from './helpers/people.js';

/**
 * The admin console API (docs/26 F15) against a fake chain that answers like
 * Pactora (`get_roles`) and a Sputnik DAO (`get_policy`, proposals). Who is
 * council is read from it on every request.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});
const PACTORA = config.chain('near:sandbox').contracts.Pactora;
const DAO = 'arbiter-dao.test.near';

let app: FastifyInstance;
let db: Db;
let arbiter = DAO;
let councilMembers: string[] = [];
let daoProposals: {
  id: number;
  proposer: string;
  description: string;
  kind: unknown;
  status: string;
  votes: Record<string, string>;
}[] = [];
let reviewers: string[] = [];

const view: ChainViewer = async (_chain, contract, method) => {
  if (contract === PACTORA && method === 'get_roles') return {arbiter, owner: 'test.near'};
  if (contract === DAO && method === 'get_policy')
    return {
      roles: [
        {name: 'council', kind: {Group: councilMembers}, permissions: ['*:AddProposal', '*:VoteApprove']},
      ],
    };
  if (contract === DAO && method === 'get_last_proposal_id') return daoProposals.length;
  if (contract === DAO && method === 'get_proposals') return daoProposals;
  throw new Error(`no such view ${contract}.${method}`);
};

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
    viewChain: view,
    adminCouncilCacheMs: 0,
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
  arbiter = DAO;
  councilMembers = [];
  daoProposals = [];
  reviewers = [];
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, sessions, login_challenges, registration_challenges, api_keys, party_reviews RESTART IDENTITY CASCADE`,
  );
});

let n = 0;
const get = (token: string, url: string) => app.inject({method: 'GET', url, headers: bearer(token)});
const post = (token: string, url: string, payload: Record<string, unknown>) =>
  app.inject({method: 'POST', url, headers: bearer(token), payload});

async function disputed(chainJobId = 77) {
  const c = await agent(app, `ac${++n}`);
  const w = await agent(app, `aw${n}`);
  const [j] = await db
    .insert(jobs)
    .values({
      chainId: 'near:sandbox',
      chainJobId: String(chainJobId),
      clientAgentId: c.agentId,
      workerAgentId: w.agentId,
      path: 'escrow',
      amount: '20000',
      spec: {capability: 'market-research'},
      specHash: 'ab'.repeat(32),
      state: 'disputed',
      resultHash: 'cd'.repeat(32),
    })
    .returning({id: jobs.id, publicId: jobs.publicId});
  await db.insert(jobEvents).values({
    chainId: 'near:sandbox',
    jobId: j!.id,
    kind: 'job.disputed',
    payload: {reason: 'The report is about the wrong token.', reasonHash: 'ef'.repeat(32)},
  });
  return j!;
}

/** A signed-in council member (the fake DAO lists them). */
async function member() {
  const p = await person(app, `council${++n}`);
  councilMembers.push(p.account);
  return p;
}

describe('who is admin is read from the chain, every time', () => {
  it('a council member of the arbiter DAO, and a reviewer, and nobody else', async () => {
    const m = await member();
    const r = await person(app, `rev${++n}`);
    reviewers = [r.account];
    const nobody = await person(app, `no${++n}`);
    expect((await get(m.token, '/v1/admin/me')).json()).toMatchObject({roles: ['council'], arbiterDao: DAO});
    expect((await get(r.token, '/v1/admin/me')).json()).toMatchObject({roles: ['reviewer']});
    expect((await get(nobody.token, '/v1/admin/me')).statusCode).toBe(403);
    // A reviewer is not council.
    expect((await get(r.token, '/v1/admin/disputes')).statusCode).toBe(403);
    // An agent key is never admin.
    const a = await agent(app, `ak${++n}`);
    expect((await get(a.apiKey, '/v1/admin/me')).statusCode).toBe(401);
  });

  it('leaving the council takes effect on the next request', async () => {
    const m = await member();
    expect((await get(m.token, '/v1/admin/me')).statusCode).toBe(200);
    councilMembers = [];
    expect((await get(m.token, '/v1/admin/me')).statusCode).toBe(403);
  });

  it('a plain-account arbiter has no council: no one rules through the desk', async () => {
    arbiter = 'arbiter.test.near';
    const m = await person(app, `plain${++n}`);
    councilMembers = [m.account];
    expect((await get(m.token, '/v1/admin/disputes')).statusCode).toBe(403);
  });

  it('an admin sign-in older than an hour must be renewed', async () => {
    const m = await member();
    const [s] = await db
      .select()
      .from(sessions)
      .orderBy(sql`id DESC`)
      .limit(1);
    await db
      .update(sessions)
      .set({createdAt: new Date(Date.now() - 61 * 60 * 1000)})
      .where(eq(sessions.id, s!.id));
    const r = await get(m.token, '/v1/admin/me');
    expect(r.statusCode).toBe(401);
    expect(r.json().detail).toMatch(/less than an hour old/);
  });
});

describe('the dispute desk', () => {
  it('lists disputes and shows the evidence with a hash that changes when the evidence does', async () => {
    const m = await member();
    const j = await disputed();
    const list = (await get(m.token, '/v1/admin/disputes')).json();
    expect(list.disputes.map((d: {jobId: string}) => d.jobId)).toEqual([j.publicId]);
    const d1 = (await get(m.token, `/v1/admin/disputes/${j.publicId}`)).json();
    expect(d1).toMatchObject({state: 'disputed', disputeReason: 'The report is about the wrong token.'});
    expect(d1.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await get(m.token, `/v1/admin/disputes/${j.publicId}`)).json().evidenceHash).toBe(
      d1.evidenceHash,
    );
    await db
      .update(jobs)
      .set({resultHash: '99'.repeat(32)})
      .where(eq(jobs.id, j.id));
    expect((await get(m.token, `/v1/admin/disputes/${j.publicId}`)).json().evidenceHash).not.toBe(
      d1.evidenceHash,
    );
  });

  it('builds the exact add_proposal call, bound to the evidence it saw; a stale hash is refused', async () => {
    const m = await member();
    const j = await disputed(77);
    const ev = (await get(m.token, `/v1/admin/disputes/${j.publicId}`)).json().evidenceHash;
    const r = await post(m.token, `/v1/admin/disputes/${j.publicId}/proposal`, {
      forWorker: false,
      evidenceHash: ev,
    });
    expect(r.statusCode, r.body).toBe(200);
    const fc = r.json().functionCall;
    expect(fc).toMatchObject({
      receiverId: DAO,
      methodName: 'add_proposal',
      deposit: PROPOSAL_BOND_YOCTO,
      gas: String(100n * 10n ** 12n),
    });
    expect(fc.args.proposal.description).toContain(j.publicId);
    expect(fc.args.proposal.description).toContain(ev);
    expect(rulingOf(fc.args.proposal.kind, PACTORA)).toEqual({jobId: 77, forWorker: false});
    expect(fc.args.proposal.kind).toEqual(rulingKind(PACTORA, 77, false));

    const stale = await post(m.token, `/v1/admin/disputes/${j.publicId}/proposal`, {
      forWorker: true,
      evidenceHash: '0'.repeat(64),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().detail).toMatch(/stale evidence/);
    const audits = await db
      .select()
      .from(complianceAudit)
      .where(eq(complianceAudit.action, 'admin.proposal.built'));
    expect(audits.at(-1)!.actor).toBe(m.account);
  });

  it('lists the DAO proposals for this job only, and builds a vote on the kind the chain holds', async () => {
    const m = await member();
    const j = await disputed(77);
    daoProposals = [
      {
        id: 0,
        proposer: m.account,
        description: 'other job',
        kind: rulingKind(PACTORA, 12, true),
        status: 'InProgress',
        votes: {},
      },
      {
        id: 1,
        proposer: m.account,
        description: 'this job',
        kind: rulingKind(PACTORA, 77, false),
        status: 'InProgress',
        votes: {[m.account]: 'Approve'},
      },
      {
        id: 2,
        proposer: m.account,
        description: 'not a ruling',
        kind: {Transfer: {receiver_id: 'x', amount: '1'}},
        status: 'InProgress',
        votes: {},
      },
      {
        id: 3,
        proposer: m.account,
        description: 'other contract',
        kind: rulingKind('evil.test.near', 77, true),
        status: 'InProgress',
        votes: {},
      },
      {
        id: 4,
        proposer: m.account,
        description: 'done',
        kind: rulingKind(PACTORA, 77, true),
        status: 'Rejected',
        votes: {},
      },
    ];
    const ps = (await get(m.token, `/v1/admin/disputes/${j.publicId}/proposals`)).json();
    expect(ps.proposals.map((p: {id: number}) => p.id)).toEqual([1, 4]);
    expect(ps.proposals[0]).toMatchObject({forWorker: false, youVoted: 'Approve'});

    const v = (
      await post(m.token, `/v1/admin/disputes/${j.publicId}/proposals/1/vote`, {action: 'VoteApprove'})
    ).json();
    expect(v.functionCall).toMatchObject({receiverId: DAO, methodName: 'act_proposal', deposit: '0'});
    expect(v.functionCall.args).toEqual({id: 1, action: 'VoteApprove', proposal: daoProposals[1]!.kind});
    expect(
      (await post(m.token, `/v1/admin/disputes/${j.publicId}/proposals/4/vote`, {action: 'VoteApprove'}))
        .statusCode,
    ).toBe(409);
    expect(
      (await post(m.token, `/v1/admin/disputes/${j.publicId}/proposals/0/vote`, {action: 'VoteApprove'}))
        .statusCode,
    ).toBe(404);
    expect(
      (await post(m.token, `/v1/admin/disputes/${j.publicId}/proposals/1/vote`, {action: 'Finalize'}))
        .statusCode,
    ).toBe(422);
  });

  it('a file is shown to the council only for a disputed job', async () => {
    const m = await member();
    const r = await get(m.token, '/v1/admin/files/00000000-0000-4000-8000-000000000001');
    expect(r.statusCode).toBe(404);
  });
});

describe('moderation', () => {
  it('a reviewer or council member hides a review with a reason, and it is audited', async () => {
    const r = await person(app, `mod${++n}`);
    reviewers = [r.account];
    const c = await agent(app, `mc${++n}`);
    const w = await agent(app, `mw${n}`);
    const [j] = await db
      .insert(jobs)
      .values({
        chainId: 'near:sandbox',
        clientAgentId: c.agentId,
        workerAgentId: w.agentId,
        path: 'escrow',
        amount: '1',
        spec: {},
        specHash: 'ab'.repeat(32),
        state: 'settled',
        settledAt: new Date(),
      })
      .returning();
    const [rev] = await db
      .insert(partyReviews)
      .values({
        jobId: j!.id,
        authorAgentId: c.agentId,
        subjectAgentId: w.agentId,
        authorRole: 'client',
        rating: 1,
        body: 'Abusive words go here.',
      })
      .returning();
    expect((await post(r.token, `/v1/admin/reviews/${rev!.publicId}/hide`, {reason: 'x'})).statusCode).toBe(
      422,
    );
    const hidden = await post(r.token, `/v1/admin/reviews/${rev!.publicId}/hide`, {
      reason: 'abusive language',
    });
    expect(hidden.json()).toEqual({reviewId: rev!.publicId, hidden: true});
    const list = (await get(r.token, '/v1/admin/reviews')).json();
    expect(list.reviews[0]).toMatchObject({hidden: true, hiddenReason: 'abusive language'});
    const stranger = await person(app, `st${++n}`);
    expect(
      (await post(stranger.token, `/v1/admin/reviews/${rev!.publicId}/hide`, {reason: 'because'})).statusCode,
    ).toBe(403);
    void agents;
  });
});
