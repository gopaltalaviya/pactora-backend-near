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
  sessionOnly,
  txHash,
  txReads,
  txs,
} from './helpers/people.js';

/**
 * People act on jobs by signing in their own wallet: the API prepares the
 * exact FunctionCall, the browser signs it, and the API confirms it from
 * the chain's own events (docs/26 "prepare → sign → confirm"). Also GET
 * /v1/me and GET /v1/jobs for a session, and the result-mismatch guard on
 * approval for agents and people alike.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});
const chain = config.chain('near:sandbox');

let app: FastifyInstance;
let db: Db;
let submitted: {kind: string}[] = [];

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
    rateLimitPerMinute: 100_000,
    submit: async (args) => {
      submitted.push({kind: args.kind});
      return {txHash: '4yJxShz8HXfTyoTMXP9rQSoQUZE8uihkDmnpRrynZeZz'};
    },
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  submitted = [];
  txs.clear();
  txReads.length = 0;
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, registration_challenges RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`
    DO $$ BEGIN
      IF to_regclass('sessions') IS NOT NULL THEN TRUNCATE sessions RESTART IDENTITY; END IF;
      IF to_regclass('login_challenges') IS NOT NULL THEN TRUNCATE login_challenges; END IF;
      IF to_regclass('person_actions') IS NOT NULL THEN TRUNCATE person_actions RESTART IDENTITY; END IF;
    END $$`);
});

const SPEC = {
  capability: 'photo-capture',
  input: {what: 'three shop fronts'},
  outputSchema: {type: 'object', required: ['photos'], properties: {photos: {type: 'array'}}},
  deadlineSeconds: 600,
};

/** A job between two agents rows (by database id), straight into the table as the API would have written it. */
async function job(
  clientId: number,
  workerId: number,
  o: {
    state?: string;
    chainJobId?: string | null;
    amount?: string;
    fee?: string | null;
    resultHash?: string;
    mismatch?: boolean;
  } = {},
): Promise<string> {
  const rows = (await db.execute(sql`
    INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, fee, spec, spec_hash, chain_job_id, state, result_hash, result_mismatch)
    VALUES ('near:sandbox', ${clientId}, ${workerId}, 'escrow', ${o.amount ?? '20000'}, ${o.fee ?? null}, ${JSON.stringify(SPEC)}::jsonb,
            ${'ab'.repeat(32)}, ${o.chainJobId === undefined ? '42' : o.chainJobId}, ${o.state ?? 'created'}, ${o.resultHash ?? null},
            ${o.mismatch ?? false})
    RETURNING public_id`)) as unknown as {public_id: string}[];
  return rows[0]!.public_id;
}

const agentIdOf = async (account: string) =>
  (
    (await db.execute(
      sql`SELECT id FROM agents WHERE owner_address = ${account} AND kind = 'person'`,
    )) as unknown as {id: number}[]
  )[0]!.id;

const prepare = (token: string, jobId: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/person-actions/prepare`,
    headers: bearer(token),
    payload,
  });
const confirm = (token: string, jobId: string, action: string, hash: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/person-actions/confirm`,
    headers: bearer(token),
    payload: {action, txHash: hash},
  });

describe('a person worker accepts: prepare → sign → confirm', () => {
  it('prepares the exact accept_job call, confirms it from the chain, and replays the same hash idempotently', async () => {
    const client = await agent(app, 'pa-client');
    const p = await person(app, 'pa-worker');
    const id = await job(client.agentId, await agentIdOf(p.account));

    const prep = await prepare(p.token, id, {action: 'accept'});
    expect(prep.statusCode, prep.body).toBe(200);
    expect(prep.json()).toMatchObject({
      action: 'accept',
      signerId: p.account,
      expectedEvent: 'job_accepted',
      functionCall: {
        receiverId: chain.contracts.Pactora,
        methodName: 'accept_job',
        args: {job_id: 42},
        gas: '100000000000000',
        deposit: '0',
      },
    });
    // Nothing moved yet.
    expect((await app.inject({url: `/v1/jobs/${id}`})).json().state).toBe('created');

    const hash = onChainTx(txHash(), p.account, [
      {
        event: 'job_accepted',
        data: {job_id: 42, worker: Number(p.chainAgentId), bond: '10000', work_deadline: 1},
      },
    ]);
    const ok = await confirm(p.token, id, 'accept', hash);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({state: 'accepted', txHash: hash, replayed: false});
    expect(txReads).toEqual([{txHash: hash, signerId: p.account}]);
    const detail = (await app.inject({url: `/v1/jobs/${id}`})).json();
    expect(detail.state).toBe('accepted');
    expect(detail.events.map((e: {kind: string}) => e.kind)).toEqual(['job.accepted']);

    const again = await confirm(p.token, id, 'accept', hash);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({state: 'accepted', replayed: true});
    expect((await app.inject({url: `/v1/jobs/${id}`})).json().events).toHaveLength(1);
    // The same hash claimed as another action is a conflict.
    expect((await confirm(p.token, id, 'submit', hash)).statusCode).toBe(409);
    expect(submitted).toEqual([]);
  });

  it('refuses a transaction that carries no such event, one for another job, a pending one and a reverted one', async () => {
    const client = await agent(app, 'pb-client');
    const p = await person(app, 'pb-worker');
    const id = await job(client.agentId, await agentIdOf(p.account));

    const none = onChainTx(txHash(), p.account, []);
    const r1 = await confirm(p.token, id, 'accept', none);
    expect(r1.statusCode).toBe(409);
    expect(r1.json().detail).toContain('no job_accepted event');

    const other = onChainTx(txHash(), p.account, [
      {
        event: 'job_accepted',
        data: {job_id: 43, worker: Number(p.chainAgentId), bond: '0', work_deadline: 1},
      },
    ]);
    expect((await confirm(p.token, id, 'accept', other)).statusCode).toBe(409);

    const pending = txHash();
    const r3 = await confirm(p.token, id, 'accept', pending);
    expect(r3.statusCode).toBe(409);
    expect(r3.json().retryAfter).toBe(2);

    const reverted = txHash();
    txs.set(reverted, {status: 'reverted'});
    expect((await confirm(p.token, id, 'accept', reverted)).json().detail).toContain('failed on chain');
    expect((await app.inject({url: `/v1/jobs/${id}`})).json().state).toBe('created');
  });

  it('refuses a transaction someone else signed', async () => {
    const client = await agent(app, 'pc-client');
    const p = await person(app, 'pc-worker');
    const id = await job(client.agentId, await agentIdOf(p.account));
    const hash = onChainTx(txHash(), 'someone-else.test.near', [
      {
        event: 'job_accepted',
        data: {job_id: 42, worker: Number(p.chainAgentId), bond: '0', work_deadline: 1},
      },
    ]);
    expect((await confirm(p.token, id, 'accept', hash)).statusCode).toBe(403);
  });

  it('refuses the wrong party at prepare and at confirm, an agent key, and a session with no person agent', async () => {
    const client = await agent(app, 'pd-client');
    const p = await person(app, 'pd-worker');
    const stranger = await person(app, 'pd-stranger');
    const id = await job(client.agentId, await agentIdOf(p.account));

    expect((await prepare(stranger.token, id, {action: 'accept'})).statusCode).toBe(403);
    // The worker is not the client: it cannot cancel.
    expect((await prepare(p.token, id, {action: 'cancel'})).statusCode).toBe(403);
    const hash = onChainTx(txHash(), stranger.account, [
      {
        event: 'job_accepted',
        data: {job_id: 42, worker: Number(stranger.chainAgentId), bond: '0', work_deadline: 1},
      },
    ]);
    expect((await confirm(stranger.token, id, 'accept', hash)).statusCode).toBe(403);

    const asAgent = await prepare(client.apiKey, id, {action: 'cancel'});
    expect(asAgent.statusCode).toBe(401);
    expect(asAgent.json().code).toBe('WRONG_CREDENTIAL');
    expect((await prepare(await sessionOnly(app, 'pd-nobody'), id, {action: 'accept'})).statusCode).toBe(403);
  });

  it('refuses an action from the wrong state, and one before the job is on chain', async () => {
    const client = await agent(app, 'pe-client');
    const p = await person(app, 'pe-worker');
    const worker = await agentIdOf(p.account);
    expect(
      (await prepare(p.token, await job(client.agentId, worker, {state: 'accepted'}), {action: 'accept'}))
        .statusCode,
    ).toBe(409);
    const unlinked = await prepare(p.token, await job(client.agentId, worker, {chainJobId: null}), {
      action: 'accept',
    });
    expect(unlinked.statusCode).toBe(409);
    expect(unlinked.json().retryAfter).toBe(2);
  });
});

describe('delivering and reviewing', () => {
  it('stores the delivery before signing, hashed as POST /result hashes it, and flags a different on-chain hash', async () => {
    const client = await person(app, 'pf-client');
    const p = await person(app, 'pf-worker');
    const id = await job(await agentIdOf(client.account), await agentIdOf(p.account), {state: 'accepted'});

    const bad = await prepare(p.token, id, {
      action: 'submit',
      output: {nope: 1},
      producedAt: new Date().toISOString(),
    });
    expect(bad.statusCode).toBe(422);

    const output = {photos: ['a.jpg', 'b.jpg', 'c.jpg']};
    const prep = await prepare(p.token, id, {action: 'submit', output, producedAt: new Date().toISOString()});
    expect(prep.statusCode, prep.body).toBe(200);
    const expected = sha256Hex(canonicalize(output));
    expect(prep.json()).toMatchObject({
      resultHash: expected,
      functionCall: {methodName: 'submit_result', args: {job_id: 42, result_hash: expected}},
    });
    expect((await app.inject({url: `/v1/jobs/${id}`})).json()).toMatchObject({
      state: 'accepted',
      resultHash: expected,
    });

    // The wallet signed some OTHER hash.
    const wrong = onChainTx(txHash(), p.account, [
      {event: 'result_submitted', data: {job_id: 42, result_hash: 'ee'.repeat(32), review_deadline: 1}},
    ]);
    const res = await confirm(p.token, id, 'submit', wrong);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({state: 'submitted', resultMismatch: true});
    const detail = (await app.inject({url: `/v1/jobs/${id}`})).json();
    // Ours is kept, not overwritten.
    expect(detail).toMatchObject({resultHash: expected, resultMismatch: true});

    // So the client cannot approve it; a dispute is still open.
    const approve = await prepare(client.token, id, {action: 'approve'});
    expect(approve.statusCode).toBe(409);
    expect(approve.json().code).toBe('RESULT_MISMATCH');
    expect(
      (await prepare(client.token, id, {action: 'dispute', reason: 'The photos are not of the shop fronts.'}))
        .statusCode,
    ).toBe(200);
  });

  it('confirms an approval and a dispute with its reason', async () => {
    const client = await person(app, 'pg-client');
    const p = await person(app, 'pg-worker');
    const clientId = await agentIdOf(client.account);
    const workerId = await agentIdOf(p.account);

    const a = await job(clientId, workerId, {state: 'submitted', chainJobId: '50'});
    expect((await prepare(client.token, a, {action: 'approve'})).json().functionCall).toMatchObject({
      methodName: 'approve',
      args: {job_id: 50, review_hash: null},
    });
    // A settlement that is not the client's approval does not count as one.
    const expired = onChainTx(txHash(), client.account, [
      {
        event: 'job_settled',
        data: {job_id: 50, worker: Number(p.chainAgentId), paid: '19800', fee: '200', outcome: 'Unresolved'},
      },
    ]);
    expect((await confirm(client.token, a, 'approve', expired)).statusCode).toBe(409);
    const paid = onChainTx(txHash(), client.account, [
      {
        event: 'job_settled',
        data: {job_id: 50, worker: Number(p.chainAgentId), paid: '19800', fee: '200', outcome: 'Success'},
      },
    ]);
    expect((await confirm(client.token, a, 'approve', paid)).json()).toMatchObject({state: 'settled'});

    const d = await job(clientId, workerId, {state: 'submitted', chainJobId: '51'});
    const reason = 'Only two of the three photos were delivered.';
    const prep = (await prepare(client.token, d, {action: 'dispute', reason})).json();
    expect(prep.reasonHash).toBe(sha256Hex(canonicalize({reason})));
    const disputed = onChainTx(txHash(), client.account, [
      {
        event: 'job_disputed',
        data: {job_id: 51, dispute_bond: '10000', dispute_deadline: 1, reason_hash: prep.reasonHash},
      },
    ]);
    expect((await confirm(client.token, d, 'dispute', disputed)).json().state).toBe('disputed');
    expect((await app.inject({url: `/v1/jobs/${d}`})).json().dispute).toMatchObject({
      reason,
      reasonHash: prep.reasonHash,
    });
  });

  it('refuses an agent client approving a mismatched job through the signer route', async () => {
    const client = await agent(app, 'ph-client');
    const worker = await agent(app, 'ph-worker');
    const id = await job(client.agentId, worker.agentId, {
      state: 'submitted',
      resultHash: 'cd'.repeat(32),
      mismatch: true,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${id}/approve`,
      headers: bearer(client.apiKey),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('RESULT_MISMATCH');
    expect(submitted).toEqual([]);
    // Without the flag the same approval goes through.
    await db.execute(sql`UPDATE jobs SET result_mismatch = false`);
    expect(
      (await app.inject({method: 'POST', url: `/v1/jobs/${id}/approve`, headers: bearer(client.apiKey)}))
        .statusCode,
    ).toBe(200);
  });
});

describe('GET /v1/me', () => {
  it('counts earnings from settled jobs only, less the fee, and spend as a client', async () => {
    const p = await person(app, 'me-person', {location: 'Paris, FR', capabilities: ['photo-capture']});
    const other = await agent(app, 'me-other');
    const mine = await agentIdOf(p.account);
    await job(other.agentId, mine, {state: 'settled', amount: '20000', fee: '200', chainJobId: '60'});
    // No fee recorded yet: the contract's formula, max(30000 × 1%, 100) = 300.
    await job(other.agentId, mine, {state: 'settled', amount: '30000', chainJobId: '61'});
    await job(other.agentId, mine, {state: 'submitted', amount: '99999', chainJobId: '62'});
    await job(mine, other.agentId, {state: 'settled', amount: '45000', chainJobId: '63'});
    await job(mine, other.agentId, {state: 'refunded', amount: '50000', chainJobId: '64'});

    const res = await app.inject({url: '/v1/me', headers: bearer(p.token)});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      account: p.account,
      chainId: 'near:sandbox',
      person: expect.objectContaining({
        publicId: p.publicId,
        chainAgentId: p.chainAgentId,
        location: 'Paris, FR',
        capabilities: ['photo-capture'],
      }),
      earnings: {settledCount: 2, receivedBaseUnits: String(19_800 + 29_700)},
      spentBaseUnits: '45000',
    });
  });

  it('answers person: null for an account with no person agent, and refuses an agent key', async () => {
    const token = await sessionOnly(app, 'me-nobody');
    expect((await app.inject({url: '/v1/me', headers: bearer(token)})).json()).toMatchObject({
      person: null,
      earnings: {settledCount: 0, receivedBaseUnits: '0'},
      spentBaseUnits: '0',
    });
    const a = await agent(app, 'me-agent');
    expect((await app.inject({url: '/v1/me', headers: bearer(a.apiKey)})).json().code).toBe(
      'WRONG_CREDENTIAL',
    );
  });
});

describe('GET /v1/jobs for a person', () => {
  it("lists the person agent's jobs, filtered on the server by role, state and capability", async () => {
    const p = await person(app, 'jl-person');
    const other = await agent(app, 'jl-other');
    const mine = await agentIdOf(p.account);
    await job(other.agentId, mine, {state: 'accepted', chainJobId: '70'});
    await job(mine, other.agentId, {state: 'created', chainJobId: '71'});
    const third = await agent(app, 'jl-third');
    await job(other.agentId, third.agentId, {chainJobId: '72'});

    const list = async (q = '') =>
      (await app.inject({url: `/v1/jobs${q}`, headers: bearer(p.token)})).json() as {
        jobs: {role: string; state: string}[];
      };
    expect((await list()).jobs.map((j) => j.role).sort()).toEqual(['client', 'worker']);
    expect((await list('?role=worker')).jobs).toEqual([
      expect.objectContaining({role: 'worker', state: 'accepted'}),
    ]);
    expect((await list('?state=created')).jobs).toEqual([expect.objectContaining({role: 'client'})]);
    expect((await list('?capability=photo-capture')).jobs).toHaveLength(2);
    expect((await list('?capability=market-research')).jobs).toHaveLength(0);

    // An agent key keeps its old behaviour, and gains the capability filter.
    const agentList = (await app.inject({url: '/v1/jobs', headers: bearer(other.apiKey)})).json();
    expect(agentList.jobs).toHaveLength(3);

    const nobody = await sessionOnly(app, 'jl-nobody');
    expect((await app.inject({url: '/v1/jobs', headers: bearer(nobody)})).json()).toEqual({
      count: 0,
      nextCursor: null,
      jobs: [],
    });
  });
});
