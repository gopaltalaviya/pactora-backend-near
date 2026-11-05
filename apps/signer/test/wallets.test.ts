import {describe, expect, it} from 'vitest';
import {WalletWatch} from '../src/wallets.js';

/**
 * NEAR balances of the accounts the signer sends from. A drained wallet or
 * keeper fails a run at the worst moment; the watch reads balances in the
 * background, so `/health` (a liveness check) never waits on an RPC.
 */
const A = 'agent-a.owner.testnet';
const B = 'keeper.testnet';
const NEAR = 10n ** 24n;

const nearWith = (balances: Record<string, bigint | null>, fail = false) => ({
  balance: async (account: string) => {
    if (fail) throw new Error('rpc down');
    return account in balances ? balances[account]! : 0n;
  },
});

describe('WalletWatch', () => {
  it('flags the accounts below the threshold and keeps the rest, in yocto', async () => {
    const watch = new WalletWatch({
      near: nearWith({[A]: NEAR / 2n, [B]: NEAR / 100n}),
      wallets: () => [
        {account: A, role: 'signing-key'},
        {account: B, role: 'keeper'},
      ],
      lowYocto: NEAR / 10n,
    });
    await watch.check();
    const snap = watch.snapshot();
    expect(snap.checkedAt).not.toBeNull();
    expect(snap.wallets).toEqual([
      {account: A, role: 'signing-key', balanceYocto: '500000000000000000000000', low: false},
      {account: B, role: 'keeper', balanceYocto: '10000000000000000000000', low: true},
    ]);
    expect(snap.anyLow).toBe(true);
  });

  it('reports nothing measured before the first check, not a healthy all-clear', () => {
    const watch = new WalletWatch({
      near: nearWith({}),
      wallets: () => [{account: A, role: 'keeper'}],
      lowYocto: 1n,
    });
    expect(watch.snapshot()).toMatchObject({checkedAt: null, anyLow: false, wallets: []});
  });

  it('keeps the last good reading when the RPC fails, and says when it was', async () => {
    let fail = false;
    const near = {
      balance: async () => {
        if (fail) throw new Error('rpc down');
        return NEAR;
      },
    };
    const watch = new WalletWatch({near, wallets: () => [{account: A, role: 'keeper'}], lowYocto: 1n});
    await watch.check();
    const first = watch.snapshot().checkedAt;
    fail = true;
    await watch.check();
    expect(watch.snapshot().checkedAt).toBe(first);
    expect(watch.snapshot().wallets).toHaveLength(1);
  });

  it('flags an account that does not exist as low, with no balance', async () => {
    const watch = new WalletWatch({
      near: nearWith({[A]: null}),
      wallets: () => [{account: A, role: 'signing-key'}],
      lowYocto: 1n,
    });
    await watch.check();
    expect(watch.snapshot().wallets).toEqual([
      {account: A, role: 'signing-key', balanceYocto: null, low: true},
    ]);
  });

  it('reads the list of accounts on every check, so keys created later are watched', async () => {
    const list = [{account: A, role: 'signing-key'}];
    const watch = new WalletWatch({
      near: nearWith({[A]: NEAR, [B]: NEAR}),
      wallets: () => list,
      lowYocto: 1n,
    });
    await watch.check();
    list.push({account: B, role: 'signing-key'});
    await watch.check();
    expect(watch.snapshot().wallets.map((w) => w.account)).toEqual([A, B]);
  });

  it('sets a gauge per account, in NEAR, when given one', async () => {
    const set: [Record<string, string>, number][] = [];
    const gauge = {labels: (l: Record<string, string>) => ({set: (v: number) => set.push([l, v])})};
    const watch = new WalletWatch({
      near: nearWith({[A]: 3n * NEAR}),
      wallets: () => [{account: A, role: 'signing-key'}],
      lowYocto: 1n,
      gauge: gauge as never,
    });
    await watch.check();
    expect(set).toEqual([[{address: A, role: 'signing-key'}, 3]]);
  });
});
