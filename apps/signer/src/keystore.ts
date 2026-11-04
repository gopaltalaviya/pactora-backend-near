import {createDecipheriv, pbkdf2Sync, scryptSync} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {keccak256, type Account} from 'viem';

/**
 * Key loading, behind an interface so the storage choice is replaceable.
 *
 * Decision C1 (2026-09-23): an encrypted Web3 Secret Storage keystore held in
 * an env var, decrypted here with a passphrase from a separate env var.
 * Honest rather than ideal — both halves live in the same Railway project, so
 * a full compromise of that project yields the key.
 *
 * That is survivable only because it is not the last line of defence: the
 * on-chain AgentAccount caps bound the damage to one day's spend, to
 * allowlisted counterparties, and the owner can revoke and sweep. This is
 * written down in the submission's trust assumptions rather than omitted.
 *
 * `KmsSigner` slots in behind the same interface with no call-site changes.
 */
export interface KeySource {
  /** The signing account for an agent, or null if this source has no key for it. */
  /**
   * The key for this agent.
   *
   * `wallet` is the address the agent is REGISTERED to on chain, and the
   * chain compares it to `msg.sender`. A source holding more than one key
   * selects on it; a single-key source may ignore it, and the signer then
   * refuses any mismatch rather than broadcasting a certain revert.
   */
  accountFor(agentId: number, wallet?: string): Promise<Account | null>;
  /**
   * Every key this source holds. An agent whose wallet is an AgentAccount is
   * signed for by a SESSION key the account has granted — an address that is
   * not the wallet — so the signer asks the account which of these it trusts.
   */
  all?(): Account[];
  readonly kind: string;
}

/** Web3 Secret Storage v3, the format `cast wallet import` and geth produce. */
interface KeystoreV3 {
  version: 3;
  crypto: {
    cipher: string;
    ciphertext: string;
    cipherparams: {iv: string};
    kdf: 'scrypt' | 'pbkdf2';
    kdfparams: Record<string, unknown>;
    mac: string;
  };
}

export function decryptKeystore(keystore: KeystoreV3, passphrase: string): `0x${string}` {
  const {crypto: c} = keystore;
  if (keystore.version !== 3) throw new Error(`unsupported keystore version ${String(keystore.version)}`);

  const pass = Buffer.from(passphrase, 'utf8');
  let derived: Buffer;

  if (c.kdf === 'scrypt') {
    const p = c.kdfparams as {salt: string; n: number; r: number; p: number; dklen: number};
    derived = scryptSync(pass, Buffer.from(p.salt, 'hex'), p.dklen, {
      N: p.n,
      r: p.r,
      p: p.p,
      // scrypt with N=262144 needs far more than node's 32MB default.
      maxmem: 1024 * 1024 * 1024,
    });
  } else {
    const p = c.kdfparams as {salt: string; c: number; dklen: number; prf: string};
    derived = pbkdf2Sync(pass, Buffer.from(p.salt, 'hex'), p.c, p.dklen, 'sha256');
  }

  const ciphertext = Buffer.from(c.ciphertext, 'hex');

  // Verify the MAC BEFORE decrypting. A wrong passphrase must fail loudly
  // here rather than yield a plausible-looking but wrong key, which would
  // silently sign from an address nobody funded.
  //
  // Keccak-256, NOT node's 'sha3-256'. They are different functions on the
  // same sponge and produce different digests; using the latter rejects every
  // valid keystore.
  const mac = keccak256(`0x${Buffer.concat([derived.subarray(16, 32), ciphertext]).toString('hex')}`).slice(
    2,
  );

  if (mac !== c.mac.toLowerCase()) throw new Error('keystore MAC mismatch — wrong passphrase');

  const decipher = createDecipheriv(
    c.cipher === 'aes-128-ctr' ? 'aes-128-ctr' : c.cipher,
    derived.subarray(0, 16),
    Buffer.from(c.cipherparams.iv, 'hex'),
  );
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return `0x${key.toString('hex')}`;
}

/**
 * Keys from environment.
 *
 * `SIGNER_KEYSTORE_JSON` holds a v3 keystore (or a map of agentId → keystore),
 * `SIGNER_KEYSTORE_PASSPHRASE` the passphrase. Decrypted once at boot and held
 * in memory — never written to disk, never logged, never returned by an API.
 */
export class EnvKeystoreSource implements KeySource {
  readonly kind = 'env-keystore';
  private readonly accounts = new Map<number, Account>();
  private fallback: Account | null = null;

  /** @param testnet one key for every agent is accepted on a testnet only */
  constructor(env: NodeJS.ProcessEnv = process.env, testnet = false) {
    const raw = env['SIGNER_KEYSTORE_JSON'];
    const passphrase = env['SIGNER_KEYSTORE_PASSPHRASE'];
    if (!raw) return;
    if (!passphrase) throw new Error('SIGNER_KEYSTORE_JSON is set but SIGNER_KEYSTORE_PASSPHRASE is not');

    const parsed = JSON.parse(raw) as KeystoreV3 | Record<string, KeystoreV3>;

    if (isKeystore(parsed)) {
      // One key serving every agent. Acceptable on testnet; elsewhere each
      // agent holds its own, so one compromise is not total.
      if (!testnet) {
        throw new Error(
          'SIGNER_KEYSTORE_JSON holds one key for every agent; off testnet it must map one key per agent',
        );
      }
      this.fallback = privateKeyToAccount(decryptKeystore(parsed, passphrase));
      return;
    }

    for (const [agentId, keystore] of Object.entries(parsed)) {
      this.accounts.set(Number(agentId), privateKeyToAccount(decryptKeystore(keystore, passphrase)));
    }
  }

  async accountFor(agentId: number, wallet?: string): Promise<Account | null> {
    const byId = this.accounts.get(agentId);
    if (byId) return byId;
    if (wallet) {
      // Keystores are commonly keyed by address rather than by our database
      // id, and the address is the thing the chain actually checks.
      for (const account of this.accounts.values()) {
        if (account.address.toLowerCase() === wallet.toLowerCase()) return account;
      }
    }
    return this.fallback;
  }

  all(): Account[] {
    return [...this.accounts.values(), ...(this.fallback ? [this.fallback] : [])];
  }

  get agentCount(): number {
    return this.accounts.size || (this.fallback ? 1 : 0);
  }
}

function isKeystore(value: KeystoreV3 | Record<string, KeystoreV3>): value is KeystoreV3 {
  return (value as KeystoreV3).version === 3;
}

/**
 * Local development only: raw keys from env, never permitted on mainnet.
 *
 * `SIGNER_DEV_PRIVATE_KEYS` takes a comma-separated list and selects by the
 * agent's registered wallet address. One key for every agent looks like it
 * works right up to the first call the chain checks `msg.sender` on — every
 * accept and every result submission — and then reverts with a custom error
 * that reads as "unknown reason". Distinct agents need distinct keys.
 *
 * `SIGNER_DEV_PRIVATE_KEY` (singular) is still accepted for a single-agent
 * setup, and is used when no listed key matches.
 */
export class RawKeySource implements KeySource {
  readonly kind = 'raw-key-dev-only';
  private readonly byAddress = new Map<string, Account>();
  private readonly fallback: Account | null;

  constructor(env: NodeJS.ProcessEnv = process.env, allowed = false) {
    const single = env['SIGNER_DEV_PRIVATE_KEY'];
    const many = env['SIGNER_DEV_PRIVATE_KEYS'];

    if ((single || many) && !allowed) {
      throw new Error(
        'SIGNER_DEV_PRIVATE_KEY(S) is set on a non-testnet chain. Raw keys are for local development only.',
      );
    }

    for (const key of (many ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)) {
      const account = privateKeyToAccount(key as `0x${string}`);
      this.byAddress.set(account.address.toLowerCase(), account);
    }

    this.fallback = single ? privateKeyToAccount(single as `0x${string}`) : null;
    if (this.fallback) this.byAddress.set(this.fallback.address.toLowerCase(), this.fallback);
  }

  async accountFor(_agentId: number, wallet?: string): Promise<Account | null> {
    if (wallet) {
      const match = this.byAddress.get(wallet.toLowerCase());
      if (match) return match;
    }
    return this.fallback;
  }

  all(): Account[] {
    return [...this.byAddress.values()];
  }

  get keyCount(): number {
    return this.byAddress.size;
  }
}
