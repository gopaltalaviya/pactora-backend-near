import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {sql} from 'drizzle-orm';
import {loadConfig, loadAbis} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {Indexer} from '../src/indexer.js';

/**
 * How far behind the chain is the indexer?
 *
 * It knew — every tick reads the head — and told nobody: `/metrics` had only
 * "ticks" and "last success", so an indexer that succeeded on every tick while
 * falling further behind a backlog looked perfectly healthy. `progress()` is
 * what the head and indexed-block gauges are set from.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});
const chain = config.chain(31337);

let db: Db;
beforeAll(() => {
  db = createDb(DB_URL, {max: 2});
});
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE indexer_cursor`);
});

/** A chain that answers without a node: a fixed head, no logs. */
const fakeClient = (head: bigint) =>
  ({
    getBlockNumber: async () => head,
    getBlock: async ({blockNumber}: {blockNumber: bigint}) => ({
      hash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
    }),
    getLogs: async () => [],
  }) as never;

describe('indexer progress', () => {
  it('is unknown before the first tick', () => {
    const indexer = new Indexer({db, chain, abis: loadAbis() as never, client: fakeClient(0n)});
    expect(indexer.progress()).toEqual({headBlock: null, indexedBlock: null});
  });

  it('reports the chain head and the block it has indexed to after each tick', async () => {
    const head = BigInt(chain.startBlock) + 50n;
    const indexer = new Indexer({db, chain, abis: loadAbis() as never, client: fakeClient(head)});
    const to = await indexer.tick();
    expect(indexer.progress()).toEqual({headBlock: head, indexedBlock: to});
    expect(head - to).toBeGreaterThanOrEqual(BigInt(chain.confirmations));
  });
});
