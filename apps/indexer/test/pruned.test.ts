import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {BlockPrunedError, rpcSource, type BlockRpc} from '@pactora/near';
import {Indexer} from '../src/indexer.js';
import {runIndexerLoop} from '../src/loop.js';
import {FakeChain, sandboxChain} from './near-fixtures.js';
import {DB_URL, cursorRow, reset} from './db.js';

/**
 * Round 3 (2026-11-09; STATUS known issue): a first start whose start block
 * a non-archival RPC has garbage-collected. The indexer used to read the
 * pruned heights as empty blocks — skipping the history in silence — or fail
 * on them and retry forever. Now it stops at once with one error naming the
 * fix, records `stalled: start block pruned` for /v1/status, waits the
 * longest backoff between attempts, and clears the stall on a good tick.
 */
const chain = sandboxChain();

/** A fake node that keeps only heights from `earliest` on, as a non-archival RPC does. */
class PrunedChain extends FakeChain {
  constructor(
    start: number,
    public earliest: number,
    private readonly answer: 'earliest' | 'error' = 'earliest',
  ) {
    super(start);
  }
  override async blockAt(height: number) {
    if (height < this.earliest) {
      this.asked.push(height);
      throw new Error(
        `[-32000] Server error: UNKNOWN_BLOCK Block either has never been observed on the node or has been garbage collected: BlockId(Height(${height}))`,
      );
    }
    return super.blockAt(height);
  }
  async earliestHeight() {
    return this.answer === 'earliest' ? this.earliest : null;
  }
}

let db: Db;
beforeAll(() => {
  db = createDb(DB_URL, {max: 2});
});
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  await reset(db);
});

const stateRows = async () =>
  (await db.execute(sql`SELECT chain_id, state, fix FROM indexer_state`)) as unknown as {
    chain_id: string;
    state: string;
    fix: string;
  }[];

describe('a start block the RPC has garbage-collected', () => {
  it("is caught from the node's earliest height before any block is read, and recorded", async () => {
    const src = new PrunedChain(chain.startBlock, chain.startBlock + 500);
    src.empty(600);
    const indexer = new Indexer({db, chain, source: src});
    const err = (await indexer.tick().then(
      () => new Error('no error'),
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('StartBlockPrunedError');
    expect(err.message).toMatch(new RegExp(`start block ${chain.startBlock} has been garbage collected`));
    expect(err.message).toMatch(/INDEXER_START_AT_HEAD=1.*archival RPC/);
    // Not one pruned height read as an empty block, and no cursor moved past them.
    expect(src.asked).toEqual([]);
    expect(await cursorRow(db)).toEqual([]);
    expect(await stateRows()).toEqual([
      {
        chain_id: chain.chainId,
        state: 'stalled: start block pruned',
        fix: expect.stringContaining('archival RPC'),
      },
    ]);
  });

  it('is caught from the RPC\'s "garbage collected" answer when the node does not say its earliest height', async () => {
    const src = new PrunedChain(chain.startBlock, chain.startBlock + 500, 'error');
    src.empty(600);
    const err = await new Indexer({db, chain, source: src}).tick().then(
      () => new Error('no error'),
      (e: unknown) => e as Error,
    );
    expect(err.name).toBe('StartBlockPrunedError');
    expect(await cursorRow(db)).toEqual([]);
    expect((await stateRows()).map((r) => r.state)).toEqual(['stalled: start block pruned']);
  });

  it('the RPC source tells a garbage-collected height from a skipped one', async () => {
    const unknown = Object.assign(new Error('UNKNOWN_BLOCK'), {type: 'UNKNOWN_BLOCK'});
    const rpc: BlockRpc = {
      finalBlock: async () => ({height: 2_000, hash: 'h', timestampNs: 0n}),
      txOutcome: async () => {
        throw new Error('unused');
      },
      block: async (height) => {
        if (height < 1_500) throw new BlockPrunedError(height, 1_500);
        if (height === 1_600) return null; // skipped: no block was ever produced
        throw unknown;
      },
      chunkTxs: async () => [],
      earliestHeight: async () => 1_500,
    };
    const source = rpcSource(rpc);
    expect(await source.earliestHeight!()).toBe(1_500);
    await expect(source.blockAt(1_000)).rejects.toThrow(
      /garbage collected by this RPC \(its earliest block is 1500\)/,
    );
    expect(await source.blockAt(1_600)).toBeNull();
  });

  it('the loop does not tight-loop: every retry waits the longest backoff', async () => {
    const src = new PrunedChain(chain.startBlock, chain.startBlock + 500);
    src.empty(600);
    const indexer = new Indexer({db, chain, source: src});
    const waits: number[] = [];
    const errors: string[] = [];
    const ac = new AbortController();
    await runIndexerLoop(() => indexer.tick(), {
      pollMs: 2_000,
      maxBackoffMs: 60_000,
      signal: ac.signal,
      random: () => 0.5,
      onError: (err) => errors.push((err as Error).name),
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 4) ac.abort();
      },
    });
    expect(waits).toEqual([60_000, 60_000, 60_000, 60_000]);
    expect(errors).toEqual(Array(4).fill('StartBlockPrunedError'));
  });

  it('a good tick (the operator fixed it) clears the recorded stall', async () => {
    const src = new PrunedChain(chain.startBlock, chain.startBlock + 500);
    src.empty(600);
    const indexer = new Indexer({db, chain, source: src});
    await indexer.tick().catch(() => {});
    expect(await stateRows()).toHaveLength(1);
    // The fix: INDEXER_START_AT_HEAD=1 seeds the cursor at the head.
    await indexer.seedCursorToHead();
    src.empty(3);
    await indexer.tick();
    expect(await stateRows()).toEqual([]);
  });

  it('an archival node (start block still there) indexes as before', async () => {
    const src = new PrunedChain(chain.startBlock, chain.startBlock);
    src.empty(10);
    expect(await new Indexer({db, chain, source: src}).tick()).toBe(chain.startBlock + 9);
    expect(await stateRows()).toEqual([]);
  });
});
