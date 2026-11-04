#!/usr/bin/env node
/**
 * Integration check: a real chain, a real settlement, a real database.
 *
 * Unit tests cannot tell you whether the indexer decodes what the contracts
 * actually emit. This drives anvil end to end and asserts on the rows.
 *
 * Prerequisites (the script says so if they are missing):
 *   anvil running, docker compose up -d, migrations applied, `make export` run.
 */

import {createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {isCanonicalRegistry, registerAgent, topUp} from './lib/chain.mjs';
import {foundry} from 'viem/chains';
import postgres from 'postgres';
import {loadConfig, loadAbis} from '@pactora/config';
import {createDb, closeDb} from '@pactora/db';
import {Indexer} from '../apps/indexer/dist/indexer.js';

const CHAIN_ID = Number(process.env.VERIFY_CHAIN_ID ?? 31337);
const DB_URL = process.env.DATABASE_URL ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';
// anvil account 0 — a published test key, worthless by design.
// anvil account 0 locally; the real DEPLOYER key on a testnet run.
const DEPLOYER = privateKeyToAccount(
  process.env.DEPLOYER_PRIVATE_KEY ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);

const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.error(`  ✗ ${m}`);
  process.exitCode = 1;
};

const config = loadConfig();
const abis = loadAbis();
const chain = config.chain(CHAIN_ID);

const RPC = chain.rpcUrl;
const viemChain = {...foundry, id: CHAIN_ID};
const pub = createPublicClient({chain: viemChain, transport: http(RPC)});
const wallet = createWalletClient({account: DEPLOYER, chain: viemChain, transport: http(RPC)});

const addr = (n) => {
  const a = chain.contracts[n] ?? chain.erc8004[n];
  if (!a) throw new Error(`no address for ${n} in deployments/31337.json`);
  return a;
};

const identity = chain.erc8004['identityRegistry'];
const token = addr('PaymentToken');
const vault = addr('StakeVault');
const escrow = addr('TaskEscrow');

console.log('\nPactora indexer verification');
console.log(`  chain    ${chain.name} (${chain.chainId})`);
console.log(`  escrow   ${escrow}\n`);

const write = async (address, abi, functionName, args) => {
  const hash = await wallet.writeContract({address, abi, functionName, args});
  return pub.waitForTransactionReceipt({hash});
};

// ── 1. two agents, bonded ────────────────────────────────────────────────
const idAbi = abis['MockIdentityRegistry'];
const vaultAbi = abis['StakeVault'];
const escrowAbi = abis['TaskEscrow'];
const erc20 = parseAbi([
  'function mint(address,uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

// Two owners, two wallets: v2 refuses a hire between agents of one owner
// (SameOwner) or one wallet (SelfDealing). Ids are READ from the events —
// `1n` and `2n` held only on a fresh local chain.
const WORKER = privateKeyToAccount(
  process.env.AGENT_B_PRIVATE_KEY ?? '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // anvil #1
);
const workerClient = createWalletClient({account: WORKER, chain: viemChain, transport: http(RPC)});
await topUp(pub, wallet, WORKER.address, 100_000_000_000_000_000n);
const clientAgentId = await registerAgent(pub, wallet, {
  identity,
  abi: idAbi,
  canonical: isCanonicalRegistry(chain),
  uri: 'ipfs://client',
  wallet: DEPLOYER.address,
});
const workerAgentId = await registerAgent(pub, workerClient, {
  identity,
  abi: idAbi,
  canonical: isCanonicalRegistry(chain),
  uri: 'ipfs://worker',
  wallet: WORKER.address,
});
ok(`registered agents ${clientAgentId} and ${workerAgentId} in ERC-8004`);

await write(token, erc20, 'mint', [DEPLOYER.address, 1_000_000_000n]);
await write(token, erc20, 'approve', [vault, 1_000_000_000n]);
await write(vault, vaultAbi, 'deposit', [workerAgentId, 10_000_000n]);

const hireable = await pub.readContract({
  address: vault,
  abi: vaultAbi,
  functionName: 'isHireable',
  args: [workerAgentId],
});
hireable ? ok('worker is bonded and hireable') : fail('worker should be hireable');

// ── 2. settle a job on-chain ─────────────────────────────────────────────
await write(token, erc20, 'approve', [escrow, 1_000_000_000n]);
// UNIQUE PER RUN, and that is not cosmetic.
//
// A constant here emits the same specHash on-chain on every run, and the
// indexer links a job to its on-chain id by finding the first event carrying
// a matching hash. Replaying from startBlock, that is an OLDER run's payment —
// so this check reported "the linkage is broken" when the linkage was fine,
// and would have reported success just as confidently if it were broken.
//
// This is the same defect the API already fixed by scoping its specHash to a
// job id; the script had kept the old shape.
const specHash = keccak256(toHex(`verify-indexer-spec:${Date.now()}:${Math.random()}`));

// The escrow's job counter persists across runs of this script, so the id
// must be read, never assumed. Assuming it silently indexes nothing.
const expectedJobId = await pub.readContract({
  address: escrow,
  abi: escrowAbi,
  functionName: 'nextJobId',
});

const receipt = await write(escrow, escrowAbi, 'directPay', [
  clientAgentId,
  workerAgentId,
  20_000n,
  specHash,
]);
ok(`directPay settled as job ${expectedJobId} in block ${receipt.blockNumber}`);

// The indexer deliberately trails the head by `confirmations`, so the block
// holding the settlement is not yet safe to index. Mine past it rather than
// racing the chain — a flaky test is worse than no test.
// Wait past the indexer's confirmation trail. anvil mines on demand; a real
// network needs real blocks, so poll rather than assume.
if (CHAIN_ID === 31337) {
  await fetch(RPC, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'anvil_mine', params: ['0x5']}),
  });
} else {
  const target = receipt.blockNumber + BigInt(chain.confirmations) + 1n;
  while ((await pub.getBlockNumber()) < target) await new Promise((r) => setTimeout(r, 1000));
}
ok(`advanced past the settlement (trailing ${chain.confirmations} confirmation(s))`);

// ── 3. the API row the indexer will project onto ─────────────────────────
const sql = postgres(DB_URL, {max: 1, onnotice: () => {}});
await sql`TRUNCATE agents, jobs, job_events, agent_stats, payments, agent_capabilities RESTART IDENTITY CASCADE`;
await sql`DELETE FROM indexer_cursor`;

const [clientRow] = await sql`
  INSERT INTO agents (chain_id, chain_agent_id, owner_address, wallet_address, name, price_per_task)
  VALUES (${CHAIN_ID}, ${clientAgentId}, ${DEPLOYER.address}, ${DEPLOYER.address}, 'ClientBot', 20000)
  RETURNING id`;
const [workerRow] = await sql`
  INSERT INTO agents (chain_id, chain_agent_id, owner_address, wallet_address, name, price_per_task)
  VALUES (${CHAIN_ID}, ${workerAgentId}, ${DEPLOYER.address}, ${'0x000000000000000000000000000000000000dEaD'}, 'WorkerBot', 20000)
  RETURNING id`;

// chain_job_id is deliberately NULL: this is exactly what the API writes,
// because the signer returns on broadcast and the id does not exist yet.
// The indexer must link the two by specHash on its own.
await sql`
  INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash)
  VALUES (${CHAIN_ID}, ${clientRow.id}, ${workerRow.id}, 'direct', 20000, '{}', ${specHash})`;

// ── 4. run the indexer ───────────────────────────────────────────────────
const db = createDb(DB_URL);
const indexer = new Indexer({db, chain, abis});

// Seed the cursor just behind the settlement instead of replaying from the
// deployment block.
//
// Monad caps eth_getLogs at 100 blocks, and the deployment is now hundreds of
// thousands of blocks behind the head — replaying from there would need
// thousands of RPC round trips. That is the indexer working as designed; it
// is simply not what this script is testing. What it tests is that a
// settlement is decoded, linked by specHash, projected, and counted once.
const seedFrom = receipt.blockNumber - 5n;
const seedBlock = await pub.getBlock({blockNumber: seedFrom});
await sql`
  INSERT INTO indexer_cursor (chain_id, contract, last_block, last_block_hash)
  VALUES (${CHAIN_ID}, 'TaskEscrow', ${Number(seedFrom)}, ${seedBlock.hash})`;

// Catch up, and ASSERT that it did. This previously printed a tick count
// unconditionally, so a run that never reached the settlement still reported
// success — and then failed three assertions further down with a misleading
// cause.
let ticks = 0;
let reached = false;
for (; ticks < 50; ticks++) {
  const at = await indexer.tick();
  if (at >= receipt.blockNumber) {
    reached = true;
    break;
  }
}
reached
  ? ok(`indexer caught up in ${ticks + 1} tick(s) (range ${chain.maxLogRange}/tick)`)
  : fail(`indexer did not reach block ${receipt.blockNumber} in ${ticks} ticks`);

// ── 5. assert on the rows ────────────────────────────────────────────────
const events = await sql`SELECT kind, tx_hash, log_index FROM job_events ORDER BY id`;
events.length > 0
  ? ok(`job_events written: ${events.map((e) => e.kind).join(', ')}`)
  : fail('no job_events written');

const [job] = await sql`SELECT state, chain_job_id FROM jobs WHERE spec_hash = ${specHash}`;
job?.chain_job_id === String(expectedJobId)
  ? ok(`indexer linked the job to on-chain id ${expectedJobId} via specHash`)
  : fail(`chain_job_id is ${job?.chain_job_id}, expected ${expectedJobId} — the linkage is broken`);
job?.state === 'settled'
  ? ok(`job projected to state "${job.state}"`)
  : fail(`job state is "${job?.state}", expected settled`);

const [stats] = await sql`SELECT completed, failed, score FROM agent_stats WHERE agent_id = ${workerRow.id}`;
if (stats) {
  ok(`reputation: completed=${stats.completed} failed=${stats.failed} score=${stats.score}`);
  // One completion must NOT read as a perfect score — that is the whole
  // point of the volume damping.
  Number(stats.score) < 100
    ? ok(`one job does not produce a perfect score (${stats.score})`)
    : fail(`score ${stats.score} — volume damping is not working`);
} else {
  fail('no agent_stats row written');
}

// ── 6. re-running must change nothing ────────────────────────────────────
const cursorBefore = await sql`SELECT last_block, last_block_hash FROM indexer_cursor`;
await indexer.tick();
await indexer.tick();
const eventsAfter = await sql`SELECT count(*)::int AS n FROM job_events`;

eventsAfter[0].n === events.length
  ? ok(`replay is a no-op (${events.length} events before and after two more ticks)`)
  : fail(`replay duplicated events: ${events.length} -> ${eventsAfter[0].n}`);

cursorBefore.length === 1 ? ok(`cursor at block ${cursorBefore[0].last_block}`) : fail('no cursor row');

// ── 7. simulate a reorg: corrupt the stored hash ─────────────────────────
await sql`UPDATE indexer_cursor SET last_block_hash = ${'0x' + 'de'.repeat(32)}`;
await indexer.tick();
const afterReorg = await sql`SELECT count(*)::int AS n FROM job_events`;
afterReorg[0].n === events.length
  ? ok('reorg rewind replayed without duplicating anything')
  : fail(`reorg replay duplicated events: ${events.length} -> ${afterReorg[0].n}`);

await sql.end();
await closeDb(db);
console.log(process.exitCode ? '\nFAILED\n' : '\nAll indexer checks passed.\n');
