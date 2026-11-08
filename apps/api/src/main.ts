import {sql} from 'drizzle-orm';
import {nearClient} from '@pactora/near';
import {z} from 'zod';
import {loadConfig} from '@pactora/config';
import {closeDb, createDb} from '@pactora/db';
import {
  buildInfo,
  createMetrics,
  env,
  installShutdown,
  loadEnv,
  parseSecretKey,
  serviceLogger,
} from '@pactora/service';
import {buildApp} from './app.js';
import {makeSignerFaucet, makeSignerSubmit, makeSignerWalletKeys} from './submit.js';
import {SanctionsIndex, SimulatedIdentityProvider} from './compliance.js';
import {
  makeBudgetReader,
  makeChainViewer,
  makeDisputeBondReader,
  makeIdentityReader,
  makePaymentReader,
  makeTxEventsReader,
} from './chain-reads.js';
import {DEFAULT_SIGN_RECIPIENT, makeOwnerVerifier} from './challenges.js';
import {makeRunExecutor} from './run-executor.js';
import {coalesce} from './coalesce.js';
import {S3ObjectStore} from '@pactora/storage';

const Env = z
  .object({
    NODE_ENV: env.nodeEnv(),
    DATABASE_URL: env.postgresUrl(),
    PORT: env.port(8080),
    HOST: z.string().default('0.0.0.0'),
    SIGNER_URL: env.httpUrl().default('http://127.0.0.1:7070'),
    SIGNER_TOKEN: z.string().min(32).optional(),
    /** A sign waits for finality on NEAR (a few seconds), so not short. */
    SIGNER_TIMEOUT_MS: env.positiveInt(60_000),
    PACTORA_SELF_URL: env.httpUrl().optional(),
    CORS_ORIGINS: env.csv(),
    TRUST_PROXY: env.trustProxy(),
    RATE_LIMIT_PER_MINUTE: env.positiveInt(600),
    /** v3: `postgres` shares the limit between API replicas. */
    RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).default('memory'),
    /** Open SSE streams per kind before new ones get 503 + retry-after. Each holds a socket. */
    SSE_MAX_STREAMS: env.positiveInt(1_000),
    /** Of those, how many one client address may hold (needs TRUST_PROXY behind a proxy). */
    SSE_MAX_STREAMS_PER_CLIENT: env.positiveInt(20),
    /** Runs one orchestrator may start per rolling 24 h. 0 = no cap. Hosted: 30. */
    RUNS_PER_DAY: z.coerce.number().int().min(0).default(0),
    METRICS_TOKEN: z.string().optional(),
    LOG_LEVEL: env.logLevel(),
    DB_POOL_MAX: env.positiveInt(5),
    /** Blocks the indexer may trail the chain head before /v1/status says 'degraded'. */
    STATUS_MAX_INDEXER_LAG_BLOCKS: env.positiveInt(150),
    /** NEP-413 `recipient` the owner's wallet signs for (docs/NEAR-PORT.md §5). */
    PACTORA_SIGN_RECIPIENT: z.string().min(1).default(DEFAULT_SIGN_RECIPIENT),
    /** Evidence photo uploads (docs/26 F6): `on` needs the object store below; `off` refuses them. */
    EVIDENCE_UPLOADS: z.enum(['on', 'off']).default('on'),
    /** S3-compatible object storage for evidence. Unset bucket: no store (refused in production). */
    OBJECT_STORE_BUCKET: z.string().min(3).optional(),
    /** Omitted: AWS S3 itself. Locally: the compose MinIO, http://127.0.0.1:9110. */
    OBJECT_STORE_ENDPOINT: env.httpUrl().optional(),
    OBJECT_STORE_REGION: z.string().min(1).default('us-east-1'),
    /** Both or neither; neither uses the AWS SDK's default chain (an instance role). */
    OBJECT_STORE_ACCESS_KEY_ID: z.string().min(1).optional(),
    OBJECT_STORE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** 1 for MinIO and most S3-compatible stores (bucket in the path). */
    OBJECT_STORE_FORCE_PATH_STYLE: env.flag(),
    /** Server-side encryption on every object; `none` only for a store that cannot (documented). */
    OBJECT_STORE_SSE: z.enum(['AES256', 'aws:kms', 'none']).default('AES256'),
    /** Webhooks (docs/26 F9): 32 random bytes, 64 hex or 44 base64, that seal each hook's secret. Unset: no webhooks. */
    WEBHOOK_SECRET_KEY: z
      .string()
      .refine((v) => {
        try {
          parseSecretKey(v);
          return true;
        } catch {
          return false;
        }
      }, 'WEBHOOK_SECRET_KEY must be 32 random bytes: 64 hex characters or 44 base64 characters')
      .optional(),
    /** Local development only: let webhooks target http and private addresses. Refused in production. */
    WEBHOOK_ALLOW_PRIVATE: env.flag(),
    /** The test-token faucet (testnet and sandbox only), in the token's base units. */
    FAUCET_AMOUNT: z.coerce.bigint().positive().default(5_000_000n),
    FAUCET_PER_IP_PER_DAY: env.positiveInt(5),
    FAUCET_DAILY_CAP: z.coerce.bigint().positive().default(500_000_000n),
    /** Sanctions screening of a person's legal name (docs/26 F14). `off` is refused in production. */
    SANCTIONS_SCREENING: z.enum(['on', 'off']).default('on'),
    /** Identity checks (docs/26 F13): `none`, or `simulated` (test chains only, labelled everywhere). */
    IDENTITY_PROVIDER: z.enum(['none', 'simulated']).default('none'),
    /** Verifies the identity provider's webhooks (HMAC). Required with a provider. */
    KYC_WEBHOOK_SECRET: z.string().min(32, 'KYC_WEBHOOK_SECRET must be at least 32 characters').optional(),
    /** Where the simulated provider's page lives (the interface). */
    KYC_PAGE_BASE: env.httpUrl().default('http://localhost:3000'),
    /** NEAR accounts that decide compliance cases, comma-separated. Production with screening needs two. */
    /** The bot's @username when apps/channels runs with TELEGRAM_BOT_TOKEN; unset: no Telegram linking. */
    TELEGRAM_BOT_USERNAME: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{4,31}bot$/i, 'TELEGRAM_BOT_USERNAME is a bot username, ending in bot')
      .optional(),
    /** Email links can be made: apps/channels has an email provider. */
    EMAIL_CHANNEL: env.flag(),
    COMPLIANCE_REVIEWERS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
  })
  // In production the browser origins must be named: `*` is fine for a local
  // demo and wrong for a deployment with a real front end.
  .refine((e) => e.NODE_ENV !== 'production' || e.CORS_ORIGINS.length > 0, {
    message: 'CORS_ORIGINS is required when NODE_ENV=production',
    path: ['CORS_ORIGINS'],
  })
  // Evidence never falls back to something else in production: no store,
  // no start (EVIDENCE_UPLOADS=off says so explicitly instead).
  .refine((e) => e.NODE_ENV !== 'production' || e.EVIDENCE_UPLOADS === 'off' || e.OBJECT_STORE_BUCKET, {
    message: 'OBJECT_STORE_BUCKET is required when NODE_ENV=production and EVIDENCE_UPLOADS=on',
    path: ['OBJECT_STORE_BUCKET'],
  })
  .refine((e) => e.NODE_ENV !== 'production' || !e.WEBHOOK_ALLOW_PRIVATE, {
    message: 'WEBHOOK_ALLOW_PRIVATE is for local development and is refused when NODE_ENV=production',
    path: ['WEBHOOK_ALLOW_PRIVATE'],
  })
  .refine((e) => e.NODE_ENV !== 'production' || e.SANCTIONS_SCREENING === 'on', {
    message: 'SANCTIONS_SCREENING=off is refused when NODE_ENV=production',
    path: ['SANCTIONS_SCREENING'],
  })
  .refine((e) => e.IDENTITY_PROVIDER === 'none' || Boolean(e.KYC_WEBHOOK_SECRET), {
    message: 'an IDENTITY_PROVIDER needs KYC_WEBHOOK_SECRET',
    path: ['KYC_WEBHOOK_SECRET'],
  })
  .refine(
    (e) =>
      e.NODE_ENV !== 'production' || e.SANCTIONS_SCREENING !== 'on' || e.COMPLIANCE_REVIEWERS.length >= 2,
    {
      message:
        'production screening needs at least two COMPLIANCE_REVIEWERS (a strong match is cleared by two)',
      path: ['COMPLIANCE_REVIEWERS'],
    },
  )
  .refine((e) => e.FAUCET_AMOUNT <= e.FAUCET_DAILY_CAP, {
    message: 'FAUCET_AMOUNT must not exceed FAUCET_DAILY_CAP',
    path: ['FAUCET_AMOUNT'],
  })
  .refine((e) => Boolean(e.OBJECT_STORE_ACCESS_KEY_ID) === Boolean(e.OBJECT_STORE_SECRET_ACCESS_KEY), {
    message: 'set OBJECT_STORE_ACCESS_KEY_ID and OBJECT_STORE_SECRET_ACCESS_KEY together, or neither',
    path: ['OBJECT_STORE_ACCESS_KEY_ID'],
  });

const cfg = loadEnv(Env);
const logger = serviceLogger('api', cfg.LOG_LEVEL);

const config = loadConfig();
const db = createDb(cfg.DATABASE_URL, {max: cfg.DB_POOL_MAX});
const metrics = createMetrics('api');
const build = buildInfo({service: 'api', packageJsonUrl: new URL('../package.json', import.meta.url)});

// Every chain's RPC must be the network the config names — the NEAR
// counterpart of checking eth_chainId. A testnet API pointed at a mainnet
// RPC (or a sandbox from another run) refuses to start rather than mislead.
for (const c of Object.values(config.chains)) {
  // A clear refusal, not an undici stack trace ("fetch failed"), when it does not answer at all.
  const served = await nearClient(c.rpcUrl, {timeoutMs: 10_000})
    .networkId()
    .catch((err: unknown) => {
      throw new Error(
        `${c.chainId}: the RPC at ${c.rpcUrl} did not answer (${err instanceof Error ? err.message : String(err)}) — refusing to start`,
      );
    });
  if (served !== c.nearNetworkId) {
    throw new Error(`${c.chainId}: RPC ${c.rpcUrl} serves "${served}", expected "${c.nearNetworkId}"`);
  }
}

// One head reader per chain for /v1/status: a short timeout and no retries —
// a status page must answer "rpc: down" promptly, not wait out retries.
const heads = new Map<string, ReturnType<typeof nearClient>>(
  Object.values(config.chains).map((c) => [c.chainId, nearClient(c.rpcUrl, {timeoutMs: 2_000, retries: 0})]),
);
// Coalesced: one probe in flight, its answer reused for 5 s. Uncoalesced, a
// stopped signer's DNS lookups filled libuv's thread pool and starved the RPC
// lookup, so /v1/status reported the chain down too (see coalesce.ts).
const signerHealth = coalesce<unknown>(async () => {
  const res = await fetch(`${cfg.SIGNER_URL}/health`, {signal: AbortSignal.timeout(2_000)});
  if (!res.ok) throw new Error(`signer /health answered ${res.status}`);
  // v3: the body carries the signer's gas reading, which /v1/status reports.
  return res.json().catch(() => undefined);
}, 5_000);

// Resolved before the server starts: a deployment with no model key still
// serves the marketplace, and `/health` says plainly whether it can run.
// The reason is LOGGED — it used to be `.catch(() => null)`, so a mistyped
// key was indistinguishable from a deliberate "no orchestrator".
const runExecutor = await makeRunExecutor({
  baseUrl: cfg.PACTORA_SELF_URL ?? `http://127.0.0.1:${cfg.PORT}`,
  chainId: config.defaultChainId,
}).catch((err: unknown) => {
  logger.warn({err}, 'orchestrator unavailable; the API will serve everything except starting a run');
  return null;
});

// Evidence storage. In development a missing bucket on the local MinIO is
// created; elsewhere it must already exist (with its own policy), and a
// store that does not answer stops the boot rather than the first upload.
const objectStore =
  cfg.EVIDENCE_UPLOADS === 'on' && cfg.OBJECT_STORE_BUCKET
    ? new S3ObjectStore({
        bucket: cfg.OBJECT_STORE_BUCKET,
        region: cfg.OBJECT_STORE_REGION,
        ...(cfg.OBJECT_STORE_ENDPOINT ? {endpoint: cfg.OBJECT_STORE_ENDPOINT} : {}),
        ...(cfg.OBJECT_STORE_ACCESS_KEY_ID && cfg.OBJECT_STORE_SECRET_ACCESS_KEY
          ? {accessKeyId: cfg.OBJECT_STORE_ACCESS_KEY_ID, secretAccessKey: cfg.OBJECT_STORE_SECRET_ACCESS_KEY}
          : {}),
        forcePathStyle: cfg.OBJECT_STORE_FORCE_PATH_STYLE,
        serverSideEncryption: cfg.OBJECT_STORE_SSE,
      })
    : undefined;
if (objectStore) {
  await objectStore.ensureBucket(cfg.NODE_ENV !== 'production').catch((err: unknown) => {
    throw new Error(
      `evidence storage: bucket ${cfg.OBJECT_STORE_BUCKET} at ${cfg.OBJECT_STORE_ENDPOINT ?? 'AWS S3'} is not reachable (${err instanceof Error ? err.message : String(err)}) — refusing to start`,
    );
  });
} else {
  logger.warn(
    {evidenceUploads: cfg.EVIDENCE_UPLOADS},
    'no evidence storage: photo uploads and downloads answer 503 (set OBJECT_STORE_BUCKET, docs/08)',
  );
}

// The simulated identity provider never looks at a document: only where
// every enabled chain is a test chain.
if (cfg.IDENTITY_PROVIDER === 'simulated' && !Object.values(config.chains).every((c) => c.testnet)) {
  throw new Error('IDENTITY_PROVIDER=simulated is for test chains only; a chain enabled here is not one');
}
const identityProvider =
  cfg.IDENTITY_PROVIDER === 'simulated'
    ? new SimulatedIdentityProvider(cfg.KYC_WEBHOOK_SECRET!, cfg.KYC_PAGE_BASE.replace(/\/$/, ''))
    : undefined;
if (identityProvider) logger.warn('identity provider: SIMULATED (testnet only; no document is checked)');

const signerDeps = {
  signerUrl: cfg.SIGNER_URL,
  ...(cfg.SIGNER_TOKEN ? {signerToken: cfg.SIGNER_TOKEN} : {}),
  timeoutMs: cfg.SIGNER_TIMEOUT_MS,
  config,
};
const app = await buildApp({
  ...(objectStore ? {objectStore} : {}),
  ...(identityProvider ? {identityProvider} : {}),
  sanctions: new SanctionsIndex(db),
  screening: cfg.SANCTIONS_SCREENING === 'on',
  complianceReviewers: cfg.COMPLIANCE_REVIEWERS,
  viewChain: makeChainViewer(config),
  ...(cfg.TELEGRAM_BOT_USERNAME ? {telegramBot: cfg.TELEGRAM_BOT_USERNAME} : {}),
  emailChannel: cfg.EMAIL_CHANNEL,
  ...(cfg.WEBHOOK_SECRET_KEY ? {webhookSecretKey: parseSecretKey(cfg.WEBHOOK_SECRET_KEY)} : {}),
  ...(cfg.WEBHOOK_ALLOW_PRIVATE ? {webhookTargetPolicy: {allowHttp: true, allowPrivate: true}} : {}),
  // Only where every enabled chain is a test chain; the route refuses others anyway.
  ...(Object.values(config.chains).every((c) => c.testnet) ? {faucetSend: makeSignerFaucet(signerDeps)} : {}),
  faucet: {amount: cfg.FAUCET_AMOUNT, perIpPerDay: cfg.FAUCET_PER_IP_PER_DAY, dailyCap: cfg.FAUCET_DAILY_CAP},
  db,
  chains: config.chains,
  defaultChainId: config.defaultChainId,
  readBudget: makeBudgetReader(config),
  readIdentity: makeIdentityReader(config),
  readPayment: makePaymentReader(config),
  readTxEvents: makeTxEventsReader(config),
  readDisputeBond: makeDisputeBondReader(config),
  verifyOwner: makeOwnerVerifier(config, cfg.PACTORA_SIGN_RECIPIENT),
  signRecipient: cfg.PACTORA_SIGN_RECIPIENT,
  walletKeys: makeSignerWalletKeys({
    signerUrl: cfg.SIGNER_URL,
    ...(cfg.SIGNER_TOKEN ? {signerToken: cfg.SIGNER_TOKEN} : {}),
    timeoutMs: cfg.SIGNER_TIMEOUT_MS,
    config,
  }),
  corsOrigins: cfg.CORS_ORIGINS,
  trustProxy: cfg.TRUST_PROXY,
  rateLimitPerMinute: cfg.RATE_LIMIT_PER_MINUTE,
  rateLimitStore: cfg.RATE_LIMIT_STORE,
  maxStreams: cfg.SSE_MAX_STREAMS,
  maxStreamsPerClient: cfg.SSE_MAX_STREAMS_PER_CLIENT,
  runsPerDay: cfg.RUNS_PER_DAY,
  requirePublicHttpsEndpoints: cfg.NODE_ENV === 'production',
  ...(runExecutor ? {runExecutor} : {}),
  submit: makeSignerSubmit({
    signerUrl: cfg.SIGNER_URL,
    ...(cfg.SIGNER_TOKEN ? {signerToken: cfg.SIGNER_TOKEN} : {}),
    timeoutMs: cfg.SIGNER_TIMEOUT_MS,
    config,
  }),
  readiness: {
    database: () => db.execute(sql`SELECT 1`),
    signer: signerHealth,
  },
  status: {
    signer: signerHealth,
    headBlock: async (chainId) => BigInt((await heads.get(chainId)!.finalBlock()).height),
    maxIndexerLagBlocks: cfg.STATUS_MAX_INDEXER_LAG_BLOCKS,
  },
  build,
  metrics,
  ...(cfg.METRICS_TOKEN ? {metricsToken: cfg.METRICS_TOKEN} : {}),
  // The API is the one service with a public domain: its metrics are not
  // published to the internet by default.
  requireMetricsToken: cfg.NODE_ENV === 'production',
  loggerInstance: logger,
});

installShutdown({
  logger,
  closers: [
    // Stops accepting, ends SSE streams, waits for in-flight requests.
    ['http', () => app.close()],
    ['database', () => closeDb(db)],
  ],
});

await app.listen({port: cfg.PORT, host: cfg.HOST});
logger.info(
  {
    port: cfg.PORT,
    chains: Object.keys(config.chains),
    orchestrator: Boolean(runExecutor),
    cors: cfg.CORS_ORIGINS,
    build,
    metrics:
      cfg.NODE_ENV !== 'production' || Boolean(cfg.METRICS_TOKEN) ? 'served' : 'off (set METRICS_TOKEN)',
  },
  'api listening',
);
