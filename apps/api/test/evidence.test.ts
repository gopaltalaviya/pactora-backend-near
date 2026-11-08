import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {sha256Hex} from '@pactora/near';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {canonicalize} from '@pactora/shared';
import {MemoryObjectStore} from '@pactora/storage';
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
  txHash,
} from './helpers/people.js';
import {GPS_MARK, jpeg, multipart, png, pngOfSize, webp} from './helpers/images.js';

/**
 * Evidence, draft rounds with checks, and chat (docs/26 F6, F7, F8).
 *
 * Every test runs on an ordinary listing job: a bid selected, the job
 * created on the (fake) chain at the bid price, accepted by its worker. The
 * worker uploads photos, posts drafts, the client reviews each snapshot by
 * its hash; the accepted snapshot's hash is what is submitted on chain.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

const MiB = 1024 * 1024;
let app: FastifyInstance;
let bare: FastifyInstance;
let db: Db;
const store = new MemoryObjectStore();
let calls = 0;
let submitted: {kind: string; agentId: number; payload?: Record<string, unknown>; idempotencyKey: string}[] =
  [];

const build = (over: Record<string, unknown> = {}) =>
  buildApp({
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
    submit: async (args) => {
      submitted.push({
        kind: args.kind,
        agentId: args.agentId,
        idempotencyKey: args.idempotencyKey,
        ...(args.payload ? {payload: args.payload} : {}),
      });
      calls++;
      return {
        txHash: `4yJxShz8HXfTyoTMXP9rQSoQUZE8uihkDmnpRrynZe${String(calls % 100).padStart(2, 'Z')}`,
        chainJobId: String(500 + calls),
      };
    },
    ...over,
  });

beforeAll(async () => {
  db = createDb(DB_URL, {max: 5});
  app = await build({objectStore: store});
  bare = await build();
});
afterAll(async () => {
  await app.close();
  await bare.close();
  await closeDb(db);
});
beforeEach(async () => {
  submitted = [];
  purses.clear();
  store.objects.clear();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, token_transfers, registration_challenges, sessions, login_challenges, listings, applications, listing_slots, person_actions, job_files, job_drafts, job_reviews, job_messages RESTART IDENTITY CASCADE`,
  );
});

let seq = 0;
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

type Party = {token: string; chainAgentId: string; account?: string};

/** A listing job, created and accepted. `worker`/`client` say who is a person. */
async function acceptedJob(opts: {worker?: 'agent' | 'person'; client?: 'agent' | 'person'} = {}) {
  const n = ++seq;
  const c = opts.client === 'person' ? await person(app, `ev-c${n}`) : await agent(app, `ev-c${n}`);
  const w = opts.worker === 'person' ? await person(app, `ev-w${n}`) : await agent(app, `ev-w${n}`);
  const client: Party = 'apiKey' in c ? {token: c.apiKey, chainAgentId: c.chainAgentId} : c;
  const worker: Party = 'apiKey' in w ? {token: w.apiKey, chainAgentId: w.chainAgentId} : w;
  const l = await app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: {...bearer(client.token), 'idempotency-key': `ev-listing-${n}`},
    payload: {
      title: 'Photograph a shop front',
      description: 'One clear daytime photo of the shop front and its sign.',
      category: 'physical',
      interactionMode: 'capture',
      skills: ['photography'],
      maxPriceBaseUnits: '40000',
      maxWorkers: 1,
      estimatedMinutes: 30,
      deadline: inDays(3),
      criteria: 'The whole shop front and its sign are visible and in focus.',
      acceptWindowSeconds: 600,
      workWindowSeconds: 7200,
    },
  });
  expect(l.statusCode, l.body).toBe(201);
  const listingId = l.json().listingId as string;
  const bid = await app.inject({
    method: 'POST',
    url: `/v1/listings/${listingId}/applications`,
    headers: bearer(worker.token),
    payload: {
      action: 'apply',
      priceBaseUnits: '30000',
      proposal: 'I live on that street and can do it today.',
    },
  });
  expect(bid.statusCode, bid.body).toBe(201);
  const d = await app.inject({
    method: 'POST',
    url: `/v1/listings/${listingId}/decide`,
    headers: bearer(client.token),
    payload: {
      applicationId: bid.json().applicationId,
      action: 'select',
      reason: 'Close by and a clear plan.',
    },
  });
  expect(d.statusCode, d.body).toBe(200);
  const jobId = d.json().job.jobId as string;
  let chainJobId = d.json().job.chainJobId as string | null;
  if (opts.client === 'person') {
    const job = (await app.inject({url: `/v1/jobs/${jobId}`})).json();
    chainJobId = String(900 + n);
    const h = onChainTx(txHash(), client.account!, [
      {
        event: 'job_created',
        data: {
          job_id: Number(chainJobId),
          client: Number(client.chainAgentId),
          worker: Number(worker.chainAgentId),
          amount: '30000',
          spec_hash: job.specHash,
        },
      },
    ]);
    const conf = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/person-actions/confirm`,
      headers: bearer(client.token),
      payload: {action: 'create', txHash: h},
    });
    expect(conf.statusCode, conf.body).toBe(200);
  }
  if (opts.worker === 'person') {
    const h = onChainTx(txHash(), worker.account!, [
      {event: 'job_accepted', data: {job_id: Number(chainJobId), worker: Number(worker.chainAgentId)}},
    ]);
    const conf = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/person-actions/confirm`,
      headers: bearer(worker.token),
      payload: {action: 'accept', txHash: h},
    });
    expect(conf.statusCode, conf.body).toBe(200);
  } else {
    const a = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/accept`,
      headers: bearer(worker.token),
    });
    expect(a.statusCode, a.body).toBe(200);
  }
  submitted = [];
  return {jobId, chainJobId: chainJobId!, client, worker};
}

const upload = (
  token: string,
  jobId: string,
  bytes: Buffer,
  opts: Parameters<typeof multipart>[1] = {},
  on = app,
) => {
  const m = multipart(bytes, opts);
  return on.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/files`,
    headers: {...bearer(token), ...m.headers},
    payload: m.payload,
  });
};
const draft = (
  token: string,
  jobId: string,
  text = 'Photo taken at 10:00, sign fully visible.',
  output?: unknown,
) =>
  app.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/drafts`,
    headers: bearer(token),
    payload: {text, ...(output ? {output} : {})},
  });
const checks = (met = true) => [
  {criterion: 'The whole shop front is visible', met, support: 'photo 1'},
  {criterion: 'The sign is in focus', met: true, support: 'photo 1'},
];
const review = (
  token: string,
  jobId: string,
  d: {draftId: string; snapshotHash: string},
  decision: 'revise' | 'accept_draft' | 'dispute_intent',
  over: Record<string, unknown> = {},
) =>
  app.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/drafts/${d.draftId}/review`,
    headers: bearer(token),
    payload: {
      snapshotHash: d.snapshotHash,
      decision,
      reason: decision === 'revise' ? 'Please retake it closer to the sign.' : 'Exactly what was asked for.',
      checks: checks(),
      ...over,
    },
  });
const say = (token: string, jobId: string, body: string, key?: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/messages`,
    headers: {...bearer(token), ...(key ? {'idempotency-key': key} : {})},
    payload: {body, ...extra},
  });

describe('evidence uploads', () => {
  it('stores a photo with its metadata removed, hashing the STORED bytes, typed by its magic bytes', async () => {
    const {jobId, worker, client} = await acceptedJob();
    const dirty = jpeg({exif: true, xmp: true, comment: true});
    expect(dirty.includes(Buffer.from(GPS_MARK))).toBe(true);
    // The client says PNG; the bytes say JPEG, and the bytes win.
    const res = await upload(worker.token, jobId, dirty, {contentType: 'image/png', filename: 'x.png'});
    expect(res.statusCode, res.body).toBe(201);
    const f = res.json();
    expect(f).toMatchObject({mime: 'image/jpeg', withdrawnAt: null});
    expect(f.metadataRemoved).toEqual(expect.arrayContaining(['EXIF', 'XMP/APP1', 'COM']));
    const [stored] = [...store.objects.values()];
    const bytes = Buffer.from(stored!.bytes);
    expect(bytes.includes(Buffer.from(GPS_MARK))).toBe(false);
    expect(bytes.includes(Buffer.from('Exif'))).toBe(false);
    expect(f.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(f.size).toBe(bytes.length);

    // Read back by a party: the detected type, nosniff, inline, never cached.
    const get = await app.inject({url: `/v1/files/${f.fileId}`, headers: bearer(client.token)});
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('image/jpeg');
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect(get.headers['content-disposition']).toBe(`inline; filename="${f.fileId}.jpg"`);
    expect(get.headers['cache-control']).toBe('private, no-store');
    expect(get.rawPayload.equals(bytes)).toBe(true);
    expect(createHash('sha256').update(get.rawPayload).digest('hex')).toBe(f.sha256);
  });

  it('removes a PNG eXIf GPS block and a WebP EXIF chunk too', async () => {
    const {jobId, worker} = await acceptedJob();
    for (const img of [png({exif: true, text: true}), webp({exif: true, xmp: true})]) {
      const res = await upload(worker.token, jobId, img);
      expect(res.statusCode, res.body).toBe(201);
    }
    for (const {bytes} of store.objects.values()) {
      expect(Buffer.from(bytes).includes(Buffer.from(GPS_MARK))).toBe(false);
    }
  });

  it('refuses wrong magic bytes whatever the name and Content-Type say', async () => {
    const {jobId, worker} = await acceptedJob();
    for (const bytes of [
      Buffer.from('GIF89a\x01\0\x01\0\0\0\0', 'latin1'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      Buffer.from('%PDF-1.7 not a photo'),
    ]) {
      const res = await upload(worker.token, jobId, bytes, {contentType: 'image/png', filename: 'photo.png'});
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('SCHEMA_MISMATCH');
    }
    expect(store.objects.size).toBe(0);
  });

  it('accepts exactly 8 MiB and refuses 8 MiB + 1', async () => {
    const {jobId, worker} = await acceptedJob();
    const exact = pngOfSize(8 * MiB);
    expect(exact.length).toBe(8 * MiB);
    const ok = await upload(worker.token, jobId, exact);
    expect(ok.statusCode, ok.body).toBe(201);
    const over = pngOfSize(8 * MiB + 1);
    const res = await upload(worker.token, jobId, over);
    expect(res.statusCode).toBe(413);
    expect(store.objects.size).toBe(1);
  });

  it('allows 10 active files and refuses the 11th; withdrawn ones count toward 30 total', async () => {
    const {jobId, worker} = await acceptedJob();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await upload(worker.token, jobId, png());
      expect(res.statusCode, res.body).toBe(201);
      ids.push(res.json().fileId);
    }
    const eleventh = await upload(worker.token, jobId, png());
    expect(eleventh.statusCode).toBe(409);
    expect(eleventh.json()).toMatchObject({code: 'LIMIT_REACHED'});
    expect(eleventh.json().detail).toMatch(/10 active/);

    // Withdraw and re-upload until 30 uploads exist in total.
    let total = 10;
    while (total < 30) {
      const w = await app.inject({
        method: 'DELETE',
        url: `/v1/jobs/${jobId}/files/${ids.shift()}`,
        headers: bearer(worker.token),
      });
      expect(w.statusCode, w.body).toBe(200);
      const res = await upload(worker.token, jobId, png());
      expect(res.statusCode, res.body).toBe(201);
      ids.push(res.json().fileId);
      total++;
    }
    await app.inject({
      method: 'DELETE',
      url: `/v1/jobs/${jobId}/files/${ids.shift()}`,
      headers: bearer(worker.token),
    });
    const thirtyFirst = await upload(worker.token, jobId, png());
    expect(thirtyFirst.statusCode).toBe(409);
    expect(thirtyFirst.json().detail).toMatch(/30 uploads/);
    const list = (await app.inject({url: `/v1/jobs/${jobId}/files`, headers: bearer(worker.token)})).json();
    expect(list).toMatchObject({active: 9, total: 30});
    // Withdrawn bytes are kept: older snapshots must stay checkable.
    expect(store.objects.size).toBe(30);
  });

  it('only the worker uploads or withdraws; withdrawing twice is a replay', async () => {
    const {jobId, worker, client} = await acceptedJob();
    expect((await upload(client.token, jobId, png())).statusCode).toBe(403);
    const f = (await upload(worker.token, jobId, png())).json();
    const del = (token: string) =>
      app.inject({method: 'DELETE', url: `/v1/jobs/${jobId}/files/${f.fileId}`, headers: bearer(token)});
    expect((await del(client.token)).statusCode).toBe(403);
    const first = await del(worker.token);
    expect(first.json()).toMatchObject({replayed: false});
    expect(first.json().withdrawnAt).not.toBeNull();
    expect((await del(worker.token)).json()).toMatchObject({replayed: true});
  });

  it('refuses uploads before the job is accepted and without storage configured (503, never a silent fake)', async () => {
    const {jobId, worker} = await acceptedJob();
    const res = await upload(worker.token, jobId, png(), {}, bare);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('UPSTREAM_UNAVAILABLE');
    await db.execute(sql`UPDATE jobs SET state = 'created' WHERE public_id = ${jobId}`);
    const early = await upload(worker.token, jobId, png());
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('INVALID_STATE');
  });

  it('takes multipart on the upload route only', async () => {
    const {jobId, worker} = await acceptedJob();
    const m = multipart(Buffer.from('{"text":"hello there, a draft"}'));
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/drafts`,
      headers: {...bearer(worker.token), ...m.headers},
      payload: m.payload,
    });
    expect(res.statusCode).toBe(415);
  });
});

describe('who may read evidence, drafts and chat', () => {
  it('refuses a third party on every read and write, and needs a credential', async () => {
    const {jobId, worker} = await acceptedJob();
    const f = (await upload(worker.token, jobId, png())).json();
    const d = (await draft(worker.token, jobId)).json();
    const stranger = await agent(app, 'ev-stranger');
    const outsider = await person(app, 'ev-outsider');
    for (const token of [stranger.apiKey, outsider.token]) {
      for (const url of [
        `/v1/files/${f.fileId}`,
        `/v1/jobs/${jobId}/files`,
        `/v1/jobs/${jobId}/drafts`,
        `/v1/jobs/${jobId}/messages`,
      ]) {
        const res = await app.inject({url, headers: bearer(token)});
        expect(res.statusCode, url).toBe(403);
      }
      expect((await say(token, jobId, 'let me in')).statusCode).toBe(403);
      expect((await review(token, jobId, d, 'accept_draft')).statusCode).toBe(403);
      expect((await upload(token, jobId, png())).statusCode).toBe(403);
    }
    expect((await app.inject({url: `/v1/files/${f.fileId}`})).statusCode).toBe(401);
    expect((await app.inject({url: `/v1/jobs/${jobId}/messages`})).statusCode).toBe(401);
  });
});

describe('draft rounds and review', () => {
  it('builds an immutable snapshot whose sha256 is the draft hash; a withdrawn photo is out of the next one, still in the old', async () => {
    const {jobId, worker, client} = await acceptedJob();
    const a = (await upload(worker.token, jobId, png())).json();
    const b = (await upload(worker.token, jobId, jpeg())).json();
    await say(client.token, jobId, 'Please include the door.');
    const res = await draft(worker.token, jobId, 'Two photos attached, the door is visible.', {photos: 2});
    expect(res.statusCode, res.body).toBe(201);
    const d1 = res.json();
    expect(d1.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d1.snapshotHash).toBe(sha256Hex(canonicalize(d1.snapshot)));
    expect(d1.snapshot).toMatchObject({
      v: 1,
      jobId,
      round: 1,
      text: 'Two photos attached, the door is visible.',
      output: {photos: 2},
    });
    expect(d1.snapshot.files.map((x: {fileId: string}) => x.fileId)).toEqual([a.fileId, b.fileId]);
    expect(d1.snapshot.files[0]).toEqual({
      fileId: a.fileId,
      sha256: a.sha256,
      mime: 'image/png',
      size: a.size,
    });
    expect(d1.snapshot.messages).toEqual([
      expect.objectContaining({from: 'client', body: 'Please include the door.'}),
    ]);
    const job = (await app.inject({url: `/v1/jobs/${jobId}`})).json();
    expect(d1.snapshot.terms).toEqual(job.spec);
    expect(d1.snapshot.specHash).toBe(job.specHash);

    // A second draft while this one awaits review is refused; the same one again is a replay.
    expect((await draft(worker.token, jobId, 'Something else entirely, please.')).statusCode).toBe(409);
    const again = await draft(worker.token, jobId, 'Two photos attached, the door is visible.', {photos: 2});
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({draftId: d1.draftId, replayed: true});

    expect((await review(client.token, jobId, d1, 'revise')).statusCode).toBe(200);
    await app.inject({
      method: 'DELETE',
      url: `/v1/jobs/${jobId}/files/${a.fileId}`,
      headers: bearer(worker.token),
    });
    const d2 = (await draft(worker.token, jobId, 'Retook it: one photo, closer.')).json();
    expect(d2.round).toBe(2);
    expect(d2.snapshot.files.map((x: {fileId: string}) => x.fileId)).toEqual([b.fileId]);
    // The old snapshot is unchanged, and the withdrawn file still readable.
    const list = (await app.inject({url: `/v1/jobs/${jobId}/drafts`, headers: bearer(client.token)})).json();
    expect(list.drafts[0].snapshot.files.map((x: {fileId: string}) => x.fileId)).toEqual([
      a.fileId,
      b.fileId,
    ]);
    expect(list.drafts[0].snapshotHash).toBe(d1.snapshotHash);
    expect(sha256Hex(canonicalize(list.drafts[0].snapshot))).toBe(d1.snapshotHash);
    expect((await app.inject({url: `/v1/files/${a.fileId}`, headers: bearer(client.token)})).statusCode).toBe(
      200,
    );
    expect(list).toMatchObject({phase: 'awaiting_review', revisionsUsed: 1, revisionsLeft: 2});
  });

  it('refuses a stale hash with 409', async () => {
    const {jobId, worker, client} = await acceptedJob();
    const d1 = (await draft(worker.token, jobId)).json();
    const wrong = await review(
      client.token,
      jobId,
      {draftId: d1.draftId, snapshotHash: 'a'.repeat(64)},
      'accept_draft',
    );
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().detail).toMatch(/stale/);
    await review(client.token, jobId, d1, 'revise');
    const d2 = (await draft(worker.token, jobId, 'The second round, retaken.')).json();
    // Reviewing a superseded round's snapshot: stale too (it was already decided, so a different decision conflicts).
    const old = await review(client.token, jobId, d1, 'accept_draft');
    expect(old.statusCode).toBe(409);
    const cross = await review(
      client.token,
      jobId,
      {draftId: d2.draftId, snapshotHash: d1.snapshotHash},
      'accept_draft',
    );
    expect(cross.statusCode).toBe(409);
    expect(cross.json().detail).toMatch(/stale/);
  });

  it('allows 3 revisions and refuses the 4th', async () => {
    const {jobId, worker, client} = await acceptedJob();
    for (let round = 1; round <= 3; round++) {
      const d = (await draft(worker.token, jobId, `Round ${round} of the photo.`)).json();
      expect(d.round).toBe(round);
      const r = await review(client.token, jobId, d, 'revise');
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().revisionsLeft).toBe(3 - round);
    }
    const d4 = (await draft(worker.token, jobId, 'Round 4 of the photo.')).json();
    const fourth = await review(client.token, jobId, d4, 'revise');
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().code).toBe('LIMIT_REACHED');
    // The client must decide: accept or dispute.
    expect((await review(client.token, jobId, d4, 'dispute_intent')).statusCode).toBe(200);
    expect((await draft(worker.token, jobId, 'A fifth round, please.')).statusCode).toBe(409);
  });

  it('refuses accept_draft with an unmet check, and writes a review once per snapshot', async () => {
    const {jobId, worker, client} = await acceptedJob();
    const d = (await draft(worker.token, jobId)).json();
    const unmet = await review(client.token, jobId, d, 'accept_draft', {checks: checks(false)});
    expect(unmet.statusCode).toBe(422);
    expect(unmet.json().detail).toMatch(/The whole shop front is visible/);
    expect((await review(client.token, jobId, d, 'accept_draft', {checks: []})).statusCode).toBe(422);
    expect(
      (
        await review(client.token, jobId, d, 'accept_draft', {
          checks: Array.from({length: 31}, () => checks()[0]),
        })
      ).statusCode,
    ).toBe(422);
    expect((await review(client.token, jobId, d, 'accept_draft', {reason: 'too short'})).statusCode).toBe(
      422,
    );
    expect((await review(worker.token, jobId, d, 'accept_draft')).statusCode).toBe(403);

    const first = await review(client.token, jobId, d, 'accept_draft');
    expect(first.statusCode, first.body).toBe(200);
    const r = first.json();
    expect(r.review.reviewHash).toBe(
      sha256Hex(
        canonicalize({
          v: 1,
          jobId,
          draftId: d.draftId,
          snapshotHash: d.snapshotHash,
          decision: 'accept_draft',
          reason: 'Exactly what was asked for.',
          checks: checks(),
        }),
      ),
    );
    expect(r).toMatchObject({phase: 'accepted', acceptedSnapshotHash: d.snapshotHash, replayed: false});
    const replay = await review(client.token, jobId, d, 'accept_draft', {reason: 'Said again on a retry.'});
    expect(replay.json()).toMatchObject({replayed: true, review: {reviewHash: r.review.reviewHash}});
    const other = await review(client.token, jobId, d, 'revise');
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe('IDEMPOTENCY_CONFLICT');
    const [{n}] = (await db.execute(sql`SELECT count(*)::int AS n FROM job_reviews`)) as unknown as [
      {n: number},
    ];
    expect(n).toBe(1);
    // Once accepted, the evidence is fixed.
    expect((await upload(worker.token, jobId, png())).statusCode).toBe(409);
    expect((await draft(worker.token, jobId, 'One more change after all.')).statusCode).toBe(409);
  });

  it('checks a draft output against the outputSchema when the spec has one', async () => {
    const {jobId, worker} = await acceptedJob();
    await db.execute(
      sql`UPDATE jobs SET spec = jsonb_set(spec, '{outputSchema}', '{"type":"object","required":["photos"]}') WHERE public_id = ${jobId}`,
    );
    expect((await draft(worker.token, jobId, 'No structured output given.', {other: 1})).statusCode).toBe(
      422,
    );
    expect((await draft(worker.token, jobId, 'Structured output given.', {photos: 1})).statusCode).toBe(201);
  });
});

describe('submitting from an accepted draft', () => {
  it('refuses to submit a listing job without an accepted draft — agent route and person prepare', async () => {
    const a = await acceptedJob();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${a.jobId}/result`,
      headers: bearer(a.worker.token),
      payload: {output: {photos: 1}, producedAt: new Date().toISOString()},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/accepted draft/);
    expect(submitted).toHaveLength(0);

    const p = await acceptedJob({worker: 'person'});
    const prep = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${p.jobId}/person-actions/prepare`,
      headers: bearer(p.worker.token),
      payload: {action: 'submit', output: {photos: 1}, producedAt: new Date().toISOString()},
    });
    expect(prep.statusCode).toBe(409);
    expect(prep.json().detail).toMatch(/accepted draft/);
  });

  it("an agent worker submits the accepted snapshot hash; the API approves for the agent client with the review's hash", async () => {
    const {jobId, chainJobId, worker, client} = await acceptedJob();
    await upload(worker.token, jobId, png());
    const d = (await draft(worker.token, jobId)).json();
    const r = (await review(client.token, jobId, d, 'accept_draft')).json();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/result`,
      headers: bearer(worker.token),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      resultHash: d.snapshotHash,
      settlement: {status: 'approved', reviewHash: r.review.reviewHash},
    });
    expect(submitted.map((s) => s.kind)).toEqual(['submitResult', 'approve']);
    expect(submitted[0]!.payload!['resultHash']).toBe(d.snapshotHash);
    expect(submitted[1]!.payload!['reviewHash']).toBe(r.review.reviewHash);
    const job = (await app.inject({url: `/v1/jobs/${jobId}`})).json();
    expect(job).toMatchObject({state: 'settled', resultHash: d.snapshotHash, chainJobId});
    expect(job.resultUri).toBe(`pactora://jobs/${jobId}/drafts/${d.draftId}`);
    // The public job shows a reference, never the evidence.
    expect(job.result).toEqual({draftId: d.draftId, snapshotHash: d.snapshotHash, round: 1});
    expect(JSON.stringify(job)).not.toContain('Photo taken at 10:00');
  });

  it('a person worker gets result_hash = snapshot hash to sign; the confirm carries out the agent client approval', async () => {
    const {jobId, chainJobId, worker, client} = await acceptedJob({worker: 'person'});
    const d = (await draft(worker.token, jobId)).json();
    const r = (await review(client.token, jobId, d, 'accept_draft')).json();
    const prep = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/person-actions/prepare`,
      headers: bearer(worker.token),
      payload: {action: 'submit'},
    });
    expect(prep.statusCode, prep.body).toBe(200);
    expect(prep.json().functionCall.args).toEqual({job_id: Number(chainJobId), result_hash: d.snapshotHash});
    const h = onChainTx(txHash(), worker.account!, [
      {event: 'result_submitted', data: {job_id: Number(chainJobId), result_hash: d.snapshotHash}},
    ]);
    const conf = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/person-actions/confirm`,
      headers: bearer(worker.token),
      payload: {action: 'submit', txHash: h},
    });
    expect(conf.statusCode, conf.body).toBe(200);
    expect(conf.json()).toMatchObject({
      state: 'settled',
      resultMismatch: false,
      settlement: {status: 'approved'},
    });
    expect(submitted).toEqual([
      expect.objectContaining({kind: 'approve', payload: {reviewHash: r.review.reviewHash}}),
    ]);
  });

  it('a person client is told it is ready to approve, and its approve call carries the review hash', async () => {
    const {jobId, chainJobId, worker, client} = await acceptedJob({client: 'person'});
    const d = (await draft(worker.token, jobId)).json();
    const r = (await review(client.token, jobId, d, 'accept_draft')).json();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/result`,
      headers: bearer(worker.token),
      payload: {},
    });
    expect(res.json().settlement).toEqual({status: 'ready_to_approve', reviewHash: r.review.reviewHash});
    expect(submitted.map((s) => s.kind)).toEqual(['submitResult']);
    const drafts = (
      await app.inject({url: `/v1/jobs/${jobId}/drafts`, headers: bearer(client.token)})
    ).json();
    expect(drafts.readyToApprove).toBe(true);
    const prep = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/person-actions/prepare`,
      headers: bearer(client.token),
      payload: {action: 'approve'},
    });
    expect(prep.statusCode, prep.body).toBe(200);
    expect(prep.json().functionCall.args).toEqual({
      job_id: Number(chainJobId),
      review_hash: r.review.reviewHash,
    });
  });

  it('a different hash on chain is a mismatch: approval refused for agent and person alike, only a dispute is offered', async () => {
    const {jobId, chainJobId, worker, client} = await acceptedJob({worker: 'person'});
    const d = (await draft(worker.token, jobId)).json();
    await review(client.token, jobId, d, 'accept_draft');
    await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/person-actions/prepare`,
      headers: bearer(worker.token),
      payload: {action: 'submit'},
    });
    // The worker signs something else than the accepted snapshot.
    const h = onChainTx(txHash(), worker.account!, [
      {event: 'result_submitted', data: {job_id: Number(chainJobId), result_hash: 'b'.repeat(64)}},
    ]);
    const conf = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/person-actions/confirm`,
      headers: bearer(worker.token),
      payload: {action: 'submit', txHash: h},
    });
    expect(conf.json()).toMatchObject({state: 'submitted', resultMismatch: true});
    expect(conf.json().settlement).toBeUndefined();
    expect(submitted).toHaveLength(0);
    const approve = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/approve`,
      headers: bearer(client.token),
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().code).toBe('RESULT_MISMATCH');
    const drafts = (
      await app.inject({url: `/v1/jobs/${jobId}/drafts`, headers: bearer(client.token)})
    ).json();
    expect(drafts).toMatchObject({readyToApprove: false, resultMismatch: true});
    const dispute = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/dispute`,
      headers: bearer(client.token),
      payload: {reason: 'the hash on chain is not the accepted draft'},
    });
    expect(dispute.statusCode, dispute.body).toBe(200);
  });

  it('the sweep approves an accepted draft the indexer saw on chain, once', async () => {
    const swept = await build({objectStore: store, draftSettleSweepMs: 50});
    try {
      const {jobId, worker, client} = await acceptedJob();
      const d = (await draft(worker.token, jobId)).json();
      await review(client.token, jobId, d, 'accept_draft');
      // As the indexer writes it: state and hash from the chain, no API call.
      await db.execute(
        sql`UPDATE jobs SET state = 'submitted', result_hash = ${d.snapshotHash} WHERE public_id = ${jobId}`,
      );
      for (let i = 0; i < 60 && submitted.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 200));
      expect(submitted.map((s) => s.kind)).toEqual(['approve']);
      const job = (await app.inject({url: `/v1/jobs/${jobId}`})).json();
      expect(job.state).toBe('settled');
    } finally {
      await swept.close();
    }
  });

  it('a non-listing job keeps the delivery-hash behaviour unchanged', async () => {
    const c = await agent(app, 'ev-direct-c');
    const w = await agent(app, 'ev-direct-w', {pricePerTask: '50000'});
    const hire = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {...bearer(c.apiKey), 'idempotency-key': 'ev-direct-hire-1'},
      payload: {
        workerAgentId: String(w.agentId),
        spec: {capability: 'market-research', input: {q: 'x'}},
        maxPrice: '50000',
        path: 'escrow',
      },
    });
    expect(hire.statusCode, hire.body).toBe(201);
    const jobId = hire.json().jobId;
    await app.inject({method: 'POST', url: `/v1/jobs/${jobId}/accept`, headers: bearer(w.apiKey)});
    const output = {summary: 'a result'};
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/result`,
      headers: bearer(w.apiKey),
      payload: {output, producedAt: new Date().toISOString()},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().settlement).toBeUndefined();
    const job = (await app.inject({url: `/v1/jobs/${jobId}`})).json();
    expect(job).toMatchObject({
      state: 'submitted',
      resultHash: sha256Hex(canonicalize(output)),
      resultUri: null,
    });
  });
});

describe('chat', () => {
  it('posts between the parties, announces it on the public stream without its words, and keeps replies in the job', async () => {
    const {jobId, worker, client} = await acceptedJob();
    const first = await say(client.token, jobId, 'Is the shop open on Sundays?');
    expect(first.statusCode, first.body).toBe(201);
    const m = first.json();
    expect(m).toMatchObject({from: 'client', body: 'Is the shop open on Sundays?', inReplyTo: null});
    const reply = await say(worker.token, jobId, 'Yes, from ten.', undefined, {inReplyTo: m.messageId});
    expect(reply.json()).toMatchObject({from: 'worker', inReplyTo: m.messageId});

    const other = await acceptedJob();
    const foreign = (await say(other.client.token, other.jobId, 'A message in another job.')).json();
    const cross = await say(worker.token, jobId, 'Replying across jobs.', undefined, {
      inReplyTo: foreign.messageId,
    });
    expect(cross.statusCode).toBe(422);

    const list = (
      await app.inject({url: `/v1/jobs/${jobId}/messages`, headers: bearer(worker.token)})
    ).json();
    expect(list).toMatchObject({count: 2, writable: true, role: 'worker'});
    expect(list.messages.map((x: {body: string}) => x.body)).toEqual([
      'Is the shop open on Sundays?',
      'Yes, from ten.',
    ]);

    const events = (await app.inject({url: `/v1/jobs/${jobId}`}))
      .json()
      .events.map((e: {kind: string}) => e.kind);
    expect(events.filter((k: string) => k === 'job.message')).toHaveLength(2);
    const [row] = (await db.execute(
      sql`SELECT payload FROM job_events WHERE kind = 'job.message' ORDER BY id LIMIT 1`,
    )) as unknown as [{payload: Record<string, unknown>}];
    expect(Object.keys(row.payload).sort()).toEqual(['at', 'from', 'jobId', 'messageId']);
  });

  it('is idempotent by key: the same key and body is the same message, a changed body is 409', async () => {
    const {jobId, client} = await acceptedJob();
    const key = 'msg-key-0000000001';
    const a = await say(client.token, jobId, 'Hello there.', key);
    const b = await say(client.token, jobId, 'Hello there.', key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({messageId: a.json().messageId, replayed: true});
    const c = await say(client.token, jobId, 'Hello, changed.', key);
    expect(c.statusCode).toBe(409);
    expect(c.json().code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await say(client.token, jobId, 'Short key.', 'too-short')).statusCode).toBe(422);
    expect((await say(client.token, jobId, 'Long key.', 'k'.repeat(129))).statusCode).toBe(422);
  });

  it('takes 1-4000 characters and 100 messages per job', async () => {
    const {jobId, client, worker} = await acceptedJob();
    expect((await say(client.token, jobId, '')).statusCode).toBe(422);
    expect((await say(client.token, jobId, '   ')).statusCode).toBe(422);
    expect((await say(client.token, jobId, 'x'.repeat(4001))).statusCode).toBe(422);
    expect((await say(client.token, jobId, 'x'.repeat(4000))).statusCode).toBe(201);
    for (let i = 1; i < 100; i++) {
      const res = await say(i % 2 ? worker.token : client.token, jobId, `message ${i}`);
      expect(res.statusCode).toBe(201);
    }
    const over = await say(client.token, jobId, 'the 101st');
    expect(over.statusCode).toBe(409);
    expect(over.json().code).toBe('LIMIT_REACHED');
    const d = (await draft(worker.token, jobId)).json();
    expect(d.snapshot.messages).toHaveLength(100);
  });

  it('is open while the job is accepted or submitted, and closed before and after', async () => {
    const {jobId, client} = await acceptedJob();
    for (const [state, code] of [
      ['created', 409],
      ['accepted', 201],
      ['submitted', 201],
      ['settled', 409],
      ['refunded', 409],
      ['disputed', 409],
    ] as const) {
      await db.execute(sql`UPDATE jobs SET state = ${state} WHERE public_id = ${jobId}`);
      const res = await say(client.token, jobId, `while ${state}`);
      expect(res.statusCode, state).toBe(code);
    }
  });
});

describe('the upload semaphore', () => {
  it('lets `limit` through, queues the rest in order, and refuses a request that waited too long', async () => {
    const {Semaphore} = await import('../src/routes/files.js');
    const s = new Semaphore(2, 100);
    const a = await s.acquire();
    const b = await s.acquire();
    expect(s.inUse).toBe(2);
    let third = false;
    const c = s.acquire().then((release) => ((third = true), release));
    await new Promise((r) => setTimeout(r, 20));
    expect(third).toBe(false);
    a();
    a(); // a second release of the same slot does nothing
    const releaseC = await c;
    expect(third).toBe(true);
    expect(s.inUse).toBe(2);
    await expect(s.acquire()).rejects.toMatchObject({code: 'RATE_LIMITED'});
    b();
    releaseC();
    expect(s.inUse).toBe(0);
  });
});
