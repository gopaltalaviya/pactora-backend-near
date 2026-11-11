import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import type {ChainConfig} from '@pactora/config';
import {neardataSource, type BlockRead} from '@pactora/near';
import {Indexer, MAX_BLOCKS_PER_TICK} from '../src/indexer.js';
import {openSource} from '../src/source.js';
import {sandboxChain} from './near-fixtures.js';
import {DB_URL, cursorRow, reset} from './db.js';

/**
 * The production code path against the real NEAR testnet, read-only: no
 * keys, no transactions. Pactora is not deployed on testnet yet, so the
 * contracts set is fake — the payment token is whichever NEP-141 contract
 * logged an `ft_transfer` in a recent final block — which proves the parts a
 * fixture cannot: real neardata blocks, their prev_hash chain and skipped
 * heights over a whole batch, and real NEP-297 log lines.
 *
 *   NEAR_LIVE=1 DATABASE_URL=… pnpm vitest run apps/indexer/test/live.test.ts
 *
 * It TRUNCATEs like every indexer test: the scratch database only.
 */
const LIVE = process.env['NEAR_LIVE'] === '1';
const RPC = process.env['RPC_URL_TESTNET'] ?? 'https://test.rpc.fastnear.com';
const NEARDATA = 'https://testnet.neardata.xyz';
/** How far back to look for an ft_transfer. */
const SEARCH_BLOCKS = 120;

/**
 * neardata's free tier answered "rate-limit exceeded of 30 blocks per minute"
 * (HTTP 429) on 2026-11-05, so every read here is spaced 2.2 s apart and a
 * 429 waits a minute and retries. The production code is unchanged: this
 * only paces the `fetch` the real `neardataSource` is given.
 */
function pacedFetch(): typeof fetch {
  let nextAt = 0;
  const paced = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    for (;;) {
      const wait = nextAt - Date.now();
      nextAt = Math.max(Date.now(), nextAt) + 2_200;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      // A fresh timeout per attempt: the caller's started before the wait.
      const res = await fetch(url, {...init, signal: AbortSignal.timeout(20_000)});
      if (res.status !== 429) return res;
      await new Promise((r) => setTimeout(r, 60_000));
    }
  };
  return paced as typeof fetch;
}
const paced = pacedFetch();

function testnetChain(over: Partial<ChainConfig> = {}, contracts: Record<string, string> = {}): ChainConfig {
  const base = sandboxChain();
  return {
    ...base,
    chainId: 'near:testnet',
    nearNetworkId: 'testnet',
    rpcUrl: RPC,
    blockSource: {kind: 'neardata', url: NEARDATA},
    contracts: {...base.contracts, Pactora: 'pactora-not-deployed.testnet', ...contracts},
    startBlock: 0,
    ...over,
  };
}

interface Found {
  block: BlockRead;
  receiptId: string;
  txHash: string;
  token: string;
  line: number;
  entries: Array<{old_owner_id: string; new_owner_id: string; amount: string}>;
}

/** The newest successful receipt with an ft_transfer, parsed here independently of the indexer. */
async function findFtTransfer(): Promise<Found> {
  const nd = neardataSource(NEARDATA, paced);
  const final = await nd.finalHeight();
  // At least one full batch behind the head, so the tick reads MAX_BLOCKS_PER_TICK blocks.
  for (let h = final - MAX_BLOCKS_PER_TICK; h > final - MAX_BLOCKS_PER_TICK - SEARCH_BLOCKS; h--) {
    const block = await nd.blockAt(h);
    if (!block) continue;
    for (const r of block.receipts) {
      if (!r.ok) continue;
      for (let line = 0; line < r.logs.length; line++) {
        const l = r.logs[line]!;
        if (!l.startsWith('EVENT_JSON:')) continue;
        const e = JSON.parse(l.slice('EVENT_JSON:'.length)) as {
          standard: string;
          event: string;
          data: Found['entries'];
        };
        if (e.standard === 'nep141' && e.event === 'ft_transfer') {
          return {
            block,
            receiptId: r.receiptId,
            txHash: r.txHash,
            token: r.executorId,
            line,
            entries: e.data,
          };
        }
      }
    }
  }
  throw new Error(`no ft_transfer in the ${SEARCH_BLOCKS} blocks before ${final - MAX_BLOCKS_PER_TICK}`);
}

describe.skipIf(!LIVE)('indexer on NEAR testnet, live (read-only)', () => {
  let db: Db;
  beforeAll(async () => {
    db = createDb(DB_URL, {max: 2});
    await reset(db);
  });
  afterAll(async () => {
    await reset(db);
    await closeDb(db);
  });

  it('opens the neardata source only for the network the config names', async () => {
    const source = await openSource(testnetChain());
    expect(source.kind).toBe('neardata');
    await expect(openSource(testnetChain({nearNetworkId: 'mainnet'}))).rejects.toThrow(/network "testnet"/);
    await expect(
      openSource(testnetChain({blockSource: {kind: 'neardata', url: 'https://mainnet.neardata.xyz'}})),
    ).rejects.toThrow(/not the same network/);
  }, 60_000);

  it('indexes a real ft_transfer through one production tick', async () => {
    const found = await findFtTransfer();
    const chain = testnetChain({}, {PaymentToken: found.token});
    const first = found.entries[0]!;

    // Make the sender a known agent wallet, and start the cursor just before the block.
    await db.execute(sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
        VALUES ('near:testnet', 'pactora-live-owner.testnet', ${first.old_owner_id}, 'live', '1')`);
    await db.execute(sql`INSERT INTO indexer_cursor (chain_id, contract, last_block, last_block_hash)
        VALUES ('near:testnet', 'Pactora', ${found.block.height - 1}, ${found.block.prevHash})`);

    // The production source, with paced requests (openSource is checked above).
    const source = neardataSource(NEARDATA, paced);
    const indexer = new Indexer({db, chain, source});
    const to = await indexer.tick();
    // A whole batch read and linked by prev_hash, real skipped heights included.
    expect(to).toBe(found.block.height + MAX_BLOCKS_PER_TICK - 1);
    const [cursor] = await cursorRow(db);
    const last = await source.blockAt(to);
    if (last) expect(cursor!.last_block_hash).toBe(last.hash);
    expect(cursor!.last_block).toBe(to);

    const rows = (await db.execute(
      sql`SELECT block_number::int, tx_hash, receipt_id, log_index, from_address, to_address, amount::text
          FROM token_transfers WHERE receipt_id = ${found.receiptId} ORDER BY log_index`,
    )) as unknown as Array<Record<string, unknown>>;
    const expected = found.entries
      .map((e, i) => ({e, i}))
      .filter(({e}) => e.old_owner_id === first.old_owner_id || e.new_owner_id === first.old_owner_id)
      .map(({e, i}) => ({
        block_number: found.block.height,
        tx_hash: found.txHash,
        receipt_id: found.receiptId,
        log_index: 256 * found.line + i,
        from_address: e.old_owner_id,
        to_address: e.new_owner_id,
        amount: e.amount,
      }));
    expect(rows).toEqual(expected);
    console.log(
      `live: ${found.token} receipt ${found.receiptId} at ${found.block.height}: ${rows.length} transfer(s); indexed to ${to}`,
    );
  }, 900_000);
});
