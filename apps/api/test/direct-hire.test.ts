import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {accountStanding, createDb, closeDb, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import type {ChainViewer} from '../src/chain-reads.js';
import {addr, chainDeps} from './helpers/register.js';
import {
  agent,
  bearer,
  fakeReadBudget,
  fakeReadTxEvents,
  onChainTx,
  person,
  purses,
  txHash,
  txs,
} from './helpers/people.js';

/**
 * A person hires an agent directly (POST /v1/jobs/hire), without a listing:
 * the same guards a person's selection of a bid has, the job row written
 * before the browser signs, and the create_job call handed back to sign
 * through the person-actions prepare/confirm flow.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});
const chain = config.chain('near:sandbox');
const PACTORA = chain.contracts.Pactora;

let app: FastifyInstance;
let db: Db;
/** Per contract agent id: what `stake_of` reports; absent → hireable. */
const stakes = new Map<string, {hireable: boolean} | null>();
const view: ChainViewer = async (_c, contract, method, args) => {
  if (contract === PACTORA && method === 'stake_of') {
    const id = String((args as {agent_id: number}).agent_id);
    return stakes.has(id) ? stakes.get(id) : {locked: '0', unlocked: '100000000', hireable: true};
  }
  throw new Error(`no such view ${contract}.${method}`);
};
let submitted = 0;

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    readBudget: fakeReadBudget,
    readTxEvents: fakeReadTxEvents,
    viewChain: view,
    rateLimitPerMinute: 100_000,
    liveEvents: false,
    draftSettleSweepMs: 0,
    listingExpirySweepMs: 0,
    sessionKeySweepMs: 0,
    retention: {intervalMs: 0},
    submit: async () => {
      submitted++;
      return {txHash: 'unused'};
    },
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  purses.clear();
  stakes.clear();
  txs.clear();
  submitted = 0;
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, token_transfers, registration_challenges, sessions, login_challenges, person_actions, account_standing, agent_events, agent_event_seq RESTART IDENTITY CASCADE`,
  );
});

let n = 0;
const key = () => `direct-hire-${++n}-key`;
const hire = (token: string, payload: Record<string, unknown>) =>
  app.inject({method: 'POST', url: '/v1/jobs/hire', headers: bearer(token), payload});
const body = (workerAgentId: number, over: Record<string, unknown> = {}) => ({
  workerAgentId: String(workerAgentId),
  amount: '20000',
  task: 'Summarise the three most recent NEAR governance proposals in plain English.',
  idempotencyKey: key(),
  ...over,
});
const personAgentId = async (account: string) =>
  (
    (await db.execute(
      sql`SELECT id FROM agents WHERE owner_address = ${account} AND kind = 'person'`,
    )) as unknown as {id: number}[]
  )[0]!.id;
const jobCount = async () =>
  ((await db.execute(sql`SELECT count(*)::int AS n FROM jobs`)) as unknown as [{n: number}])[0].n;

describe('POST /v1/jobs/hire — a person hires an agent directly', () => {
  it('writes the job and answers the create_job call to sign; funding confirms through person-actions', async () => {
    const p = await person(app, 'dh-client');
    const w = await agent(app, 'dh-worker');
    const res = await hire(p.token, body(w.agentId, {capability: 'market-research'}));
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json() as {
      job: {
        jobId: string;
        chainJobId: string | null;
        state: string;
        amount: string;
        amountDisplay: string;
        specHash: string;
        spec: {capability: string; input: Record<string, unknown>};
      };
      funding: {
        by: string;
        done: boolean;
        signerId: string;
        confirm: string;
        functionCall: {receiverId: string; methodName: string; args: Record<string, unknown>};
      };
    };
    expect(out.job).toMatchObject({chainJobId: null, state: 'created', amount: '20000'});
    expect(out.job.amountDisplay).toBe(chain.formatToken(20000n));
    expect(out.job.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.job.spec.capability).toBe('market-research');
    expect(out.job.spec.input).toMatchObject({kind: 'direct', task: expect.stringContaining('governance')});
    expect(out.funding).toMatchObject({
      by: 'person',
      done: false,
      signerId: p.account,
      confirm: `/v1/jobs/${out.job.jobId}/person-actions/confirm`,
    });
    expect(out.funding.functionCall).toMatchObject({receiverId: PACTORA, methodName: 'create_job'});
    expect(out.funding.functionCall.args).toMatchObject({
      client_id: Number(p.chainAgentId),
      worker_id: Number(w.chainAgentId),
      amount: '20000',
      spec_hash: out.job.specHash,
      accept_window: chain.params.acceptWindowSeconds,
      work_window: chain.params.workWindowSeconds,
    });
    // Nothing went to the signer: the person's own wallet funds it.
    expect(submitted).toBe(0);

    // Unfunded, the worker is not offered it yet; the person funds it through the usual flow.
    const offered = async () =>
      (
        (await app.inject({url: '/v1/jobs?role=worker', headers: bearer(w.apiKey)})).json() as {
          jobs: {jobId: string}[];
        }
      ).jobs.map((j) => j.jobId);
    expect(await offered()).not.toContain(out.job.jobId);
    const prep = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${out.job.jobId}/person-actions/prepare`,
      headers: bearer(p.token),
      payload: {action: 'create'},
    });
    expect(prep.statusCode, prep.body).toBe(200);
    expect(prep.json().functionCall).toEqual(out.funding.functionCall);
    const hash = onChainTx(txHash(), p.account, [
      {
        event: 'job_created',
        data: {
          job_id: 77,
          client: Number(p.chainAgentId),
          worker: Number(w.chainAgentId),
          amount: '20000',
          spec_hash: out.job.specHash,
        },
      },
    ]);
    const conf = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${out.job.jobId}/person-actions/confirm`,
      headers: bearer(p.token),
      payload: {action: 'create', txHash: hash},
    });
    expect(conf.statusCode, conf.body).toBe(200);
    expect(conf.json()).toMatchObject({state: 'created', chainJobId: '77'});
    const events = (await db.execute(
      sql`SELECT kind FROM job_events WHERE job_id = (SELECT id FROM jobs WHERE public_id = ${out.job.jobId})`,
    )) as unknown as {kind: string}[];
    expect(events.map((e) => e.kind)).toContain('job.created');
    expect(await offered()).toContain(out.job.jobId);
  });

  it('defaults the capability to one of the worker’s own', async () => {
    const p = await person(app, 'dh-default');
    const w = await agent(app, 'dh-default-worker');
    const res = await hire(p.token, body(w.agentId));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().job.spec.capability).toBe('market-research');
  });

  it('is idempotent on the client and the key: a replay is the same job, another body conflicts', async () => {
    const p = await person(app, 'dh-idem');
    const w = await agent(app, 'dh-idem-worker');
    const b = body(w.agentId);
    const first = await hire(p.token, b);
    expect(first.statusCode, first.body).toBe(201);
    const again = await hire(p.token, b);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().job.jobId).toBe(first.json().job.jobId);
    expect(again.json().job.specHash).toBe(first.json().job.specHash);
    expect(await jobCount()).toBe(1);

    const other = await hire(p.token, {...b, amount: '25000'});
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe('IDEMPOTENCY_CONFLICT');
    const otherTask = await hire(p.token, {...b, task: 'Something else entirely, please.'});
    expect(otherTask.json().code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await jobCount()).toBe(1);
  });

  it('refuses an agent key: agents hire through POST /v1/jobs', async () => {
    const c = await agent(app, 'dh-agent-client');
    const w = await agent(app, 'dh-agent-worker');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/hire',
      headers: {authorization: `Bearer ${c.apiKey}`},
      payload: body(w.agentId),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
    expect(res.json().detail).toBe('direct hire is for people; agents use POST /v1/jobs');
    expect(await jobCount()).toBe(0);
  });

  it('validates the body: task length, key length, a numeric worker id, a base-units amount', async () => {
    const p = await person(app, 'dh-body');
    const w = await agent(app, 'dh-body-worker');
    for (const over of [
      {task: ''},
      {task: 'x'.repeat(2001)},
      {idempotencyKey: 'short'},
      {idempotencyKey: 'k'.repeat(129)},
      {workerAgentId: 'abc'},
      {amount: '1.5'},
    ]) {
      const res = await hire(p.token, body(w.agentId, over));
      expect(res.statusCode, JSON.stringify(over)).toBe(422);
    }
    expect(await jobCount()).toBe(0);
  });

  it('refuses a person on hold', async () => {
    const p = await person(app, 'dh-held');
    const w = await agent(app, 'dh-held-worker');
    await db.insert(accountStanding).values({
      agentId: await personAgentId(p.account),
      standing: 'hold',
      reason: 'direct hire test',
    });
    const res = await hire(p.token, body(w.agentId));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
    expect(res.json().detail).toContain('hire a worker');
    expect(await jobCount()).toBe(0);
  });

  it('refuses a worker that does not exist, or is inactive', async () => {
    const p = await person(app, 'dh-missing');
    const missing = await hire(p.token, body(999_999));
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('NOT_FOUND');

    const w = await agent(app, 'dh-inactive-worker');
    await db.execute(sql`UPDATE agents SET active = false WHERE id = ${w.agentId}`);
    const inactive = await hire(p.token, body(w.agentId));
    expect(inactive.statusCode).toBe(409);
    expect(inactive.json().code).toBe('AGENT_NOT_HIREABLE');
    expect(await jobCount()).toBe(0);
  });

  it('refuses a worker the chain calls not hireable', async () => {
    const p = await person(app, 'dh-stake');
    const w = await agent(app, 'dh-stake-worker');
    stakes.set(w.chainAgentId, {hireable: false});
    const res = await hire(p.token, body(w.agentId));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AGENT_NOT_HIREABLE');
    expect(await jobCount()).toBe(0);
  });

  it('refuses a worker with the same owner (the contract refuses SameOwner)', async () => {
    const p = await person(app, 'dh-owner');
    const w = await agent(app, 'dh-owned-worker', {ownerAddress: p.account});
    const res = await hire(p.token, body(w.agentId));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
    expect(res.json().detail).toContain('same owner');
    expect(await jobCount()).toBe(0);
  });

  it('refuses a blocked counterparty, and names why', async () => {
    const p = await person(app, 'dh-victim');
    const workerOwner = addr('dh-farm-owner');
    const w = await agent(app, 'dh-farmed', {ownerAddress: workerOwner});
    const puppet = await agent(app, 'dh-puppet');
    await db.execute(sql`INSERT INTO token_transfers (chain_id, block_number, tx_hash, receipt_id, log_index, from_address, to_address, amount)
        VALUES ('near:sandbox', 200, 'tx-farm', 'receipt-farm', 0, ${workerOwner}, ${puppet.wallet}, 1000000)`);
    await db.execute(sql`INSERT INTO payments (chain_id, from_agent_id, to_agent_id, amount, tx_hash, block_number)
        VALUES ('near:sandbox', ${puppet.agentId}, ${w.agentId}, 50000, ${'0x' + '210'.padStart(64, '0')}, 210)`);
    const res = await hire(p.token, body(w.agentId));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('COUNTERPARTY_BLOCKED');
    expect(res.json().detail).toContain('self-funded');
    expect(await jobCount()).toBe(0);
  });

  it('refuses an amount below the escrow minimum, or above the client’s per-task cap', async () => {
    const p = await person(app, 'dh-amount');
    const w = await agent(app, 'dh-amount-worker');
    const low = await hire(p.token, body(w.agentId, {amount: String(chain.params.minJobAmount - 1n)}));
    expect(low.statusCode).toBe(422);
    expect(low.json().code).toBe('SCHEMA_MISMATCH');

    purses.set(p.account, {perTaskCap: 30_000n});
    const high = await hire(p.token, body(w.agentId, {amount: '30001'}));
    expect(high.statusCode).toBe(402);
    expect(high.json().code).toBe('BUDGET_EXCEEDED');
    const atCap = await hire(p.token, body(w.agentId, {amount: '30000'}));
    expect(atCap.statusCode, atCap.body).toBe(201);
    expect(await jobCount()).toBe(1);
  });

  it('refuses a capability the worker does not offer', async () => {
    const p = await person(app, 'dh-cap');
    const w = await agent(app, 'dh-cap-worker');
    const res = await hire(p.token, body(w.agentId, {capability: 'plumbing'}));
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('SCHEMA_MISMATCH');
    expect(res.json().detail).toContain('market-research');
    expect(await jobCount()).toBe(0);
  });
});
