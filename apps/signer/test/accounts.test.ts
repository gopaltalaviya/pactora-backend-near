import {describe, expect, it} from 'vitest';
import type {Hex} from 'viem';
import {WalletVerifier, assertRpcChain, cloneCodeOf, delegationOf, type CodeReader} from '../src/accounts.js';

/**
 * Which wallets are ours, by code (audit H3). The signer and the renewer act
 * for an "AgentAccount" only when this says so; a contract that merely
 * answers the account's view functions is `foreign`.
 */

const FACTORY = '0x' + 'fa'.repeat(20);
const IMPL = '0x' + '1a'.repeat(20);
const DELEGATE = '0x' + 'de'.repeat(20);

function reader(code: Record<string, string>, opts: {implementation?: () => Promise<string>} = {}) {
  const calls = {getCode: 0, implementation: 0};
  const pub: CodeReader = {
    getCode: async ({address}) => {
      calls.getCode++;
      return (code[address.toLowerCase()] ?? '0x') as Hex;
    },
    readContract: async () => {
      calls.implementation++;
      return opts.implementation ? opts.implementation() : IMPL;
    },
  };
  return {pub, calls};
}

describe('what a wallet is', () => {
  const A = '0x' + '0a'.repeat(20);

  it('is an account when its code is a clone of the factory implementation', async () => {
    const {pub} = reader({[A]: cloneCodeOf(IMPL)});
    expect(await new WalletVerifier(pub, {factory: FACTORY}).kindOf(A)).toBe('account');
  });

  it('is an account when it is an EOA delegated to AgentDelegate', async () => {
    const {pub} = reader({[A]: delegationOf(DELEGATE)});
    expect(await new WalletVerifier(pub, {delegate: DELEGATE}).kindOf(A)).toBe('account');
  });

  it('is an EOA when it has no code', async () => {
    const {pub} = reader({});
    expect(await new WalletVerifier(pub, {factory: FACTORY}).kindOf(A)).toBe('eoa');
  });

  it('is foreign for any other code — including another factory’s clone', async () => {
    const {pub} = reader({[A]: cloneCodeOf('0x' + '99'.repeat(20))});
    expect(await new WalletVerifier(pub, {factory: FACTORY, delegate: DELEGATE}).kindOf(A)).toBe('foreign');
  });

  it('keeps a clone verdict, and reads the factory once', async () => {
    const {pub, calls} = reader({[A]: cloneCodeOf(IMPL)});
    let t = 0;
    const v = new WalletVerifier(pub, {factory: FACTORY}, () => t);
    await v.kindOf(A);
    t = 10 * 60_000;
    await v.kindOf(A);
    expect(calls).toEqual({getCode: 1, implementation: 1});
  });

  it('re-reads a wallet that may change: an EOA can be delegated, a delegate re-pointed', async () => {
    const code: Record<string, string> = {};
    const {pub} = reader(code);
    let t = 0;
    const v = new WalletVerifier(pub, {factory: FACTORY, delegate: DELEGATE}, () => t);
    expect(await v.kindOf(A)).toBe('eoa');
    code[A] = delegationOf('0x' + '66'.repeat(20));
    t = 61_000;
    expect(await v.kindOf(A)).toBe('foreign');
  });

  it('does not condemn every account because the factory could not be read once', async () => {
    let fail = true;
    const {pub} = reader(
      {[A]: cloneCodeOf(IMPL)},
      {
        implementation: async () => {
          if (fail) throw new Error('fetch failed');
          return IMPL;
        },
      },
    );
    const v = new WalletVerifier(pub, {factory: FACTORY});
    await expect(v.kindOf(A)).rejects.toThrow(/fetch failed/);
    fail = false;
    expect(await v.kindOf(A)).toBe('account');
  });
});

describe('the RPC at boot', () => {
  const chain = {chainId: 10143, name: 'Monad Testnet'} as never;

  it('refuses an RPC that serves another chain', async () => {
    await expect(assertRpcChain({getChainId: async () => 143}, chain)).rejects.toThrow(/serves chain 143/);
  });

  it('accepts the configured chain', async () => {
    await expect(assertRpcChain({getChainId: async () => 10143}, chain)).resolves.toBeUndefined();
  });
});
