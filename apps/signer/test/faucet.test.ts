import {describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '@pactora/config';
import {KeyPair, keyPairKey} from '@pactora/near';
import {assertFaucetNotOwner} from '../src/faucet.js';

/**
 * Audit L5. The faucet must never hold the payment token owner's key (it
 * could mint without limit). The check read the token's `owner` and, when
 * the RPC failed, skipped the guard and started anyway.
 */
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});
const CHAIN = config.chain('near:sandbox');
const faucet = {accountId: 'faucet.test.near', key: keyPairKey(KeyPair.fromRandom('ed25519'))};

const nearAnswering = (owner: string | Error) => ({
  view: async <T>(): Promise<T> => {
    if (owner instanceof Error) throw owner;
    return owner as T;
  },
});

describe('the faucet owner guard', () => {
  it('passes a separate account', async () => {
    await expect(
      assertFaucetNotOwner(nearAnswering('treasury.test.near'), CHAIN, faucet),
    ).resolves.toBeUndefined();
  });

  it("refuses the token owner's account", async () => {
    await expect(assertFaucetNotOwner(nearAnswering(faucet.accountId), CHAIN, faucet)).rejects.toThrow(
      /payment token's owner/,
    );
  });

  it('refuses to start when the owner cannot be read, instead of skipping the guard', async () => {
    await expect(
      assertFaucetNotOwner(nearAnswering(new Error('fetch failed')), CHAIN, faucet),
    ).rejects.toThrow(/could not read the payment token's owner.*refusing to start/);
  });
});
