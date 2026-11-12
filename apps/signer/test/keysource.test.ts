import {describe, expect, it, vi} from 'vitest';
import {KeyPair} from '@pactora/near';
import type {KmsClient} from '../src/kms.js';
import {keeperAccount, minterAccount, signerKeys} from '../src/keysource.js';

/** Which keys the signer runs on, decided once at boot from the environment. */

const KP = KeyPair.fromRandom('ed25519');
const SPKI = new Uint8Array([...Buffer.from('302a300506032b6570032100', 'hex'), ...KP.getPublicKey().data]);

/** A KMS holding KP under every key id. */
const kms = vi.fn(async (): Promise<KmsClient> => ({
  getPublicKey: async () => SPKI,
  sign: async (_id, message) => KP.sign(message).signature,
}));

/** The store is never queried in these tests; a database is not needed. */
const db = undefined as never;
const PASS = 'p'.repeat(40);
const cred = (account: string, kp = KP) =>
  JSON.stringify({account_id: account, public_key: kp.getPublicKey().toString(), private_key: kp.toString()});

describe('signerKeys', () => {
  it('uses the KMS, on any chain', async () => {
    const keys = await signerKeys({
      env: {SIGNER_KMS_KEYS: JSON.stringify({'bot.alice.near': 'alias/agent-5'})},
      testnet: false,
      chainId: 'near:mainnet',
      db,
      kms,
    });
    expect(keys.kind).toBe('aws-kms');
    expect((await keys.keyFor('bot.alice.near'))?.publicKey).toBe(KP.getPublicKey().toString());
  });

  it('refuses two imported sources at once', async () => {
    await expect(
      signerKeys({
        env: {SIGNER_KMS_KEYS: '{}', SIGNER_DEV_CREDENTIALS: cred('a.testnet')},
        testnet: true,
        chainId: 'near:testnet',
        db,
        kms,
      }),
    ).rejects.toThrow(/both set/);
  });

  it('refuses a KMS map that is not account → key id', async () => {
    for (const bad of ['not json', '["k1"]', '{"a.testnet": 5}']) {
      await expect(
        signerKeys({env: {SIGNER_KMS_KEYS: bad}, testnet: true, chainId: 'near:testnet', db, kms}),
      ).rejects.toThrow(/SIGNER_KMS_KEYS/);
    }
  });

  it('takes dev credentials on a testnet, and refuses them anywhere else', async () => {
    const keys = await signerKeys({
      env: {SIGNER_DEV_CREDENTIALS: cred('a.testnet')},
      testnet: true,
      chainId: 'near:testnet',
      db,
      kms,
    });
    expect(keys.kind).toBe('dev-credentials-testnet-only');
    await expect(
      signerKeys({
        env: {SIGNER_DEV_CREDENTIALS: cred('a.near')},
        testnet: false,
        chainId: 'near:mainnet',
        db,
        kms,
      }),
    ).rejects.toThrow(/testnet only/);
  });

  it('adds the encrypted store when a passphrase is set', async () => {
    const keys = await signerKeys({
      env: {SIGNER_KEY_PASSPHRASE: PASS, SIGNER_DEV_CREDENTIALS: cred('a.testnet')},
      testnet: true,
      chainId: 'near:testnet',
      db,
      kms,
    });
    expect(keys.kind).toBe('dev-credentials-testnet-only+db-keystore');
  });

  it('refuses a short passphrase at boot', async () => {
    await expect(
      signerKeys({env: {SIGNER_KEY_PASSPHRASE: 'short'}, testnet: true, chainId: 'near:testnet', db, kms}),
    ).rejects.toThrow(/at least 32/);
  });
});

describe('the keeper account', () => {
  it('is off when nothing is set', async () => {
    expect(await keeperAccount({}, true, kms)).toBeUndefined();
  });

  it('takes an ed25519 secret key on a testnet', async () => {
    const k = await keeperAccount(
      {KEEPER_ACCOUNT_ID: 'keeper.testnet', KEEPER_SECRET_KEY: KP.toString()},
      true,
      kms,
    );
    expect(k?.accountId).toBe('keeper.testnet');
    expect(k?.key.publicKey).toBe(KP.getPublicKey().toString());
  });

  it('refuses a raw key off testnet, and names the KMS variable', async () => {
    await expect(
      keeperAccount({KEEPER_ACCOUNT_ID: 'keeper.near', KEEPER_SECRET_KEY: KP.toString()}, false, kms),
    ).rejects.toThrow(/KEEPER_KMS_KEY_ID/);
  });

  it('runs from a KMS key on any chain', async () => {
    const k = await keeperAccount(
      {KEEPER_ACCOUNT_ID: 'keeper.near', KEEPER_KMS_KEY_ID: 'alias/keeper'},
      false,
      kms,
    );
    expect(k?.key.publicKey).toBe(KP.getPublicKey().toString());
  });

  it('refuses a key without an account, both keys at once, and a malformed key', async () => {
    await expect(keeperAccount({KEEPER_SECRET_KEY: KP.toString()}, true, kms)).rejects.toThrow(
      /KEEPER_ACCOUNT_ID/,
    );
    await expect(
      keeperAccount(
        {KEEPER_ACCOUNT_ID: 'k.testnet', KEEPER_SECRET_KEY: KP.toString(), KEEPER_KMS_KEY_ID: 'x'},
        true,
        kms,
      ),
    ).rejects.toThrow(/both set/);
    await expect(
      keeperAccount({KEEPER_ACCOUNT_ID: 'k.testnet', KEEPER_SECRET_KEY: 'ed25519:1111'}, true, kms),
    ).rejects.toThrow(/not a valid/);
    await expect(keeperAccount({KEEPER_ACCOUNT_ID: 'k.testnet'}, true, kms)).rejects.toThrow(/neither/);
  });
});

describe('the credential minter account', () => {
  it('is off when nothing is set', () => {
    expect(minterAccount({}, true)).toBeUndefined();
  });

  it('takes an ed25519 secret key on a testnet', () => {
    const m = minterAccount({MINTER_ACCOUNT_ID: 'minter.testnet', MINTER_SECRET_KEY: KP.toString()}, true);
    expect(m?.accountId).toBe('minter.testnet');
    expect(m?.key.publicKey).toBe(KP.getPublicKey().toString());
  });

  it('refuses to run on a chain that is not a testnet', () => {
    expect(() =>
      minterAccount({MINTER_ACCOUNT_ID: 'minter.near', MINTER_SECRET_KEY: KP.toString()}, false),
    ).toThrow(/not a testnet/);
  });

  it('needs both the account and the key, a NEAR account id, and a well-formed ed25519 key', () => {
    expect(() => minterAccount({MINTER_SECRET_KEY: KP.toString()}, true)).toThrow(/MINTER_ACCOUNT_ID/);
    expect(() => minterAccount({MINTER_ACCOUNT_ID: 'minter.testnet'}, true)).toThrow(/MINTER_SECRET_KEY/);
    expect(() =>
      minterAccount({MINTER_ACCOUNT_ID: 'Not An Account', MINTER_SECRET_KEY: KP.toString()}, true),
    ).toThrow(/not a NEAR account id/);
    expect(() =>
      minterAccount({MINTER_ACCOUNT_ID: 'minter.testnet', MINTER_SECRET_KEY: 'secp256k1:abc'}, true),
    ).toThrow(/ed25519/);
    expect(() =>
      minterAccount({MINTER_ACCOUNT_ID: 'minter.testnet', MINTER_SECRET_KEY: 'ed25519:1111'}, true),
    ).toThrow(/not a valid/);
  });

  it('refuses to share an account with the faucet or the keeper: one key, two nonce counters', () => {
    const minter = {MINTER_ACCOUNT_ID: 'ops.testnet', MINTER_SECRET_KEY: KP.toString()};
    expect(() => minterAccount({...minter, FAUCET_ACCOUNT_ID: 'ops.testnet'}, true)).toThrow(
      /MINTER_ACCOUNT_ID must not be FAUCET_ACCOUNT_ID/,
    );
    expect(() => minterAccount({...minter, KEEPER_ACCOUNT_ID: 'ops.testnet'}, true)).toThrow(
      /MINTER_ACCOUNT_ID must not be KEEPER_ACCOUNT_ID/,
    );
    expect(
      minterAccount(
        {...minter, FAUCET_ACCOUNT_ID: 'faucet.testnet', KEEPER_ACCOUNT_ID: 'keeper.testnet'},
        true,
      )?.accountId,
    ).toBe('ops.testnet');
  });
});
