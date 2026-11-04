#!/usr/bin/env node
/**
 * End-to-end: the whole stack, one settlement, asserted on real state.
 *
 * Every layer has been verified on its own. This is the first thing that runs
 * the API, the signer and the indexer TOGETHER against a live chain and
 * checks the seams between them — which is where demos actually break.
 *
 * It asserts on money, not on HTTP 200s: the worker's balance, the fee split,
 * the on-chain job state, and the reputation the settlement produced.
 *
 *   VERIFY_CHAIN_ID=10143 node scripts/e2e.mjs
 */

import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createPublicClient, createWalletClient, http, parseAbi} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {isCanonicalRegistry, registerAgent, registerWithApi, topUp} from './lib/chain.mjs';
import {foundry} from 'viem/chains';
import postgres from 'postgres';
import {loadConfig, loadAbis} from '@pactora/config';
import {createDb, closeDb} from '@pactora/db';
import {PactoraClient, PactoraError} from '@pactora/sdk';
import {Indexer} from '../apps/indexer/dist/indexer.js';

const CHAIN_ID = Number(process.env.VERIFY_CHAIN_ID ?? 31337);
const DB_URL = process.env.DATABASE_URL ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';
const API_PORT = Number(process.env.E2E_API_PORT ?? 8099);
const SIGNER_PORT = Number(process.env.E2E_SIGNER_PORT ?? 7099);

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.error(`  ✗ ${m}`);
  failures++;
};

const config = loadConfig();
const abis = loadAbis();
const chain = config.chain(CHAIN_ID);
const sql = postgres(DB_URL, {max: 2, onnotice: () => {}});
const db = createDb(DB_URL);

const DEPLOYER = privateKeyToAccount(
  process.env.DEPLOYER_PRIVATE_KEY ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const viemChain = {...foundry, id: CHAIN_ID};
const pub = createPublicClient({chain: viemChain, transport: http(chain.rpcUrl)});
const wallet = createWalletClient({account: DEPLOYER, chain: viemChain, transport: http(chain.rpcUrl)});

console.log(`\nPactora end-to-end — ${chain.name} (${chain.chainId})`);
console.log(`  escrow ${chain.contracts['TaskEscrow']}\n`);

const children = [];
const cleanup = async () => {
  for (const c of children) c.kill();
  await sql.end().catch(() => {});
  await closeDb(db).catch(() => {});
};
process.on('exit', () => children.forEach((c) => c.kill()));

try {
  // ── 1. on-chain identities ────────────────────────────────────────────
  const erc20 = parseAbi([
    'function mint(address,uint256)',
    'function approve(address,uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
  ]);
  const write = async (address, abi, fn, args) =>
    pub.waitForTransactionReceipt({hash: await wallet.writeContract({address, abi, functionName: fn, args})});

  const identity = chain.erc8004['identityRegistry'];
  const token = chain.contracts['PaymentToken'];
  const vault = chain.contracts['StakeVault'];
  const escrow = chain.contracts['TaskEscrow'];

  // The worker is a DIFFERENT owner with a different wallet. v2's escrow
  // refuses a hire between two agents of one owner (SameOwner), and paying
  // the client's own wallet would net to zero and prove nothing. The worker
  // registers its own identity, so it owns it.
  const WORKER = privateKeyToAccount(
    process.env.AGENT_B_PRIVATE_KEY ?? '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // anvil #1
  );
  const WORKER_WALLET = WORKER.address;
  const workerClient = createWalletClient({account: WORKER, chain: viemChain, transport: http(chain.rpcUrl)});
  await topUp(pub, wallet, WORKER.address, 100_000_000_000_000_000n); // 0.1 native for one registration
  const idAbi = abis['MockIdentityRegistry'];
  const clientChainId = await registerAgent(pub, wallet, {
    identity,
    abi: idAbi,
    canonical: isCanonicalRegistry(chain),
    uri: 'ipfs://client',
    wallet: DEPLOYER.address,
  });
  const workerChainId = await registerAgent(pub, workerClient, {
    identity,
    abi: idAbi,
    canonical: isCanonicalRegistry(chain),
    uri: 'ipfs://worker',
    wallet: WORKER_WALLET,
  });

  await write(token, erc20, 'mint', [DEPLOYER.address, 1_000_000_000n]);
  await write(token, erc20, 'approve', [vault, 1_000_000_000n]);
  await write(token, erc20, 'approve', [escrow, 1_000_000_000n]);
  await write(vault, abis['StakeVault'], 'deposit', [workerChainId, 10_000_000n]);
  ok(`registered agents ${clientChainId}/${workerChainId} and bonded the worker`);

  // ── 2. start the services ─────────────────────────────────────────────
  const env = {
    ...process.env,
    DATABASE_URL: DB_URL,
    ENABLED_CHAIN_IDS: String(CHAIN_ID),
    DEFAULT_CHAIN_ID: String(CHAIN_ID),
    PACTORA_CONTRACTS_ROOT: process.env.PACTORA_CONTRACTS_ROOT ?? '../agentx-contracts',
    SIGNER_DEV_PRIVATE_KEY: DEPLOYER.address
      ? (process.env.DEPLOYER_PRIVATE_KEY ??
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
      : '',
    SIGNER_PORT: String(SIGNER_PORT),
    SIGNER_URL: `http://127.0.0.1:${SIGNER_PORT}`,
    // Shared by the API and the signer, fresh per run.
    SIGNER_TOKEN: randomBytes(24).toString('hex'),
    PORT: String(API_PORT),
    LOG_LEVEL: 'warn',
  };

  const start = (name, script) => {
    const child = spawn(process.execPath, [script], {env, stdio: ['ignore', 'pipe', 'pipe']});
    child.stderr.on('data', (d) => {
      const s = String(d);
      if (/error|Error/.test(s)) process.stderr.write(`    [${name}] ${s}`);
    });
    children.push(child);
    return child;
  };

  start('signer', 'apps/signer/dist/main.js');
  start('api', 'apps/api/dist/main.js');

  const waitFor = async (url, label) => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(url);
        if (r.ok) return ok(`${label} is up`);
      } catch {
        // not up yet — that is what this loop is waiting out
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${label} never became healthy at ${url}`);
  };
  await waitFor(`http://127.0.0.1:${SIGNER_PORT}/health`, 'signer');
  await waitFor(`http://127.0.0.1:${API_PORT}/health`, 'api');

  // ── 3. register through the API ───────────────────────────────────────
  await sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, signer_txs RESTART IDENTITY CASCADE`;
  await sql`DELETE FROM indexer_cursor`;

  const base = `http://127.0.0.1:${API_PORT}`;
  // `owner` signs the API's challenge: proof the registrant controls the identity.
  const register = (name, price, chainAgentId, walletAddress, owner = DEPLOYER) =>
    registerWithApi(
      base,
      {
        name,
        capabilities: ['market-research'],
        pricePerTask: price,
        walletAddress,
        ownerAddress: owner.address,
        chainId: CHAIN_ID,
        // Verified by the API against the identity registry before it is
        // stored — the same path the /register page takes.
        chainAgentId: String(chainAgentId),
      },
      owner,
    );

  const clientAgent = await register('ClientBot', '20000', clientChainId, DEPLOYER.address);
  const workerAgent = await register('ResearchBot', '20000', workerChainId, WORKER_WALLET, WORKER);
  ok(`registered two agents through the API (ids ${clientAgent.agentId}, ${workerAgent.agentId})`);

  // ── 4. discovery ──────────────────────────────────────────────────────
  const sdk = new PactoraClient({baseUrl: base, apiKey: clientAgent.apiKey, chainId: CHAIN_ID});
  const found = await sdk.discover({capability: 'market-research', maxPrice: '50000'});
  found.some((a) => a.agentId === workerAgent.agentId)
    ? ok(`discovery found the worker among ${found.length} candidate(s)`)
    : fail('discovery did not return the worker');

  found[0]?.priceDisplay === '0.02 MockUSDC'
    ? ok(`price is formatted for the caller: ${found[0].priceDisplay}`)
    : fail(`priceDisplay was "${found[0]?.priceDisplay}"`);

  // ── 5. hire ───────────────────────────────────────────────────────────
  // The indexer starts at the head, not at the deployment block. The cursor
  // was deleted above, and from the deployment block it would need to walk
  // 1.6 million blocks at Monad's 100-block log cap before reaching this
  // run's transaction. For a long time it never did, and this script still
  // passed: the indexer linked the job to an OLD run's payment with the same
  // spec hash. Linking now checks the parties, which exposed it.
  const indexer = new Indexer({db, chain, abis});
  await indexer.seedCursorToHead();

  const workerBalanceBefore = await pub.readContract({
    address: token,
    abi: erc20,
    functionName: 'balanceOf',
    args: [WORKER_WALLET],
  });

  const receipt = await sdk.hire({
    workerAgentId: workerAgent.agentId,
    spec: {capability: 'market-research', input: {question: 'ETH/USDC depth on Monad'}, deadlineSeconds: 120},
    maxPrice: '50000',
    // Asked for explicitly: this worker is new, and `auto` only pays up
    // front for a worker whose score has earned it (fastPathMinScore).
    path: 'direct',
  });

  receipt.path === 'direct'
    ? ok(`hired on the fast path, as asked, tx ${receipt.txHash.slice(0, 12)}…`)
    : fail(`expected the direct path, got "${receipt.path}"`);
  ok(`explorer: ${receipt.explorerUrl}`);

  // ── 6. idempotency ────────────────────────────────────────────────────
  const replay = await sdk.hire({
    workerAgentId: workerAgent.agentId,
    spec: {capability: 'market-research', input: {question: 'ETH/USDC depth on Monad'}, deadlineSeconds: 120},
    maxPrice: '50000',
    // Asked for explicitly: this worker is new, and `auto` only pays up
    // front for a worker whose score has earned it (fastPathMinScore).
    path: 'direct',
  });
  replay.txHash === receipt.txHash
    ? ok('an identical hire replayed the original transaction instead of paying twice')
    : fail(`a retry produced a SECOND payment: ${replay.txHash} != ${receipt.txHash}`);
  // And a second JOB: it used to insert a new row per retry, backed by no
  // transaction, while the money side replayed correctly.
  const [{n: jobRows}] = await sql`SELECT count(*)::int AS n FROM jobs`;
  replay.jobId === receipt.jobId && jobRows === 1
    ? ok('and returned the original job, not a new one')
    : fail(`the retry answered job ${replay.jobId} (original ${receipt.jobId}); ${jobRows} job rows exist`);

  // ── 7. the money actually moved ───────────────────────────────────────
  const txReceipt = await pub.waitForTransactionReceipt({hash: receipt.txHash});
  txReceipt.status === 'success'
    ? ok(`settled in block ${txReceipt.blockNumber}`)
    : fail('the transaction reverted');

  const workerBalanceAfter = await pub.readContract({
    address: token,
    abi: erc20,
    functionName: 'balanceOf',
    args: [WORKER_WALLET],
  });
  const paid = workerBalanceAfter - workerBalanceBefore;
  const fee = 20000n / 100n;
  paid === 20000n - fee
    ? ok(`the worker was actually paid ${chain.formatToken(paid)} (fee ${chain.formatToken(fee)} withheld)`)
    : fail(`worker received ${paid}, expected ${20000n - fee}`);

  // ── 8. the indexer picks it up ────────────────────────────────────────
  for (let i = 0; i < 300; i++) {
    const at = await indexer.tick();
    if (at >= txReceipt.blockNumber) break;
  }

  const [job] = await sql`SELECT state, chain_job_id, fee FROM jobs WHERE spec_hash = ${receipt.specHash}`;
  job?.state === 'settled' ? ok(`job projected to "${job.state}"`) : fail(`job state is "${job?.state}"`);
  job?.chain_job_id ? ok(`linked to on-chain id ${job.chain_job_id}`) : fail('chain_job_id was never linked');

  const [stats] =
    await sql`SELECT completed, failed, score FROM agent_stats WHERE agent_id = ${workerAgent.agentId}`;
  Number(stats?.completed) === 1
    ? ok(`reputation: completed=${stats.completed} failed=${stats.failed} score=${stats.score}`)
    : fail(`completed=${stats?.completed}, expected exactly 1`);

  // ── 9. the error contract agents rely on ──────────────────────────────
  try {
    await sdk.hire({
      workerAgentId: workerAgent.agentId,
      spec: {capability: 'market-research', input: {q: 2}, deadlineSeconds: 60},
      maxPrice: '1',
    });
    fail('a hire above maxPrice was accepted');
  } catch (err) {
    err instanceof PactoraError && err.code === 'PRICE_ABOVE_MAX'
      ? ok('a hire above maxPrice fails with PRICE_ABOVE_MAX, not a bare 500')
      : fail(`unexpected error: ${err?.code ?? err}`);
  }
} catch (err) {
  fail(`e2e aborted: ${err.message}`);
} finally {
  await cleanup();
}

console.log(failures ? `\nFAILED (${failures})\n` : '\nEnd-to-end passed.\n');
process.exit(failures ? 1 : 0);
