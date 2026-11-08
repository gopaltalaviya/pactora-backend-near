import {createHmac} from 'node:crypto';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {eq, sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import type {ListEntry} from '@pactora/compliance';
import {
  agents,
  closeDb,
  complianceAudit,
  createDb,
  identityVerifications,
  sanctionsListVersions,
  standingOf,
  type Db,
} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {
  SanctionsIndex,
  SimulatedIdentityProvider,
  storeList,
  type IdentityDecision,
  type IdentityProvider,
} from '../src/compliance.js';
import {kycSweep} from '../src/routes/kyc.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, fakeReadTxEvents, person} from './helpers/people.js';

/** docs/26 F13, F14, F27: screening, identity checks, cases, standing, retention. */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});
const SECRET = 'w'.repeat(40);

let app: FastifyInstance;
let unscreened: FastifyInstance;
let db: Db;
let provider: SimulatedIdentityProvider;
let reviewers: string[] = [];

/** 5000 filler entries (the OFAC minimum) plus the names the tests screen. */
function ofacFixture(extra: ListEntry[]): ListEntry[] {
  const filler = Array.from({length: 5000}, (_, i) => ({
    source: 'ofac',
    ref: String(100000 + i),
    kind: 'individual' as const,
    names: [`Fillername${i} Zzyzx${i}`],
  }));
  return [...filler, ...extra];
}
const TARGET: ListEntry = {
  source: 'ofac',
  ref: '2674',
  kind: 'individual',
  names: ['ABBAS, Abu', 'Abu ABBAS'],
};
const NEAR_MISS: ListEntry = {
  source: 'ofac',
  ref: '7777',
  kind: 'individual',
  names: ['Rustam Karimova Tashkentova'],
};

beforeAll(async () => {
  db = createDb(DB_URL, {max: 10});
  provider = new SimulatedIdentityProvider(SECRET, 'http://site.test');
  const base = {
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
  };
  app = await buildApp({
    ...base,
    identityProvider: provider,
    sanctions: new SanctionsIndex(db),
    screening: true,
    get complianceReviewers() {
      return reviewers;
    },
  });
  unscreened = await buildApp({
    ...base,
    identityProvider: provider,
    sanctions: new SanctionsIndex(db),
    screening: true,
  });
});
afterAll(async () => {
  await app.close();
  await unscreened.close();
  await closeDb(db);
});
beforeEach(async () => {
  reviewers = [];
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, sessions, login_challenges, registration_challenges, api_keys, sanctions_list_versions, sanctions_entries, identity_verifications, account_standing, compliance_cases, compliance_decisions RESTART IDENTITY CASCADE`,
  );
});

const loadLists = () =>
  storeList(db, 'ofac', `fixture-${Date.now()}-${Math.random()}`, ofacFixture([TARGET, NEAR_MISS]));
const start = (token: string, legalName: string, on = app) =>
  on.inject({method: 'POST', url: '/v1/kyc/start', headers: bearer(token), payload: {legalName}});
const kyc = async (token: string) =>
  (await app.inject({method: 'GET', url: '/v1/kyc', headers: bearer(token)})).json();
const agentIdOf = async (publicId: string) =>
  (await db.query.agents.findFirst({where: eq(agents.publicId, publicId)}))!.id;
const auditFor = async (agentId: number) =>
  (await db.select().from(complianceAudit).where(eq(complianceAudit.agentId, agentId))).map((a) => a.action);

let n = 0;

describe('list refresh guards', () => {
  it('replaces, then skips an unchanged copy, and refuses a truncated one keeping the old', async () => {
    const entries = ofacFixture([TARGET]);
    expect((await storeList(db, 'ofac', 'copy-1', entries)).action).toBe('replace');
    expect((await storeList(db, 'ofac', 'copy-1', entries)).action).toBe('skip');
    const truncated = await storeList(db, 'ofac', 'copy-2', entries.slice(0, 3000));
    expect(truncated).toMatchObject({action: 'refuse'});
    const active = await db
      .select()
      .from(sanctionsListVersions)
      .where(eq(sanctionsListVersions.active, true));
    expect(active).toHaveLength(1);
    expect(active[0]!.entryCount).toBe(5001);
    expect((await new SanctionsIndex(db).screen('Abu Abbas')).hits).toHaveLength(1);
  });

  it('with screening on and no list loaded, nothing starts: an empty list is not a clean result', async () => {
    const p = await person(app, `k${++n}`);
    const r = await start(p.token, 'Priya Sharma');
    expect(r.statusCode).toBe(503);
    expect(r.json().detail).toMatch(/no sanctions list is loaded/);
  });
});

describe('identity checks', () => {
  it('a clean name gets a session; approval needs a verified document', async () => {
    await loadLists();
    const p = await person(app, `k${++n}`);
    const r = await start(p.token, 'Priya Sharma');
    expect(r.statusCode, r.body).toBe(201);
    const s = r.json();
    expect(s).toMatchObject({status: 'pending', simulated: true});
    expect(s.url).toMatch(/^http:\/\/site\.test\/kyc\/simulated\?session=sim_/);
    const session = new URL(s.url).searchParams.get('session')!;
    // A second start is the same check.
    expect((await start(p.token, 'Priya Sharma')).json()).toMatchObject({
      verificationId: s.verificationId,
      replayed: true,
    });

    const noDoc = await app.inject({
      method: 'POST',
      url: `/v1/kyc/simulated/${session}`,
      headers: bearer(p.token),
      payload: {outcome: 'approved', documentVerified: false},
    });
    expect(noDoc.json().status).toBe('rejected');
    expect((await kyc(p.token)).verification).toMatchObject({status: 'rejected', documentVerified: false});

    const r2 = await start(p.token, 'Priya Sharma');
    const session2 = new URL(r2.json().url).searchParams.get('session')!;
    await app.inject({
      method: 'POST',
      url: `/v1/kyc/simulated/${session2}`,
      headers: bearer(p.token),
      payload: {outcome: 'approved'},
    });
    const k = await kyc(p.token);
    expect(k).toMatchObject({
      standing: 'clear',
      provider: {name: 'simulated', simulated: true},
      walletScreening: expect.stringMatching(/not available/),
      verification: {status: 'approved', documentVerified: true},
    });
    // Only the minimum is kept.
    const [row] = await db
      .select()
      .from(identityVerifications)
      .where(eq(identityVerifications.publicId, k.verification.verificationId));
    expect(Object.keys(row!).sort()).toEqual(
      [
        'agentId',
        'createdAt',
        'decidedAt',
        'documentVerified',
        'id',
        'legalName',
        'provider',
        'providerSessionId',
        'publicId',
        'status',
      ].sort(),
    );
  });

  it('a strong match holds the account and opens NO vendor session', async () => {
    await loadLists();
    const p = await person(app, `k${++n}`);
    const r = await start(p.token, 'Abu Abbas');
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({status: 'held'});
    expect(r.json().url).toBeUndefined();
    const agentId = await agentIdOf(p.publicId);
    expect(await standingOf(db, agentId)).toBe('hold');
    const [row] = await db
      .select()
      .from(identityVerifications)
      .where(eq(identityVerifications.agentId, agentId));
    expect(row!.providerSessionId).toBeNull();
    expect(await auditFor(agentId)).toEqual(expect.arrayContaining(['case.opened', 'standing.hold']));
  });

  it('the simulated page is for the session owner only', async () => {
    await loadLists();
    const p = await person(app, `k${++n}`);
    const other = await person(app, `k${++n}`);
    const session = new URL((await start(p.token, 'Priya Sharma')).json().url).searchParams.get('session')!;
    const r = await app.inject({
      method: 'POST',
      url: `/v1/kyc/simulated/${session}`,
      headers: bearer(other.token),
      payload: {outcome: 'approved'},
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('webhooks are only a reason to ask again', () => {
  const sign = (raw: string, t: number, secret = SECRET) => ({
    'content-type': 'application/json',
    'x-timestamp': String(t),
    'x-signature': createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex'),
  });

  it('a forged, old or unsigned webhook changes nothing; a genuine one makes us re-read the provider', async () => {
    await loadLists();
    const p = await person(app, `k${++n}`);
    const session = new URL((await start(p.token, 'Priya Sharma')).json().url).searchParams.get('session')!;
    // The provider decides, but nobody tells us yet.
    provider.complete(session, 'approved', true);
    const raw = JSON.stringify({sessionId: session, status: 'approved'});
    const now = Math.floor(Date.now() / 1000);
    const hook = (headers: Record<string, string>, payload = raw) =>
      app.inject({method: 'POST', url: '/v1/kyc/webhook', headers, payload});
    const statusNow = async () =>
      (
        await db
          .select()
          .from(identityVerifications)
          .where(eq(identityVerifications.providerSessionId, session))
      )[0]!.status;

    expect((await hook(sign(raw, now, 'x'.repeat(40)))).json()).toEqual({accepted: false});
    expect((await hook(sign(raw, now - 301))).json()).toEqual({accepted: false});
    expect((await hook({'content-type': 'application/json'})).json()).toEqual({accepted: false});
    // Signed over a different body than the one sent.
    expect((await hook(sign(raw, now), `${raw} `)).json()).toEqual({accepted: false});
    expect(await statusNow()).toBe('pending');

    expect((await hook(sign(raw, now))).json()).toEqual({accepted: true});
    expect(await statusNow()).toBe('approved');
  });

  it('a decision for a session opened for someone else is not applied', async () => {
    await loadLists();
    const p = await person(app, `k${++n}`);
    const r = await start(p.token, 'Priya Sharma');
    const session = new URL(r.json().url).searchParams.get('session')!;
    const lying: IdentityProvider = {
      name: 'simulated',
      simulated: true,
      createSession: provider.createSession.bind(provider),
      fetchDecision: async (): Promise<IdentityDecision> => ({
        status: 'approved',
        documentVerified: true,
        vendorData: 'someone-else',
      }),
      verifyWebhook: () => session,
    };
    await kycSweep(db, lying);
    const [row] = await db
      .select()
      .from(identityVerifications)
      .where(eq(identityVerifications.providerSessionId, session));
    expect(row!.status).toBe('pending');
    expect(await auditFor(row!.agentId)).toContain('kyc.vendor_data_mismatch');
  });

  it('a missed webhook is caught by the sweep, and retention expires and deletes', async () => {
    await loadLists();
    const p = await person(app, `k${++n}`);
    const session = new URL((await start(p.token, 'Priya Sharma')).json().url).searchParams.get('session')!;
    provider.complete(session, 'rejected', false);
    await kycSweep(db, provider);
    const [row] = await db
      .select()
      .from(identityVerifications)
      .where(eq(identityVerifications.providerSessionId, session));
    expect(row!.status).toBe('rejected');

    const later = new Date(Date.now() + 91 * 86_400_000);
    await kycSweep(db, undefined, later);
    expect(
      await db.select().from(identityVerifications).where(eq(identityVerifications.id, row!.id)),
    ).toEqual([]);

    const q = await person(app, `k${++n}`);
    await start(q.token, 'Priya Sharma');
    await kycSweep(db, undefined, new Date(Date.now() + 31 * 86_400_000));
    expect((await kyc(q.token)).verification.status).toBe('expired');
  });
});

describe('cases and decisions', () => {
  async function heldPerson() {
    await loadLists();
    const p = await person(app, `k${++n}`);
    await start(p.token, 'Abu Abbas');
    const r1 = await person(app, `rev${++n}`);
    const r2 = await person(app, `rev${++n}`);
    reviewers = [r1.account, r2.account, p.account];
    const cases = (
      await app.inject({method: 'GET', url: '/v1/compliance/cases', headers: bearer(r1.token)})
    ).json().cases;
    return {p, r1, r2, c: cases[0], agentId: await agentIdOf(p.publicId)};
  }
  const decideAs = (token: string, caseId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/v1/compliance/cases/${caseId}/decisions`,
      headers: bearer(token),
      payload,
    });
  const why = 'Different date of birth and nationality.';

  it('only reviewers see the queue, and nobody decides their own case', async () => {
    const {p, c} = await heldPerson();
    const stranger = await person(app, `k${++n}`);
    expect(
      (await app.inject({method: 'GET', url: '/v1/compliance/cases', headers: bearer(stranger.token)}))
        .statusCode,
    ).toBe(403);
    expect(c).toMatchObject({strength: 'strong', status: 'open', version: 1, subjectAccount: p.account});
    const self = await decideAs(p.token, c.caseId, {decision: 'clear', reason: why, caseVersion: 1});
    expect(self.statusCode).toBe(403);
    expect(self.json().detail).toMatch(/own account/);
  });

  it('a strong match needs two different reviewers to clear; then the hold lifts', async () => {
    const {r1, r2, c, agentId} = await heldPerson();
    const first = await decideAs(r1.token, c.caseId, {decision: 'clear', reason: why, caseVersion: 1});
    expect(first.json()).toMatchObject({status: 'open', version: 2, clearsSoFar: 1});
    expect(await standingOf(db, agentId)).toBe('hold');
    // The same reviewer again is a replay, not a second voice.
    expect(
      (await decideAs(r1.token, c.caseId, {decision: 'clear', reason: why, caseVersion: 2})).json(),
    ).toMatchObject({replayed: true, status: 'open'});
    expect(
      (await decideAs(r1.token, c.caseId, {decision: 'confirm', reason: why, caseVersion: 2})).statusCode,
    ).toBe(409);
    // A decision made on what the case used to be is stale.
    expect(
      (await decideAs(r2.token, c.caseId, {decision: 'clear', reason: why, caseVersion: 1})).statusCode,
    ).toBe(409);
    const second = await decideAs(r2.token, c.caseId, {decision: 'clear', reason: why, caseVersion: 2});
    expect(second.json()).toMatchObject({status: 'cleared', clearsSoFar: 2});
    expect(await standingOf(db, agentId)).toBe('clear');
    expect(await auditFor(agentId)).toEqual(expect.arrayContaining(['case.clear', 'standing.clear']));
  });

  it('one reviewer confirming blocks the account', async () => {
    const {r1, c, agentId} = await heldPerson();
    const r = await decideAs(r1.token, c.caseId, {
      decision: 'confirm',
      reason: 'Same name, DOB and nationality.',
      caseVersion: 1,
    });
    expect(r.json()).toMatchObject({status: 'confirmed'});
    expect(await standingOf(db, agentId)).toBe('blocked');
    expect(
      (await decideAs(r1.token, c.caseId, {decision: 'clear', reason: why, caseVersion: 2})).statusCode,
    ).toBe(409);
  });

  it('a decision needs a reason of 10-2000 characters', async () => {
    const {r1, c} = await heldPerson();
    expect(
      (await decideAs(r1.token, c.caseId, {decision: 'clear', reason: 'ok', caseVersion: 1})).statusCode,
    ).toBe(422);
  });

  it('the audit trail cannot be changed or emptied, not even by the API role', async () => {
    const {agentId} = await heldPerson();
    const tryIt = (q: ReturnType<typeof sql>) =>
      db.execute(q).then(
        () => 'done',
        (e: {cause?: {message?: string}}) => e.cause?.message ?? String(e),
      );
    expect(
      await tryIt(sql`UPDATE compliance_audit SET action = 'nothing' WHERE agent_id = ${agentId}`),
    ).toMatch(/append-only/);
    expect(await tryIt(sql`DELETE FROM compliance_audit WHERE agent_id = ${agentId}`)).toMatch(/append-only/);
    expect(await tryIt(sql`TRUNCATE compliance_audit`)).toMatch(/append-only/);
  });
});

describe('a hold is a soft gate in the API', () => {
  it('a held person cannot apply for or claim work; a clear one can apply', async () => {
    await loadLists();
    const client = await agent(app, `kc${++n}`);
    const post = (hiringMode: string, key: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/listings',
        headers: {...bearer(client.apiKey), 'idempotency-key': key},
        payload: {
          title: 'Photograph a shop front',
          description: 'One clear daytime photo of the shop front and its sign.',
          category: 'physical',
          interactionMode: 'capture',
          skills: ['photography'],
          maxPriceBaseUnits: '40000',
          maxWorkers: 1,
          hiringMode,
          estimatedMinutes: 30,
          deadline: new Date(Date.now() + 3 * 86_400_000).toISOString(),
          criteria: 'The whole shop front and its sign are visible and in focus.',
          acceptWindowSeconds: 600,
          workWindowSeconds: 7200,
        },
      });
    const l = await post('applications', `kyc-listing-apply-${n}`);
    expect(l.statusCode, l.body).toBe(201);
    const instant = await post('instant', `kyc-listing-instant-${n}`);
    expect(instant.statusCode, instant.body).toBe(201);
    const bid = {
      action: 'apply',
      priceBaseUnits: '30000',
      proposal: 'I can photograph it within the hour, in daylight.',
    };

    const held = await person(app, `kh${++n}`);
    await start(held.token, 'Abu Abbas');
    const refused = await app.inject({
      method: 'POST',
      url: `/v1/listings/${l.json().listingId}/applications`,
      headers: bearer(held.token),
      payload: bid,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().detail).toMatch(/on hold while a compliance review is open/);
    const claim = await app.inject({
      method: 'POST',
      url: `/v1/listings/${instant.json().listingId}/claim`,
      headers: bearer(held.token),
      payload: {},
    });
    expect(claim.statusCode).toBe(403);

    // The same request from someone clear goes through: the hold is what refused it.
    const clear = await person(app, `kok${++n}`);
    const ok = await app.inject({
      method: 'POST',
      url: `/v1/listings/${l.json().listingId}/applications`,
      headers: bearer(clear.token),
      payload: bid,
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });
});
