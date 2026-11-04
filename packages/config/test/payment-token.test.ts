import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {loadConfig} from '../src/index.js';

/**
 * Where the token is deployed with the protocol, `networks.json` leaves its
 * address null and the deploy writes it to `deployments/<chainId>.json`. Read
 * from the network block alone, the hosted API reported every balance as 0
 * and told agents the network had no payment token at all (2026-10-12).
 */

const contractsRoot = fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url));

describe('the payment token address', () => {
  for (const chainId of [31337, 10143]) {
    it(`comes from the deployment when the network leaves it null (chain ${chainId})`, () => {
      const c = loadConfig({
        contractsRoot,
        env: {ENABLED_CHAIN_IDS: String(chainId), DEFAULT_CHAIN_ID: String(chainId)},
      }).chain(chainId);
      expect(c.contracts['PaymentToken']).toBeTruthy();
      expect(c.network.paymentToken.address).toBe(c.contracts['PaymentToken']);
    });
  }
});
