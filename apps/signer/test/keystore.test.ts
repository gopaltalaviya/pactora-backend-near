import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {KeyPair, PublicKey} from '@pactora/near';
import {
  DbKeyStore,
  EnvCredentialsSource,
  Keys,
  decryptSecret,
  encryptSecret,
  parseCredential,
  type KeySource,
} from '../src/keystore.js';

/**
 * Where the signer's keys live. Generated keys are encrypted in Postgres
 * (`signer_keys`) under a passphrase that is only in the signer's
 * environment; testnet development keys may come from env as near-cli
 * credential JSON.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near_signer';
const PASS = 'p'.repeat(40);
/** A cheap KDF: a test has no attacker to slow down. */
const FAST = {N: 2 ** 10, r: 8, p: 1};
const WALLET = 'bot.alice.testnet';

let db: Db;
beforeAll(() => {
  db = createDb(DB_URL, {max: 5});
});
afterAll(() => closeDb(db));
beforeEach(async () => {
  await db.execute(sql`TRUNCATE signer_keys RESTART IDENTITY`);
});

const credentialOf = (account: string, kp = KeyPair.fromRandom('ed25519')) => ({
  account_id: account,
  public_key: kp.getPublicKey().toString(),
  private_key: kp.toString(),
});

describe('the near-cli credential format', () => {
  it('reads account_id, public_key and an ed25519 private_key', () => {
    const kp = KeyPair.fromRandom('ed25519');
    const {accountId, keyPair} = parseCredential(credentialOf(WALLET, kp));
    expect(accountId).toBe(WALLET);
    expect(keyPair.getPublicKey().toString()).toBe(kp.getPublicKey().toString());
  });

  it('refuses a public_key that is not the private key’s', () => {
    const c = {...credentialOf(WALLET), public_key: KeyPair.fromRandom('ed25519').getPublicKey().toString()};
    expect(() => parseCredential(c)).toThrow(/does not match/);
  });

  it('refuses a secp256k1 key and a malformed one, without echoing it', () => {
    expect(() => parseCredential({account_id: WALLET, private_key: 'secp256k1:abc'})).toThrow(/ed25519/);
    let message = '';
    try {
      parseCredential({account_id: WALLET, private_key: 'ed25519:not-a-key-SECRETVALUE'});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/not a valid ed25519 key/);
    expect(message).not.toContain('SECRETVALUE');
  });

  it('refuses an account id NEAR would not accept', () => {
    expect(() => parseCredential(credentialOf('Not_An.Account!'))).toThrow(/not an account id/);
  });
});

describe('testnet development credentials from env', () => {
  it('selects by account, from one credential or a list', async () => {
    const a = credentialOf('a.testnet');
    const b = credentialOf('b.testnet');
    const one = new EnvCredentialsSource({SIGNER_DEV_CREDENTIALS: JSON.stringify(a)}, true);
    expect((await one.keyFor('a.testnet'))?.publicKey).toBe(a.public_key);
    const two = new EnvCredentialsSource({SIGNER_DEV_CREDENTIALS: JSON.stringify([a, b])}, true);
    expect((await two.keyFor('b.testnet'))?.publicKey).toBe(b.public_key);
    expect(await two.keyFor('c.testnet')).toBeNull();
    expect(await two.accounts()).toEqual(['a.testnet', 'b.testnet']);
  });

  it('refuses raw keys off testnet', () => {
    expect(
      () => new EnvCredentialsSource({SIGNER_DEV_CREDENTIALS: JSON.stringify(credentialOf('a.near'))}, false),
    ).toThrow(/testnet only/);
  });
});

describe('sealing a key', () => {
  it('round-trips, and fails loudly on a wrong passphrase', async () => {
    const sealed = await encryptSecret('secret', PASS, 'aad', FAST);
    expect(await decryptSecret(sealed, PASS, 'aad')).toBe('secret');
    await expect(decryptSecret(sealed, 'q'.repeat(40), 'aad')).rejects.toThrow(/does not decrypt/);
  });

  /** A ciphertext copied onto another row must not sign as that row's account. */
  it('is bound to its row: another account’s identity does not decrypt it', async () => {
    const sealed = await encryptSecret('secret', PASS, 'pactora-signer-key|near:testnet|a.testnet|pk', FAST);
    await expect(
      decryptSecret(sealed, PASS, 'pactora-signer-key|near:testnet|b.testnet|pk'),
    ).rejects.toThrow();
  });

  /**
   * Audit I2. The KDF cost is read from the row. A row altered to N = 2^30
   * would make the signer derive for minutes (and allocate gigabytes); a tag
   * shortened to 4 bytes would be accepted as a 4-byte tag.
   */
  it('refuses a KDF cost above 2^17, or one that is not scrypt’s shape', async () => {
    const sealed = await encryptSecret('secret', PASS, 'aad', FAST);
    const [format, , ...rest] = sealed.split('.');
    const withCost = (cost: string) => [format, cost, ...rest].join('.');
    await expect(decryptSecret(withCost(`${2 ** 18},8,1`), PASS, 'aad')).rejects.toThrow(/KDF cost/);
    await expect(decryptSecret(withCost('1000,8,1'), PASS, 'aad')).rejects.toThrow(/KDF cost/);
    await expect(decryptSecret(withCost('x,8,1'), PASS, 'aad')).rejects.toThrow(/KDF cost/);
    await expect(decryptSecret(withCost(`${2 ** 10},64,1`), PASS, 'aad')).rejects.toThrow(/KDF cost/);
    await expect(decryptSecret(withCost(`${2 ** 17},8,1`), 'q'.repeat(40), 'aad')).rejects.toThrow(
      /does not decrypt/,
    );
  });

  it('accepts only a full 16-byte authentication tag', async () => {
    const sealed = await encryptSecret('secret', PASS, 'aad', FAST);
    const parts = sealed.split('.');
    const tag = Buffer.from(parts[4]!, 'base64');
    expect(tag).toHaveLength(16);
    parts[4] = tag.subarray(0, 4).toString('base64');
    await expect(decryptSecret(parts.join('.'), PASS, 'aad')).rejects.toThrow();
  });
});

describe('the database key store', () => {
  const store = () => new DbKeyStore(db, 'near:testnet', PASS, FAST);

  it('creates a key once, and answers the same public key after', async () => {
    const first = await store().ensure(WALLET);
    expect(first.created).toBe(true);
    expect(() => PublicKey.from(first.publicKey)).not.toThrow();
    const again = await store().ensure(WALLET);
    expect(again).toEqual({publicKey: first.publicKey, created: false});
  });

  it('gives concurrent creators — two replicas — one key', async () => {
    const results = await Promise.all(Array.from({length: 5}, () => store().ensure(WALLET)));
    expect(new Set(results.map((r) => r.publicKey)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM signer_keys`)) as unknown as {
      n: number;
    }[];
    expect(rows[0]!.n).toBe(1);
  });

  /** The window between looking and inserting: another replica inserts first, and its key wins. */
  it('when another replica inserts between the lookup and the insert, answers that replica’s key', async () => {
    const winner = await store().ensure(WALLET);
    const late = store();
    const internals = late as unknown as {row: (a: string) => Promise<unknown>};
    const real = internals.row.bind(late);
    let first = true;
    internals.row = async (a: string) => {
      if (first) {
        first = false;
        return undefined; // it looked before the other replica's insert landed
      }
      return real(a);
    };
    expect(await late.ensure(WALLET)).toEqual({publicKey: winner.publicKey, created: false});
  });

  it('signs with the stored key, from a fresh process', async () => {
    const {publicKey} = await store().ensure(WALLET);
    const key = await store().keyFor(WALLET);
    expect(key?.publicKey).toBe(publicKey);
    const msg = new Uint8Array(32).fill(3);
    expect(PublicKey.from(publicKey).verify(msg, await key!.sign(msg))).toBe(true);
  });

  it('stores no plaintext secret, and does not decrypt with another passphrase', async () => {
    await store().ensure(WALLET);
    const [row] = (await db.execute(sql`SELECT ciphertext FROM signer_keys`)) as unknown as {
      ciphertext: string;
    }[];
    expect(row!.ciphertext).not.toMatch(/ed25519:|private_key/);
    await expect(new DbKeyStore(db, 'near:testnet', 'x'.repeat(40), FAST).keyFor(WALLET)).rejects.toThrow(
      /does not decrypt/,
    );
  });

  it('keeps chains apart', async () => {
    await store().ensure(WALLET);
    expect(await new DbKeyStore(db, 'near:sandbox', PASS, FAST).keyFor(WALLET)).toBeNull();
  });

  it('refuses a short passphrase and an account id NEAR would not accept', async () => {
    expect(() => new DbKeyStore(db, 'near:testnet', 'short')).toThrow(/at least 32/);
    await expect(store().ensure('NOT VALID')).rejects.toThrow(/not a NEAR account id/);
  });

  /**
   * Audit M1. A key is handed out BEFORE its account exists (the owner
   * creates the account with it, NEAR-WIRE §5 step 2), so a made-up account
   * leaves a row. Those are not permanent: after the grace period, a key
   * whose account never appeared on chain and that no agent row names is
   * removed. A key whose account exists is kept, registered or not.
   */
  it('sweeps keys whose account never appeared on chain, after the grace period', async () => {
    const s = store();
    await s.ensure('never-made.testnet');
    await s.ensure('exists-unregistered.testnet');
    await s.ensure('registered.testnet');
    await s.ensure('fresh.testnet');
    await db.execute(
      sql`UPDATE signer_keys SET created_at = now() - interval '2 days' WHERE account_id <> 'fresh.testnet'`,
    );
    await db.execute(
      sql`INSERT INTO agents (chain_id, chain_agent_id, owner_address, wallet_address, name, price_per_task)
          VALUES ('near:testnet', '1', 'o.testnet', 'registered.testnet', 'R', 1)`,
    );
    const asked: string[] = [];
    const near = {
      balance: async (a: string) => {
        asked.push(a);
        return a === 'exists-unregistered.testnet' ? 10n ** 24n : null;
      },
    };
    const swept = await s.sweepUnclaimed(near, {graceMs: 24 * 3600_000});
    expect(swept).toEqual(['never-made.testnet']);
    // The chain is asked only about aged rows with no agent row.
    expect(asked.sort()).toEqual(['exists-unregistered.testnet', 'never-made.testnet']);
    expect((await s.accounts()).sort()).toEqual([
      'exists-unregistered.testnet',
      'fresh.testnet',
      'registered.testnet',
    ]);
    await db.execute(sql`DELETE FROM agents WHERE wallet_address = 'registered.testnet'`);
  });

  it('keeps every row when the chain cannot be asked', async () => {
    const s = store();
    await s.ensure('maybe.testnet');
    await db.execute(sql`UPDATE signer_keys SET created_at = now() - interval '2 days'`);
    const near = {
      balance: async () => {
        throw new Error('rpc down');
      },
    };
    expect(await s.sweepUnclaimed(near, {graceMs: 1000})).toEqual([]);
    expect(await s.accounts()).toEqual(['maybe.testnet']);
  });
});

describe('imported keys before the store', () => {
  it('answers /keys with an imported key rather than creating a second one', async () => {
    const imported: KeySource = {
      kind: 'imported',
      keyFor: async (a) =>
        a === WALLET ? {publicKey: 'ed25519:IMPORTED', sign: async () => new Uint8Array()} : null,
      accounts: async () => [WALLET],
    };
    const keys = new Keys(imported, new DbKeyStore(db, 'near:testnet', PASS, FAST));
    expect(await keys.ensure(WALLET)).toEqual({publicKey: 'ed25519:IMPORTED', created: false});
    const created = await keys.ensure('other.testnet');
    expect(created.created).toBe(true);
    expect((await keys.accounts()).sort()).toEqual(['bot.alice.testnet', 'other.testnet']);
  });

  it('cannot create keys without a store', async () => {
    await expect(new Keys(null, null).ensure(WALLET)).rejects.toThrow(/no key store/);
  });
});
