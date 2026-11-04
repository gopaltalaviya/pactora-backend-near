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
