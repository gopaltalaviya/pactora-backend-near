import type {NetworkInfo} from '@pactora/sdk';

/**
 * Shared fixture.
 *
 * Deliberately NOT in a `.test.ts` file: importing one to borrow a constant
 * runs its suite a second time inside the importing file, which inflates the
 * count and hides which file actually failed.
 */
export const TESTNET: NetworkInfo = {
  chainId: 'near:testnet',
  nearNetworkId: 'testnet',
  name: 'NEAR Testnet',
  shortName: 'near-testnet',
  testnet: true,
  nativeCurrency: {name: 'NEAR', symbol: 'NEAR', decimals: 24},
  paymentToken: {symbol: 'mUSDC', decimals: 6, accountId: 'musdc.pactora.testnet'},
  contracts: {
    Pactora: 'pactora.testnet',
    PaymentToken: 'musdc.pactora.testnet',
    Arbiter: 'arbiter.sputnikv2.testnet',
  },
  rpcUrls: ['https://rpc.testnet.near.org'],
  explorerBaseUrl: 'https://testnet.nearblocks.io',
  faucetUrls: [],
  windows: {accept: 300, work: 900, review: 1800, dispute: 3600},
  fastPathMax: '30000',
  fastPathMaxDisplay: '0.03 mUSDC',
  protocolFeeBps: 100,
  enabledChains: ['near:testnet'],
};
