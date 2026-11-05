import {describe, expect, it} from 'vitest';
import {assertNoLegacyEnv, legacyEnvProblems} from '../src/legacy-env.js';

describe('legacyEnvProblems', () => {
  it('maps each AGENTX_* name to its PACTORA_* replacement', () => {
    expect(legacyEnvProblems({AGENTX_CHAIN_ID: '10143', PATH: '/bin'})).toEqual([
      'AGENTX_CHAIN_ID was renamed PACTORA_CHAIN_ID on 2026-11-01 — rename it in your environment',
    ]);
  });

  it('is empty for an environment with only new names', () => {
    expect(legacyEnvProblems({PACTORA_CHAIN_ID: '10143'})).toEqual([]);
  });

  it('throws one error listing all of them', () => {
    expect(() => assertNoLegacyEnv({AGENTX_API_URL: 'x', AGENTX_API_KEY: ''})).toThrow(
      /AGENTX_API_KEY[\s\S]*AGENTX_API_URL/,
    );
    expect(() => assertNoLegacyEnv({})).not.toThrow();
  });
});

describe('EVM-era network variables (NEAR port, docs/NEAR-PORT.md §1)', () => {
  it('names the replacement for each numeric-chain variable', () => {
    expect(
      legacyEnvProblems({ENABLED_CHAIN_IDS: '10143', DEFAULT_CHAIN_ID: '10143', RPC_URL_10143: 'https://x'}),
    ).toEqual([
      'DEFAULT_CHAIN_ID is from the EVM build — use DEFAULT_CHAIN (a CAIP-2 id such as near:testnet)',
      'ENABLED_CHAIN_IDS is from the EVM build — use ENABLED_CHAINS (CAIP-2 ids such as near:testnet)',
      'RPC_URL_10143 is from the EVM build — use RPC_URL_<SLUG>, e.g. RPC_URL_TESTNET',
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
