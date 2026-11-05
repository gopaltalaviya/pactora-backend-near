import {createCipheriv, createDecipheriv, randomBytes, scryptSync} from 'node:crypto';
import {and, eq} from 'drizzle-orm';
import {KeyPair, keyPairKey, type TxKey} from '@pactora/near';
import {type Db, signerKeys} from '@pactora/db';
import {ACCOUNT_ID_RE, ErrorCode, PactoraError} from '@pactora/shared';

/**
 * Where the signer's keys come from, behind one interface.
 *
 * On NEAR an agent's wallet is an account holding a FUNCTION-CALL key scoped
 * to the Pactora contract (docs/NEAR-PORT.md §5): the owner adds it with
 * `AddKey`, after the signer generated it (`POST /keys`). The key can call the
 * contract and nothing else, and cannot attach a deposit. What it can move is
 * bounded by the contract's purse caps, on chain.
 *
 * Keys are looked up by the wallet ACCOUNT, which is what the chain checks
 * (`predecessor_account_id`), never by our database id.
 */
export interface KeySource {
  readonly kind: string;
  /** The key this source holds for `accountId`, or null. */
  keyFor(accountId: string): Promise<TxKey | null>;
  /** Every account this source holds a key for (for `/health`). */
  accounts(): Promise<string[]>;
}

/** A source that can also create keys: `POST /keys`. */
export interface KeyStore extends KeySource {
  /** The account's key, created when missing. Idempotent and race-free. */
  ensure(accountId: string): Promise<{publicKey: string; created: boolean}>;
}

// ── the near-cli credential format ───────────────────────────────────────

/**
 * As near-cli writes it to `~/.near-credentials/<network>/<account>.json`.
 * This is also the plaintext the key store encrypts, so a key can be moved
 * between the two without conversion.
 */
export interface NearCredential {
  account_id: string;
  public_key: string;
  private_key: string;
}

export function isAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && ACCOUNT_ID_RE.test(id);
}

/** Parse and check a credential: an ed25519 key whose public half is the one it claims. */
export function parseCredential(raw: unknown): {accountId: string; keyPair: KeyPair} {
  const c = raw as Partial<NearCredential> | null;
  if (!c || typeof c !== 'object' || typeof c.account_id !== 'string' || typeof c.private_key !== 'string') {
    throw new Error('not a NEAR credential: expected {account_id, public_key, private_key}');
  }
  if (!isAccountId(c.account_id))
    throw new Error(`credential account_id "${c.account_id}" is not an account id`);
  if (!c.private_key.startsWith('ed25519:')) {
    throw new Error(`credential for ${c.account_id}: only ed25519 keys are used (private_key "ed25519:...")`);
  }
  let keyPair: KeyPair;
  try {
    keyPair = KeyPair.fromString(c.private_key as `ed25519:${string}`);
  } catch {
    // Never echo the value: it is the secret.
    throw new Error(`credential for ${c.account_id}: private_key is not a valid ed25519 key`);
  }
  if (c.public_key !== undefined && c.public_key !== keyPair.getPublicKey().toString()) {
    throw new Error(`credential for ${c.account_id}: public_key does not match private_key`);
  }
  return {accountId: c.account_id, keyPair};
}

// ── testnet development keys from env ────────────────────────────────────

/**
 * `SIGNER_DEV_CREDENTIALS`: one near-cli credential object, or an array of
 * them. Raw keys in the environment — testnet only, refused anywhere else.
 */
export class EnvCredentialsSource implements KeySource {
  readonly kind = 'dev-credentials-testnet-only';
  private readonly byAccount = new Map<string, TxKey>();

  constructor(env: NodeJS.ProcessEnv, testnet: boolean) {
    const raw = env['SIGNER_DEV_CREDENTIALS'];
    if (!raw) return;
    if (!testnet) {
      throw new Error(
        'SIGNER_DEV_CREDENTIALS is set on a chain that is not a testnet; raw keys are for testnet only',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        'SIGNER_DEV_CREDENTIALS is not JSON: expected a near-cli credential or an array of them',
      );
    }
    for (const c of Array.isArray(parsed) ? parsed : [parsed]) {
      const {accountId, keyPair} = parseCredential(c);
      this.byAccount.set(accountId, keyPairKey(keyPair));
    }
  }

  async keyFor(accountId: string): Promise<TxKey | null> {
    return this.byAccount.get(accountId) ?? null;
  }

  async accounts(): Promise<string[]> {
    return [...this.byAccount.keys()];
  }

  get size(): number {
    return this.byAccount.size;
  }
}

// ── encryption at rest ───────────────────────────────────────────────────

/**
 * AES-256-GCM under a key scrypt-derived from the passphrase with a fresh
 * salt per row. The row's identity (chain, account, public key) is the
 * additional authenticated data, so a ciphertext copied onto another row
 * fails to decrypt instead of signing as the wrong account.
 */
const FORMAT = 'v1';
export interface KdfCost {
  N: number;
  r: number;
  p: number;
}
/** ~50 ms per derivation; derived once per key per process (keys are cached). */
export const DEFAULT_KDF: KdfCost = {N: 2 ** 15, r: 8, p: 1};

function derive(passphrase: string, salt: Buffer, cost: KdfCost): Buffer {
  return scryptSync(passphrase, salt, 32, {...cost, maxmem: 256 * cost.N * cost.r + 1024 * 1024});
}

export function encryptSecret(
  plaintext: string,
  passphrase: string,
  aad: string,
  cost = DEFAULT_KDF,
): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(passphrase, salt, cost), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const parts = [salt, iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64'));
  return [FORMAT, `${cost.N},${cost.r},${cost.p}`, ...parts].join('.');
}

export function decryptSecret(sealed: string, passphrase: string, aad: string): string {
  const [format, costText, salt, iv, tag, ct] = sealed.split('.');
  if (format !== FORMAT || !costText || !salt || !iv || !tag || ct === undefined) {
    throw new Error('not a sealed signer key');
  }
  const [N, r, p] = costText.split(',').map(Number) as [number, number, number];
  const decipher = createDecipheriv(
    'aes-256-gcm',
    derive(passphrase, Buffer.from(salt, 'base64'), {N, r, p}),
    Buffer.from(iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // A wrong passphrase must fail loudly, never yield a plausible wrong key.
    throw new Error('signer key does not decrypt: wrong SIGNER_KEY_PASSPHRASE, or the row was altered');
  }
}

// ── the key store ────────────────────────────────────────────────────────

/**
 * Generated keys, one per wallet account per chain, in `signer_keys`.
 *
 * Why the database and not a directory of credential files: the signer may
 * run as more than one replica, and "create if missing" must give every
 * replica the SAME key — a unique index does that, a filesystem per replica
 * does not. Railway's filesystem is also not durable across deploys, and a
 * lost key strands the wallet until its owner adds a new one. Why it is
 * still safe: the database holds only ciphertext; the passphrase is in the
 * signer's environment and nowhere else, so a leaked dump yields no key.
 * Plaintext keys exist only in this process's memory, and are never logged.
 */
export class DbKeyStore implements KeyStore {
  readonly kind = 'db-keystore';
  private readonly cache = new Map<string, TxKey>();

  constructor(
    private readonly db: Db,
    private readonly chainId: string,
    private readonly passphrase: string,
    private readonly cost: KdfCost = DEFAULT_KDF,
  ) {
    if (passphrase.length < 32) throw new Error('SIGNER_KEY_PASSPHRASE must be at least 32 characters');
  }

  private aad(accountId: string, publicKey: string): string {
    return `pactora-signer-key|${this.chainId}|${accountId}|${publicKey}`;
  }

  private async row(accountId: string) {
    return this.db.query.signerKeys.findFirst({
      where: and(eq(signerKeys.chainId, this.chainId), eq(signerKeys.accountId, accountId)),
    });
  }

  async keyFor(accountId: string): Promise<TxKey | null> {
    const cached = this.cache.get(accountId);
    if (cached) return cached;
    const row = await this.row(accountId);
    if (!row) return null;
    const plain = decryptSecret(row.ciphertext, this.passphrase, this.aad(row.accountId, row.publicKey));
    const {accountId: inside, keyPair} = parseCredential(JSON.parse(plain));
    if (inside !== accountId || keyPair.getPublicKey().toString() !== row.publicKey) {
      throw new Error(`signer_keys row for ${accountId} does not hold the key it names`);
    }
    const key = keyPairKey(keyPair);
    this.cache.set(accountId, key);
    return key;
  }

  async ensure(accountId: string): Promise<{publicKey: string; created: boolean}> {
    if (!isAccountId(accountId)) {
      throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, `"${accountId}" is not a NEAR account id`);
    }
    const existing = await this.row(accountId);
    if (existing) return {publicKey: existing.publicKey, created: false};

    const keyPair = KeyPair.fromRandom('ed25519');
    const publicKey = keyPair.getPublicKey().toString();
    const credential: NearCredential = {
      account_id: accountId,
      public_key: publicKey,
      private_key: keyPair.toString(),
    };
    const ciphertext = encryptSecret(
      JSON.stringify(credential),
      this.passphrase,
      this.aad(accountId, publicKey),
      this.cost,
    );
    const [inserted] = await this.db
      .insert(signerKeys)
      .values({chainId: this.chainId, accountId, publicKey, ciphertext})
      .onConflictDoNothing()
      .returning({publicKey: signerKeys.publicKey});
    if (inserted) {
      this.cache.set(accountId, keyPairKey(keyPair));
      return {publicKey: inserted.publicKey, created: true};
    }
    // Another request (or replica) created it first: theirs is the key.
    const winner = await this.row(accountId);
    if (!winner) throw new Error(`signer_keys: lost the race for ${accountId} but found no row`);
    return {publicKey: winner.publicKey, created: false};
  }

  async accounts(): Promise<string[]> {
    const rows = await this.db
      .select({accountId: signerKeys.accountId})
      .from(signerKeys)
      .where(eq(signerKeys.chainId, this.chainId));
    return rows.map((r) => r.accountId);
  }
}

/**
 * Imported keys (KMS, or testnet dev credentials) first, then the store.
 * `/keys` answers with an imported key when one exists, so the store never
 * creates a second key for an account that already has one here.
 */
export class Keys implements KeyStore {
  readonly kind: string;

  constructor(
    private readonly imported: KeySource | null,
    private readonly store: KeyStore | null,
  ) {
    this.kind = [imported?.kind, store?.kind].filter(Boolean).join('+') || 'none';
  }

  async keyFor(accountId: string): Promise<TxKey | null> {
    return (await this.imported?.keyFor(accountId)) ?? (await this.store?.keyFor(accountId)) ?? null;
  }

  async ensure(accountId: string): Promise<{publicKey: string; created: boolean}> {
    const held = await this.imported?.keyFor(accountId);
    if (held) return {publicKey: held.publicKey, created: false};
    if (!this.store) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        'this signer has no key store (SIGNER_KEY_PASSPHRASE is not set), so it cannot create keys',
      );
    }
    return this.store.ensure(accountId);
  }

  async accounts(): Promise<string[]> {
    const all = [...((await this.imported?.accounts()) ?? []), ...((await this.store?.accounts()) ?? [])];
    return [...new Set(all)];
  }
}
