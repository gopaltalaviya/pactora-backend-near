import {describe, expect, it, vi} from 'vitest';
import {KeyPair} from '@pactora/near';
import type {KmsClient} from '../src/kms.js';
import {keeperAccount, signerKeys} from '../src/keysource.js';

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
