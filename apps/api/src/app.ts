import Fastify, {type FastifyBaseLogger, type FastifyInstance} from 'fastify';
import helmet from '@fastify/helmet';
import {
  clientKey,
  registerMetrics,
  serviceOptions,
  withTimeout,
  type BuildInfo,
  type Metrics,
} from '@pactora/service';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {postgresRateLimitStore} from './rate-store.js';
import type {ChainConfig} from '@pactora/config';
import type {Db} from '@pactora/db';
import {registerErrorHandler} from './errors.js';
import {openApiDocument} from './openapi.js';
import {EventBus} from './events.js';
import {listenForEvents} from './live.js';
import {registerAgentRoutes} from './routes/agents.js';
import {registerJobRoutes, type JobRouteDeps} from './routes/jobs.js';
import {registerKeyRoutes} from './routes/keys.js';
import {registerMetaRoutes} from './routes/meta.js';
import {registerRunRoutes} from './routes/runs.js';
import {registerPeopleRoutes} from './routes/people.js';
import {registerListingRoutes, sweepExpiredListings} from './routes/listings.js';
import {registerMeRoutes} from './routes/me.js';
import {registerPersonActionRoutes} from './routes/person-actions.js';
import {registerSessionRoutes} from './routes/session.js';
import {registerFileRoutes} from './routes/files.js';
import {registerDraftRoutes} from './routes/drafts.js';
import {registerMessageRoutes} from './routes/messages.js';
import {registerDisputeRoutes} from './routes/dispute.js';
import {registerReportRoutes} from './routes/reports.js';
import {registerAgentEventRoutes} from './routes/agent-events.js';
import {registerWebhookRoutes} from './routes/webhooks.js';
import {registerFaucetRoutes, type FaucetConfig} from './routes/faucet.js';
import {registerProfileRoutes} from './routes/profiles.js';
import {kycSweep, registerKycRoutes} from './routes/kyc.js';
import {registerAdminRoutes} from './routes/admin.js';
import {registerChannelRoutes} from './routes/channels.js';
import type {ChainViewer} from './chain-reads.js';
import type {IdentityProvider, SanctionsIndex} from './compliance.js';
import type {FaucetSend} from './submit.js';
import type {TargetPolicy} from '@pactora/service';
import {jobsReadyToSettle, settleAcceptedDraft} from './evidence.js';
import type {ObjectStore} from '@pactora/storage';
import {sweepChangedKeySessions, sweepExpiredSessions} from './auth.js';
import {registerStatusRoutes, type StatusDeps} from './routes/status.js';
import {registerX402Routes} from './routes/x402.js';
import {RunService, type RunExecutor} from './runs.js';
import type {
  AccessKeysReader,
  BudgetReader,
  DisputeBondReader,
  IdentityReader,
  PaymentReader,
  TxEventsReader,
} from './chain-reads.js';
import type {OwnerVerifier} from './challenges.js';
import type {WalletKeys} from './routes/agents.js';

export interface AppDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  defaultChainId: string;
  submit: JobRouteDeps['submit'];
  bus?: EventBus;
  /** Omitted, /v1/budget answers from the cached policy and says so. */
  readBudget?: BudgetReader;
  /** Omitted, every registration is refused: it cannot be verified. */
  readIdentity?: IdentityReader;
  /** An account's full-access keys: recorded at sign-in, re-read by the session sweep (0025). */
  readAccessKeys?: AccessKeysReader;
  /** How often accounts with live sessions have their key set re-read; default 5 min, 0 = never. */
  sessionKeySweepMs?: number;
  /** NEP-413 owner signatures, checked to be full-access keys (challenges.ts). */
  verifyOwner: OwnerVerifier;
  /** The signer's agent keys; omitted, registration cannot create or accept wallets. */
  walletKeys?: WalletKeys;
  /** NEP-413 recipient; default `pactora`. */
  signRecipient?: string;
  /** Omitted, the x402 facilitator can settle but never confirms a payment. */
  readPayment?: PaymentReader;
  /** Omitted, a transaction a person signed in the browser cannot be confirmed (the indexer still sees it). */
  readTxEvents?: TxEventsReader;
  /** Omitted, a dispute declares no spend and the contract alone enforces the cap. */
  readDisputeBond?: DisputeBondReader;
  /** Omitted, the API serves everything except starting a run. */
  runExecutor?: RunExecutor;
  /** Browser origins allowed to call the API. Omitted, any origin may. */
  corsOrigins?: string[];
  /**
   * Honour X-Forwarded-For. Set behind a proxy (Railway), never when exposed
   * directly. A number trusts that many hops — prefer it to `true`.
   */
  trustProxy?: boolean | number;
  /** Requests per client IP per minute. */
  rateLimitPerMinute?: number;
  /** v3: `postgres` shares the limit between replicas; omitted, it counts in memory. */
  rateLimitStore?: 'memory' | 'postgres';
  /**
   * v3: hear events other processes store — the indexer, another replica —
   * through Postgres LISTEN/NOTIFY (live.ts). Default on; off, a stream
   * carries only what this process publishes.
   */
  liveEvents?: boolean;
  /** Open SSE streams this instance holds, per stream kind (jobs, runs); past it, 503 + retry-after. */
  maxStreams?: number;
  /** Of those, how many one client address may hold. */
  maxStreamsPerClient?: number;
  /** Runs one orchestrator may start per rolling 24 h; 0/unset = no cap. */
  runsPerDay?: number;
  /** Refuse non-public, non-https agent endpoint URLs (production). */
  requirePublicHttpsEndpoints?: boolean;
  /** Agents one owner account may register per chain (F25); default 100. */
  maxAgentsPerOwner?: number;
  logger?: boolean;
  /** A configured pino logger (redaction, service name). Wins over `logger`. */
  loggerInstance?: FastifyBaseLogger;
  /** Dependencies `/ready` checks — the database, and whatever else is wired. */
  readiness?: Record<string, () => Promise<unknown>>;
  /** Prometheus registry; `/metrics` is served when given. */
  metrics?: Metrics;
  metricsToken?: string;
  /** Serve `/metrics` only behind `metricsToken` (production: the API has a public domain). */
  requireMetricsToken?: boolean;
  /** What is running — reported on `/health` and `/v1/status`. */
  build?: BuildInfo;
  /** Dependencies `/v1/status` reports on. */
  status?: StatusDeps;
  /** How often expired sessions and sign-in challenges are deleted; default hourly. */
  sessionSweepMs?: number;
  /**
   * Evidence storage (docs/26 F6). Omitted, uploads and downloads answer
   * 503 — main.ts refuses to start in production without one.
   */
  objectStore?: ObjectStore;
  /** Evidence uploads in flight at once across this process; default 4. */
  uploadConcurrency?: number;
  /**
   * How often accepted drafts that reached the chain are approved for their
   * agent clients (the backstop for a submission the API did not see);
   * default 15 s, 0 = never.
   */
  draftSettleSweepMs?: number;
  /** How often a waiting GET /v1/events looks again; default 500 ms. */
  eventsPollMs?: number;
  /** How often open listings past their deadline are announced as expired (feed events); default 60 s, 0 = never. */
  listingExpirySweepMs?: number;
  /** WEBHOOK_SECRET_KEY's 32 bytes; omitted, POST /v1/webhooks answers 503. */
  webhookSecretKey?: Buffer;
  /** Local development only: allow http and private webhook targets. */
  webhookTargetPolicy?: TargetPolicy;
  /** The signer's faucet (testnet and sandbox only); omitted, POST /v1/faucet answers 503. */
  faucetSend?: FaucetSend;
  faucet?: FaucetConfig;
  /** Identity checks (docs/26 F13); omitted, POST /v1/kyc/start answers 503. */
  identityProvider?: IdentityProvider;
  /** Sanctions screening (docs/26 F14) of a person's legal name before an identity session. */
  sanctions?: SanctionsIndex;
  /** Screening on; off only in development (main.ts refuses production without it). Default on. */
  screening?: boolean;
  /** NEAR accounts that may decide compliance cases. */
  complianceReviewers?: string[];
  /** Live contract views: the admin console reads the arbiter DAO and its proposals (docs/26 F15). */
  viewChain?: ChainViewer;
  /** How long the admin console reuses a read of the DAO council; default 30 s. */
  adminCouncilCacheMs?: number;
  /** The Telegram bot's @username, when apps/channels runs with a token (docs/26 F11). */
  telegramBot?: string;
  /** Email links can be made (apps/channels has an email provider). */
  emailChannel?: boolean;
  /** Called for every route as it is registered — the docs test lists them. */
  onRoute?: (route: {method: string | string[]; url: string}) => void;
}

/** Liveness and readiness: what a load balancer reads. Exempt from the rate limit. */
const PROBE_PATHS = new Set(['/health', '/ready']);

/**
 * Built as a factory so tests can construct the whole API with an injected
 * `submit` and no signer, no chain and no network. A server you can only
 * exercise by starting it is a server nobody writes tests for.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // Request ids: an incoming x-request-id is honoured, else a random UUID —
  // agents retry, and a trace id that survives into the response is how a
  // failed hire is connected to the log line explaining it. Body limit and
  // timeouts are explicit (serviceOptions).
  const app = Fastify({
    ...serviceOptions({trustProxy: deps.trustProxy ?? false}),
    ...(deps.loggerInstance ? {loggerInstance: deps.loggerInstance} : {logger: deps.logger ?? false}),
  });

  if (deps.onRoute) {
    const onRoute = deps.onRoute;
    app.addHook('onRoute', (route) => onRoute({method: route.method, url: route.url}));
  }

  const bus = deps.bus ?? new EventBus(deps.maxStreams, deps.maxStreamsPerClient);
  // A second bus, not a shared namespace: job 7 and run 7 are unrelated, and
  // one map keyed by number would deliver each other's events.
  const runBus = new EventBus(deps.maxStreams, deps.maxStreamsPerClient);

  // The interface lives on another origin (Vercel vs Railway; two ports
  // locally), and with no CORS headers every browser request was refused —
  // the first real render of the interface said "API unreachable" on every
  // page. Any origin is safe to allow because auth is a bearer key, never a
  // cookie: credentials are not allowed, so a hostile page can do nothing
  // here it could not do with curl. CORS_ORIGINS narrows it anyway.
  await app.register(cors, {
    origin: deps.corsOrigins && deps.corsOrigins.length > 0 ? deps.corsOrigins : '*',
    credentials: false,
    // DELETE: signing out (DELETE /v1/session, /v1/sessions).
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'last-event-id', 'x-payment'],
    exposedHeaders: ['x-trace-id', 'retry-after'],
  });

  const shared = deps.rateLimitStore === 'postgres';
  await app.register(rateLimit, {
    max: deps.rateLimitPerMinute ?? 600,
    timeWindow: '1 minute',
    // v3: one window per client across every replica (see rate-store.ts).
    // Fail open on a store error: a limiter that fails closed turns a
    // database hiccup into an outage.
    ...(shared ? {store: postgresRateLimitStore(deps.db) as never, skipOnError: true} : {}),
    // Per client IP, BEFORE authentication. It was keyed on the raw
    // Authorization header — so an attacker got a fresh bucket for every
    // garbage key, which made the per-request auth cost unbounded. With
    // TRUST_PROXY set, `req.ip` is the client, not Railway's proxy. An IPv6
    // client counts under its /64 (audit L1), or every request could come
    // from a fresh address in its own prefix.
    keyGenerator: (req) => clientKey(req.ip),
    // Never the probes. A client that spends its budget must not make the
    // instance look dead to the load balancer reading /health and /ready —
    // behind one shared egress IP that took a healthy instance out of rotation.
    allowList: (req) => PROBE_PATHS.has(req.url.split('?')[0] ?? ''),
  });

  registerErrorHandler(app);

  // Security headers. This is a JSON API, so the content policy is "nothing":
  // no script, no frame, no inline anything — a response rendered as a page
  // by mistake cannot become one.
  await app.register(helmet, {
    contentSecurityPolicy: {directives: {defaultSrc: ["'none'"], frameAncestors: ["'none'"]}},
    crossOriginResourcePolicy: {policy: 'cross-origin'}, // the interface is on another origin
  });

  if (deps.metrics) {
    registerMetrics(app, deps.metrics, {
      ...(deps.metricsToken ? {token: deps.metricsToken} : {}),
      requireToken: deps.requireMetricsToken ?? false,
    });
  }

  app.get('/ready', async (_request, reply) => {
    const checks = Object.entries(deps.readiness ?? {});
    const results = await Promise.all(
      checks.map(async ([name, check]) => {
        try {
          await withTimeout(check(), 2_000, `${name} did not answer within 2000 ms`);
          return [name, {ok: true}] as const;
        } catch (err) {
          // Named, never described: this endpoint is public, and a driver
          // error names the internal host it could not reach. The reason is
          // in the log.
          app.log.warn({err, check: name}, 'readiness check failed');
          return [name, {ok: false}] as const;
        }
      }),
    );
    const ok = results.every(([, r]) => r.ok);
    const detail: Record<string, {ok: boolean}> = {};
    for (const [name, result] of results) detail[name] = result;
    return reply.status(ok ? 200 : 503).send({ok, checks: detail});
  });

  // SSE streams never end by themselves; end them so close() does not wait.
  // preClose, not onClose: onClose runs only AFTER the server has closed,
  // which it cannot do while a stream is open.
  app.addHook('preClose', async () => {
    bus.closeAll();
    runBus.closeAll();
  });

  // Awaited, so the app is listening before it serves its first stream.
  if (deps.liveEvents ?? true) {
    const stopListening = await listenForEvents({
      db: deps.db,
      bus,
      runBus,
      log: (err, msg) => app.log.error({err}, msg),
    });
    // Before the pool is closed (main.ts closes the database after the app).
    app.addHook('onClose', async () => {
      await stopListening().catch((err: unknown) => app.log.warn({err}, 'live events: unlisten failed'));
    });
  }

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-trace-id', request.id);
    return payload;
  });

  app.get('/health', async () => ({
    ok: true,
    chains: Object.values(deps.chains).map((c) => ({
      chainId: c.chainId,
      name: c.name,
      testnet: c.testnet,
      contract: c.contracts.Pactora,
    })),
    defaultChainId: deps.defaultChainId,
    subscribers: bus.subscriberCount + runBus.subscriberCount,
    /** Whether this deployment can start an orchestrator run at all. */
    orchestrator: Boolean(deps.runExecutor),
    /** Which code this is: version, commit, build time. */
    build: deps.build ?? null,
  }));

  // The API described as OpenAPI, built once: the routes do not change while
  // the process runs (openapi.ts says how it stays true to them).
  const openApi = openApiDocument(deps.build?.version ?? '0.0.0');
  app.get('/v1/openapi.json', async () => openApi);

  registerStatusRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    ...(deps.build ? {build: deps.build} : {}),
    ...(deps.status ? {status: deps.status} : {}),
  });

  await registerAgentRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    defaultChainId: deps.defaultChainId,
    ...(deps.readIdentity ? {readIdentity: deps.readIdentity} : {}),
    verifyOwner: deps.verifyOwner,
    ...(deps.walletKeys ? {walletKeys: deps.walletKeys} : {}),
    ...(deps.signRecipient ? {signRecipient: deps.signRecipient} : {}),
    requirePublicHttpsEndpoints: deps.requirePublicHttpsEndpoints ?? false,
    ...(deps.rateLimitPerMinute ? {rateLimitPerMinute: deps.rateLimitPerMinute} : {}),
    ...(deps.maxAgentsPerOwner !== undefined ? {maxAgentsPerOwner: deps.maxAgentsPerOwner} : {}),
  });
  await registerKeyRoutes(app, {
    db: deps.db,
    verifyOwner: deps.verifyOwner,
    ...(deps.readIdentity ? {readIdentity: deps.readIdentity} : {}),
    ...(deps.rateLimitPerMinute ? {rateLimitPerMinute: deps.rateLimitPerMinute} : {}),
  });
  await registerJobRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    defaultChainId: deps.defaultChainId,
    bus,
    submit: deps.submit,
    ...(deps.readDisputeBond ? {readDisputeBond: deps.readDisputeBond} : {}),
  });
  await registerMetaRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    defaultChainId: deps.defaultChainId,
    ...(deps.readBudget ? {readBudget: deps.readBudget} : {}),
  });

  await registerX402Routes(app, {
    db: deps.db,
    chains: deps.chains,
    bus,
    submit: deps.submit,
    ...(deps.readPayment ? {readPayment: deps.readPayment} : {}),
  });

  await registerSessionRoutes(app, {
    db: deps.db,
    enabled: Object.keys(deps.chains),
    defaultChainId: deps.defaultChainId,
    verifyOwner: deps.verifyOwner,
    ...(deps.signRecipient ? {signRecipient: deps.signRecipient} : {}),
    ...(deps.rateLimitPerMinute ? {rateLimitPerMinute: deps.rateLimitPerMinute} : {}),
    ...(deps.readAccessKeys ? {readAccessKeys: deps.readAccessKeys} : {}),
  });
  await registerPeopleRoutes(app, {
    db: deps.db,
    enabled: Object.keys(deps.chains),
    ...(deps.readIdentity ? {readIdentity: deps.readIdentity} : {}),
  });
  await registerMeRoutes(app, {db: deps.db, chains: deps.chains});
  await registerPersonActionRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    bus,
    submit: deps.submit,
    ...(deps.readTxEvents ? {readTxEvents: deps.readTxEvents} : {}),
  });
  await registerFileRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    bus,
    ...(deps.objectStore ? {objectStore: deps.objectStore} : {}),
    ...(deps.uploadConcurrency ? {uploadConcurrency: deps.uploadConcurrency} : {}),
  });
  await registerDraftRoutes(app, {db: deps.db, chains: deps.chains, bus});
  await registerMessageRoutes(app, {db: deps.db, chains: deps.chains, bus});
  await registerDisputeRoutes(app, {db: deps.db, chains: deps.chains, bus});
  await registerReportRoutes(app, {
    db: deps.db,
    reviewers: () => deps.complianceReviewers ?? [],
    ...(deps.rateLimitPerMinute ? {rateLimitPerMinute: deps.rateLimitPerMinute} : {}),
  });
  await registerAgentEventRoutes(app, {
    db: deps.db,
    ...(deps.eventsPollMs ? {pollMs: deps.eventsPollMs} : {}),
  });
  await registerWebhookRoutes(app, {
    db: deps.db,
    ...(deps.webhookSecretKey ? {secretKey: deps.webhookSecretKey} : {}),
    ...(deps.webhookTargetPolicy ? {targetPolicy: deps.webhookTargetPolicy} : {}),
  });
  await registerProfileRoutes(app, {db: deps.db});
  await registerKycRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    ...(deps.identityProvider ? {provider: deps.identityProvider} : {}),
    ...(deps.sanctions ? {sanctions: deps.sanctions} : {}),
    screening: deps.screening ?? true,
    reviewers: () => deps.complianceReviewers ?? [],
  });
  await registerChannelRoutes(app, {
    db: deps.db,
    ...(deps.telegramBot ? {telegramBot: deps.telegramBot} : {}),
    ...(deps.emailChannel ? {email: true} : {}),
  });
  await registerAdminRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    ...(deps.viewChain ? {view: deps.viewChain} : {}),
    reviewers: () => deps.complianceReviewers ?? [],
    ...(deps.objectStore ? {objectStore: deps.objectStore} : {}),
    ...(deps.adminCouncilCacheMs !== undefined ? {councilCacheMs: deps.adminCouncilCacheMs} : {}),
  });
  await registerFaucetRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    ...(deps.faucetSend ? {send: deps.faucetSend} : {}),
    config: deps.faucet ?? {amount: 5_000_000n, perIpPerDay: 5, dailyCap: 500_000_000n},
  });
  await registerListingRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    defaultChainId: deps.defaultChainId,
    bus,
    submit: deps.submit,
    ...(deps.readBudget ? {readBudget: deps.readBudget} : {}),
  });

  // Expired sessions and sign-in challenges authenticate nobody; deleting
  // them only keeps the tables small. In-process, on a timer that close()
  // stops, so no extra service is needed. A failed sweep waits for the next.
  let sweepTimer: NodeJS.Timeout | undefined;
  const sweepEvery = deps.sessionSweepMs ?? 60 * 60 * 1000;
  const sweep = () => {
    sweepTimer = setTimeout(() => {
      Promise.all([sweepExpiredSessions(deps.db), kycSweep(deps.db, deps.identityProvider)])
        .catch((err: unknown) => app.log.warn({err}, 'session sweep failed'))
        .finally(() => {
          if (sweepTimer) sweep();
        });
    }, sweepEvery);
    sweepTimer.unref();
  };
  sweep();
  app.addHook('onClose', async () => {
    clearTimeout(sweepTimer);
    sweepTimer = undefined;
  });

  // Accepted drafts whose hash reached the chain without the API seeing the
  // submission (the indexer recorded it): approve them for agent clients.
  // Idempotent per review, so racing a request's own approval is harmless.
  let settleTimer: NodeJS.Timeout | undefined;
  const settleEvery = deps.draftSettleSweepMs ?? 15_000;
  const settleSweep = () => {
    settleTimer = setTimeout(() => {
      jobsReadyToSettle(deps.db)
        .then(async (ids) => {
          for (const id of ids) {
            await settleAcceptedDraft({db: deps.db, bus, submit: deps.submit}, id).catch((err: unknown) =>
              app.log.warn({err, job: id}, 'accepted draft: approval failed; retried next sweep'),
            );
          }
        })
        .catch((err: unknown) => app.log.warn({err}, 'accepted-draft sweep failed'))
        .finally(() => {
          if (settleTimer) settleSweep();
        });
    }, settleEvery);
    settleTimer.unref();
  };
  if (settleEvery > 0) settleSweep();
  app.addHook('onClose', async () => {
    clearTimeout(settleTimer);
    settleTimer = undefined;
  });

  // Sessions of an account whose full-access keys changed end (0025): a
  // rotated or stolen-and-replaced key must not leave a week-long session.
  let keySweepTimer: NodeJS.Timeout | undefined;
  const keySweepEvery = deps.sessionKeySweepMs ?? 5 * 60_000;
  const readAccessKeys = deps.readAccessKeys;
  const keySweep = () => {
    keySweepTimer = setTimeout(() => {
      sweepChangedKeySessions(deps.db, readAccessKeys!)
        .then((r) => {
          if (r.revoked > 0) app.log.info(r, 'sessions ended: account keys changed');
        })
        .catch((err: unknown) => app.log.warn({err}, 'session key sweep failed'))
        .finally(() => {
          if (keySweepTimer) keySweep();
        });
    }, keySweepEvery);
    keySweepTimer.unref();
  };
  if (keySweepEvery > 0 && readAccessKeys) keySweep();
  app.addHook('onClose', async () => {
    clearTimeout(keySweepTimer);
    keySweepTimer = undefined;
  });

  // Listings whose deadline passed: the client and its bidders are told once
  // (dedupe keys), through the same feed as every other event.
  let expiryTimer: NodeJS.Timeout | undefined;
  const expiryEvery = deps.listingExpirySweepMs ?? 60_000;
  const expirySweep = () => {
    expiryTimer = setTimeout(() => {
      sweepExpiredListings(deps.db)
        .catch((err: unknown) => app.log.warn({err}, 'listing expiry sweep failed'))
        .finally(() => {
          if (expiryTimer) expirySweep();
        });
    }, expiryEvery);
    expiryTimer.unref();
  };
  if (expiryEvery > 0) expirySweep();
  app.addHook('onClose', async () => {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
  });

  await registerRunRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    runBus,
    ...(deps.runExecutor
      ? {
          runs: new RunService({
            db: deps.db,
            bus: runBus,
            execute: deps.runExecutor,
            log: (err, msg) => app.log.error({err}, msg),
            ...(deps.runsPerDay ? {runsPerDay: deps.runsPerDay} : {}),
          }),
        }
      : {}),
  });

  return app;
}

export {EventBus};
