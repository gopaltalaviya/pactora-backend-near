import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {Indexer} from '../src/indexer.js';
import {FakeChain, GOLDEN, log, receipt, sandboxChain} from './near-fixtures.js';
import {CLIENT, DB_URL, WORKER, reset, seedAgents} from './db.js';

/**
 * The funding graph: payment-token NEP-141 `ft_transfer` events that touch a
 * known agent's wallet or owner, into token_transfers — what the trust check
 * reads to tell a client funded by the worker's side from one that paid with
 * its own money. Read from the token's receipts in the same blocks as the
 * protocol's.
 */
const chain = sandboxChain();
const TOKEN = chain.contracts.PaymentToken;
const STRANGER_A = 'stranger-a.test.near';
const STRANGER_B = 'stranger-b.test.near';

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

const rows = async () =>
  (await db.execute(
    sql`SELECT from_address, to_address, amount::text, block_number::int, tx_hash, receipt_id, log_index
        FROM token_transfers ORDER BY id`,
  )) as unknown as {
    from_address: string;
    to_address: string;
    amount: string;
    block_number: number;
    tx_hash: string;
    receipt_id: string;
    log_index: number;
  }[];

describe('funding transfers', () => {
  it('keeps transfers that touch a known wallet or owner, and nothing else', async () => {
    await seedAgents(db);
    const src = new FakeChain(chain.startBlock);
    const b1 = src.block(
      receipt({
        executor: TOKEN,
        receiptId: 'RT1',
        txHash: 'TT1',
        logs: [log.ftTransfer([{from: WORKER.owner, to: STRANGER_A, amount: 1_000_000}])],
      }),
    );
    const b2 = src.block(
      receipt({
        executor: TOKEN,
        receiptId: 'RT2',
        txHash: 'TT2',
        logs: [log.ftTransfer([{from: STRANGER_B, to: CLIENT.wallet, amount: 20_000, memo: 'hi'}])],
      }),
    );
    src.block(
      receipt({
        executor: TOKEN,
        logs: [log.ftTransfer([{from: STRANGER_A, to: STRANGER_B, amount: 5}])],
      }),
    );
    await new Indexer({db, chain, source: src}).tick();

    expect(await rows()).toEqual([
      {
        from_address: WORKER.owner,
        to_address: STRANGER_A,
        amount: '1000000',
        block_number: b1,
        tx_hash: 'TT1',
        receipt_id: 'RT1',
        log_index: 0,
      },
      {
        from_address: STRANGER_B,
        to_address: CLIENT.wallet,
        amount: '20000',
        block_number: b2,
        tx_hash: 'TT2',
        receipt_id: 'RT2',
        log_index: 0,
      },
    ]);
  });

  it('numbers each entry 256 × log line + entry, as the schema documents', async () => {
    await seedAgents(db);
    const src = new FakeChain(chain.startBlock);
    src.block(
      receipt({
        executor: TOKEN,
        receiptId: 'RT9',
        logs: [
          'not an event',
          log.ftTransfer([
            {from: STRANGER_A, to: STRANGER_B, amount: 1},
            {from: WORKER.wallet, to: CLIENT.wallet, amount: 2},
            {from: CLIENT.owner, to: STRANGER_A, amount: 3},
          ]),
        ],
      }),
    );
    await new Indexer({db, chain, source: src}).tick();
    expect((await rows()).map((r) => [r.amount, r.log_index])).toEqual([
      ['2', 256 + 1],
      ['3', 256 + 2],
    ]);
  });

  it('records each transfer once, however often the blocks are read', async () => {
    await seedAgents(db);
    const src = new FakeChain(chain.startBlock);
    src.block(
      receipt({executor: TOKEN, logs: [log.ftTransfer([{from: WORKER.owner, to: STRANGER_A, amount: 7}])]}),
    );
    await new Indexer({db, chain, source: src}).tick();
    await db.execute(sql`TRUNCATE indexer_cursor`);
    await new Indexer({db, chain, source: src}).tick();
    expect(await rows()).toHaveLength(1);
  });

  it('ignores mints: a mint has no sender, so it cannot be one side funding the other', async () => {
    await seedAgents(db);
    const src = new FakeChain(chain.startBlock);
    src.block(receipt({executor: TOKEN, logs: [log.ftMint(CLIENT.wallet, 1_000_000)]}));
    await new Indexer({db, chain, source: src}).tick();
    expect(await rows()).toEqual([]);
  });

  it('ignores ft_transfer logged by any account but the payment token, and failed receipts', async () => {
    await seedAgents(db);
    const src = new FakeChain(chain.startBlock);
    const line = log.ftTransfer([{from: WORKER.owner, to: CLIENT.wallet, amount: 9}]);
    src.block(receipt({executor: 'other-token.test.near', logs: [line]}));
    src.block(receipt({executor: chain.contracts.Pactora, logs: [line]}));
    src.block(receipt({executor: TOKEN, ok: false, logs: [line]}));
    await new Indexer({db, chain, source: src}).tick();
    expect(await rows()).toEqual([]);
  });

  it('reads the line near-contract-standards really emits', async () => {
    await db.execute(sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
        VALUES ('near:sandbox', 'alice.test.near', 'alice-agent.test.near', 'A', '1')`);
    const src = new FakeChain(chain.startBlock);
    src.block(receipt({executor: TOKEN, logs: [GOLDEN.ftTransferMemo]}));
    await new Indexer({db, chain, source: src}).tick();
    expect((await rows()).map((r) => [r.from_address, r.to_address, r.amount])).toEqual([
      ['alice.test.near', 'bob.test.near', '100'],
    ]);
  });
});
