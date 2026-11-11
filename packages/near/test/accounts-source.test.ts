import {describe, expect, it} from 'vitest';
import {accountsSource} from '../src/index.js';

/**
 * The `accounts` block source (2026-11-11): FastNEAR's transactions API, asked
 * only for the transactions touching Pactora and its token. Testnet's free
 * block feeds cannot keep pace with ~100 blocks a minute; this reads a few
 * pages per tick whatever the traffic. These tests pin what keeps it
 * complete: the hold-back below the API's head, the look-back before the
 * range, and that each receipt is filed under the block it executed in.
 */

type Receipt = {id: string; h: number; index?: number; exec: string; logs?: string[]; fail?: boolean};

function fakeApi(o: {
  head: number;
  rows: Record<string, Array<{hash: string; h: number}>>;
  txs: Record<string, {signer: string; receipts: Receipt[]}>;
  pageSize?: number;
  failPath?: string;
}) {
  const calls: Array<{path: string; body: Record<string, unknown>}> = [];
  const post = async (url: string, init: {body: string}) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({path, body});
    if (o.failPath === path) return {ok: false, status: 429, json: async () => ({})};
    let out: unknown;
    if (path === '/v0/blocks') {
      out = {
        blocks: [{block_height: o.head, block_hash: `H${o.head}`, block_timestamp: '1700000000000000000'}],
      };
    } else if (path === '/v0/account') {
      const all = (o.rows[body['account_id'] as string] ?? []).filter(
        (r) =>
          r.h >= (body['from_tx_block_height'] as number) && r.h <= (body['to_tx_block_height'] as number),
      );
      const start = body['resume_token'] ? Number(body['resume_token']) : 0;
      const size = o.pageSize ?? 200;
      out = {
        account_txs: all
          .slice(start, start + size)
          .map((r) => ({transaction_hash: r.hash, tx_block_height: r.h})),
        ...(start + size < all.length ? {resume_token: String(start + size)} : {}),
      };
    } else if (path === '/v0/transactions') {
      const hashes = body['tx_hashes'] as string[];
      expect(hashes.length).toBeLessThanOrEqual(20);
      out = {
        transactions: hashes.map((h) => {
          const t = o.txs[h];
          if (!t) return null;
          return {
            transaction: {hash: h, signer_id: t.signer},
            receipts: t.receipts.map((r) => ({
              receipt: {receipt_id: r.id, predecessor_id: t.signer, receiver_id: r.exec},
              execution_outcome: {
                id: r.id,
                block_hash: `H${r.h}`,
                block_height: r.h,
                block_timestamp: 1700000000000000000 + r.h,
                ...(r.index !== undefined ? {index: r.index} : {}),
                outcome: {
                  executor_id: r.exec,
                  logs: r.logs ?? [],
                  status: r.fail ? {Failure: {}} : {SuccessValue: ''},
                },
              },
            })),
          };
        }),
      };
    } else {
      throw new Error(`unexpected ${path}`);
    }
    return {ok: true, status: 200, json: async () => out};
  };
  return {post, calls};
}

describe('accounts source', () => {
  it('reports the API head minus the hold-back as final, so the indexer never passes what the API has not listed', async () => {
    const api = fakeApi({head: 1000, rows: {}, txs: {}});
    const src = accountsSource({
      baseUrl: 'https://tx.invalid/',
      accounts: ['p.testnet'],
      fetchImpl: api.post,
      holdBack: 50,
    });
    expect(src.kind).toBe('accounts');
    expect(await src.finalHeight()).toBe(950);
    expect(await src.apiHead()).toEqual({height: 1000, hash: 'H1000'});
  });

  it('keeps exactly the receipts that executed in the range, each under its own block, in execution order', async () => {
    const api = fakeApi({
      head: 2000,
      rows: {
        // A: its transaction is before the range, its second receipt executed inside it.
        // C: beyond the range, so not asked for. B: also seen through the token, read once.
        'p.testnet': [
          {hash: 'A', h: 95},
          {hash: 'B', h: 100},
          {hash: 'C', h: 130},
        ],
        't.testnet': [{hash: 'B', h: 100}],
      },
      txs: {
        A: {
          signer: 'a.testnet',
          receipts: [
            {id: 'a1', h: 96, exec: 'x.testnet'},
            {id: 'a2', h: 101, exec: 'p.testnet', logs: ['la']},
          ],
        },
        B: {
          signer: 'b.testnet',
          receipts: [
            {id: 'b2', h: 102, index: 3, exec: 'p.testnet', logs: ['lb2'], fail: true},
            {id: 'b1', h: 102, index: 1, exec: 't.testnet', logs: ['lb1']},
            {id: 'b3', h: 121, exec: 'p.testnet'},
          ],
        },
      },
    });
    const src = accountsSource({
      baseUrl: 'https://tx.invalid',
      accounts: ['p.testnet', 't.testnet'],
      fetchImpl: api.post,
      lookBack: 10,
    });
    const blocks = await src.blocksIn!(100, 120);
    expect(blocks.map((b) => [b.height, b.hash, b.receipts.map((r) => r.receiptId)])).toEqual([
      [101, 'H101', ['a2']],
      [102, 'H102', ['b1', 'b2']],
    ]);
    expect(blocks[1]!.receipts[1]).toEqual({
      receiptId: 'b2',
      executorId: 'p.testnet',
      predecessorId: 'b.testnet',
      txHash: 'B',
      logs: ['lb2'],
      ok: false,
    });
    const listed = api.calls.filter((c) => c.path === '/v0/account');
    expect(
      listed.map((c) => [
        c.body['account_id'],
        c.body['from_tx_block_height'],
        c.body['to_tx_block_height'],
        c.body['desc'],
      ]),
    ).toEqual([
      ['p.testnet', 90, 120, false],
      ['t.testnet', 90, 120, false],
    ]);
    expect(api.calls.filter((c) => c.path === '/v0/transactions')).toHaveLength(1);
  });

  it('follows resume tokens and fetches transactions 20 at a time', async () => {
    const rows = Array.from({length: 45}, (_, i) => ({hash: `T${i}`, h: 500 + i}));
    const txs = Object.fromEntries(
      rows.map((r) => [
        r.hash,
        {signer: 's.testnet', receipts: [{id: `r${r.h}`, h: r.h, exec: 'p.testnet'}]},
      ]),
    );
    const api = fakeApi({head: 2000, rows: {'p.testnet': rows}, txs, pageSize: 10});
    const src = accountsSource({
      baseUrl: 'https://tx.invalid',
      accounts: ['p.testnet'],
      fetchImpl: api.post,
      lookBack: 0,
    });
    const blocks = await src.blocksIn!(500, 544);
    expect(blocks).toHaveLength(45);
    expect(api.calls.filter((c) => c.path === '/v0/account')).toHaveLength(5);
    expect(api.calls.filter((c) => c.path === '/v0/transactions')).toHaveLength(3);
  });

  it('fails the read on an HTTP error rather than returning an empty range', async () => {
    const api = fakeApi({
      head: 2000,
      rows: {'p.testnet': [{hash: 'A', h: 100}]},
      txs: {},
      failPath: '/v0/transactions',
    });
    const src = accountsSource({baseUrl: 'https://tx.invalid', accounts: ['p.testnet'], fetchImpl: api.post});
    await expect(src.blocksIn!(100, 110)).rejects.toThrow(/HTTP 429/);
  });

  it('refuses to start with nothing to watch', () => {
    expect(() => accountsSource({baseUrl: 'https://tx.invalid', accounts: []})).toThrow(/no accounts/);
  });
});
