import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {loadConfig} from '../src/index.js';

// An unsupported variable in a `.env` (such as DEFAULT_CHAIN_ID, a numeric
// network id) would otherwise boot on the defaults and fail somewhere else,
// later, with a confusing error.
const contractsRoot = fileURLToPath(new URL('../../../chain', import.meta.url));
const base = {ENABLED_CHAINS: 'near:sandbox'};

describe('an unsupported variable refuses to start', () => {
  it('names the replacement', () => {
    expect(() => loadConfig({contractsRoot, env: {...base, DEFAULT_CHAIN_ID: '1'}})).toThrow(
      /DEFAULT_CHAIN_ID.*unsupported.*DEFAULT_CHAIN/,
    );
  });

  it('lists every stale variable at once, even an empty one', () => {
    let message = '';
    try {
      loadConfig({contractsRoot, env: {...base, ENABLED_CHAIN_IDS: '1', RPC_URL_1: ''}});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/ENABLED_CHAIN_IDS.*ENABLED_CHAINS/);
    expect(message).toMatch(/RPC_URL_1.*RPC_URL_<SLUG>/);
  });

  it('still loads when only the new names are set', () => {
    const config = loadConfig({contractsRoot, env: {...base, PACTORA_CONTRACTS_ROOT: contractsRoot}});
    expect(config.defaultChainId).toBe('near:sandbox');
  });
});
