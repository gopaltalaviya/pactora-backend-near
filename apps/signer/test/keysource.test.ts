import {secp256k1} from '@noble/curves/secp256k1';
import {privateKeyToAccount} from 'viem/accounts';
import {describe, expect, it, vi} from 'vitest';
import type {KmsClient} from '../src/kms.js';
import {serviceAccount, sessionManagerAccount, signerKeys} from '../src/keysource.js';
import {makeKeystore} from './helpers/keystore.js';

const KEY_A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const KEY_B = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const ADDR_A = privateKeyToAccount(KEY_A).address;
const SPKI_PREFIX = '3056301006072a8648ce3d020106052b8104000a034200';

/** A KMS holding KEY_A under every key id. */
const kms = vi.fn(async (): Promise<KmsClient> => ({
  async getPublicKey() {
    const pub = secp256k1.getPublicKey(KEY_A.slice(2), false);
    return Uint8Array.from(Buffer.concat([Buffer.from(SPKI_PREFIX, 'hex'), Buffer.from(pub)]));
  },
  async sign(_id, digest) {
    return secp256k1.sign(digest, KEY_A.slice(2)).toDERRawBytes();
  },
}));

describe('signerKeys', () => {
  it('uses the KMS on a mainnet', async () => {
    const keys = await signerKeys({SIGNER_KMS_KEYS: JSON.stringify({'5': 'alias/agent-5'})}, false, kms);
    expect(keys.kind).toBe('aws-kms');
    expect((await keys.accountFor(5))?.address).toBe(ADDR_A);
  });

  it('refuses two key sources at once', async () => {
    const env = {SIGNER_KMS_KEYS: '{}', SIGNER_KEYSTORE_JSON: '{}'};
    await expect(signerKeys(env, true, kms)).rejects.toThrow(/both set/);
  });

  it('refuses a KMS map that is not id → key id', async () => {
    await expect(signerKeys({SIGNER_KMS_KEYS: 'alias/x'}, false, kms)).rejects.toThrow(/not JSON/);
    await expect(signerKeys({SIGNER_KMS_KEYS: '["a"]'}, false, kms)).rejects.toThrow(/object/);
  });

  it('falls back to the keystore, then to raw keys on a testnet', async () => {
    const pass = 'p';
    const ks = await signerKeys(
      {
        SIGNER_KEYSTORE_JSON: JSON.stringify({'1': makeKeystore(KEY_B, pass)}),
        SIGNER_KEYSTORE_PASSPHRASE: pass,
      },
      false,
      kms,
    );
    expect(ks.kind).toBe('env-keystore');
    expect((await signerKeys({SIGNER_DEV_PRIVATE_KEY: KEY_B}, true, kms)).kind).toBe('raw-key-dev-only');
  });

  it('refuses raw keys on a mainnet', async () => {
    await expect(signerKeys({SIGNER_DEV_PRIVATE_KEY: KEY_B}, false, kms)).rejects.toThrow(/non-testnet/);
  });
});

describe('serviceAccount (keeper, renewer)', () => {
  it('runs from a KMS key on a mainnet', async () => {
    const account = await serviceAccount('KEEPER', {KEEPER_KMS_KEY_ID: 'alias/keeper'}, false, kms);
    expect(account?.address).toBe(ADDR_A);
  });

  it('refuses a raw key on a mainnet, and names the KMS variable', async () => {
    await expect(
      serviceAccount('SESSION_OWNER', {SESSION_OWNER_PRIVATE_KEY: KEY_B}, false, kms),
    ).rejects.toThrow(/SESSION_OWNER_KMS_KEY_ID/);
  });

  it('accepts a raw key on a testnet', async () => {
    const account = await serviceAccount('KEEPER', {KEEPER_PRIVATE_KEY: KEY_B}, true, kms);
    expect(account?.address).toBe(privateKeyToAccount(KEY_B).address);
  });

  it('is off when neither is set, and refuses both', async () => {
    expect(await serviceAccount('KEEPER', {}, false, kms)).toBeUndefined();
    await expect(
      serviceAccount('KEEPER', {KEEPER_KMS_KEY_ID: 'k', KEEPER_PRIVATE_KEY: KEY_B}, true, kms),
    ).rejects.toThrow(/both set/);
  });
});

/**
 * Audit F1: the renewer is the hosted accounts' session MANAGER, not their
 * owner, and its key is named for what it is. The old name still works, with
 * a warning, so an existing server is not left without renewals.
 */
describe('the session manager key', () => {
  it('is SESSION_MANAGER_*', async () => {
    const r = await sessionManagerAccount({SESSION_MANAGER_KMS_KEY_ID: 'alias/manager'}, false, kms);
    expect(r?.account.address).toBe(ADDR_A);
    expect(r?.deprecatedName).toBe(false);
  });

  it('still reads the old SESSION_OWNER_* name, and says it is deprecated', async () => {
    const r = await sessionManagerAccount({SESSION_OWNER_PRIVATE_KEY: KEY_B}, true, kms);
    expect(r?.account.address).toBe(privateKeyToAccount(KEY_B).address);
    expect(r?.deprecatedName).toBe(true);
  });

  it('refuses both names at once', async () => {
    await expect(
      sessionManagerAccount(
        {SESSION_MANAGER_PRIVATE_KEY: KEY_A, SESSION_OWNER_PRIVATE_KEY: KEY_B},
        true,
        kms,
      ),
    ).rejects.toThrow(/SESSION_MANAGER.*SESSION_OWNER|both/);
  });

  it('is off when neither is set', async () => {
    expect(await sessionManagerAccount({}, false, kms)).toBeUndefined();
  });
});
