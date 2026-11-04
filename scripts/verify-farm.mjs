#!/usr/bin/env node
/**
 * v3, live: a farmed worker is flagged, through API-created jobs, and an
 * honest one with the same shape is not.
 *
 * prooflines found the most-reviewed agent on Monad had 7,665 reviews, every
 * one from a wallet its owner had funded. A payment-backed review stops free
 * reviews; it cannot stop an owner paying itself. This runs that farm for
 * real — the API, the signer and the indexer, against Monad testnet — and
 * asks the trust check:
 *
 *   FARM:    worker W, owned by F. F sends MockUSDC to three fresh clients
 *            (each its own owner, so SameOwner does not stop them), and each
 *            hires W through the API.            → expected: self-funded
 *   CONTROL: worker H. Three fresh clients are funded by a mint — not by H —
 *            and each hires H through the API.   → expected: trusted
 *
 * The verdicts are read from GET /v1/agents/:id/trust, which reads what the
 * indexer recorded from the chain (payments and the token's own Transfer
 * logs). Nothing is inserted by hand.
 *
 *   set -a; . ../agentx-contracts/.env; set +a
 *   VERIFY_CHAIN_ID=10143 node scripts/verify-farm.mjs --truncates-the-dev-db
 *
 * It TRUNCATEs the dev database (as e2e.mjs does) — never during a demo.
 * Every key is a throwaway; their MON is swept back to the funder at the end.
 */

import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {foundry} from 'viem/chains';
import postgres from 'postgres';
import {loadConfig, loadAbis} from '@pactora/config';
import {createDb, closeDb} from '@pactora/db';
import {PactoraClient} from '@pactora/sdk';
import {Indexer} from '../apps/indexer/dist/indexer.js';
import {isCanonicalRegistry, registerAgent, registerWithApi, send, topUp} from './lib/chain.mjs';

if (!process.argv.includes('--truncates-the-dev-db')) {
  console.error('This TRUNCATEs the dev database. Re-run with --truncates-the-dev-db, never during a demo.');
  process.exit(2);
}

const CHAIN_ID = Number(process.env.VERIFY_CHAIN_ID ?? 10143);
const DB_URL = process.env.DATABASE_URL ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';
const API_PORT = Number(process.env.FARM_API_PORT ?? 8097);
const SIGNER_PORT = Number(process.env.FARM_SIGNER_PORT ?? 7097);

const config = loadConfig();
const abis = loadAbis();
const chain = config.chain(CHAIN_ID);
if (!chain.testnet) throw new Error(`chain ${CHAIN_ID} is not a testnet — this script sends transactions`);
const sql = postgres(DB_URL, {max: 2, onnotice: () => {}});
const db = createDb(DB_URL);
const viemChain = {...foundry, id: CHAIN_ID};
const pub = createPublicClient({chain: viemChain, transport: http(chain.rpcUrl)});
const walletOf = (account) => createWalletClient({account, chain: viemChain, transport: http(chain.rpcUrl)});

const funderKey = process.env.FUNDER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
if (!funderKey) throw new Error('FUNDER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) is not set');
const FUNDER = walletOf(privateKeyToAccount(funderKey));

const token = chain.contracts['PaymentToken'];
const vault = chain.contracts['StakeVault'];
const escrow = chain.contracts['TaskEscrow'];
const identity = chain.erc8004['identityRegistry'];
const erc20 = parseAbi([
  'function mint(address,uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
]);
const write = (client, address, abi, functionName, args) =>
  send(pub, client, {to: address, data: encodeFunctionData({abi, functionName, args})});

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.error(`  ✗ ${m}`);
  failures++;
};

const PRICE = 20_000n; // 0.02, the fast path
const key = () => {
  const k = generatePrivateKey();
  return {key: k, account: privateKeyToAccount(k)};
};
const farmer = key(); // owns the farmed worker W
const honest = key(); // owns the control worker H
const farmClients = [key(), key(), key()];
const fairClients = [key(), key(), key()];
const everyone = [farmer, honest, ...farmClients, ...fairClients];

const children = [];
async function cleanup() {
  for (const c of children) c.kill();
  // Native coin back to the funder from every throwaway key.
  const gasPrice = await pub.getGasPrice().catch(() => null);
  if (gasPrice) {
    for (const {account} of everyone) {
      const left = await pub.getBalance({address: account.address}).catch(() => 0n);
      const fee = 30_000n * gasPrice * 2n;
      if (left > fee) {
        await walletOf(account)
          .sendTransaction({
            to: FUNDER.account.address,
            value: left - fee,
            gas: 30_000n,
            gasPrice: gasPrice * 2n,
          })
          .then((hash) => pub.waitForTransactionReceipt({hash}))
          .catch(() => {});
      }
    }
  }
  await sql.end().catch(() => {});
  await closeDb(db).catch(() => {});
}

console.log(`\nfarm check — chain ${CHAIN_ID}, escrow ${escrow}`);
try {
  // ── 1. gas, identities, bonds, approvals ──────────────────────────────
  for (const {account} of everyone) await topUp(pub, FUNDER, account.address, 300_000_000_000_000_000n);
  const funded = await pub.getBlockNumber();
  // A balance funded in the last couple of blocks is not yet spendable for gas
  // on Monad (scripts/spike-7702.mjs). Wait three.
  while ((await pub.getBlockNumber()) < funded + 3n) await new Promise((r) => setTimeout(r, 400));

  const canonical = isCanonicalRegistry(chain);
  const idAbi = abis['MockIdentityRegistry'];
  const reg = (k, uri) =>
    registerAgent(pub, walletOf(k.account), {
      identity,
      abi: idAbi,
      uri,
      wallet: k.account.address,
      canonical,
    });
  const farmWorkerId = await reg(farmer, 'ipfs://farm-worker');
  const honestWorkerId = await reg(honest, 'ipfs://honest-worker');
  const farmClientIds = [];
  for (const c of farmClients) farmClientIds.push(await reg(c, 'ipfs://farm-client'));
  const fairClientIds = [];
  for (const c of fairClients) fairClientIds.push(await reg(c, 'ipfs://fair-client'));
  ok(
    `identities: farm worker ${farmWorkerId}, honest worker ${honestWorkerId}, clients ${[...farmClientIds, ...fairClientIds].join(', ')}`,
  );

  const minStake = await pub.readContract({
    address: vault,
    abi: abis['StakeVault'],
    functionName: 'minStake',
  });
  for (const [k, id] of [
    [farmer, farmWorkerId],
    [honest, honestWorkerId],
  ]) {
    const w = walletOf(k.account);
    await write(w, token, erc20, 'mint', [k.account.address, minStake]);
    await write(w, token, erc20, 'approve', [vault, minStake]);
    await write(w, vault, abis['StakeVault'], 'deposit', [id, minStake]);
  }
  for (const c of [...farmClients, ...fairClients]) {
    await write(walletOf(c.account), token, erc20, 'approve', [escrow, 1_000_000n]);
  }
  ok('both workers bonded; every client approved the escrow');

  // ── 2. services ───────────────────────────────────────────────────────
  const env = {
    ...process.env,
    DATABASE_URL: DB_URL,
    ENABLED_CHAIN_IDS: String(CHAIN_ID),
    DEFAULT_CHAIN_ID: String(CHAIN_ID),
    PACTORA_CONTRACTS_ROOT: process.env.PACTORA_CONTRACTS_ROOT ?? '../agentx-contracts',
    SIGNER_DEV_PRIVATE_KEYS: [...farmClients, ...fairClients].map((c) => c.key).join(','),
    SIGNER_PORT: String(SIGNER_PORT),
    SIGNER_URL: `http://127.0.0.1:${SIGNER_PORT}`,
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
  };
  start('signer', 'apps/signer/dist/main.js');
  start('api', 'apps/api/dist/main.js');
  for (const [url, label] of [
    [`http://127.0.0.1:${SIGNER_PORT}/health`, 'signer'],
    [`http://127.0.0.1:${API_PORT}/health`, 'api'],
  ]) {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = await fetch(url)
        .then((r) => r.ok)
        .catch(() => false);
      if (!up) await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) throw new Error(`${label} never became healthy`);
  }
  ok('signer and api are up');

  await sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, signer_txs, token_transfers RESTART IDENTITY CASCADE`;
  await sql`DELETE FROM indexer_cursor`;
  const indexer = new Indexer({db, chain, abis});
  await indexer.seedCursorToHead();

  const base = `http://127.0.0.1:${API_PORT}`;
  // Each agent owns its identity, so its own key signs the API's challenge.
  const register = (name, chainAgentId, account) =>
    registerWithApi(
      base,
      {
        name,
        capabilities: ['market-research'],
        pricePerTask: String(PRICE),
        walletAddress: account.address,
        ownerAddress: account.address,
        chainId: CHAIN_ID,
        chainAgentId: String(chainAgentId),
      },
      account,
    );
  const farmWorker = await register('FarmedBot', farmWorkerId, farmer.account);
  const honestWorker = await register('HonestBot', honestWorkerId, honest.account);
  const farmApi = [];
  for (const [i, c] of farmClients.entries())
    farmApi.push(await register(`Sock${i}`, farmClientIds[i], c.account));
  const fairApi = [];
  for (const [i, c] of fairClients.entries())
    fairApi.push(await register(`Client${i}`, fairClientIds[i], c.account));
  ok('eight agents registered through the API');

  // ── 3. the money: farmed from the worker's own side, or minted ─────────
  // Indexed from here on: the cursor is at the head, these come after it.
  const farmerWallet = walletOf(farmer.account);
  await write(farmerWallet, token, erc20, 'mint', [farmer.account.address, 3n * PRICE]);
  for (const c of farmClients)
    await write(farmerWallet, token, erc20, 'transfer', [c.account.address, PRICE]);
  for (const c of fairClients)
    await write(walletOf(c.account), token, erc20, 'mint', [c.account.address, PRICE]);
  ok("the farmer sent each sock puppet one job's worth; the fair clients minted their own");

  // ── 4. the hires, through the API ─────────────────────────────────────
  let last = 0n;
  const hire = async (client, worker) => {
    const sdk = new PactoraClient({baseUrl: base, apiKey: client.apiKey, chainId: CHAIN_ID});
    const receipt = await sdk.hire({
      workerAgentId: worker.agentId,
      spec: {capability: 'market-research', input: {q: randomBytes(4).toString('hex')}, deadlineSeconds: 120},
      maxPrice: String(PRICE),
      path: 'direct',
    });
    const r = await pub.waitForTransactionReceipt({hash: receipt.txHash});
    if (r.status !== 'success') throw new Error(`hire reverted: ${receipt.txHash}`);
    if (r.blockNumber > last) last = r.blockNumber;
  };
  for (const c of farmApi) await hire(c, farmWorker);
  for (const c of fairApi) await hire(c, honestWorker);
  ok('six hires paid on chain through the API (three to each worker)');

  // ── 5. the indexer catches up; the trust check answers ────────────────
  for (let i = 0; i < 600; i++) {
    if ((await indexer.tick()) >= last) break;
  }
  const [{n: transfers}] = await sql`SELECT count(*)::int AS n FROM token_transfers`;
  const [{n: pays}] = await sql`SELECT count(*)::int AS n FROM payments`;
  ok(`indexed ${pays} payment(s) and ${transfers} token transfer(s) from the chain`);

  const reader = new PactoraClient({baseUrl: base, apiKey: fairApi[0].apiKey, chainId: CHAIN_ID});
  const farm = await reader.trust(farmWorker.agentId);
  const fair = await reader.trust(honestWorker.agentId);
  console.log(`    farmed: ${farm.verdict} — ${farm.reasons.join('; ')}`);
  console.log(`    honest: ${fair.verdict} — ${fair.reasons.join('; ')}`);
  farm.verdict === 'self-funded' && farm.metrics.selfFunded === 3
    ? ok('the farmed worker is flagged self-funded: 3 of 3 payments')
    : fail(`farmed worker: ${farm.verdict}, selfFunded ${farm.metrics.selfFunded}`);
  fair.verdict === 'trusted' && fair.metrics.selfFunded === 0
    ? ok('the honest worker, same shape, is trusted: 3 owners, none self-funded')
    : fail(`honest worker: ${fair.verdict}, selfFunded ${fair.metrics.selfFunded}`);
  farm.metrics.trustScore <= fair.metrics.trustScore
    ? ok(`trust score excludes the farmed payments: ${farm.metrics.trustScore} vs ${fair.metrics.trustScore}`)
    : fail(`farmed trust score ${farm.metrics.trustScore} above honest ${fair.metrics.trustScore}`);
} catch (err) {
  fail(`farm check aborted: ${err.message}`);
} finally {
  await cleanup();
}

console.log(failures ? `\nFAILED (${failures})\n` : '\nFarm check passed.\n');
process.exitCode = failures ? 1 : 0;
