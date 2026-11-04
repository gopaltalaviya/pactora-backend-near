import {describe, expect, it} from 'vitest';
import {WalletWatch} from '../src/wallets.js';

/**
 * Gas balances (v3). docs/17 had "wallet balance monitoring: none; checked by
 * hand before demos" — and a drained FUNDER or keeper fails a run with a
 * bare revert. The watch reads balances in the background, so `/health` (a
 * liveness check) never waits on an RPC.
 */
const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);

const pubWith = (balances: Record<string, bigint>, fail = false) => ({
  getBalance: async ({address}: {address: string}) => {
    if (fail) throw new Error('rpc down');
    return balances[address.toLowerCase()] ?? 0n;
  },
});

describe('WalletWatch', () => {
  it('flags the wallets below the threshold and keeps the rest', async () => {
    const watch = new WalletWatch({
      pub: pubWith({[A]: 5n * 10n ** 17n, [B]: 10n ** 16n}),
      wallets: [
        {address: A, role: 'signing-key'},
        {address: B, role: 'keeper'},
      ],
      lowWei: 2n * 10n ** 17n,
    });
    await watch.check();
    const snap = watch.snapshot();
    expect(snap.checkedAt).not.toBeNull();
    expect(snap.wallets).toEqual([
      {address: A, role: 'signing-key', balanceWei: '500000000000000000', low: false},
      {address: B, role: 'keeper', balanceWei: '10000000000000000', low: true},
    ]);
    expect(snap.anyLow).toBe(true);
  });

  it('reports nothing measured before the first check, not a healthy all-clear', () => {
    const watch = new WalletWatch({pub: pubWith({}), wallets: [{address: A, role: 'keeper'}], lowWei: 1n});
    expect(watch.snapshot()).toMatchObject({checkedAt: null, anyLow: false, wallets: []});
  });

  it('keeps the last good reading when the RPC fails, and says when it was', async () => {
    let fail = false;
    const pub = {
      getBalance: async () => {
        if (fail) throw new Error('rpc down');
        return 10n ** 18n;
      },
    };
    const watch = new WalletWatch({pub, wallets: [{address: A, role: 'keeper'}], lowWei: 1n});
    await watch.check();
    const first = watch.snapshot().checkedAt;
    fail = true;
    await watch.check();
    expect(watch.snapshot().checkedAt).toBe(first);
    expect(watch.snapshot().wallets).toHaveLength(1);
  });

  it('sets a gauge per wallet when given one', async () => {
    const set: [Record<string, string>, number][] = [];
    const gauge = {labels: (l: Record<string, string>) => ({set: (v: number) => set.push([l, v])})};
    const watch = new WalletWatch({
      pub: pubWith({[A]: 3n * 10n ** 18n}),
      wallets: [{address: A, role: 'signing-key'}],
      lowWei: 1n,
      gauge: gauge as never,
    });
    await watch.check();
    expect(set).toEqual([[{address: A, role: 'signing-key'}, 3]]);
  });
});
