import {describe, expect, it} from 'vitest';
import {assertNoUnsupportedEnv, unsupportedEnvProblems} from '../src/unsupported-env.js';

describe('unsupportedEnvProblems', () => {
  it('is empty for an environment with only supported names', () => {
    expect(unsupportedEnvProblems({PACTORA_API_URL: 'http://x', PATH: '/bin'})).toEqual([]);
  });

  it('throws one error listing all of them, even an empty one', () => {
    expect(() => assertNoUnsupportedEnv({ENABLED_CHAIN_IDS: '1', DEFAULT_CHAIN_ID: ''})).toThrow(
      /DEFAULT_CHAIN_ID[\s\S]*ENABLED_CHAIN_IDS/,
    );
    expect(() => assertNoUnsupportedEnv({})).not.toThrow();
  });
});

describe('numeric-network variables (docs/NEAR-WIRE.md §1)', () => {
  it('names the replacement for each numeric-chain variable', () => {
    expect(
      unsupportedEnvProblems({ENABLED_CHAIN_IDS: '1', DEFAULT_CHAIN_ID: '1', RPC_URL_1: 'https://x'}),
    ).toEqual([
      'DEFAULT_CHAIN_ID is an unsupported variable — use DEFAULT_CHAIN (a CAIP-2 id such as near:testnet)',
      'ENABLED_CHAIN_IDS is an unsupported variable — use ENABLED_CHAINS (CAIP-2 ids such as near:testnet)',
      'RPC_URL_1 is an unsupported variable — use RPC_URL_<SLUG>, e.g. RPC_URL_TESTNET',
    ]);
  });

  it('leaves the NEAR names alone', () => {
    expect(
      unsupportedEnvProblems({
        ENABLED_CHAINS: 'near:testnet',
        DEFAULT_CHAIN: 'near:testnet',
        RPC_URL_TESTNET: 'x',
      }),
    ).toEqual([]);
  });
});
