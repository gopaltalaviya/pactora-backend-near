import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {loadConfig} from '../src/index.js';

// The env vars were renamed AGENTX_* → PACTORA_* on 2026-11-01. A hosted
// `.env` that still says AGENTX_CONTRACTS_ROOT would otherwise boot on the
// default path and fail somewhere else, later, with a confusing error.
const contractsRoot = fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url));
const base = {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'};

describe('a pre-rename AGENTX_* variable refuses to start', () => {
  it('names the PACTORA_* replacement', () => {
    expect(() => loadConfig({contractsRoot, env: {...base, AGENTX_CONTRACTS_ROOT: contractsRoot}})).toThrow(
      /AGENTX_CONTRACTS_ROOT.*renamed.*PACTORA_CONTRACTS_ROOT/,
    );
  });

  it('lists every stale variable at once, even an empty one', () => {
    let message = '';
    try {
      loadConfig({contractsRoot, env: {...base, AGENTX_API_KEY: 'ax_x', AGENTX_SELF_URL: ''}});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/AGENTX_API_KEY.*PACTORA_API_KEY/);
    expect(message).toMatch(/AGENTX_SELF_URL.*PACTORA_SELF_URL/);
  });

  it('still loads when only the new names are set', () => {
    const config = loadConfig({contractsRoot, env: {...base, PACTORA_CONTRACTS_ROOT: contractsRoot}});
    expect(config.defaultChainId).toBe(31337);
  });
});
