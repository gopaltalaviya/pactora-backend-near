import type {LocalAccount} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {EnvKeystoreSource, RawKeySource, type KeySource} from './keystore.js';
import {KmsKeySource, kmsAccount, type KmsClient} from './kms.js';

/**
 * Which keys the signer runs on, decided once at boot from the environment.
 *
 * - `SIGNER_KMS_KEYS` → AWS KMS (any chain; the only choice on a mainnet that
 *   does not want a decryptable key in its environment).
 * - `SIGNER_KEYSTORE_JSON` → an encrypted keystore; off testnet, one per agent.
 * - otherwise raw `SIGNER_DEV_PRIVATE_KEY(S)` → testnet only.
 *
 * Two sources at once is refused: which one signs must never be a guess.
 */
export async function signerKeys(
  env: NodeJS.ProcessEnv,
  testnet: boolean,
  kms: () => Promise<KmsClient>,
): Promise<KeySource> {
  const kmsKeys = env['SIGNER_KMS_KEYS'];
  if (kmsKeys && env['SIGNER_KEYSTORE_JSON']) {
    throw new Error('SIGNER_KMS_KEYS and SIGNER_KEYSTORE_JSON are both set; set one');
  }
  if (kmsKeys) {
    let map: unknown;
    try {
      map = JSON.parse(kmsKeys);
    } catch {
      throw new Error('SIGNER_KMS_KEYS is not JSON: expected {"<agentId or wallet>": "<KMS key id>"}');
    }
    if (
      !map ||
      typeof map !== 'object' ||
      Array.isArray(map) ||
      !Object.values(map).every((v) => typeof v === 'string')
    ) {
      throw new Error('SIGNER_KMS_KEYS must be an object of agent id or wallet → KMS key id');
    }
    return KmsKeySource.create(await kms(), map as Record<string, string>);
  }
  if (env['SIGNER_KEYSTORE_JSON']) return new EnvKeystoreSource(env, testnet);
  // Raw keys are permitted on a testnet only, and the constructor enforces it.
  return new RawKeySource(env, testnet);
}

/**
 * The keeper's or the renewer's account: `<NAME>_KMS_KEY_ID` on any chain,
 * `<NAME>_PRIVATE_KEY` on a testnet only, neither → not running.
 */
export async function serviceAccount(
  name: 'KEEPER' | 'SESSION_MANAGER' | 'SESSION_OWNER',
  env: NodeJS.ProcessEnv,
  testnet: boolean,
  kms: () => Promise<KmsClient>,
): Promise<LocalAccount | undefined> {
  const keyId = env[`${name}_KMS_KEY_ID`];
  const raw = env[`${name}_PRIVATE_KEY`];
  if (keyId && raw) throw new Error(`${name}_KMS_KEY_ID and ${name}_PRIVATE_KEY are both set; set one`);
  if (keyId) return kmsAccount(await kms(), keyId);
  if (!raw) return undefined;
  if (!testnet)
    throw new Error(
      `${name}_PRIVATE_KEY is a raw key; raw keys are for testnet only — use ${name}_KMS_KEY_ID`,
    );
  return privateKeyToAccount(raw as `0x${string}`);
}

/**
 * The renewer's account: the hosted accounts' session manager (audit F1). It
 * used to be their owner and was named `SESSION_OWNER_*`; that name is still
 * read, flagged deprecated, so an existing server keeps renewing.
 */
export async function sessionManagerAccount(
  env: NodeJS.ProcessEnv,
  testnet: boolean,
  kms: () => Promise<KmsClient>,
): Promise<{account: LocalAccount; deprecatedName: boolean} | undefined> {
  const named = (n: string) => Boolean(env[`${n}_KMS_KEY_ID`] || env[`${n}_PRIVATE_KEY`]);
  if (named('SESSION_MANAGER') && named('SESSION_OWNER')) {
    throw new Error(
      'SESSION_MANAGER_* and SESSION_OWNER_* are both set; SESSION_OWNER_* is the old name — keep one',
    );
  }
  const current = await serviceAccount('SESSION_MANAGER', env, testnet, kms);
  if (current) return {account: current, deprecatedName: false};
  const old = await serviceAccount('SESSION_OWNER', env, testnet, kms);
  return old ? {account: old, deprecatedName: true} : undefined;
}
