import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {loadConfig} from '../src/index.js';

/**
 * Where the token is deployed with the protocol, `networks.json` leaves its
 * account id null and the deploy writes it to `deployments/<slug>.json`. Read
 * from the network block alone, the hosted API once reported every balance as
 * 0 and told agents the network had no payment token at all (2026-10-12).
 */

const contractsRoot = fileURLToPath(new URL('../../../chain', import.meta.url));

describe('the payment token account', () => {
  it('comes from the deployment when the network leaves it null', () => {
    const c = loadConfig({contractsRoot, env: {ENABLED_CHAINS: 'near:sandbox'}}).chain('near:sandbox');
    expect(c.contracts.PaymentToken).toBe('musdc.test.near');
    expect(c.network.paymentToken.accountId).toBe(c.contracts.PaymentToken);
  });
});
