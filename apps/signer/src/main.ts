import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {loadConfig} from '@pactora/config';
import {closeDb, closeLockPool, createDb, createLockPool} from '@pactora/db';
import {nearClient} from '@pactora/near';
import {buildInfo, createMetrics, env, installShutdown, loadEnv, serviceLogger} from '@pactora/service';
import {buildSignerApp} from './app.js';
import {awsKms, type KmsClient} from './kms.js';
import {faucetAccount, keeperAccount, signerKeys} from './keysource.js';
import {assertFaucetNotOwner, makeFaucet} from './faucet.js';
import {SignerService} from './signer.js';
import {chainKeeper} from './keeper.js';
import {WalletWatch, signingAccountsToWatch, type WatchedWallet} from './wallets.js';
import {bindHost} from './auth.js';

/**
 * The signer is NOT a public service.
 *
 * On Railway it binds to private networking only; the API reaches it at the
 * internal hostname. Without SIGNER_TOKEN it binds to loopback and refuses to
 * listen anywhere wider (see auth.ts).
 *
 * Chain wiring (`ENABLED_CHAINS`, `DEFAULT_CHAIN`, `RPC_URL_<SLUG>`) is read
 * by `loadConfig`; this process serves the default chain.
 */
const Env = z.object({
  DATABASE_URL: env.postgresUrl(),
  SIGNER_PORT: env.port(7070),
  SIGNER_HOST: z.string().optional(),
  SIGNER_TOKEN: z.string().min(32, 'SIGNER_TOKEN must be at least 32 characters').optional(),
  /** Encrypts the keys `POST /keys` generates (signer_keys). Without it the signer cannot create keys. */
  SIGNER_KEY_PASSPHRASE: z
    .string()
    .min(32, 'SIGNER_KEY_PASSPHRASE must be at least 32 characters')
    .optional(),
  /** Testnet only: near-cli credential JSON (one object or an array). */
  SIGNER_DEV_CREDENTIALS: z.string().optional(),
  /** AWS KMS ed25519 keys, `{"<wallet account>": "<key id or ARN>"}`. */
  SIGNER_KMS_KEYS: z.string().optional(),
  AWS_REGION: z.string().optional(),
  KEEPER_ACCOUNT_ID: z.string().optional(),
  KEEPER_SECRET_KEY: env.nearSecretKey().optional(),
  KEEPER_KMS_KEY_ID: z.string().min(1).optional(),
  KEEPER_INTERVAL_MS: env.positiveInt(15_000),
  /** The test-token faucet (testnet and sandbox only): a separate account with a limited float. */
  FAUCET_ACCOUNT_ID: z.string().optional(),
  FAUCET_SECRET_KEY: env.nearSecretKey().optional(),
  /** The most one send may carry, in the token's base units; the API's per-claim amount must fit. */
  FAUCET_MAX_PER_SEND: z
    .string()
    .regex(/^[1-9]\d{0,38}$/, 'FAUCET_MAX_PER_SEND must be a positive whole number of base units')
    .default('10000000'),
  /** Below this many yoctoNEAR an account is "low" on /health. Default 0.1 NEAR (ten 100 Tgas calls). */
  WALLET_LOW_BALANCE_YOCTO: z
    .string()
    .regex(/^\d+$/, 'must be a whole number of yoctoNEAR')
    .default('100000000000000000000000'),
  WALLET_CHECK_INTERVAL_MS: env.positiveInt(60_000),
  /** How long a generated key waits for its account to appear on chain before it is removed. Default a day. */
  SIGNER_KEY_UNCLAIMED_GRACE_MS: env.positiveInt(24 * 60 * 60 * 1000),
  METRICS_TOKEN: z.string().optional(),
  TRUST_PROXY: env.trustProxy(),
  LOG_LEVEL: env.logLevel(),
  DB_POOL_MAX: env.positiveInt(5),
  LOCK_POOL_MAX: env.positiveInt(10),
});

const cfg = loadEnv(Env);
const logger = serviceLogger('signer', cfg.LOG_LEVEL);

const config = loadConfig();
const chain = config.chain();
const db = createDb(cfg.DATABASE_URL, {max: cfg.DB_POOL_MAX});
const locks = createLockPool(cfg.DATABASE_URL, {max: cfg.LOCK_POOL_MAX});
const near = nearClient(chain.rpcUrl);

// Before any key is loaded: an RPC serving another network — a mistyped
// RPC_URL_<SLUG> — would have this signer sign that network's transactions.
// A clear refusal, not an undici stack trace ("fetch failed"), when it does not answer at all.
const served = await near.networkId().catch((err: unknown) => {
  throw new Error(
    `the RPC at ${chain.rpcUrl} (${chain.chainId}) did not answer (${err instanceof Error ? err.message : String(err)}) — refusing to start`,
  );
});
if (served !== chain.nearNetworkId) {
  throw new Error(
    `the RPC at ${chain.rpcUrl} serves NEAR network "${served}", not "${chain.nearNetworkId}" (${chain.chainId}) — refusing to start`,
  );
}

// One KMS client for the signing keys and the keeper, made only if asked for.
let kmsClient: Promise<KmsClient> | undefined;
const kms = () => (kmsClient ??= awsKms(cfg.AWS_REGION));

const keys = await signerKeys({env: process.env, testnet: chain.testnet, chainId: chain.chainId, db, kms});
if (keys.kind.includes('dev-credentials')) {
  logger.warn({kind: keys.kind, chainId: chain.chainId}, 'using raw development keys');
} else {
  logger.info({kind: keys.kind, chainId: chain.chainId}, 'keys loaded');
}
const keeper = await keeperAccount(process.env, chain.testnet, kms);
const faucetKey = faucetAccount(process.env, chain.testnet);
// Never the token's owner: that key could mint without limit. An RPC that
// does not answer refuses the start rather than skipping the check.
if (faucetKey) await assertFaucetNotOwner(near, chain, faucetKey);
const faucet = faucetKey
  ? makeFaucet({near, chain, account: faucetKey, maxPerSend: BigInt(cfg.FAUCET_MAX_PER_SEND)})
  : undefined;

const service = new SignerService({db, locks, chain, keys, near, logger});
const metrics = createMetrics('signer');

// The balances of every account this signer sends from, read in the
// background so /health never waits on the RPC. Of the held keys, only the
// wallets an agent row names: a key asked for and never used is not a wallet.
const walletWatch = new WalletWatch({
  near,
  wallets: async (): Promise<WatchedWallet[]> => [
    ...(await signingAccountsToWatch(db, chain.chainId, await keys.accounts())).map((account) => ({
      account,
      role: 'signing-key',
    })),
    ...(keeper ? [{account: keeper.accountId, role: 'keeper'}] : []),
    ...(faucet ? [{account: faucet.accountId, role: 'faucet'}] : []),
  ],
  lowYocto: BigInt(cfg.WALLET_LOW_BALANCE_YOCTO),
  gauge: metrics.gauge('signer_wallet_balance', 'NEAR balance of an account the signer sends from', [
    'address',
    'role',
  ]),
});
const stopWalletWatch = walletWatch.start(cfg.WALLET_CHECK_INTERVAL_MS);

// Keys asked for whose account never appeared on chain are removed after a
// day (keystore.ts `sweepUnclaimed`): a bounded number of reads per hour.
const sweepKeys = setInterval(
  () => {
    keys
      .sweepUnclaimed(near, {graceMs: cfg.SIGNER_KEY_UNCLAIMED_GRACE_MS})
      .then((removed) => {
        if (removed.length > 0) logger.info({removed: removed.length}, 'removed unclaimed wallet keys');
      })
      .catch((err: unknown) => logger.warn({err}, 'sweeping unclaimed wallet keys failed'));
  },
  60 * 60 * 1000,
);
sweepKeys.unref();

const app = buildSignerApp({
  service,
  keys,
  chainId: chain.chainId,
  keysKind: keys.kind,
  build: buildInfo({service: 'signer', packageJsonUrl: new URL('../package.json', import.meta.url)}),
  ...(cfg.SIGNER_TOKEN ? {token: cfg.SIGNER_TOKEN} : {}),
  ...(cfg.METRICS_TOKEN ? {metricsToken: cfg.METRICS_TOKEN} : {}),
  trustProxy: cfg.TRUST_PROXY,
  metrics,
  logger,
  wallets: () => walletWatch.snapshot(),
  ...(faucet ? {faucet} : {}),
  checks: {
    database: () => db.execute(sql`SELECT 1`),
    rpc: () => near.finalBlock(),
  },
});

// The keeper sends the contract's permissionless exits when they fall due —
// without it, a worker that vanishes after accepting strands the client's
// money. It runs here because this is the process allowed to hold a key, but
// on an account of its own.
let stopKeeper: (() => void) | undefined;
if (keeper) {
  stopKeeper = chainKeeper({db, chain, near, account: keeper, logger, metrics}).start(cfg.KEEPER_INTERVAL_MS);
  logger.info({chainId: chain.chainId, keeper: keeper.accountId}, 'keeper sweeping for due exits');
} else {
  logger.warn('no keeper account: expired jobs will wait for someone else to exit them');
}

installShutdown({
  logger,
  closers: [
    ['keeper', async () => stopKeeper?.()],
    ['wallet-watch', async () => stopWalletWatch()],
    ['key-sweep', async () => clearInterval(sweepKeys)],
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
