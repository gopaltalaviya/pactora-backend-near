import {describe, expect, it} from 'vitest';
import {blockRpc, nearClient, neardataSource, rpcSource} from '../src/index.js';

/**
 * Read-only checks against the real NEAR testnet: a fake that agrees with my
 * assumptions proves nothing. No keys, no transactions, no money.
 *
 *   NEAR_LIVE=1 pnpm vitest run packages/near/test/live.test.ts
 */
const LIVE = process.env['NEAR_LIVE'] === '1';
const RPC = process.env['RPC_URL_TESTNET'] ?? 'https://rpc.testnet.near.org';

describe.skipIf(!LIVE)('NEAR testnet, live (read-only)', () => {
  const client = nearClient(RPC);

  it('is the testnet', async () => {
    expect(await client.networkId()).toBe('testnet');
  });

  it('calls a view method (the Sputnik DAO v2 factory)', async () => {
    const daos = await client.view<string[]>('sputnikv2.testnet', 'get_dao_list', {});
    expect(Array.isArray(daos)).toBe(true);
    expect(daos.length).toBeGreaterThan(0);
  }, 30_000);

  it('reads balances, and null for an account that does not exist', async () => {
    expect(await client.balance('sputnikv2.testnet')).toBeGreaterThan(0n);
    expect(await client.balance('no-such-account-pactora-0000.testnet')).toBeNull();
  });

  it('answers null for a key the account does not have', async () => {
    expect(
      await client.accessKey('sputnikv2.testnet', 'ed25519:11111111111111111111111111111111'),
    ).toBeNull();
  });

  it('reads a final block, and neardata serves the same height', async () => {
    const b = await client.finalBlock();
    expect(b.height).toBeGreaterThan(0);
    const nd = neardataSource('https://testnet.neardata.xyz');
    const read = await nd.blockAt(b.height);
    expect(read?.hash).toBe(b.hash);
  }, 30_000);

  it('finds the same receipts through neardata and through RPC polling', async () => {
    const nd = neardataSource('https://testnet.neardata.xyz');
    const rpc = rpcSource(blockRpc(RPC));
    const head = await rpc.finalHeight();
    // Walk back to a block with a transaction in it.
    for (let h = head - 5; h > head - 60; h--) {
      const viaRpc = await rpc.blockAt(h);
      if (!viaRpc || viaRpc.receipts.length === 0) continue;
      const tx = viaRpc.receipts[0]!.txHash;
      // The transaction's first receipt executes in this block or the next few.
      const near = await Promise.all([0, 1, 2, 3].map((d) => nd.blockAt(h + d)));
      const ids = new Set(
        near.flatMap((b) => b?.receipts.filter((r) => r.txHash === tx).map((r) => r.receiptId) ?? []),
      );
      expect([...ids]).toContain(viaRpc.receipts[0]!.receiptId);
      return;
    }
    throw new Error('no transaction in the last 60 testnet blocks');
  }, 120_000);
});
