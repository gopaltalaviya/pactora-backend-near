import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createDb, closeDb, type Db} from '@pactora/db';
import {Indexer, MAX_BLOCKS_PER_TICK} from '../src/indexer.js';
import {FakeChain, log, receipt, sandboxChain} from './near-fixtures.js';
import {CLIENT, DB_URL, cursorRow, eventRows, jobRow, reset, seedJob} from './db.js';

/**
 * Reading final blocks: how far a tick goes, what the cursor holds, and the
 * one thing it must never do — index a block that does not follow the last.
 *
 * NEAR final blocks do not reorg. A block whose prev_hash is not the hash
 * the cursor stored means a wrong source (another network, a broken mirror)
 * or a bug here, and the only safe answer is to stop where it stands.
 */
const chain = sandboxChain();
const PACTORA = chain.contracts.Pactora;

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

describe('indexer progress', () => {
  it('is unknown before the first tick', () => {
    const indexer = new Indexer({db, chain, source: new FakeChain(chain.startBlock)});
    expect(indexer.progress()).toEqual({headBlock: null, indexedBlock: null});
  });

  it('reports the final head and the block it has indexed to after each tick', async () => {
    const src = new FakeChain(chain.startBlock);
    src.empty(10);
    const indexer = new Indexer({db, chain, source: src});
    const to = await indexer.tick();
    expect(to).toBe(chain.startBlock + 9);
    expect(indexer.progress()).toEqual({headBlock: chain.startBlock + 9, indexedBlock: to});
  });

  it(`reads at most ${MAX_BLOCKS_PER_TICK} blocks a tick, then carries on from the cursor`, async () => {
    const src = new FakeChain(chain.startBlock);
    src.empty(MAX_BLOCKS_PER_TICK + 20);
    const indexer = new Indexer({db, chain, source: src});

    expect(await indexer.tick()).toBe(chain.startBlock + MAX_BLOCKS_PER_TICK - 1);
    expect(indexer.progress().headBlock).toBe(chain.startBlock + MAX_BLOCKS_PER_TICK + 19);
    expect(await indexer.tick()).toBe(chain.startBlock + MAX_BLOCKS_PER_TICK + 19);
    // Every height read exactly once, in order.
    expect(src.asked).toEqual(Array.from({length: MAX_BLOCKS_PER_TICK + 20}, (_, i) => chain.startBlock + i));
  });

  it('does nothing when there is no new final block', async () => {
    const src = new FakeChain(chain.startBlock);
    src.empty(3);
    const indexer = new Indexer({db, chain, source: src});
    await indexer.tick();
    const asked = src.asked.length;
    expect(await indexer.tick()).toBe(chain.startBlock + 2);
    expect(src.asked.length).toBe(asked);
  });

  it("stores the cursor under 'Pactora', with the last block's height and hash", async () => {
    const src = new FakeChain(chain.startBlock);
    src.empty(4);
    await new Indexer({db, chain, source: src}).tick();
    expect(await cursorRow(db)).toEqual([
      {
        contract: 'Pactora',
        last_block: chain.startBlock + 3,
        last_block_hash: src.hashAt(chain.startBlock + 3),
      },
    ]);
  });
});

describe('skipped heights', () => {
  it('advance the cursor, and the next block still links to the last real one', async () => {
    const src = new FakeChain(chain.startBlock);
    src.empty(2);
    src.skip(3);
    const indexer = new Indexer({db, chain, source: src});
    expect(await indexer.tick()).toBe(chain.startBlock + 4);
    // The cursor names the skipped height and the hash of the block before it.
    expect(await cursorRow(db)).toEqual([
      {
        contract: 'Pactora',
        last_block: chain.startBlock + 4,
        last_block_hash: src.hashAt(chain.startBlock + 1),
      },
    ]);

    src.empty(1); // its prev_hash is block startBlock+1's
    expect(await indexer.tick()).toBe(chain.startBlock + 5);
  });
});

describe('a block that does not follow the last one', () => {
  it('halts, naming both hashes, and writes nothing', async () => {
    const a = new FakeChain(chain.startBlock, 'A');
    a.empty(5);
    await new Indexer({db, chain, source: a}).tick();
    const before = await cursorRow(db);

    // Another chain from the same height on — a wrong source.
    const b = new FakeChain(chain.startBlock + 5, 'B');
    b.empty(5);
    const indexer = new Indexer({db, chain, source: b});
    const err = await indexer.tick().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/prev_hash/);
    expect(err?.message).toContain(a.hashAt(chain.startBlock + 4));
    expect(err?.message).toContain('B-genesis');
    expect(await cursorRow(db)).toEqual(before);
    // And it stays halted: retrying does not step over it.
    await expect(indexer.tick()).rejects.toThrow(/prev_hash/);
    expect(await cursorRow(db)).toEqual(before);
  });

  it('halts on a break inside one batch, before applying any of it', async () => {
    await seedJob(db);
    const src = new FakeChain(chain.startBlock);
    src.block(receipt({executor: PACTORA, logs: [log.jobAccepted({jobId: 7, worker: 2, bond: 0})]}));
    src.empty(3);
    // Block 3 claims a parent that is not block 2.
    src.blocks.set(chain.startBlock + 3, {
      height: chain.startBlock + 3,
      hash: 'X-3',
      prevHash: 'X-2',
      timestampNs: 0n,
      receipts: [],
    });

    await expect(new Indexer({db, chain, source: src}).tick()).rejects.toThrow(/prev_hash/);
    expect(await eventRows(db)).toEqual([]);
    expect(await cursorRow(db)).toEqual([]);
  });

  it('halts when a height reported empty actually held a block', async () => {
    const src = new FakeChain(chain.startBlock);
    src.empty(3);
    // The source drops block 1: block 2's parent is then a block never read.
    src.blocks.set(chain.startBlock + 1, null);
    await expect(new Indexer({db, chain, source: src}).tick()).rejects.toThrow(/prev_hash/);
  });

  it('halts when the source answers with a different height than asked', async () => {
    const src = new FakeChain(chain.startBlock);
    src.empty(3);
    const wrong = src.blocks.get(chain.startBlock + 2)!;
    src.blocks.set(chain.startBlock + 1, wrong);
    await expect(new Indexer({db, chain, source: src}).tick()).rejects.toThrow(/height/);
  });
});

describe('one transaction per batch', () => {
  /**
   * A write that fails part-way through a batch — here the database refusing
   * a row — must take the batch's earlier writes and the cursor with it, so
   * the retry replays the batch from the start instead of skipping its head.
   */
  it('rolls back the events already applied when a later write in the batch fails', async () => {
    const {jobId} = await seedJob(db);
    const src = new FakeChain(chain.startBlock);
    src.block(receipt({executor: PACTORA, logs: [log.jobAccepted({jobId: 7, worker: 2, bond: 0})]}));
    // Not a NEAR account id: token_transfers' CHECK refuses it, inside the transaction.
    src.block(
      receipt({
        executor: chain.contracts.PaymentToken,
        logs: [log.ftTransfer([{from: 'Not An Account', to: CLIENT.wallet, amount: 1}])],
      }),
    );
    await expect(new Indexer({db, chain, source: src}).tick()).rejects.toThrow(/token_transfers/);
    expect(await eventRows(db)).toEqual([]);
    expect(await cursorRow(db)).toEqual([]);
    expect((await jobRow(db, jobId)).state).toBe('created');
  });

  it('applies none of a batch when a later block in it cannot be applied', async () => {
    const {jobId} = await seedJob(db);
    const src = new FakeChain(chain.startBlock);
    src.block(receipt({executor: PACTORA, logs: [log.jobAccepted({jobId: 7, worker: 2, bond: 0})]}));
    // A settled event from the Pactora contract that the decoder refuses.
    src.block(
      receipt({
        executor: PACTORA,
        logs: [log.jobSettled({jobId: 7, worker: 2, paid: 1, fee: 1, outcome: 'Won'})],
      }),
    );
    await expect(new Indexer({db, chain, source: src}).tick()).rejects.toThrow(/outcome/);
    expect(await eventRows(db)).toEqual([]);
    expect(await cursorRow(db)).toEqual([]);
    expect((await jobRow(db, jobId)).state).toBe('created');
  });
});

describe('starting from the head instead of from the deployment block', () => {
  it('writes a cursor at the final head so the first tick does not backfill', async () => {
    const src = new FakeChain(chain.startBlock);
    src.empty(200);
    const indexer = new Indexer({db, chain, source: src});
    expect(await indexer.seedCursorToHead()).toBe(chain.startBlock + 199);
    expect(await cursorRow(db)).toEqual([
      {
        contract: 'Pactora',
        last_block: chain.startBlock + 199,
        last_block_hash: src.hashAt(chain.startBlock + 199),
      },
    ]);
    src.empty(1);
    expect(await indexer.tick()).toBe(chain.startBlock + 200);
  });

  it('leaves an existing cursor alone — a restart must not skip a backlog', async () => {
    const src = new FakeChain(chain.startBlock);
    src.empty(5);
    const indexer = new Indexer({db, chain, source: src});
    await indexer.tick();
    src.empty(100);
    expect(await indexer.seedCursorToHead()).toBeNull();
    expect((await cursorRow(db))[0]!.last_block).toBe(chain.startBlock + 4);
  });
});
