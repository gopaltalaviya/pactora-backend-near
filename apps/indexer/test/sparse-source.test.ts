import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createDb, closeDb, type Db} from '@pactora/db';
import type {BlockRead, BlockSource} from '@pactora/near';
import {Indexer, MAX_BLOCKS_PER_SPARSE_TICK} from '../src/indexer.js';
import {log, receipt, sandboxChain} from './near-fixtures.js';
import {DB_URL, cursorRow, eventRows, reset, seedJob} from './db.js';

/**
 * A sparse source (`accounts`, 2026-11-11) answers for a whole range with only
 * the blocks our receipts executed in. The indexer must apply exactly those,
 * move the cursor to the end of the range (not to the last block it saw),
 * and refuse a block outside what it asked for.
 */
const chain = sandboxChain();
const PACTORA = chain.contracts.Pactora;

class SparseFake implements BlockSource {
  readonly kind = 'accounts' as const;
  asked: Array<[number, number]> = [];
  constructor(
    public final: number,
    public blocks: BlockRead[] = [],
  ) {}
  async finalHeight() {
    return this.final;
  }
  async blockAt(height: number): Promise<BlockRead> {
    return {height, hash: `S${height}`, prevHash: '', timestampNs: 0n, receipts: []};
  }
  async blocksIn(from: number, to: number) {
    this.asked.push([from, to]);
    return this.blocks.filter((b) => b.height >= from - 1000 && b.height <= to + 1000);
  }
}

const block = (height: number, receipts: BlockRead['receipts']): BlockRead => ({
  height,
  hash: `S${height}`,
  prevHash: '',
  timestampNs: 1_700_000_000_000_000_000n,
  receipts,
});

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

describe('a sparse (accounts) source', () => {
  it('applies the blocks it returns and moves the cursor to the end of the range asked for', async () => {
    await seedJob(db);
    const at = chain.startBlock + 40;
    const src = new SparseFake(chain.startBlock + 100, [
      block(at, [receipt({executor: PACTORA, logs: [log.jobAccepted({jobId: 7, worker: 2, bond: 0})]})]),
    ]);
    const indexer = new Indexer({db, chain, source: src});
    expect(await indexer.tick()).toBe(chain.startBlock + 100);
    expect(src.asked).toEqual([[chain.startBlock, chain.startBlock + 100]]);
    expect((await eventRows(db)).map((e) => e.kind)).toEqual(['accepted']);
    expect(await cursorRow(db)).toEqual([
      {contract: 'Pactora', last_block: chain.startBlock + 100, last_block_hash: `S${at}`},
    ]);

    // Nothing new: the next tick asks from the cursor on and writes nothing more.
    src.blocks = [];
    src.final = chain.startBlock + 150;
    expect(await indexer.tick()).toBe(chain.startBlock + 150);
    expect(src.asked[1]).toEqual([chain.startBlock + 101, chain.startBlock + 150]);
    expect(await eventRows(db)).toHaveLength(1);
  });

  it('takes at most MAX_BLOCKS_PER_SPARSE_TICK blocks a tick', async () => {
    const src = new SparseFake(chain.startBlock + 5000);
    await new Indexer({db, chain, source: src}).tick();
    expect(src.asked).toEqual([[chain.startBlock, chain.startBlock + MAX_BLOCKS_PER_SPARSE_TICK - 1]]);
  });

  it('refuses a block outside the range it asked for, and writes nothing', async () => {
    await seedJob(db);
    const src = new SparseFake(chain.startBlock + 100, [
      block(chain.startBlock + 500, [
        receipt({executor: PACTORA, logs: [log.jobAccepted({jobId: 7, worker: 2, bond: 0})]}),
      ]),
    ]);
    await expect(new Indexer({db, chain, source: src}).tick()).rejects.toThrow(/asked the accounts source/);
    expect(await eventRows(db)).toEqual([]);
    expect(await cursorRow(db)).toEqual([]);
  });
});
