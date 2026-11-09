import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, jobEvents, jobs, type Db} from '@pactora/db';
import {MemoryObjectStore} from '@pactora/storage';
import {buildApp, EventBus} from '../src/app.js';
import type {ChainViewer} from '../src/chain-reads.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, person} from './helpers/people.js';
import {GPS_MARK, multipart, png} from './helpers/images.js';

/**
 * Client dispute evidence (2026-11-09, migration 0027): notes (≤ 2000, ≤ 10)
 * and photos (the evidence pipeline, ≤ 10) attached while the job is
 * submitted or disputed, read by both parties, in the desk's bundle and hash.
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
const store = new MemoryObjectStore();
let council: string[] = [];
const view: ChainViewer = async (_c, contract, method) => {
  if (contract === PACTORA && method === 'get_roles') return {arbiter: DAO, owner: 'test.near'};
  if (contract === DAO && method === 'get_policy')
    return {roles: [{name: 'council', kind: {Group: council}, permissions: ['*:VoteApprove']}]};
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
    objectStore: store,
    viewChain: view,
    adminCouncilCacheMs: 0,
    submit: async () => ({txHash: 'unused'}),
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  council = [];
  store.objects.clear();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, sessions, login_challenges, job_files, dispute_notes RESTART IDENTITY CASCADE`,
  );
});

let n = 0;
async function jobIn(state: 'accepted' | 'submitted' | 'disputed') {
  const c = await agent(app, `de-c${++n}`);
  const w = await agent(app, `de-w${n}`);
  const [j] = await db
    .insert(jobs)
    .values({
      chainId: 'near:sandbox',
      chainJobId: String(300 + n),
      clientAgentId: c.agentId,
      workerAgentId: w.agentId,
      path: 'escrow',
      amount: '20000',
      spec: {capability: 'market-research'},
      specHash: 'ab'.repeat(32),
      state,
      resultHash: 'cd'.repeat(32),
    })
    .returning({id: jobs.id, publicId: jobs.publicId});
  if (state === 'disputed') {
    await db.insert(jobEvents).values({
      chainId: 'near:sandbox',
      jobId: j!.id,
      kind: 'job.disputed',
      payload: {reason: 'The report is about the wrong token.', reasonHash: 'ef'.repeat(32)},
    });
  }
  return {c, w, jobId: j!.publicId};
}
const note = (token: string, jobId: string, text: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/dispute/notes`,
    headers: bearer(token),
    payload: {text},
  });
const photo = (token: string, jobId: string, bytes = png({exif: true})) => {
  const m = multipart(bytes);
  return app.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/dispute/files`,
    headers: {...bearer(token), ...m.headers},
    payload: m.payload,
  });
};
const read = (token: string, jobId: string) =>
  app.inject({method: 'GET', url: `/v1/jobs/${jobId}/dispute`, headers: bearer(token)});

describe('client dispute evidence', () => {
  it('the client attaches notes and photos on a disputed job; both parties read them; limits and roles hold', async () => {
    const {c, w, jobId} = await jobIn('disputed');
    const r = await note(c.apiKey, jobId, 'The figures on page 2 are for the wrong token.');
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({jobId, text: 'The figures on page 2 are for the wrong token.'});
    const up = await photo(c.apiKey, jobId);
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json()).toMatchObject({purpose: 'dispute', mime: 'image/png'});
    // Metadata removed, as for evidence photos.
    for (const {bytes} of store.objects.values())
      expect(Buffer.from(bytes).includes(Buffer.from(GPS_MARK))).toBe(false);

    const asWorker = await read(w.apiKey, jobId);
    expect(asWorker.statusCode, asWorker.body).toBe(200);
    expect(asWorker.json()).toMatchObject({
      reason: 'The report is about the wrong token.',
      reasonHash: 'ef'.repeat(32),
      canAttach: false,
      notes: [{text: 'The figures on page 2 are for the wrong token.'}],
      files: [{purpose: 'dispute'}],
    });
    expect((await read(c.apiKey, jobId)).json().canAttach).toBe(true);
    // The worker may not attach; a stranger reads nothing.
    expect((await note(w.apiKey, jobId, 'no')).statusCode).toBe(403);
    expect((await photo(w.apiKey, jobId)).statusCode).toBe(403);
    const stranger = await person(app, `de-stranger${n}`);
    expect((await read(stranger.token, jobId)).statusCode).toBe(403);
    // Limits: 2000 chars, 10 notes, 10 photos.
    expect((await note(c.apiKey, jobId, 'x'.repeat(2001))).statusCode).toBe(422);
    for (let i = 0; i < 9; i++) expect((await note(c.apiKey, jobId, `note ${i}`)).statusCode).toBe(201);
    expect((await note(c.apiKey, jobId, 'one too many')).json()).toMatchObject({code: 'LIMIT_REACHED'});
    for (let i = 0; i < 9; i++) expect((await photo(c.apiKey, jobId)).statusCode).toBe(201);
    expect((await photo(c.apiKey, jobId)).json()).toMatchObject({code: 'LIMIT_REACHED'});
    // Dispute photos are listed with the job's files, apart from the worker's evidence count.
    const files = (
      await app.inject({method: 'GET', url: `/v1/jobs/${jobId}/files`, headers: bearer(w.apiKey)})
    ).json();
    expect(files).toMatchObject({active: 0, total: 0, disputeFiles: 10});
  });

  it('is allowed while submitted, refused while accepted (409), and reads 404 for a job never disputed', async () => {
    const submitted = await jobIn('submitted');
    expect(
      (await note(submitted.c.apiKey, submitted.jobId, 'Before I dispute: the numbers are off.')).statusCode,
    ).toBe(201);
    expect((await read(submitted.w.apiKey, submitted.jobId)).json()).toMatchObject({
      reason: null,
      notes: [{}],
    });
    const accepted = await jobIn('accepted');
    const r = await note(accepted.c.apiKey, accepted.jobId, 'too early');
    expect(r.statusCode).toBe(409);
    expect((await photo(accepted.c.apiKey, accepted.jobId)).statusCode).toBe(409);
    expect((await read(accepted.c.apiKey, accepted.jobId)).statusCode).toBe(404);
  });

  it("the desk's bundle carries the notes and photos, and its hash changes with them", async () => {
    const {c, jobId} = await jobIn('disputed');
    const m = await person(app, `de-council${n}`);
    council.push(m.account);
    const desk = (token: string) =>
      app.inject({method: 'GET', url: `/v1/admin/disputes/${jobId}`, headers: bearer(token)});
    const before = await desk(m.token);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toMatchObject({disputeNotes: [], disputeFiles: []});
    await note(c.apiKey, jobId, 'Page 2 is about another token.');
    const up = await photo(c.apiKey, jobId);
    const after = (await desk(m.token)).json();
    expect(after.disputeNotes).toEqual([expect.objectContaining({text: 'Page 2 is about another token.'})]);
    expect(after.disputeFiles).toEqual([
      expect.objectContaining({fileId: up.json().fileId, url: `/v1/admin/files/${up.json().fileId}`}),
    ]);
    expect(after.evidenceHash).not.toBe(before.json().evidenceHash);
    // The council reads the client's photo through the desk, like the worker's.
    const bytes = await app.inject({
      method: 'GET',
      url: `/v1/admin/files/${up.json().fileId}`,
      headers: bearer(m.token),
    });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/png');
  });
});
