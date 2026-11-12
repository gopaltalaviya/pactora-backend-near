import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
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
 *
 * 2026-11-12: the API no longer takes the client's word for it. The
 * signature must verify, the signing address must be the one NEAR AI's
 * public attestation report gives for that model, and one NEAR AI response
 * vouches for one job. An approve then commits the verdict's hash on chain
 * as `review_hash`.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
let payloads: Record<string, unknown>[] = [];

// A stand-in for NEAR AI's enclave key: ed25519, as the provider may use.
const tee = generateKeyPairSync('ed25519');
const TEE_ADDRESS = Buffer.from(tee.publicKey.export({format: 'jwk'}).x!, 'base64url').toString('hex');
const MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';
/** What NEAR AI's public attestation report says; tests change it. */
let attested: (model: string, algo: string) => Promise<string | null> = async (model) =>
  model === MODEL ? TEE_ADDRESS : null;
let seq = 0;
function signedJudge(over: Record<string, unknown> = {}) {
  const signedText = `${MODEL}:${createHash('sha256').update(`req${++seq}`).digest('hex')}:${createHash('sha256').update(`res${seq}`).digest('hex')}`;
  return {
    provider: 'near-ai',
    model: MODEL,
    responseId: `resp-${seq}-${Date.now()}`,
    signature: sign(null, Buffer.from(signedText), tee.privateKey).toString('hex'),
    signingAddress: TEE_ADDRESS,
    signingAlgo: 'ed25519',
    signedText,
    verifiedAt: '2026-11-12T10:00:00.000Z',
    verdictHash: createHash('sha256').update(`verdict${seq}`).digest('hex'),
    ...over,
  };
}

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
    judgeSigningAddress: (model, algo) => attested(model, algo),
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
  attested = async (model) => (model === MODEL ? TEE_ADDRESS : null);
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges RESTART IDENTITY CASCADE`,
  );
});

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
    const JUDGE = signedJudge();
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
    expect(job.judge).toEqual({...JUDGE, verified: true});
  });

  it('travels with a dispute too, and a malformed one is 422', async () => {
    const JUDGE = signedJudge();
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
    expect(job.judge).toEqual({...JUDGE, verified: true});
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

  it('an approve commits the verdict hash on chain as review_hash; a dispute does not', async () => {
    const judge = signedJudge();
    const {c, jobId} = await submitted();
    const r = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/approve`,
      headers: bearer(c.apiKey),
      payload: {judge},
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(payloads[0]).toMatchObject({reviewHash: judge.verdictHash});
    const other = await submitted();
    await app.inject({
      method: 'POST',
      url: `/v1/jobs/${other.jobId}/dispute`,
      headers: bearer(other.c.apiKey),
      payload: {reason: 'Wrong.', judge: signedJudge()},
    });
    expect(payloads.at(-1)).not.toHaveProperty('reviewHash');
  });

  it('a signature that does not verify is refused: nothing is paid, nothing stored', async () => {
    const {c, jobId} = await submitted();
    const forged = signedJudge({signature: 'ab'.repeat(64)});
    const r = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/approve`,
      headers: bearer(c.apiKey),
      payload: {judge: forged},
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toMatch(/signature/);
    expect(payloads).toHaveLength(0);
    expect((await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`})).json().state).toBe('submitted');
  });

  it('a valid signature by a key NEAR AI does not attest for that model pays, but carries no judge', async () => {
    const {c, jobId} = await submitted();
    const mine = generateKeyPairSync('ed25519');
    const signedText = `${MODEL}:${'aa'.repeat(32)}:${'bb'.repeat(32)}`;
    const selfSigned = signedJudge({
      signingAddress: Buffer.from(mine.publicKey.export({format: 'jwk'}).x!, 'base64url').toString('hex'),
      signedText,
      signature: sign(null, Buffer.from(signedText), mine.privateKey).toString('hex'),
    });
    const r = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/approve`,
      headers: bearer(c.apiKey),
      payload: {judge: selfSigned},
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(payloads[0]).not.toHaveProperty('reviewHash');
    expect((await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`})).json().judge).toBeNull();
  });

  it('when the attestation report cannot be read, the approve still pays, without a judge', async () => {
    attested = async () => {
      throw new Error('cloud-api.near.ai unreachable');
    };
    const {c, jobId} = await submitted();
    const r = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/approve`,
      headers: bearer(c.apiKey),
      payload: {judge: signedJudge()},
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`})).json().judge).toBeNull();
  });

  it('one NEAR AI response vouches for one job: reusing it on another is refused', async () => {
    const judge = signedJudge();
    const a = await submitted();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/jobs/${a.jobId}/approve`,
          headers: bearer(a.c.apiKey),
          payload: {judge},
        })
      ).statusCode,
    ).toBe(200);
    const b = await submitted();
    const r = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${b.jobId}/approve`,
      headers: bearer(b.c.apiKey),
      payload: {judge},
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toMatch(/already/);
  });
});
