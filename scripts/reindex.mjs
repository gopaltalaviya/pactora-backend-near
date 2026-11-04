#!/usr/bin/env node
/**
 * Re-read the chain from a block — runbook R3's "backfill a range" and "full
 * reindex", as one command instead of hand-copied SQL (docs/17: "SQL on the
 * cursor; no script").
 *
 *   DATABASE_URL=… node scripts/reindex.mjs --chain 10143 --from 73978102 --indexer-is-stopped
 *   DATABASE_URL=… node scripts/reindex.mjs --chain 10143 --full --indexer-is-stopped
 *
 * --from N   moves the cursor to block N, with N's REAL hash read from the
 *            chain (a mistyped hash used to be "not dangerous" only because
 *            the next tick treated it as a reorg); the next tick reads N+1.
 * --full     deletes the cursor: the next tick starts at the deployment's
 *            startBlock. Every write is keyed by (chain, tx, logIndex), so
 *            a re-read event is a no-op.
 *
 * The indexer must be STOPPED: a running tick writes the cursor after each
 * batch and would undo this. The flag says you checked; nothing here can.
 */
import postgres from 'postgres';
import {createPublicClient, http} from 'viem';
import {loadConfig} from '@pactora/config';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const chainId = Number(value('--chain'));
const from = value('--from');
const full = flag('--full');

if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set — refusing to guess which database to rewrite');
if (!Number.isInteger(chainId) || chainId <= 0) fail('--chain <id> is required');
if (full === (from !== undefined)) fail('give exactly one of --from <block> or --full');
if (from !== undefined && !/^\d+$/.test(from)) fail('--from must be a block number');
if (!flag('--indexer-is-stopped')) {
  fail('stop the indexer first (a running tick overwrites the cursor), then pass --indexer-is-stopped');
}

const config = loadConfig({env: {ENABLED_CHAIN_IDS: String(chainId), DEFAULT_CHAIN_ID: String(chainId)}});
const chain = config.chain(chainId);
const pg = postgres(process.env.DATABASE_URL, {max: 1, onnotice: () => {}});

try {
  const [before] = await pg`SELECT last_block, last_block_hash FROM indexer_cursor
                            WHERE chain_id = ${chainId} AND contract = 'TaskEscrow'`;
  console.log(
    `cursor before: ${before ? `block ${before.last_block}` : 'none (would start at the deployment block)'}`,
  );

  if (full) {
    await pg`DELETE FROM indexer_cursor WHERE chain_id = ${chainId} AND contract = 'TaskEscrow'`;
    console.log(`cursor removed: the next tick starts at the deployment's startBlock ${chain.startBlock}`);
  } else {
    const block = BigInt(from);
    if (block < BigInt(chain.startBlock)) {
      fail(`block ${block} is before the deployment's startBlock ${chain.startBlock}: nothing to read there`);
    }
    const pub = createPublicClient({transport: http(chain.rpcUrl)});
    const {hash} = await pub.getBlock({blockNumber: block});
    await pg`INSERT INTO indexer_cursor (chain_id, contract, last_block, last_block_hash, updated_at)
             VALUES (${chainId}, 'TaskEscrow', ${block.toString()}, ${hash}, now())
             ON CONFLICT (chain_id, contract) DO UPDATE
               SET last_block = EXCLUDED.last_block, last_block_hash = EXCLUDED.last_block_hash, updated_at = now()`;
    console.log(
      `cursor set to block ${block} (${hash}, read from the chain): the next tick reads ${block + 1n}`,
    );
  }
  console.log('start the indexer again.');
} finally {
  await pg.end();
}

function fail(message) {
  console.error(`reindex: ${message}`);
  process.exit(2);
}
