#!/usr/bin/env node
/**
 * v3, live: the funding graph the trust check reads is exactly the chain's.
 *
 *   set -a; . ../agentx-contracts/.env; set +a
 *   DATABASE_URL=postgres://agentx:agentx@127.0.0.1:5442/agentx  *     node scripts/verify-funding-graph.mjs <untilBlock> --truncates-the-dev-db
 *
 * Runs the real Indexer against Monad testnet from the deployment's start
 * block, with the AGENT_A and AGENT_B wallets as the known agents, then reads
 * the payment token's Transfer logs independently and compares: every
 * transfer touching a known address recorded, nothing else, exact amounts.
 * It TRUNCATES the indexer's tables first — never run it during a demo.
 */
import {createPublicClient, http, parseAbiItem} from 'viem';
import postgres from 'postgres';
import {loadConfig, loadAbis} from '@pactora/config';
import {createDb, closeDb} from '@pactora/db';
import {privateKeyToAccount} from 'viem/accounts';
import {Indexer} from '../apps/indexer/dist/indexer.js';

if (!process.argv.includes('--truncates-the-dev-db')) {
  console.error('refusing: this truncates the indexer tables. Pass --truncates-the-dev-db.');
  process.exit(2);
}
const AGENT_A = privateKeyToAccount(process.env.AGENT_A_PRIVATE_KEY).address.toLowerCase();
const AGENT_B = privateKeyToAccount(process.env.AGENT_B_PRIVATE_KEY).address.toLowerCase();
const UNTIL = BigInt(process.argv[2]);

const config = loadConfig({env: {ENABLED_CHAIN_IDS: '10143', DEFAULT_CHAIN_ID: '10143'}});
const chain = config.chain(10143);
const db = createDb(process.env.DATABASE_URL, {max: 2});
const pg = postgres(process.env.DATABASE_URL, {max: 1, onnotice: () => {}});
await pg`TRUNCATE indexer_cursor, agents, jobs, job_events, payments, agent_stats, token_transfers RESTART IDENTITY CASCADE`;
for (const [owner, wallet] of [
  [AGENT_A, AGENT_A],
  [AGENT_B, AGENT_B],
]) {
  await pg`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
      VALUES (10143, ${owner}, ${wallet}, 'live', 20000)`;
}

const pub = createPublicClient({transport: http(chain.rpcUrl)});
// Bounded so the check ends: stop the head at UNTIL (+ confirmations).
const client = new Proxy(pub, {
  get(t, p) {
    if (p === 'getBlockNumber') return async () => UNTIL + BigInt(chain.confirmations);
    const v = t[p];
    return typeof v === 'function' ? v.bind(t) : v;
  },
});
const indexer = new Indexer({db, chain, abis: loadAbis(), client});
let to = 0n;
while (to < UNTIL) to = await indexer.tick();

const recorded =
  await pg`SELECT tx_hash, log_index, from_address, to_address, amount::text AS amount FROM token_transfers ORDER BY block_number, log_index`;

// Independent truth: the token's Transfer logs touching A or B.
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const truth = [];
for (let from = BigInt(chain.startBlock); from <= UNTIL; from += 100n) {
  const end = from + 99n > UNTIL ? UNTIL : from + 99n;
  const logs = await pub.getLogs({
    address: chain.contracts.PaymentToken,
    event: TRANSFER,
    fromBlock: from,
    toBlock: end,
  });
  for (const l of logs) {
    const f = l.args.from.toLowerCase();
    const tt = l.args.to.toLowerCase();
    if ([AGENT_A, AGENT_B].includes(f) || [AGENT_A, AGENT_B].includes(tt)) {
      truth.push({
        tx_hash: l.transactionHash,
        log_index: l.logIndex,
        from_address: f,
        to_address: tt,
        amount: l.args.value.toString(),
      });
    }
  }
}
const key = (r) => `${r.tx_hash}:${r.log_index}:${r.from_address}:${r.to_address}:${r.amount}`;
const a = new Set(recorded.map(key));
const b = new Set(truth.map(key));
const missing = [...b].filter((k) => !a.has(k));
const extra = [...a].filter((k) => !b.has(k));
console.log(`recorded ${a.size}, chain says ${b.size}, missing ${missing.length}, extra ${extra.length}`);
if (missing.length || extra.length) console.log({missing, extra});
await closeDb(db);
await pg.end();
process.exit(missing.length || extra.length || b.size === 0 ? 1 : 0);
