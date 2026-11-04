import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {sql} from 'drizzle-orm';
import {loadConfig, loadAbis} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {Indexer} from '../src/indexer.js';

/**
 * v3: the indexer records payment-token transfers that touch a known agent's
 * wallet or owner — the funding graph the trust check reads. Read from the
 * token's own Transfer logs in the same 100-block chunks as the escrow's.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});
const chain = config.chain(31337);
const token = chain.contracts['PaymentToken']!.toLowerCase();

let db: Db;
beforeAll(() => {
  db = createDb(DB_URL, {max: 2});
});
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE indexer_cursor, agents, token_transfers RESTART IDENTITY CASCADE`);
});

const OWNER = '0xAAAA000000000000000000000000000000000001';
const WALLET = '0xbbbb000000000000000000000000000000000002';
const STRANGER_A = '0x' + 'c1'.repeat(20);
const STRANGER_B = '0x' + 'c2'.repeat(20);

interface FakeTransfer {
  from: string;
  to: string;
  value: bigint;
  blockNumber: bigint;
  logIndex: number;
}

/** A chain with escrow logs none, and the given token transfers. */
function fakeChain(head: bigint, transfers: FakeTransfer[]) {
  const asked: string[] = [];
  const client = {
    getBlockNumber: async () => head,
    getBlock: async ({blockNumber}: {blockNumber: bigint}) => ({
      number: blockNumber,
      hash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
    }),
    getLogs: async ({address, fromBlock, toBlock}: {address: string; fromBlock: bigint; toBlock: bigint}) => {
      asked.push(address.toLowerCase());
      if (address.toLowerCase() !== token) return [];
      return transfers
        .filter((t) => t.blockNumber >= fromBlock && t.blockNumber <= toBlock)
        .map((t) => ({
          address: token,
          args: {from: t.from, to: t.to, value: t.value},
          blockNumber: t.blockNumber,
          logIndex: t.logIndex,
          transactionHash: `0x${t.blockNumber.toString(16).padStart(60, '0')}${t.logIndex.toString(16).padStart(4, '0')}`,
          eventName: 'Transfer',
        }));
    },
  };
  return {client, asked};
}

async function knownAgent(): Promise<void> {
  await db.execute(sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
      VALUES (31337, ${OWNER}, ${WALLET}, 'Known', 20000)`);
}

const rows = async () =>
  (await db.execute(
    sql`SELECT from_address, to_address, amount::text, block_number::int AS block_number FROM token_transfers ORDER BY id`,
  )) as unknown as {from_address: string; to_address: string; amount: string; block_number: number}[];

describe('funding transfers', () => {
  it('keeps transfers that touch a known wallet or owner, lower-cased, and nothing else', async () => {
    await knownAgent();
    const start = BigInt(chain.startBlock);
    const {client, asked} = fakeChain(start + 50n, [
      {from: OWNER, to: STRANGER_A, value: 1_000_000n, blockNumber: start + 1n, logIndex: 0},
      {from: STRANGER_B, to: WALLET, value: 20_000n, blockNumber: start + 2n, logIndex: 1},
      {from: STRANGER_A, to: STRANGER_B, value: 5n, blockNumber: start + 3n, logIndex: 2},
    ]);
    const indexer = new Indexer({db, chain, abis: loadAbis() as never, client: client as never});
    await indexer.tick();

    expect(asked).toContain(token);
    expect(await rows()).toEqual([
      {
        from_address: OWNER.toLowerCase(),
        to_address: STRANGER_A,
        amount: '1000000',
        block_number: Number(start + 1n),
      },
      {from_address: STRANGER_B, to_address: WALLET, amount: '20000', block_number: Number(start + 2n)},
    ]);
  });

  it('records each transfer once, however often the range is read', async () => {
    await knownAgent();
    const start = BigInt(chain.startBlock);
    const transfers = [{from: OWNER, to: STRANGER_A, value: 7n, blockNumber: start + 1n, logIndex: 0}];
    const first = new Indexer({
      db,
      chain,
      abis: loadAbis() as never,
      client: fakeChain(start + 50n, transfers).client as never,
    });
    await first.tick();
    await db.execute(sql`TRUNCATE indexer_cursor`); // force a replay of the same blocks
    const again = new Indexer({
      db,
      chain,
      abis: loadAbis() as never,
      client: fakeChain(start + 50n, transfers).client as never,
    });
    await again.tick();
    expect(await rows()).toHaveLength(1);
  });
});

/**
 * v3: the funding graph after a reorg. A transfer from an orphaned block is
 * not on the chain any more; left in the table it could mark a payment
 * self-funded on money that never moved. Transfers are a plain copy of the
 * token's logs with nothing derived from them, so a rewind drops them and the
 * replay reads the canonical ones back.
 */
describe('funding transfers after a reorg', () => {
  it('drops a transfer from an orphaned block and keeps the canonical one', async () => {
    await knownAgent();
    const start = BigInt(chain.startBlock);
    const head = start + 50n; // safe head start+49; a reorg rewinds to start+47
    const orphaned = {from: OWNER, to: STRANGER_A, value: 111n, blockNumber: start + 48n, logIndex: 0};
    // A different transaction: its own position, so its own hash in the fake.
    const canonical = {from: OWNER, to: STRANGER_B, value: 222n, blockNumber: start + 48n, logIndex: 1};

    const forkA = fakeChain(head, [orphaned]).client;
    await new Indexer({db, chain, abis: loadAbis() as never, client: forkA as never}).tick();
    expect((await rows()).map((r) => r.amount)).toEqual(['111']);

    // The chain reorganises from start+47: new hashes, the other transfer.
    const forkB = fakeChain(head, [canonical]).client;
    const reorged = {
      ...forkB,
      getBlock: async ({blockNumber}: {blockNumber: bigint}) => ({
        number: blockNumber,
        hash: `0x${(blockNumber >= start + 47n ? 'b' : '0').repeat(4)}${blockNumber.toString(16).padStart(60, '0')}`,
      }),
    };
    await new Indexer({db, chain, abis: loadAbis() as never, client: reorged as never}).tick();

    expect((await rows()).map((r) => r.amount)).toEqual(['222']);
  });
});
