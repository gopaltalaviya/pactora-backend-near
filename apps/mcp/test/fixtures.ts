import type {NetworkInfo} from '@pactora/sdk';

/**
 * Shared fixture.
 *
 * Deliberately NOT in a `.test.ts` file: importing one to borrow a constant
 * runs its suite a second time inside the importing file, which inflates the
 * count and hides which file actually failed.
 */
export const TESTNET: NetworkInfo = {
  chainId: 10143,
  name: 'Monad Testnet',
  shortName: 'monad-testnet',
  testnet: true,
  nativeCurrency: {name: 'Monad', symbol: 'MON', decimals: 18},
  paymentToken: {symbol: 'USDC', decimals: 6, address: '0x' + '33'.repeat(20)},
  contracts: {TaskEscrow: '0x' + '44'.repeat(20)},
  erc8004: {},
  explorerBaseUrl: 'https://testnet.monadexplorer.com',
  faucetUrls: [],
  confirmations: 3,
  windows: {accept: 300, work: 900, review: 1800},
  fastPathMax: '30000',
  fastPathMaxDisplay: '0.03 USDC',
  protocolFeeBps: 100,
  enabledChains: [10143],
};
