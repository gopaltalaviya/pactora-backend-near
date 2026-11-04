import {privateKeyToAccount} from 'viem/accounts';
import {describe, expect, it} from 'vitest';
import {EnvKeystoreSource, RawKeySource} from '../src/keystore.js';
import {makeKeystore} from './helpers/keystore.js';

const KEY_A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const KEY_B = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const PASS = 'correct horse battery staple';

describe('EnvKeystoreSource', () => {
  it('decrypts one key per agent and selects by id or wallet', async () => {
    const env = {
      SIGNER_KEYSTORE_JSON: JSON.stringify({'3': makeKeystore(KEY_A, PASS), '4': makeKeystore(KEY_B, PASS)}),
      SIGNER_KEYSTORE_PASSPHRASE: PASS,
    };
    const keys = new EnvKeystoreSource(env, false);
    expect((await keys.accountFor(3))?.address).toBe(privateKeyToAccount(KEY_A).address);
    const b = privateKeyToAccount(KEY_B).address;
    expect((await keys.accountFor(9, b.toLowerCase()))?.address).toBe(b);
  });

  it('accepts one key for every agent on a testnet', async () => {
    const env = {
      SIGNER_KEYSTORE_JSON: JSON.stringify(makeKeystore(KEY_A, PASS)),
      SIGNER_KEYSTORE_PASSPHRASE: PASS,
    };
    const keys = new EnvKeystoreSource(env, true);
    expect((await keys.accountFor(77))?.address).toBe(privateKeyToAccount(KEY_A).address);
  });

  /**
   * One key for every agent makes one compromise total. The comment said
   * "on mainnet each agent should hold its own"; nothing enforced it.
   */
  it('refuses one key for every agent off testnet', () => {
    const env = {
      SIGNER_KEYSTORE_JSON: JSON.stringify(makeKeystore(KEY_A, PASS)),
      SIGNER_KEYSTORE_PASSPHRASE: PASS,
    };
    expect(() => new EnvKeystoreSource(env, false)).toThrow(/one key per agent/);
  });

  it('fails loudly on a wrong passphrase', () => {
    const env = {
      SIGNER_KEYSTORE_JSON: JSON.stringify({'1': makeKeystore(KEY_A, PASS)}),
      SIGNER_KEYSTORE_PASSPHRASE: 'no',
    };
    expect(() => new EnvKeystoreSource(env, false)).toThrow(/MAC mismatch/);
  });
});

describe('RawKeySource', () => {
  it('refuses raw keys off testnet', () => {
    expect(() => new RawKeySource({SIGNER_DEV_PRIVATE_KEY: KEY_A}, false)).toThrow(/non-testnet/);
  });
});
