import {sql} from 'drizzle-orm';
import {nearClient} from '@pactora/near';
import {z} from 'zod';
import {loadConfig} from '@pactora/config';
import {closeDb, createDb} from '@pactora/db';
import {buildInfo, createMetrics, env, installShutdown, loadEnv, serviceLogger} from '@pactora/service';
import {buildApp} from './app.js';
import {makeSignerSubmit, makeSignerWalletKeys} from './submit.js';
import {
  makeBudgetReader,
  makeDisputeBondReader,
  makeIdentityReader,
  makePaymentReader,
  makeTxEventsReader,
} from './chain-reads.js';
import {DEFAULT_SIGN_RECIPIENT, makeOwnerVerifier} from './challenges.js';
import {makeRunExecutor} from './run-executor.js';
import {coalesce} from './coalesce.js';

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
  })
  // In production the browser origins must be named: `*` is fine for a local
  // demo and wrong for a deployment with a real front end.
  .refine((e) => e.NODE_ENV !== 'production' || e.CORS_ORIGINS.length > 0, {
    message: 'CORS_ORIGINS is required when NODE_ENV=production',
    path: ['CORS_ORIGINS'],
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

const app = await buildApp({
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
