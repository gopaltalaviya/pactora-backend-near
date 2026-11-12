import {KeyPair, keyPairKey, type TxKey} from '@pactora/near';
import type {Db} from '@pactora/db';
import {DbKeyStore, EnvCredentialsSource, Keys, isAccountId, type KeySource} from './keystore.js';
import {KmsKeySource, kmsKey, type KmsClient} from './kms.js';

/**
 * Which keys the signer runs on, decided once at boot from the environment.
 *
 * Imported keys (one source at most — which one signs must never be a guess):
 * - `SIGNER_KMS_KEYS` → AWS KMS ed25519 keys, `{"<wallet account>": "<key id>"}`;
 * - `SIGNER_DEV_CREDENTIALS` → near-cli credential JSON, testnet only.
 *
 * Generated keys (`POST /keys`): the encrypted store in the database, when
 * `SIGNER_KEY_PASSPHRASE` is set.
 */
export async function signerKeys(opts: {
  env: NodeJS.ProcessEnv;
  testnet: boolean;
  chainId: string;
  db: Db;
  kms: () => Promise<KmsClient>;
}): Promise<Keys> {
  const {env} = opts;
  const kmsKeys = env['SIGNER_KMS_KEYS'];
  if (kmsKeys && env['SIGNER_DEV_CREDENTIALS']) {
    throw new Error('SIGNER_KMS_KEYS and SIGNER_DEV_CREDENTIALS are both set; set one');
  }
  let imported: KeySource | null = null;
  if (kmsKeys) {
    let map: unknown;
    try {
      map = JSON.parse(kmsKeys);
    } catch {
      throw new Error('SIGNER_KMS_KEYS is not JSON: expected {"<wallet account>": "<KMS key id>"}');
    }
    if (
      !map ||
      typeof map !== 'object' ||
      Array.isArray(map) ||
      !Object.values(map).every((v) => typeof v === 'string')
    ) {
      throw new Error('SIGNER_KMS_KEYS must be an object of wallet account → KMS key id');
    }
    imported = await KmsKeySource.create(await opts.kms(), map as Record<string, string>);
  } else if (env['SIGNER_DEV_CREDENTIALS']) {
    // The constructor refuses raw keys off testnet.
    imported = new EnvCredentialsSource(env, opts.testnet);
  }
  const passphrase = env['SIGNER_KEY_PASSPHRASE'];
  const store = passphrase ? new DbKeyStore(opts.db, opts.chainId, passphrase) : null;
  return new Keys(imported, store);
}

/** The keeper's account: a normal NEAR account with a key of its own. */
export interface ServiceAccount {
  accountId: string;
  key: TxKey;
}

/**
 * `KEEPER_ACCOUNT_ID` with `KEEPER_KMS_KEY_ID` (any chain) or
 * `KEEPER_SECRET_KEY` = `ed25519:...` (testnet only); no account → no keeper.
 */
export async function keeperAccount(
  env: NodeJS.ProcessEnv,
  testnet: boolean,
  kms: () => Promise<KmsClient>,
): Promise<ServiceAccount | undefined> {
  const accountId = env['KEEPER_ACCOUNT_ID'];
  const keyId = env['KEEPER_KMS_KEY_ID'];
  const raw = env['KEEPER_SECRET_KEY'];
  if (!accountId) {
    if (keyId || raw)
      throw new Error('KEEPER_SECRET_KEY / KEEPER_KMS_KEY_ID is set but KEEPER_ACCOUNT_ID is not');
    return undefined;
  }
  if (!isAccountId(accountId)) throw new Error(`KEEPER_ACCOUNT_ID "${accountId}" is not a NEAR account id`);
  if (keyId && raw) throw new Error('KEEPER_KMS_KEY_ID and KEEPER_SECRET_KEY are both set; set one');
  if (keyId) return {accountId, key: await kmsKey(await kms(), keyId)};
  if (!raw)
    throw new Error('KEEPER_ACCOUNT_ID is set but neither KEEPER_SECRET_KEY nor KEEPER_KMS_KEY_ID is');
  if (!testnet) {
    throw new Error('KEEPER_SECRET_KEY is a raw key; raw keys are for testnet only — use KEEPER_KMS_KEY_ID');
  }
  if (!raw.startsWith('ed25519:')) throw new Error('KEEPER_SECRET_KEY must be an ed25519:<base58> key');
  let keyPair: KeyPair;
  try {
    keyPair = KeyPair.fromString(raw as `ed25519:${string}`);
  } catch {
    throw new Error('KEEPER_SECRET_KEY is not a valid ed25519 key');
  }
  return {accountId, key: keyPairKey(keyPair)};
}

/**
 * `FAUCET_ACCOUNT_ID` with `FAUCET_SECRET_KEY` = `ed25519:...`: the test-token
 * faucet (docs/26 F23). Testnet and sandbox only, so a raw key is all it
 * takes; on any other chain a configured faucet refuses to start. No account
 * → no faucet. It must not be the token's owner (the API's startup check
 * reads the token's owner and refuses that).
 */
export function faucetAccount(env: NodeJS.ProcessEnv, testnet: boolean): ServiceAccount | undefined {
  const accountId = env['FAUCET_ACCOUNT_ID'];
  const raw = env['FAUCET_SECRET_KEY'];
  if (!accountId) {
    if (raw) throw new Error('FAUCET_SECRET_KEY is set but FAUCET_ACCOUNT_ID is not');
    return undefined;
  }
  if (!testnet)
    throw new Error('FAUCET_ACCOUNT_ID is set on a chain that is not a testnet — the faucet is test-only');
  if (!isAccountId(accountId)) throw new Error(`FAUCET_ACCOUNT_ID "${accountId}" is not a NEAR account id`);
  if (!raw) throw new Error('FAUCET_ACCOUNT_ID is set but FAUCET_SECRET_KEY is not');
  if (!raw.startsWith('ed25519:')) throw new Error('FAUCET_SECRET_KEY must be an ed25519:<base58> key');
  let keyPair: KeyPair;
  try {
    keyPair = KeyPair.fromString(raw as `ed25519:${string}`);
  } catch {
    throw new Error('FAUCET_SECRET_KEY is not a valid ed25519 key');
  }
  return {accountId, key: keyPairKey(keyPair)};
}

/**
 * `MINTER_ACCOUNT_ID` with `MINTER_SECRET_KEY` = `ed25519:...`: the
 * work-credential minter (feature/work-credentials), the account the
 * credentials contract names as its `minter`. It calls `nft_mint` and
 * nothing else, from its own NEAR for storage. Testnet and sandbox only, so
 * a raw key is all it takes; on any other chain a configured minter refuses
 * to start. No account → no minter (POST /credentials/mint answers 503).
 */
export function minterAccount(env: NodeJS.ProcessEnv, testnet: boolean): ServiceAccount | undefined {
  const accountId = env['MINTER_ACCOUNT_ID'];
  const raw = env['MINTER_SECRET_KEY'];
  if (!accountId) {
    if (raw) throw new Error('MINTER_SECRET_KEY is set but MINTER_ACCOUNT_ID is not');
    return undefined;
  }
  if (!testnet)
    throw new Error(
      'MINTER_ACCOUNT_ID is set on a chain that is not a testnet — the credential minter is test-only',
    );
  if (!isAccountId(accountId)) throw new Error(`MINTER_ACCOUNT_ID "${accountId}" is not a NEAR account id`);
  // One account, one key, two senders each counting its own nonces: they would collide.
  for (const other of ['FAUCET_ACCOUNT_ID', 'KEEPER_ACCOUNT_ID']) {
    if (env[other] === accountId) {
      throw new Error(
        `MINTER_ACCOUNT_ID must not be ${other} (${accountId}): each sender needs its own account and nonces — refusing to start`,
      );
    }
  }
  if (!raw) throw new Error('MINTER_ACCOUNT_ID is set but MINTER_SECRET_KEY is not');
  if (!raw.startsWith('ed25519:')) throw new Error('MINTER_SECRET_KEY must be an ed25519:<base58> key');
  let keyPair: KeyPair;
  try {
    keyPair = KeyPair.fromString(raw as `ed25519:${string}`);
  } catch {
    throw new Error('MINTER_SECRET_KEY is not a valid ed25519 key');
  }
  return {accountId, key: keyPairKey(keyPair)};
}
