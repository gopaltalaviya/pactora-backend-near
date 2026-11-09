import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, jobs, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget} from './helpers/people.js';

/**
 * The judge's attestation on the API (docs/24 §4, 2026-11-09): an approve or
 * dispute may carry `judge`; it is stored with the job's event, shown on
 * GET /v1/jobs/:id, validated, and never sent to the signer.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
let payloads: Record<string, unknown>[] = [];

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
    submit: async (args) => {
      payloads.push(args.payload ?? {});
      return {txHash: '4yJxShz8HXfTyoTMXP9rQSoQUZE8uihkDmnpRrynZeZz'};
    },
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  payloads = [];
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges RESTART IDENTITY CASCADE`,
  );
});

const JUDGE = {
  provider: 'near-ai',
  model: 'zai-org/GLM-5.1-FP8',
  responseId: 'chatcmpl-fixture-0001',
  signature: 'ab'.repeat(64),
  signingAddress: 'cd'.repeat(32),
  signingAlgo: 'ed25519',
  signedText: `${'ef'.repeat(32)}:${'01'.repeat(32)}`,
  verifiedAt: '2026-11-09T20:00:00.000Z',
  verdictHash: '23'.repeat(32),
};

let n = 0;
async function submitted() {
  const c = await agent(app, `ja-c${++n}`);
  const w = await agent(app, `ja-w${n}`);
  const [j] = await db
    .insert(jobs)
    .values({
      chainId: 'near:sandbox',
      chainJobId: String(800 + n),
      clientAgentId: c.agentId,
      workerAgentId: w.agentId,
      path: 'escrow',
      amount: '20000',
      spec: {capability: 'market-research'},
      specHash: 'ab'.repeat(32),
      state: 'submitted',
      result: {summary: 'x'},
      resultHash: 'cd'.repeat(32),
    })
    .returning({publicId: jobs.publicId});
  return {c, w, jobId: j!.publicId};
}

describe('judge attestation on approve and dispute', () => {
  it('is stored with the settlement, shown on the job, and kept away from the signer', async () => {
    const {c, jobId} = await submitted();
    const r = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/approve`,
      headers: bearer(c.apiKey),
      payload: {judge: JUDGE},
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(payloads[0]).not.toHaveProperty('judge');
    const job = (await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`})).json();
    expect(job.judge).toEqual(JUDGE);
  });

  it('travels with a dispute too, and a malformed one is 422', async () => {
    const {c, jobId} = await submitted();
    const bad = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/dispute`,
      headers: bearer(c.apiKey),
      payload: {reason: 'Wrong token.', judge: {...JUDGE, signingAlgo: 'rsa'}},
    });
    expect(bad.statusCode).toBe(422);
    const r = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/dispute`,
      headers: bearer(c.apiKey),
      payload: {reason: 'Wrong token.', judge: JUDGE},
    });
    expect(r.statusCode, r.body).toBe(200);
    const job = (await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`})).json();
    expect(job.judge).toEqual(JUDGE);
    expect(job.dispute).toMatchObject({reason: 'Wrong token.'});
    expect(payloads.at(-1)).not.toHaveProperty('judge');
  });

  it('is null on a job approved without one', async () => {
    const {c, jobId} = await submitted();
    expect(
      (await app.inject({method: 'POST', url: `/v1/jobs/${jobId}/approve`, headers: bearer(c.apiKey)}))
        .statusCode,
    ).toBe(200);
    expect((await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`})).json().judge).toBeNull();
  });
});
