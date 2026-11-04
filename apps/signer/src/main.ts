import {createPublicClient, http} from 'viem';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {loadConfig, loadAbis} from '@pactora/config';
import {closeDb, closeLockPool, createDb, createLockPool} from '@pactora/db';
import {buildInfo, createMetrics, env, installShutdown, loadEnv, serviceLogger} from '@pactora/service';
import {buildSignerApp} from './app.js';
import {awsKms} from './kms.js';
import {serviceAccount, sessionManagerAccount, signerKeys} from './keysource.js';
import {SignerService} from './signer.js';
import {chainKeeper} from './keeper.js';
import {WalletWatch, type WatchedWallet} from './wallets.js';
import {chainRenewer} from './renewer.js';
import {bindHost} from './auth.js';
import {assertRpcChain} from './accounts.js';

/**
 * The signer is NOT a public service.
 *
 * On Railway it binds to private networking only; the API reaches it at the
 * internal hostname. Without SIGNER_TOKEN it binds to loopback and refuses to
 * listen anywhere wider (see auth.ts).
 */
const Env = z.object({
  DATABASE_URL: env.postgresUrl(),
  SIGNER_PORT: env.port(7070),
  SIGNER_HOST: z.string().optional(),
  SIGNER_TOKEN: z.string().min(32, 'SIGNER_TOKEN must be at least 32 characters').optional(),
  SIGNER_KEYSTORE_JSON: z.string().optional(),
  /**
   * v3: AWS KMS keys, `{"<agentId or wallet>": "<key id or ARN>"}` — the way
   * to sign off testnet without a decryptable key here. Credentials and region
   * come from the AWS SDK's default chain (an instance role, AWS_REGION, …).
   */
  SIGNER_KMS_KEYS: z.string().optional(),
  KEEPER_KMS_KEY_ID: z.string().min(1).optional(),
  SESSION_MANAGER_KMS_KEY_ID: z.string().min(1).optional(),
  /** Deprecated name of SESSION_MANAGER_KMS_KEY_ID. */
  SESSION_OWNER_KMS_KEY_ID: z.string().min(1).optional(),
  AWS_REGION: z.string().optional(),
  KEEPER_PRIVATE_KEY: env.privateKey().optional(),
  KEEPER_INTERVAL_MS: env.positiveInt(15_000),
  /**
   * v3: below this many wei a sending wallet is "low" on /v1/status. A v3
   * settlement reserves ~1 M gas (~0.1 MON at testnet's 102 gwei), so the
   * default leaves about two.
   */
  WALLET_LOW_BALANCE_WEI: z
    .string()
    .regex(/^\d+$/, 'must be a whole number of wei')
    .default('200000000000000000'),
  WALLET_CHECK_INTERVAL_MS: env.positiveInt(60_000),
  /**
   * Session manager of the hosted AgentAccounts: extends their 24 h session
   * keys and can do nothing else (audit F1). Testnet only; else
   * SESSION_MANAGER_KMS_KEY_ID. Never the accounts' owner key.
   */
  SESSION_MANAGER_PRIVATE_KEY: env.privateKey().optional(),
  /** Deprecated name of SESSION_MANAGER_PRIVATE_KEY. */
  SESSION_OWNER_PRIVATE_KEY: env.privateKey().optional(),
  SESSION_RENEW_INTERVAL_MS: env.positiveInt(3_600_000),
  /** Renew a grant that lapses within this many seconds. */
  SESSION_RENEW_BEFORE_S: env.positiveInt(21_600),
  METRICS_TOKEN: z.string().optional(),
  TRUST_PROXY: env.trustProxy(),
  LOG_LEVEL: env.logLevel(),
  DB_POOL_MAX: env.positiveInt(5),
  LOCK_POOL_MAX: env.positiveInt(10),
});

const cfg = loadEnv(Env);
const logger = serviceLogger('signer', cfg.LOG_LEVEL);

const config = loadConfig();
const abis = loadAbis() as Record<string, never>;
const chain = config.chain();
const db = createDb(cfg.DATABASE_URL, {max: cfg.DB_POOL_MAX});
const locks = createLockPool(cfg.DATABASE_URL, {max: cfg.LOCK_POOL_MAX});
const pub = createPublicClient({transport: http(chain.rpcUrl)});

// Before any key is loaded: an RPC serving another chain — a mistyped
// RPC_URL_<id> — would have this testnet signer, raw keys and all, sign that
// chain's transactions. The signer, the keeper and the renewer share it.
await assertRpcChain(pub, chain);

// One KMS client for the signing keys, the keeper and the renewer, made only
// if one of them asks for it.
let kmsClient: ReturnType<typeof awsKms> | undefined;
const kms = () => (kmsClient ??= awsKms(cfg.AWS_REGION));

const keys = await signerKeys(process.env, chain.testnet, kms);
if (keys.kind === 'raw-key-dev-only') {
  logger.warn({kind: keys.kind, chainId: chain.chainId}, 'using a raw development key');
} else {
  logger.info({kind: keys.kind, chainId: chain.chainId, keys: keys.all?.().length}, 'keys loaded');
}
const keeperAccount = await serviceAccount('KEEPER', process.env, chain.testnet, kms);
const manager = await sessionManagerAccount(process.env, chain.testnet, kms);
if (manager?.deprecatedName) {
  logger.warn(
    "SESSION_OWNER_* is the old name of SESSION_MANAGER_*; the key must be the accounts' session manager, not their owner",
  );
}
const sessionManager = manager?.account;

const service = new SignerService({db, locks, chain, keys, abis, logger});
const metrics = createMetrics('signer');

// v3: the gas of every wallet this signer sends from, read in the background
// so /health never waits on the RPC. The keeper is added below if it runs.
const watched: WatchedWallet[] = (keys.all?.() ?? []).map((a) => ({address: a.address, role: 'signing-key'}));
if (keeperAccount) watched.push({address: keeperAccount.address, role: 'keeper'});
const walletWatch = new WalletWatch({
  pub,
  wallets: watched,
  lowWei: BigInt(cfg.WALLET_LOW_BALANCE_WEI),
  gauge: metrics.gauge('signer_wallet_balance', 'Native balance of a wallet the signer sends from', [
    'address',
    'role',
  ]),
});
const stopWalletWatch = walletWatch.start(cfg.WALLET_CHECK_INTERVAL_MS);

const app = buildSignerApp({
  service,
  chainId: chain.chainId,
  keysKind: keys.kind,
  build: buildInfo({service: 'signer', packageJsonUrl: new URL('../package.json', import.meta.url)}),
  ...(cfg.SIGNER_TOKEN ? {token: cfg.SIGNER_TOKEN} : {}),
  ...(cfg.METRICS_TOKEN ? {metricsToken: cfg.METRICS_TOKEN} : {}),
  trustProxy: cfg.TRUST_PROXY,
  metrics,
  logger,
  wallets: () => walletWatch.snapshot(),
  checks: {
    database: () => db.execute(sql`SELECT 1`),
    rpc: () => pub.getBlockNumber(),
  },
});

// The keeper sends the escrow's permissionless exits when they fall due —
// without it, a worker that vanishes after accepting strands the client's
// money. It runs here because this is the process allowed to hold a key, but
// on a key of its own: sharing the signer's would race it for nonces.
let stopKeeper: (() => void) | undefined;
if (keeperAccount) {
  const keeper = chainKeeper({
    db,
    chain,
    abis,
    account: keeperAccount,
    logger,
    metrics,
  });
  stopKeeper = keeper.start(cfg.KEEPER_INTERVAL_MS);
  logger.info({chainId: chain.chainId}, 'keeper sweeping for due exits');
} else {
  logger.warn('no keeper key: expired escrow jobs will wait for someone else to exit them');
}

// The renewer keeps the hosted accounts' session keys alive. AgentAccount caps
// a grant at 24 h, so without this a hosted orchestrator stops hiring a day
// after it was set up. It renews as each account's session manager.
let stopRenewer: (() => void) | undefined;
if (sessionManager) {
  const held = (keys.all?.() ?? []).map((a) => a.address);
  const renewer = chainRenewer({
    db,
    chain,
    abis,
    account: sessionManager,
    keys: held,
    renewBeforeSeconds: cfg.SESSION_RENEW_BEFORE_S,
    logger,
    metrics,
  });
  stopRenewer = renewer.start(cfg.SESSION_RENEW_INTERVAL_MS);
  logger.info({chainId: chain.chainId, keys: held.length}, 'renewer keeping session keys alive');
}

installShutdown({
  logger,
  closers: [
    ['keeper', async () => stopKeeper?.()],
    ['wallet-watch', async () => stopWalletWatch()],
    ['renewer', async () => stopRenewer?.()],
    // Stops accepting, then waits for in-flight signs to finish.
    ['http', () => app.close()],
    ['locks', () => closeLockPool(locks)],
    ['database', () => closeDb(db)],
  ],
});

const host = bindHost(process.env);
await app.listen({port: cfg.SIGNER_PORT, host});
logger.info(
  {port: cfg.SIGNER_PORT, host, chainId: chain.chainId, token: Boolean(cfg.SIGNER_TOKEN)},
  'signer listening',
);
