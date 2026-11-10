import {describe, expect, it} from 'vitest';
import {assertNoLegacyEnv, legacyEnvProblems} from '../src/legacy-env.js';

describe('legacyEnvProblems', () => {
  it('is empty for an environment with only supported names', () => {
    expect(legacyEnvProblems({PACTORA_API_URL: 'http://x', PATH: '/bin'})).toEqual([]);
  });

  it('throws one error listing all of them, even an empty one', () => {
    expect(() => assertNoLegacyEnv({ENABLED_CHAIN_IDS: '1', DEFAULT_CHAIN_ID: ''})).toThrow(
      /DEFAULT_CHAIN_ID[\s\S]*ENABLED_CHAIN_IDS/,
    );
    expect(() => assertNoLegacyEnv({})).not.toThrow();
  });
});

describe('numeric-network variables (docs/NEAR-PORT.md §1)', () => {
  it('names the replacement for each numeric-chain variable', () => {
    expect(
      legacyEnvProblems({ENABLED_CHAIN_IDS: '1', DEFAULT_CHAIN_ID: '1', RPC_URL_1: 'https://x'}),
    ).toEqual([
      'DEFAULT_CHAIN_ID is an unsupported variable — use DEFAULT_CHAIN (a CAIP-2 id such as near:testnet)',
      'ENABLED_CHAIN_IDS is an unsupported variable — use ENABLED_CHAINS (CAIP-2 ids such as near:testnet)',
      'RPC_URL_1 is an unsupported variable — use RPC_URL_<SLUG>, e.g. RPC_URL_TESTNET',
    ]);
  });

  it('leaves the NEAR names alone', () => {
    expect(
      legacyEnvProblems({
        ENABLED_CHAINS: 'near:testnet',
        DEFAULT_CHAIN: 'near:testnet',
        RPC_URL_TESTNET: 'x',
      }),
    ).toEqual([]);
  });
});
