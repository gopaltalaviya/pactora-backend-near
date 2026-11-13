import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {eq, sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {
  accountStanding,
  channelLinks,
  closeDb,
  complianceCases,
  createDb,
  jobEvents,
  jobFiles,
  jobs,
  sessions,
  webhooks,
  type Db,
} from '@pactora/db';
import {MemoryObjectStore} from '@pactora/storage';
import {createMetrics} from '@pactora/service';
import {buildApp, EventBus} from '../src/app.js';
import type {ChainViewer} from '../src/chain-reads.js';
import {SimulatedIdentityProvider} from '../src/compliance.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, fakeReadTxEvents, person, sessionOnly} from './helpers/people.js';

/**
 * Authorization across every kind of caller (docs/15 §1 "Auth" column, and
 * the guards in apps/api/src/routes/*): every served route × every user
 * type, the outcome each should get, and what it does get.
 *
 * An outcome is the AUTHORIZATION result only:
 *   401 — not authenticated, or the wrong credential (WRONG_CREDENTIAL)
 *   403 — authenticated, not allowed
 *   404 — hidden (another tenant's object, or no such id)
 *   ok  — past every authorization check (2xx, or a later 4xx such as 422
 *         validation or 409 state, which only an authorized caller reaches)
 *
 * Bodies are deliberately incomplete where a complete one would act, so an
 * authorized caller is seen through a 422 and nothing is spent. The routes
 * that act with no body (rotate, revoke, sign-out) get a FRESH identity of
 * the same kind for each authorized caller, so the shared fixtures survive.
 *
 * Every served route must have a row: the matrix fails on a route it does
 * not cover, so a new route cannot ship without its authorization decided.
 *
 * The app keeps its default hourly session sweep: `sessionSweepMs: 0` would
 * sweep continuously and delete the expired session before any request,
 * so the expiry check itself would never be exercised.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});
const PACTORA = config.chain('near:sandbox').contracts.Pactora;
const DAO = 'arbiter-dao.test.near';

// ── the user types ──────────────────────────────────────────────────────

const BAD = ['anon', 'garbage', 'revokedKey', 'expiredSession', 'signedOut'] as const;
const AGENTS = ['agentA', 'agentB', 'agentC', 'agentHeld'] as const;
const PERSONS = [
  'pClient',
  'pWorker',
  'pOther',
  'pHold',
  'pBlocked',
  'reviewer',
  'reviewerOld',
  'council',
  'councilOld',
] as const;
const WHO = [...BAD, ...AGENTS, ...PERSONS, 'sessionOnly'] as const;
type Who = (typeof WHO)[number];
type Outcome = '401' | '403' | '404' | 'ok';

const isAgent = (w: Who) => (AGENTS as readonly string[]).includes(w);
const isPerson = (w: Who) => (PERSONS as readonly string[]).includes(w);
const isBad = (w: Who) => (BAD as readonly string[]).includes(w);

/** Base rules, from the Auth column of docs/15 §1. */
const rules = {
  /** Anyone, credential or not; a credential is ignored. */
  public: (): Outcome => 'ok',
  /** An agent API key only (`authenticate`). */
  key: (w: Who): Outcome => (isAgent(w) ? 'ok' : '401'),
  /** A person's session only (`authenticatePerson`); no person agent needed. */
  session: (w: Who): Outcome => (isPerson(w) || w === 'sessionOnly' ? 'ok' : '401'),
  /** Key or session (`actorOf`): a session needs a person agent. */
  either: (w: Who): Outcome => (isBad(w) ? '401' : w === 'sessionOnly' ? '403' : 'ok'),
  /** A session acting through its person agent: an agent key is the wrong credential. */
  people: (w: Who): Outcome => (isBad(w) || isAgent(w) ? '401' : w === 'sessionOnly' ? '403' : 'ok'),
};

interface Row {
  /** `METHOD /path` exactly as served. */
  route: string;
  /** Which job or fixture the row is about, when a route has more than one row. */
  note?: string;
  url: () => string;
  body?: () => unknown;
  headers?: () => Record<string, string>;
  base: (w: Who) => Outcome;
  /** Callers the base lets through who are refused (403) as not the party/owner/role. */
  only?: Who[];
  /** The outcome some callers get instead (applied last). */
  override?: Partial<Record<Who, Outcome>>;
  /** The route revokes the credential it is called with: authorized callers get a fresh one. */
  fresh?: boolean;
}

function expected(row: Row, w: Who): Outcome {
  let out = row.base(w);
  if (out === 'ok' && row.only && !row.only.includes(w)) out = '403';
  return row.override?.[w] ?? out;
}

// ── the world ───────────────────────────────────────────────────────────

let app: FastifyInstance;
let db: Db;
const store = new MemoryObjectStore();
const councilMembers: string[] = [];
const reviewers: string[] = [];
const view: ChainViewer = async (_chain, contract, method) => {
  if (contract === PACTORA && method === 'get_roles') return {arbiter: DAO, owner: 'test.near'};
  if (contract === DAO && method === 'get_policy')
    return {
      roles: [
        {name: 'council', kind: {Group: councilMembers}, permissions: ['*:AddProposal', '*:VoteApprove']},
      ],
    };
  if (contract === DAO && method === 'get_last_proposal_id') return 0;
  if (contract === DAO && method === 'get_proposals') return [];
  throw new Error(`no such view ${contract}.${method}`);
};

const token: Partial<Record<Who, string>> = {};
const W = {} as {
  agentA: Awaited<ReturnType<typeof agent>>;
  agentB: Awaited<ReturnType<typeof agent>>;
  agentC: Awaited<ReturnType<typeof agent>>;
  agentHeld: Awaited<ReturnType<typeof agent>>;
  pClient: Awaited<ReturnType<typeof person>>;
  pWorker: Awaited<ReturnType<typeof person>>;
  pHold: Awaited<ReturnType<typeof person>>;
  pBlocked: Awaited<ReturnType<typeof person>>;
};
/** Fixture ids. */
const F = {} as {
  agentJob: string;
  personJob: string;
  disputedJob: string;
  personFile: string;
  agentFile: string;
  disputedFile: string;
  listing: string;
  listingToCancel: string;
  hookA: string;
  hookClient: string;
  caseId: string;
  kycSession: string;
};
let provider: SimulatedIdentityProvider;
let n = 0;

async function agentRowId(chainAgentId: string): Promise<number> {
  const r = await db.execute(sql`SELECT id FROM agents WHERE chain_agent_id = ${chainAgentId} LIMIT 1`);
  return Number((r as unknown as {id: string}[])[0]!.id);
}

async function insertJob(
  client: number,
  worker: number,
  state: (typeof jobs.$inferInsert)['state'],
): Promise<{id: number; publicId: string}> {
  const [j] = await db
    .insert(jobs)
    .values({
      chainId: 'near:sandbox',
      chainJobId: String(9000 + ++n),
      clientAgentId: client,
      workerAgentId: worker,
      path: 'escrow',
      amount: '20000',
      spec: {capability: 'market-research'},
      specHash: 'ab'.repeat(32),
      state,
    })
    .returning({id: jobs.id, publicId: jobs.publicId});
  return j!;
}

async function insertFile(jobId: number, uploader: number): Promise<string> {
  const key = `roles/${randomUUID()}`;
  await store.put(key, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png');
  const [f] = await db
    .insert(jobFiles)
    .values({
      jobId,
      uploaderAgentId: uploader,
      objectKey: key,
      sha256: 'ee'.repeat(32),
      mime: 'image/png',
      size: 4,
    })
    .returning({publicId: jobFiles.publicId});
  return f!.publicId;
}

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
async function postListing(t: string): Promise<string> {
  const l = await app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: {...bearer(t), 'idempotency-key': `roles-listing-${++n}-${randomUUID()}`},
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
  return (l.json() as {listingId: string}).listingId;
}

async function setStanding(agentId: number, standing: 'hold' | 'blocked') {
  await db.insert(accountStanding).values({agentId, standing, reason: 'roles test'});
}

beforeAll(async () => {
  db = createDb(DB_URL, {max: 10});
  provider = new SimulatedIdentityProvider('w'.repeat(40), 'http://localhost:3000');
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
    objectStore: store,
    metrics: createMetrics('api-roles'),
    identityProvider: provider,
    viewChain: view,
    adminCouncilCacheMs: 0,
    submit: async () => ({
      txHash: `4yJxShz8HXfTyoTMXP9rQSoQUZE8uihkDmnpRrynZe${String(++n % 100).padStart(2, 'Z')}`,
    }),
    get complianceReviewers() {
      return reviewers;
    },
  });
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, sessions, login_challenges, registration_challenges, api_keys, listings, applications, listing_slots, job_files, webhooks, account_standing, identity_verifications, agent_events, agent_event_seq RESTART IDENTITY CASCADE`,
  );

  // Agents with keys.
  for (const w of AGENTS) {
    W[w] = await agent(app, `rx-${w}`);
    token[w] = W[w].apiKey;
  }
  const revoked = await agent(app, 'rx-revoked');
  const rv = await app.inject({method: 'POST', url: '/v1/keys/revoke', headers: bearer(revoked.apiKey)});
  expect(rv.statusCode, rv.body).toBe(200);
  token.revokedKey = revoked.apiKey;

  // People with sessions and person agents.
  for (const w of PERSONS) {
    const p = await person(app, `rx-${w}`);
    token[w] = p.token;
    if (w === 'pClient' || w === 'pWorker' || w === 'pHold' || w === 'pBlocked') W[w] = p;
    if (w === 'reviewer' || w === 'reviewerOld') reviewers.push(p.account);
    if (w === 'council' || w === 'councilOld') councilMembers.push(p.account);
  }
  // An admin sign-in older than an hour (still within its 7 days).
  for (const w of ['reviewerOld', 'councilOld'] as const) {
    const keyId = token[w]!.split('_')[1]!;
    await db
      .update(sessions)
      .set({createdAt: new Date(Date.now() - 2 * 3600_000)})
      .where(eq(sessions.keyId, keyId));
  }
  token.sessionOnly = await sessionOnly(app, 'rx-session-only');

  const expired = await person(app, 'rx-expired');
  await db
    .update(sessions)
    .set({expiresAt: new Date(Date.now() - 1000)})
    .where(eq(sessions.keyId, expired.token.split('_')[1]!));
  token.expiredSession = expired.token;
  const out = await person(app, 'rx-signed-out');
  expect(
    (await app.inject({method: 'DELETE', url: '/v1/session', headers: bearer(out.token)})).statusCode,
  ).toBe(204);
  token.signedOut = out.token;
  token.garbage = 'not-a-pactora-credential';

  // Standing.
  await setStanding(W.agentHeld.agentId, 'hold');
  const pHoldId = await agentRowId(W.pHold.chainAgentId);
  const pBlockedId = await agentRowId(W.pBlocked.chainAgentId);
  await setStanding(pHoldId, 'hold');
  await setStanding(pBlockedId, 'blocked');

  // Jobs.
  const pClientId = await agentRowId(W.pClient.chainAgentId);
  const pWorkerId = await agentRowId(W.pWorker.chainAgentId);
  const agentJob = await insertJob(W.agentA.agentId, W.agentB.agentId, 'accepted');
  const personJob = await insertJob(pClientId, pWorkerId, 'accepted');
  const disputed = await insertJob(W.agentA.agentId, W.agentB.agentId, 'disputed');
  await db.insert(jobEvents).values({
    chainId: 'near:sandbox',
    jobId: disputed.id,
    kind: 'job.disputed',
    payload: {reason: 'The report is about the wrong token.', reasonHash: 'ef'.repeat(32)},
  });
  F.agentJob = agentJob.publicId;
  F.personJob = personJob.publicId;
  F.disputedJob = disputed.publicId;
  F.personFile = await insertFile(personJob.id, pWorkerId);
  F.agentFile = await insertFile(agentJob.id, W.agentB.agentId);
  F.disputedFile = await insertFile(disputed.id, W.agentB.agentId);

  F.listing = await postListing(token.pClient!);
  F.listingToCancel = await postListing(token.pClient!);

  const [hA] = await db
    .insert(webhooks)
    .values({agentId: W.agentA.agentId, url: 'https://hooks.example.com/a', secretEnc: 'x', kinds: []})
    .returning({publicId: webhooks.publicId});
  const [hC] = await db
    .insert(webhooks)
    .values({agentId: pClientId, url: 'https://hooks.example.com/c', secretEnc: 'x', kinds: []})
    .returning({publicId: webhooks.publicId});
  F.hookA = hA!.publicId;
  F.hookClient = hC!.publicId;

  const [c] = await db
    .insert(complianceCases)
    .values({
      agentId: pHoldId,
      subjectAccount: W.pHold.account,
      source: 'ofac',
      entryRef: 'roles-1',
      queryName: 'Hold Person',
      matchedName: 'Hold Persson',
      score: '0.9800',
      strength: 'strong',
    })
    .returning({publicId: complianceCases.publicId});
  F.caseId = c!.publicId;
  F.kycSession = `sim_${'0'.repeat(24)}`;
}, 120_000);

afterAll(async () => {
  await app.close();
  await closeDb(db);
});

// ── the matrix ──────────────────────────────────────────────────────────

const U = randomUUID; // an id that names nothing
/** An admin sign-in older than an hour is sent to sign in again (401) before its role is looked at. */
const STALE_ADMIN: Partial<Record<Who, Outcome>> = {reviewerOld: '401', councilOld: '401'};
const ADMIN_ANY = STALE_ADMIN;

function rows(): Row[] {
  const job = (id: () => string, suffix: string) => () => `/v1/jobs/${id()}${suffix}`;
  const aJob = () => F.agentJob;
  const pJob = () => F.personJob;
  const L =
    (s = '') =>
    () =>
      `/v1/listings/${F.listing}${s}`;
  const idem = () => ({'idempotency-key': `roles-${randomUUID()}`});
  return [
    // meta, status, discovery
    {route: 'GET /health', url: () => '/health', base: rules.public},
    {route: 'GET /ready', url: () => '/ready', base: rules.public},
    {route: 'GET /metrics', url: () => '/metrics', base: rules.public},
    {route: 'GET /v1/openapi.json', url: () => '/v1/openapi.json', base: rules.public},
    {route: 'GET /v1/status', url: () => '/v1/status', base: rules.public},
    {route: 'GET /v1/network', url: () => '/v1/network', base: rules.public},
    {route: 'GET /v1/budget', url: () => '/v1/budget', base: rules.key},
    {route: 'GET /v1/rank-modes', url: () => '/v1/rank-modes', base: rules.public},
    {route: 'GET /v1/agents', url: () => '/v1/agents', base: rules.public},
    {route: 'GET /v1/agents/:id', url: () => `/v1/agents/${W.agentA.agentId}`, base: rules.public},
    {
      route: 'GET /v1/agents/:id/trust',
      url: () => `/v1/agents/${W.agentA.agentId}/trust`,
      base: rules.public,
    },
    {
      route: 'GET /v1/agents/:id/history',
      url: () => `/v1/agents/${W.agentA.agentId}/history`,
      base: rules.public,
    },
    {
      route: 'POST /v1/agents/wallet-key',
      url: () => '/v1/agents/wallet-key',
      body: () => ({}),
      base: rules.public,
    },
    {
      route: 'POST /v1/agents/challenge',
      url: () => '/v1/agents/challenge',
      body: () => ({}),
      base: rules.public,
    },
    {route: 'POST /v1/agents', url: () => '/v1/agents', body: () => ({}), base: rules.public},
    {
      route: 'PATCH /v1/agents/:id',
      url: () => `/v1/agents/${W.agentA.agentId}`,
      body: () => ({pricePerTask: 'not-a-number'}),
      base: rules.key,
      only: ['agentA'],
    },
    {route: 'POST /v1/keys/rotate', url: () => '/v1/keys/rotate', base: rules.key, fresh: true},
    {route: 'POST /v1/keys/revoke', url: () => '/v1/keys/revoke', base: rules.key, fresh: true},
    {
      route: 'POST /v1/agents/:id/keys/challenge',
      url: () => `/v1/agents/${W.agentA.agentId}/keys/challenge`,
      body: () => ({}),
      base: rules.public,
    },
    {
      route: 'POST /v1/agents/:id/keys',
      url: () => `/v1/agents/${W.agentA.agentId}/keys`,
      body: () => ({}),
      base: rules.public,
    },

    // people: session
    {
      route: 'POST /v1/session/challenge',
      url: () => '/v1/session/challenge',
      body: () => ({}),
      base: rules.public,
    },
    {route: 'POST /v1/session', url: () => '/v1/session', body: () => ({}), base: rules.public},
    {route: 'GET /v1/session', url: () => '/v1/session', base: rules.session},
    {route: 'DELETE /v1/session', url: () => '/v1/session', base: rules.session, fresh: true},
    {route: 'DELETE /v1/sessions', url: () => '/v1/sessions', base: rules.session, fresh: true},
    {route: 'POST /v1/people', url: () => '/v1/people', body: () => ({}), base: rules.session},
    {route: 'GET /v1/me', url: () => '/v1/me', base: rules.session},
    {route: 'POST /v1/me/terms', url: () => '/v1/me/terms', body: () => ({}), base: rules.session},
    {
      route: 'GET /v1/me/agents',
      url: () => '/v1/me/agents',
      base: rules.either,
      // Owned agents by account: a session with no person agent still has an account.
      override: {sessionOnly: 'ok'},
    },
    {
      route: 'POST /v1/jobs/hire',
      url: () => '/v1/jobs/hire',
      body: () => ({}),
      base: rules.either,
      // Direct hire is a person's: an agent key is refused (agents use POST /v1/jobs).
      override: {agentA: '403', agentB: '403', agentC: '403', agentHeld: '403'},
    },
    {
      route: 'POST /v1/jobs/:id/person-actions/prepare',
      url: job(pJob, '/person-actions/prepare'),
      body: () => ({action: 'submit'}),
      base: rules.session,
      only: ['pWorker'],
      // sessionOnly has no person agent: refused before the job is read.
    },
    {
      route: 'POST /v1/jobs/:id/person-actions/confirm',
      url: job(pJob, '/person-actions/confirm'),
      body: () => ({action: 'submit', txHash: `Tx${'B'.repeat(42)}`}),
      base: rules.session,
      only: ['pWorker'],
    },

    // listings
    {
      route: 'POST /v1/listings',
      url: () => '/v1/listings',
      headers: idem,
      body: () => ({}),
      base: rules.either,
      // Standing gates posting (docs/26 F14): checked before the body is read.
      override: {pHold: '403', pBlocked: '403', agentHeld: '403'},
    },
    {route: 'GET /v1/listings', url: () => '/v1/listings', base: rules.public},
    {
      route: 'GET /v1/listings/:id',
      url: L(),
      base: rules.public,
      // An optional bearer is still checked: a bad one is refused.
      override: {garbage: '401', revokedKey: '401', expiredSession: '401', signedOut: '401'},
    },
    {
      route: 'PATCH /v1/listings/:id',
      url: L(),
      body: () => ({title: 'x'}),
      base: rules.either,
      only: ['pClient'],
    },
    {
      route: 'DELETE /v1/listings/:id',
      url: () => `/v1/listings/${F.listingToCancel}`,
      base: rules.either,
      only: ['pClient'],
    },
    {
      route: 'POST /v1/listings/:id/applications',
      url: L('/applications'),
      body: () => ({
        action: 'apply',
        priceBaseUnits: '30000',
        proposal: 'I can be there this afternoon with a camera.',
      }),
      base: rules.either,
      // Not on one's own listing; and a held or blocked account may not apply.
      only: [...AGENTS, ...PERSONS].filter((w) => w !== 'pClient'),
      override: {pHold: '403', pBlocked: '403', agentHeld: '403'},
    },
    {
      route: 'GET /v1/listings/:id/applications',
      url: L('/applications'),
      base: rules.either,
      only: ['pClient'],
    },
    {
      route: 'POST /v1/listings/:id/decide',
      url: L('/decide'),
      body: () => ({}),
      base: rules.either,
      only: ['pClient'],
    },
    {route: 'POST /v1/listings/:id/close', url: L('/close'), base: rules.either, only: ['pClient']},
    {
      route: 'POST /v1/listings/:id/unselect',
      url: L('/unselect'),
      body: () => ({}),
      base: rules.either,
      only: ['pClient'],
    },
    {route: 'POST /v1/listings/:id/reopen', url: L('/reopen'), base: rules.either, only: ['pClient']},
    {
      route: 'POST /v1/listings/:id/claim',
      url: L('/claim'),
      body: () => ({}),
      base: rules.either,
      // A held or blocked account may not claim (docs/15 "Standing gates").
      override: {pHold: '403', pBlocked: '403', agentHeld: '403'},
    },

    // jobs, agent keys
    {
      route: 'POST /v1/jobs',
      url: () => '/v1/jobs',
      headers: idem,
      body: () => ({}),
      base: rules.key,
      // A hire posts work: a held agent may not (docs/26 F14).
      override: {agentHeld: '403'},
    },
    {route: 'GET /v1/jobs', url: () => '/v1/jobs', base: rules.either, override: {sessionOnly: 'ok'}},
    {route: 'GET /v1/jobs/:id', url: job(aJob, ''), base: rules.public},
    {
      route: 'GET /v1/jobs/:id/events',
      url: () => `/v1/jobs/${U()}/events`,
      base: rules.public,
      // SSE: a job that does not exist, so the stream is not held open.
      override: Object.fromEntries(WHO.map((w) => [w, '404'])) as Record<Who, Outcome>,
    },
    // Transitions: one fresh job per row, in the state the action needs, so
    // the party check is reached (the state is checked first).
    ...(
      [
        ['accept', 'created', 'agentB'],
        ['decline', 'created', 'agentB'],
        ['result', 'accepted', 'agentB'],
        ['approve', 'submitted', 'agentA'],
        ['dispute', 'submitted', 'agentA'],
        ['cancel', 'created', 'agentA'],
      ] as const
    ).map(([action, state, who]): Row => ({
      route: `POST /v1/jobs/:id/${action}`,
      url: () => `/v1/jobs/${transitionJobs[action]}/${action}`,
      body: () => ({}),
      base: rules.key,
      only: [who],
      note: state,
    })),

    // evidence, drafts, chat — on a person job and on an agent job
    ...(
      [
        ['person job', pJob, 'pClient', 'pWorker'],
        ['agent job', aJob, 'agentA', 'agentB'],
      ] as const
    ).flatMap(([note, id, client, worker]): Row[] => [
      {
        route: 'POST /v1/jobs/:id/files',
        note,
        url: job(id, '/files'),
        body: () => ({}),
        base: rules.either,
        only: [worker],
      },
      {
        route: 'GET /v1/jobs/:id/files',
        note,
        url: job(id, '/files'),
        base: rules.either,
        only: [client, worker],
      },
      {
        route: 'DELETE /v1/jobs/:id/files/:fileId',
        note,
        url: () => `/v1/jobs/${id()}/files/${U()}`,
        base: rules.either,
        only: [worker],
        override: {[worker]: '404'},
      },
      {
        route: 'GET /v1/files/:fileId',
        note,
        url: () => `/v1/files/${note === 'person job' ? F.personFile : F.agentFile}`,
        base: rules.either,
        only: [client, worker],
      },
      {
        route: 'GET /v1/jobs/:id/drafts',
        note,
        url: job(id, '/drafts'),
        base: rules.either,
        only: [client, worker],
      },
      {
        route: 'POST /v1/jobs/:id/drafts',
        note,
        url: job(id, '/drafts'),
        body: () => ({}),
        base: rules.either,
        only: [worker],
      },
      {
        route: 'POST /v1/jobs/:id/drafts/:draftId/review',
        note,
        url: () => `/v1/jobs/${id()}/drafts/${U()}/review`,
        body: () => ({}),
        base: rules.either,
        only: [client],
      },
      {
        route: 'GET /v1/jobs/:id/messages',
        note,
        url: job(id, '/messages'),
        base: rules.either,
        only: [client, worker],
      },
      {
        route: 'POST /v1/jobs/:id/dispute/notes',
        note,
        url: job(id, '/dispute/notes'),
        body: () => ({}),
        base: rules.either,
        only: [client],
      },
      {
        route: 'POST /v1/jobs/:id/dispute/files',
        note,
        url: job(id, '/dispute/files'),
        body: () => ({}),
        base: rules.either,
        only: [client],
      },
      {
        route: 'GET /v1/jobs/:id/dispute',
        note,
        url: job(id, '/dispute'),
        base: rules.either,
        only: [client, worker],
        // A job nobody disputed: 404 once past the party check.
        override: {[client]: '404', [worker]: '404'},
      },
      {
        route: 'POST /v1/jobs/:id/messages',
        note,
        url: job(id, '/messages'),
        body: () => ({}),
        base: rules.either,
        only: [client, worker],
      },
      {
        route: 'GET /v1/jobs/:id/party-reviews',
        note,
        url: job(id, '/party-reviews'),
        base: rules.either,
        only: [client, worker],
      },
      {
        route: 'POST /v1/jobs/:id/party-reviews',
        note,
        url: job(id, '/party-reviews'),
        body: () => ({}),
        base: rules.either,
        only: [client, worker],
      },
      // Work credentials: the worker alone claims (an unsettled job is then a 409); anyone reads.
      {
        route: 'POST /v1/jobs/:id/credential',
        note,
        url: job(id, '/credential'),
        body: () => ({}),
        base: rules.either,
        only: [worker],
      },
      {route: 'GET /v1/jobs/:id/credential', note, url: job(id, '/credential'), base: rules.public},
    ]),

    // feed, notifications, webhooks
    {route: 'GET /v1/events', url: () => '/v1/events', base: rules.either},
    {route: 'GET /v1/notifications', url: () => '/v1/notifications', base: rules.either},
    {
      route: 'POST /v1/notifications/read',
      url: () => '/v1/notifications/read',
      body: () => ({}),
      base: rules.either,
    },
    {
      route: 'POST /v1/notifications/:seq/read',
      url: () => '/v1/notifications/999999/read',
      base: rules.either,
      // No such item: 404 once past auth.
      override: Object.fromEntries([...AGENTS, ...PERSONS].map((w) => [w, '404'])),
    },
    {route: 'GET /v1/me/applications', url: () => '/v1/me/applications', base: rules.either},
    {route: 'GET /v1/stats', url: () => '/v1/stats', base: rules.public},
    {route: 'GET /v1/receipts', url: () => '/v1/receipts', base: rules.public},
    {
      route: 'POST /v1/pools',
      url: () => '/v1/pools',
      body: () => ({}),
      base: rules.key,
      // Opening a pool funds a share: a held agent may not.
      override: {agentHeld: '403'},
    },
    {
      route: 'POST /v1/pools/:id/join',
      url: () => `/v1/pools/${U()}/join`,
      body: () => ({}),
      base: rules.key,
      // No such pool: 404 once past auth.
      override: Object.fromEntries(AGENTS.map((w) => [w, '404'])),
    },
    {route: 'GET /v1/pools', url: () => '/v1/pools', base: rules.public},
    {
      route: 'GET /v1/pools/:id',
      url: () => `/v1/pools/${U()}`,
      base: rules.public,
      override: Object.fromEntries(WHO.map((w) => [w, '404'])),
    },
    {route: 'POST /v1/webhooks', url: () => '/v1/webhooks', body: () => ({}), base: rules.either},
    {route: 'GET /v1/webhooks', url: () => '/v1/webhooks', base: rules.either},
    {
      route: 'GET /v1/webhooks/:id/deliveries',
      note: "agent A's hook",
      url: () => `/v1/webhooks/${F.hookA}/deliveries`,
      base: rules.either,
      // Another tenant's webhook is hidden, not forbidden.
      override: Object.fromEntries(
        [...AGENTS, ...PERSONS].filter((w) => w !== 'agentA').map((w) => [w, '404']),
      ),
    },
    {
      route: 'GET /v1/webhooks/:id/deliveries',
      note: "pClient's hook",
      url: () => `/v1/webhooks/${F.hookClient}/deliveries`,
      base: rules.either,
      override: Object.fromEntries(
        [...AGENTS, ...PERSONS].filter((w) => w !== 'pClient').map((w) => [w, '404']),
      ),
    },
    {
      route: 'POST /v1/webhooks/:id/rotate',
      note: "agent A's hook",
      url: () => `/v1/webhooks/${F.hookA}/rotate`,
      base: rules.either,
      override: Object.fromEntries(
        [...AGENTS, ...PERSONS].filter((w) => w !== 'agentA').map((w) => [w, '404']),
      ),
    },
    {
      route: 'DELETE /v1/webhooks/:id',
      note: "agent A's hook",
      url: () => `/v1/webhooks/${F.hookA}`,
      base: rules.either,
      override: Object.fromEntries(
        [...AGENTS, ...PERSONS].filter((w) => w !== 'agentA').map((w) => [w, '404']),
      ),
    },

    // faucet, channels
    {route: 'GET /v1/faucet', url: () => '/v1/faucet', base: rules.session},
    {route: 'POST /v1/faucet', url: () => '/v1/faucet', base: rules.session},
    {route: 'GET /v1/me/channels', url: () => '/v1/me/channels', base: rules.people},
    {
      route: 'POST /v1/me/channels/telegram/code',
      url: () => '/v1/me/channels/telegram/code',
      base: rules.people,
    },
    {
      route: 'POST /v1/me/channels/email',
      url: () => '/v1/me/channels/email',
      body: () => ({}),
      base: rules.people,
    },
    {
      route: 'POST /v1/me/channels/email/verify',
      url: () => '/v1/me/channels/email/verify',
      body: () => ({}),
      base: rules.people,
    },
    {
      route: 'DELETE /v1/me/channels/:channel',
      url: () => '/v1/me/channels/sms',
      base: rules.people,
      // No such channel: 404 once past auth.
      override: Object.fromEntries(PERSONS.map((w) => [w, '404'])),
    },

    // admin
    {
      route: 'GET /v1/admin/me',
      url: () => '/v1/admin/me',
      base: rules.session,
      only: ['reviewer', 'council'],
      override: ADMIN_ANY,
    },
    {
      route: 'GET /v1/admin/disputes',
      url: () => '/v1/admin/disputes',
      base: rules.session,
      only: ['council'],
      override: STALE_ADMIN,
    },
    {
      route: 'GET /v1/admin/disputes/:id',
      url: () => `/v1/admin/disputes/${F.disputedJob}`,
      base: rules.session,
      only: ['council'],
      override: STALE_ADMIN,
    },
    {
      route: 'GET /v1/admin/files/:fileId',
      url: () => `/v1/admin/files/${F.disputedFile}`,
      base: rules.session,
      only: ['council'],
      override: STALE_ADMIN,
    },
    {
      route: 'POST /v1/admin/disputes/:id/proposal',
      url: () => `/v1/admin/disputes/${F.disputedJob}/proposal`,
      body: () => ({}),
      base: rules.session,
      only: ['council'],
      override: STALE_ADMIN,
    },
    {
      route: 'GET /v1/admin/disputes/:id/proposals',
      url: () => `/v1/admin/disputes/${F.disputedJob}/proposals`,
      base: rules.session,
      only: ['council'],
      override: STALE_ADMIN,
    },
    {
      route: 'POST /v1/admin/disputes/:id/proposals/:pid/vote',
      url: () => `/v1/admin/disputes/${F.disputedJob}/proposals/1/vote`,
      body: () => ({}),
      base: rules.session,
      only: ['council'],
      override: STALE_ADMIN,
    },
    {
      route: 'GET /v1/admin/reviews',
      url: () => '/v1/admin/reviews',
      base: rules.session,
      only: ['reviewer', 'council'],
      override: ADMIN_ANY,
    },
    {
      route: 'POST /v1/admin/reviews/:id/hide',
      url: () => `/v1/admin/reviews/${U()}/hide`,
      body: () => ({}),
      base: rules.session,
      only: ['reviewer', 'council'],
      override: ADMIN_ANY,
    },

    // account: export and deletion
    {route: 'GET /v1/me/export', url: () => '/v1/me/export', base: rules.session},
    {route: 'POST /v1/me/delete/challenge', url: () => '/v1/me/delete/challenge', base: rules.session},
    {route: 'DELETE /v1/me', url: () => '/v1/me', body: () => ({}), base: rules.session},

    // reports and moderation
    {route: 'POST /v1/reports', url: () => '/v1/reports', body: () => ({}), base: rules.either},
    {
      route: 'GET /v1/admin/reports',
      url: () => '/v1/admin/reports',
      base: rules.session,
      only: ['reviewer', 'reviewerOld'],
      override: STALE_ADMIN,
    },
    {
      route: 'GET /v1/admin/audit-log.csv',
      url: () => '/v1/admin/audit-log.csv',
      base: rules.session,
      only: ['reviewer', 'reviewerOld'],
      override: STALE_ADMIN,
    },
    {
      route: 'POST /v1/admin/reports/:id/resolve',
      url: () => `/v1/admin/reports/${U()}/resolve`,
      body: () => ({}),
      base: rules.session,
      only: ['reviewer', 'reviewerOld'],
      override: STALE_ADMIN,
    },

    // identity, compliance
    {route: 'GET /v1/kyc', url: () => '/v1/kyc', base: rules.people},
    {
      route: 'POST /v1/kyc/start',
      url: () => '/v1/kyc/start',
      body: () => ({legalName: 'Robin Example'}),
      base: rules.people,
      // docs/15: a blocked account cannot start a check.
      override: {pBlocked: '403'},
    },
    {
      route: 'POST /v1/kyc/webhook',
      url: () => '/v1/kyc/webhook',
      body: () => ({sessionId: 'x'}),
      base: rules.public,
    },
    {
      route: 'POST /v1/kyc/simulated/:sessionId',
      url: () => `/v1/kyc/simulated/${F.kycSession}`,
      body: () => ({outcome: 'approved'}),
      base: rules.people,
      // Nobody's session: 404 once past auth.
      override: Object.fromEntries(PERSONS.map((w) => [w, '404'])),
    },
    {
      route: 'GET /v1/compliance/cases',
      url: () => '/v1/compliance/cases',
      base: rules.session,
      only: ['reviewer', 'reviewerOld'],
      override: STALE_ADMIN,
    },
    {
      route: 'POST /v1/compliance/cases/:id/decisions',
      url: () => `/v1/compliance/cases/${F.caseId}/decisions`,
      body: () => ({}),
      base: rules.session,
      only: ['reviewer', 'reviewerOld'],
      override: STALE_ADMIN,
    },

    // profiles
    {route: 'GET /v1/profiles', url: () => '/v1/profiles', base: rules.public},
    {
      route: 'GET /v1/profiles/:id',
      url: () => `/v1/profiles/${U()}`,
      base: rules.public,
      override: Object.fromEntries(WHO.map((w) => [w, '404'])),
    },
    {
      route: 'GET /v1/profiles/:id/reviews',
      url: () => `/v1/profiles/${U()}/reviews`,
      base: rules.public,
      override: Object.fromEntries(WHO.map((w) => [w, '404'])),
    },
    {
      route: 'GET /v1/profiles/:id/history',
      url: () => `/v1/profiles/${U()}/history`,
      base: rules.public,
      override: Object.fromEntries(WHO.map((w) => [w, '404'])),
    },
    {route: 'GET /v1/me/profile', url: () => '/v1/me/profile', base: rules.either},
    {route: 'PUT /v1/me/profile', url: () => '/v1/me/profile', body: () => ({}), base: rules.either},

    // x402, runs
    {
      route: 'POST /v1/x402/settle',
      url: () => '/v1/x402/settle',
      headers: idem,
      body: () => ({}),
      base: rules.key,
    },
    {route: 'POST /v1/x402/verify', url: () => '/v1/x402/verify', body: () => ({}), base: rules.key},
    {route: 'POST /v1/x402/redeem', url: () => '/v1/x402/redeem', body: () => ({}), base: rules.key},
    {route: 'POST /v1/runs', url: () => '/v1/runs', body: () => ({}), base: rules.key},
    {route: 'GET /v1/runs', url: () => '/v1/runs', base: rules.key},
    {
      route: 'GET /v1/runs/:id',
      url: () => `/v1/runs/${U()}`,
      base: rules.public,
      override: Object.fromEntries(WHO.map((w) => [w, '404'])),
    },
    {
      route: 'GET /v1/runs/:id/events',
      url: () => `/v1/runs/${U()}/events`,
      base: rules.public,
      override: Object.fromEntries(WHO.map((w) => [w, '404'])),
    },
  ];
}

const transitionJobs: Record<string, string> = {};

function classify(status: number, code: string | undefined): Outcome {
  if (status === 401) return '401';
  if (status === 403) return '403';
  if (status === 404 && code !== 'FST_ERR_NOT_FOUND') return '404';
  return 'ok';
}

async function freshFor(w: Who): Promise<string> {
  if (isAgent(w)) return (await agent(app, `rx-fresh-${++n}`)).apiKey;
  if (w === 'sessionOnly') return sessionOnly(app, `rx-fresh-so-${++n}`);
  return (await person(app, `rx-fresh-p-${++n}`)).token;
}

describe('authorization matrix: every served route × every user type', () => {
  it('gives each caller the outcome its role allows, and covers every served route', async () => {
    for (const [action, state] of [
      ['accept', 'created'],
      ['decline', 'created'],
      ['result', 'accepted'],
      ['approve', 'submitted'],
      ['dispute', 'submitted'],
      ['cancel', 'created'],
    ] as const) {
      transitionJobs[action] = (await insertJob(W.agentA.agentId, W.agentB.agentId, state)).publicId;
    }

    const served = new Set<string>();
    const probe = await buildApp({
      ...chainDeps(config),
      db,
      chains: config.chains,
      defaultChainId: 'near:sandbox',
      submit: async () => ({txHash: 'unused'}),
      liveEvents: false,
      draftSettleSweepMs: 0,
      metrics: createMetrics('api-roles-probe'),
      onRoute: (r) => {
        for (const m of [r.method].flat()) {
          if (['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(m)) served.add(`${m} ${r.url}`);
        }
      },
    });
    await probe.ready();
    await probe.close();

    const all = rows();
    const covered = new Set(all.map((r) => r.route));
    expect([...served].filter((r) => !covered.has(r)).sort(), 'routes with no row').toEqual([]);
    expect([...covered].filter((r) => !served.has(r)).sort(), 'rows for routes not served').toEqual([]);

    const lines: string[] = [];
    const mismatches: string[] = [];
    for (const row of all) {
      // Refused callers first, so an authorized one acting cannot change what they see.
      const order = [...WHO].sort(
        (a, b) => Number(expected(row, a) === 'ok') - Number(expected(row, b) === 'ok'),
      );
      const cells: Partial<Record<Who, string>> = {};
      for (const w of order) {
        const want = expected(row, w);
        const t = row.fresh && want === 'ok' ? await freshFor(w) : token[w];
        const method = row.route.split(' ')[0]!;
        const res = await app.inject({
          method: method as 'GET',
          url: row.url(),
          headers: {...(t && w !== 'anon' ? bearer(t) : {}), ...(row.headers?.() ?? {})},
          ...(row.body ? {payload: row.body() as Record<string, unknown>} : {}),
        });
        const code = (() => {
          try {
            return (res.json() as {code?: string}).code;
          } catch {
            return undefined;
          }
        })();
        const got = classify(res.statusCode, code);
        cells[w] = got === want ? got : `${got}≠${want}`;
        if (got !== want) {
          mismatches.push(
            `${row.route}${row.note ? ` [${row.note}]` : ''} as ${w}: got ${res.statusCode} ${code ?? ''} (${got}), want ${want} — ${res.body.slice(0, 160)}`,
          );
        }
      }
      lines.push(
        `${(row.route + (row.note ? ` [${row.note}]` : '')).padEnd(58)} ${WHO.map((w) => cells[w]!.padEnd(4)).join(' ')}`,
      );
    }
    if (process.env['ROLES_MATRIX']) {
      const legend = WHO.map((w, i) => `${i + 1}=${w}`).join(' ');
      const head = WHO.map((_, i) => String(i + 1).padEnd(4)).join(' ');
      console.log(`${legend}\n${''.padEnd(58)} ${head}\n${lines.join('\n')}`);
    }
    expect(mismatches).toEqual([]);
  }, 300_000);
});

// ── cross-tenant reads and writes ───────────────────────────────────────

async function jobRow(publicId: string) {
  return (await db.query.jobs.findFirst({where: eq(jobs.publicId, publicId)}))!;
}

describe("one tenant never sees or changes another's", () => {
  const get = (t: string, url: string) => app.inject({method: 'GET', url, headers: bearer(t)});

  it("jobs: each caller lists only its own; a stranger's list is empty", async () => {
    const ids = async (t: string) =>
      ((await get(t, '/v1/jobs')).json() as {jobs: {jobId: string}[]}).jobs.map((j) => j.jobId);
    expect(await ids(token.agentA!)).toContain(F.agentJob);
    expect(await ids(token.agentB!)).toContain(F.agentJob);
    expect(await ids(token.agentC!)).toEqual([]);
    expect(await ids(token.pClient!)).toContain(F.personJob);
    expect(await ids(token.pClient!)).not.toContain(F.agentJob);
    expect(await ids(token.pOther!)).toEqual([]);
    expect(await ids(token.sessionOnly!)).toEqual([]);
  });

  it("the feed and its read marker are per agent: a stranger neither reads a job's events nor marks them read", async () => {
    // The fan-out trigger writes one feed row per party of the job.
    const [e] = await db
      .insert(jobEvents)
      .values({
        chainId: 'near:sandbox',
        jobId: (await jobRow(F.agentJob)).id,
        kind: 'job.message',
        payload: {},
      })
      .returning({id: jobEvents.id});
    const feed = async (t: string) =>
      ((await get(t, '/v1/events?limit=200')).json() as {events: {jobId: string; seq: number}[]}).events;
    const unread = async (t: string) =>
      ((await get(t, '/v1/notifications')).json() as {unread: number}).unread;
    expect(e).toBeDefined();
    expect((await feed(token.agentA!)).some((x) => x.jobId === F.agentJob)).toBe(true);
    expect((await feed(token.agentB!)).some((x) => x.jobId === F.agentJob)).toBe(true);
    for (const w of ['agentC', 'pOther', 'pClient'] as const) {
      expect((await feed(token[w]!)).filter((x) => x.jobId === F.agentJob)).toEqual([]);
    }
    const before = await unread(token.agentA!);
    expect(before).toBeGreaterThan(0);
    const read = await app.inject({
      method: 'POST',
      url: '/v1/notifications/read',
      headers: bearer(token.agentC!),
      payload: {upTo: 0},
    });
    expect(read.statusCode, read.body).toBeLessThan(500);
    expect(await unread(token.agentA!)).toBe(before);
  });

  it("webhooks: another agent's are not listed, and cannot be read or deleted", async () => {
    const [h] = await db
      .insert(webhooks)
      .values({agentId: W.agentA.agentId, url: 'https://hooks.example.com/a2', secretEnc: 'x', kinds: []})
      .returning({publicId: webhooks.publicId});
    const list = async (t: string) =>
      ((await get(t, '/v1/webhooks')).json() as {webhooks: {webhookId: string}[]}).webhooks.map(
        (x) => x.webhookId,
      );
    expect(await list(token.agentA!)).toContain(h!.publicId);
    expect(await list(token.agentB!)).not.toContain(h!.publicId);
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/webhooks/${h!.publicId}`,
      headers: bearer(token.agentB!),
    });
    expect(del.statusCode).toBe(404);
    expect(await list(token.agentA!)).toContain(h!.publicId);
  });

  it('profiles: writing mine never touches yours', async () => {
    const put = (t: string, displayName: string) =>
      app.inject({method: 'PUT', url: '/v1/me/profile', headers: bearer(t), payload: {displayName}});
    expect((await put(token.agentA!, 'Agent A')).statusCode).toBe(200);
    expect((await put(token.agentB!, 'Agent B')).statusCode).toBe(200);
    const mine = (await get(token.agentA!, '/v1/me/profile')).json() as {displayName: string};
    expect(mine.displayName).toBe('Agent A');
  });

  it('a listing shows an applicant only its own bids, and its owner the slots', async () => {
    const as = async (t: string) =>
      (await get(t, `/v1/listings/${F.listing}`)).json() as {
        viewer?: {isOwner: boolean; applications?: {applicationId: string}[]};
      };
    const other = await as(token.pOther!);
    const worker = await as(token.pWorker!);
    expect(other.viewer?.isOwner).toBe(false);
    expect(other.viewer?.applications).toHaveLength(1);
    expect(worker.viewer?.applications).toHaveLength(1);
    expect(other.viewer!.applications![0]!.applicationId).not.toBe(
      worker.viewer!.applications![0]!.applicationId,
    );
    expect((await as(token.pClient!)).viewer?.isOwner).toBe(true);
    // A signed-in person with no person agent sees the public listing, not a 403.
    const fresh = await get(token.sessionOnly!, `/v1/listings/${F.listing}`);
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect((fresh.json() as {viewer?: unknown}).viewer).toBeUndefined();
  });

  it('channels: a person sees only their own links', async () => {
    await db.insert(channelLinks).values({
      agentId: await agentRowId(W.pClient.chainAgentId),
      channel: 'email',
      address: 'client@example.com',
    });
    const links = async (t: string) => ((await get(t, '/v1/me/channels')).json() as {links: unknown[]}).links;
    expect(await links(token.pClient!)).toHaveLength(1);
    expect(await links(token.pOther!)).toEqual([]);
  });
});

// ── the council reads disputes, not every job ───────────────────────────

describe('the dispute desk', () => {
  it("shows a council member a disputed job's evidence, and no other job's", async () => {
    const get = (url: string) => app.inject({method: 'GET', url, headers: bearer(token.council!)});
    expect((await get(`/v1/admin/disputes/${F.disputedJob}`)).statusCode).toBe(200);
    // Never disputed: its chat, drafts and photos are the parties' alone.
    for (const id of [F.agentJob, F.personJob]) {
      const r = await get(`/v1/admin/disputes/${id}`);
      expect(r.statusCode, r.body.slice(0, 200)).toBe(404);
      expect((await get(`/v1/admin/disputes/${id}/proposals`)).statusCode).toBe(404);
    }
  });
});

// ── standing gates (docs/15 "Standing gates are soft") ──────────────────

describe('a held or blocked account cannot take work', () => {
  it('cannot accept a job it was offered, by key or by session', async () => {
    const held = await insertJob(W.agentA.agentId, W.agentHeld.agentId, 'created');
    const r = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${held.publicId}/accept`,
      headers: bearer(token.agentHeld!),
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().detail).toMatch(/on hold/);

    const client = await agentRowId(W.pClient.chainAgentId);
    for (const [w, why] of [
      ['pHold', /on hold/],
      ['pBlocked', /blocked/],
    ] as const) {
      const j = await insertJob(client, await agentRowId(W[w].chainAgentId), 'created');
      const p = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${j.publicId}/person-actions/prepare`,
        headers: bearer(token[w]!),
        payload: {action: 'accept'},
      });
      expect(p.statusCode, p.body).toBe(403);
      expect(p.json().detail).toMatch(why);
    }
  });

  it('cannot apply or claim, and is told why', async () => {
    for (const [w, why] of [
      ['pHold', /on hold/],
      ['pBlocked', /blocked/],
      ['agentHeld', /on hold/],
    ] as const) {
      const apply = await app.inject({
        method: 'POST',
        url: `/v1/listings/${F.listing}/applications`,
        headers: bearer(token[w]!),
        payload: {
          action: 'apply',
          priceBaseUnits: '30000',
          proposal: 'I can be there this afternoon with a camera.',
        },
      });
      expect(apply.json().detail).toMatch(why);
      const claim = await app.inject({
        method: 'POST',
        url: `/v1/listings/${F.listing}/claim`,
        headers: bearer(token[w]!),
        payload: {},
      });
      expect(claim.json().detail).toMatch(why);
    }
  });
});

describe('a held or blocked account cannot post work either (docs/26 F14)', () => {
  it('a client put on hold cannot select a worker or fund a job, and is told why; cleared, it can again', async () => {
    const client = await agentRowId(W.pClient.chainAgentId);
    const decide = () =>
      app.inject({
        method: 'POST',
        url: `/v1/listings/${F.listing}/decide`,
        headers: bearer(token.pClient!),
        payload: {applicationId: randomUUID(), action: 'select', reason: 'Best price and a fast reply.'},
      });
    const fund = () =>
      app.inject({
        method: 'POST',
        url: `/v1/jobs/${F.personJob}/person-actions/prepare`,
        headers: bearer(token.pClient!),
        payload: {action: 'create'},
      });
    await setStanding(client, 'hold');
    try {
      for (const r of [await decide(), await fund()]) {
        expect(r.statusCode, r.body).toBe(403);
        expect(r.json().detail).toMatch(/on hold/);
      }
    } finally {
      await db.delete(accountStanding).where(eq(accountStanding.agentId, client));
    }
    // Cleared: past the gate (the made-up application is not found; the accepted job is not fundable).
    expect((await decide()).statusCode).toBe(404);
    expect((await fund()).statusCode).not.toBe(403);
  });
});

describe('a council member who is a party to a dispute recuses', () => {
  it('may read it, but the desk builds no proposal or vote for them', async () => {
    const r = await db.execute(
      sql`SELECT id FROM agents WHERE owner_address = ${councilMembers[0]!} OR wallet_address = ${councilMembers[0]!} LIMIT 1`,
    );
    const mine = Number((r as unknown as {id: string}[])[0]!.id);
    const own = await insertJob(mine, W.agentB.agentId, 'disputed');
    await db.insert(jobEvents).values({
      chainId: 'near:sandbox',
      jobId: own.id,
      kind: 'job.disputed',
      payload: {reason: 'The member is the client here.', reasonHash: 'cd'.repeat(32)},
    });
    const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
      app.inject({method, url, headers: bearer(token.council!), ...(payload ? {payload} : {})});
    expect((await call('GET', `/v1/admin/disputes/${own.publicId}`)).statusCode).toBe(200);
    for (const res of [
      await call('POST', `/v1/admin/disputes/${own.publicId}/proposal`, {
        forWorker: false,
        evidenceHash: 'a'.repeat(64),
      }),
      await call('POST', `/v1/admin/disputes/${own.publicId}/proposals/1/vote`, {action: 'VoteApprove'}),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().detail).toMatch(/party to this dispute/);
    }
    // Someone else's dispute: past the recusal (the stale hash is what stops this one).
    const other = await call('POST', `/v1/admin/disputes/${F.disputedJob}/proposal`, {
      forWorker: false,
      evidenceHash: 'a'.repeat(64),
    });
    expect(other.statusCode).not.toBe(403);
  });
});
