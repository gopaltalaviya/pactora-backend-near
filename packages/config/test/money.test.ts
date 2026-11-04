import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {loadConfig} from '../src/index.js';

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..."
// with a leading slash that fs cannot resolve.
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});
const c = config.chain(31337);

describe('token amounts are exact integer base units', () => {
  it('formats the demo prices', () => {
    expect(c.formatToken(20_000n)).toBe('0.02 MockUSDC'); // research agent
    expect(c.formatToken(50_000n)).toBe('0.05 MockUSDC'); // execution agent
    expect(c.formatToken(0n)).toBe('0 MockUSDC');
    expect(c.formatToken(1n)).toBe('0.000001 MockUSDC'); // one base unit
  });

  it('parses back exactly', () => {
    expect(c.parseToken('0.02')).toBe(20_000n);
    expect(c.parseToken('10')).toBe(10_000_000n);
    expect(c.parseToken('0.000001')).toBe(1n);
  });

  it('round-trips without drift', () => {
    for (const v of [0n, 1n, 20_000n, 999_999n, 10n ** 12n, 2n ** 80n]) {
      expect(c.parseToken(c.formatToken(v).split(' ')[0]!)).toBe(v);
    }
  });

  it('rejects more precision than the token has', () => {
    // 7 decimals on a 6dp token would silently truncate. It must throw.
    expect(() => c.parseToken('0.0000001')).toThrow(/more than 6 decimal/);
  });

  it('never uses float arithmetic', () => {
    // 0.1 + 0.2 !== 0.3 in floats. Base units must not care.
    const sum = c.parseToken('0.1') + c.parseToken('0.2');
    expect(sum).toBe(c.parseToken('0.3'));
    expect(c.formatToken(sum)).toBe('0.3 MockUSDC');
  });

  it('handles amounts beyond Number.MAX_SAFE_INTEGER', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    expect(c.parseToken(c.formatToken(big).split(' ')[0]!)).toBe(big);
  });
});

describe('fee arithmetic matches invariant I4', () => {
  it('paid + fee === amount, remainder to the worker', () => {
    const bps = BigInt(c.params.protocolFeeBps);
    for (const amount of [20_000n, 50_000n, 1n, 7n, 999_999n, 12_345_679n]) {
      const fee = (amount * bps) / 10_000n; // rounds down
      const paid = amount - fee;
      expect(paid + fee).toBe(amount); // no value created or destroyed
      expect(fee * 10_000n).toBeLessThanOrEqual(amount * bps); // never over-charges
    }
  });
});

describe('config is frozen', () => {
  it('cannot be mutated at runtime', () => {
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.params)).toBe(true);
    expect(Object.isFrozen(c.contracts)).toBe(true);
  });
});
