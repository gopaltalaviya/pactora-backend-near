#!/usr/bin/env node
/**
 * The 2026-10-26 audit's contract fixes, live (agentx-docs docs/22): against
 * the deployed contracts and the CANONICAL ERC-8004 registries on Monad
 * testnet. Real transactions; every claim is read back from the chain.
 *
 *   set -a; . ../agentx-contracts/.env; set +a
 *   VERIFY_CHAIN_ID=10143 node scripts/verify-audit.mjs
 *
 * Who is who, as in verify-v3: the client's owner is AGENT_A, the worker's
 * AGENT_B, DEPLOYER the stranger who calls exits and writes kept reviews.
 *
 * Asserts:
 *   A. M-1 — a worker that makes the escrow its operator just before its own
 *      failure no longer drops the FAILED review: the canonical registry
 *      refuses it, the escrow keeps it, the worker cannot be hired; once the
 *      approval is revoked a stranger writes it (value 0) and it is hireable
 *   B. F1 — an AgentAccount's session manager extends a session key and
 *      nothing else: what the key spent stays spent, the budget is not
 *      raised, and sweep / grant / setPolicy are refused to it
 */
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  http,
  parseAbi,
  parseEventLogs,
  toFunctionSelector,
} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {foundry} from 'viem/chains';
import {loadConfig, loadAbis} from '@pactora/config';
import {send, topUp, unique} from './lib/chain.mjs';

const CHAIN_ID = Number(process.env.VERIFY_CHAIN_ID ?? 10143);
const config = loadConfig();
const abis = loadAbis();
const chain = config.chain(CHAIN_ID);
if (!chain.testnet) throw new Error(`chain ${CHAIN_ID} is not a testnet — this script sends transactions`);

const viemChain = {...foundry, id: CHAIN_ID};
const pub = createPublicClient({chain: viemChain, transport: http(chain.rpcUrl)});

const escrow = chain.contracts['TaskEscrow'];
const vault = chain.contracts['StakeVault'];
const factory = chain.contracts['AgentAccountFactory'];
const token = chain.contracts['PaymentToken'];
const identity = chain.erc8004['identityRegistry'];
const reputation = chain.erc8004['reputationRegistry'];
const escrowAbi = abis['TaskEscrow'];
const vaultAbi = abis['StakeVault'];
const accountAbi = abis['AgentAccount'];
const factoryAbi = abis['AgentAccountFactory'];

const erc20 = parseAbi([
  'function mint(address,uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
// The canonical registry's own interface (upstream erc-8004-contracts).
const identityAbi = parseAbi([
  'function register(string agentURI) returns (uint256)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'function setApprovalForAll(address operator, bool approved)',
]);
const reputationAbi = parseAbi([
  'function getLastIndex(uint256 agentId, address client) view returns (uint64)',
  'function readFeedback(uint256 agentId, address client, uint64 index) view returns (int128, uint8, string, string, bool)',
]);

const keyed = (name) => {
  const key = process.env[name];
  if (!key) throw new Error(`${name} is not set — load agentx-contracts/.env first`);
  return privateKeyToAccount(key);
};
const deployer = keyed('DEPLOYER_PRIVATE_KEY');
const clientOwner = keyed('AGENT_A_PRIVATE_KEY');
const workerOwner = keyed('AGENT_B_PRIVATE_KEY');
const walletOf = (account) => createWalletClient({account, chain: viemChain, transport: http(chain.rpcUrl)});
const D = walletOf(deployer);
const C = walletOf(clientOwner);
const W = walletOf(workerOwner);

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  console.error(`  ✗ ${m}`);
  failures++;
};
const expect = (cond, m) => (cond ? ok(m) : bad(m));

const call = (wallet, to, abi, functionName, args = []) =>
  send(pub, wallet, {to, data: encodeFunctionData({abi, functionName, args})});
const read = (address, abi, functionName, args = []) => pub.readContract({address, abi, functionName, args});
const reviews = (agentId, from) => read(reputation, reputationAbi, 'getLastIndex', [agentId, from]);

/** The custom error a call would revert with, by eth_call — costs nothing. */
async function refusal(account, to, abi, functionName, args) {
  try {
    await pub.call({account, to, data: encodeFunctionData({abi, functionName, args})});
    return null;
  } catch (err) {
    const raw = err?.cause?.data ?? err?.data ?? err?.walk?.((e) => e?.data)?.data;
    try {
      return decodeErrorResult({abi, data: raw}).errorName;
    } catch {
      return String(err.shortMessage ?? err.message).slice(0, 80);
    }
  }
}

async function register(wallet, uri) {
  const receipt = await call(wallet, identity, identityAbi, 'register', [uri]);
  const [ev] = parseEventLogs({abi: identityAbi, logs: receipt.logs, eventName: 'Registered'});
  if (!ev) throw new Error(`no Registered event in ${receipt.transactionHash}`);
  return ev.args.agentId;
}

async function waitPast(timestamp) {
  for (;;) {
    const block = await pub.getBlock();
    if (block.timestamp > timestamp) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

console.log(`\naudit fixes, live — chain ${CHAIN_ID}, escrow ${escrow}`);
await topUp(pub, D, clientOwner.address, 2n * 10n ** 18n);
await topUp(pub, D, workerOwner.address, 2n * 10n ** 18n);

// ───────────── A. M-1: the operator toggle no longer buys a clean score ─────────────
console.log('\nA. M-1 — a refused FAILED review is kept, blocks hiring, and is written later');
{
  const clientId = await register(C, 'ipfs://agentx-audit-client');
  const workerId = await register(W, 'ipfs://agentx-audit-worker');
  const minStake = await read(vault, vaultAbi, 'minStake');
  const stake = 2n * minStake; // the expiry seizes a bond; stay hireable after it
  await call(W, token, erc20, 'mint', [workerOwner.address, stake]);
  await call(W, token, erc20, 'approve', [vault, stake]);
  await call(W, vault, vaultAbi, 'deposit', [workerId, stake]);
  await call(C, token, erc20, 'mint', [clientOwner.address, 10_000_000n]);
  await call(C, token, erc20, 'approve', [escrow, 10_000_000n]);
  ok(`client ${clientId}, worker ${workerId} on the canonical registry; worker bonded`);

  const PRICE = 50_000n;
  const created = await call(C, escrow, escrowAbi, 'createJob', [
    clientId,
    workerId,
    PRICE,
    unique('spec'),
    5n,
    5n,
  ]);
  const [ev] = parseEventLogs({abi: escrowAbi, logs: created.logs, eventName: 'JobCreated'});
  const id = ev.args.jobId;
  await call(W, escrow, escrowAbi, 'acceptJob', [id]);

  // The toggle: approve the escrow as operator just before the failure lands.
  await call(W, identity, identityAbi, 'setApprovalForAll', [escrow, true]);
  await waitPast((await read(escrow, escrowAbi, 'getJob', [id])).workDeadline);
  const before = await reviews(workerId, escrow);
  const r = await call(D, escrow, escrowAbi, 'expireUndelivered', [id]);
  const failed = parseEventLogs({abi: escrowAbi, logs: r.logs, eventName: 'FeedbackFailed'});
  expect(failed.length === 1, 'the canonical registry refused the FAILED review (FeedbackFailed)');
  expect((await reviews(workerId, escrow)) === before, 'nothing reached the registry');
  expect((await read(escrow, escrowAbi, 'unwrittenReviews', [workerId])) === 1n, 'the escrow kept it');

  await call(W, identity, identityAbi, 'setApprovalForAll', [escrow, false]);
  const hire = await refusal(clientOwner.address, escrow, escrowAbi, 'createJob', [
    clientId,
    workerId,
    PRICE,
    unique('spec'),
    300n,
    1800n,
  ]);
  expect(hire === 'ReviewUnwritten', `approval revoked, but hiring the worker is refused (${hire})`);

  // A stranger writes it.
  const w = await call(D, escrow, escrowAbi, 'retryFeedback', [id, false]);
  const retried = parseEventLogs({abi: escrowAbi, logs: w.logs, eventName: 'FeedbackRetried'});
  expect(retried.length === 1, `a stranger wrote it (FeedbackRetried, ${w.gasUsed} gas)`);
  const idx = await reviews(workerId, escrow);
  const fb = await read(reputation, reputationAbi, 'readFeedback', [workerId, escrow, idx]);
  expect(idx === before + 1n && fb[0] === 0n, 'the FAILED review (value 0) is on the canonical registry');
  expect((await read(escrow, escrowAbi, 'unwrittenReviews', [workerId])) === 0n, 'nothing left unwritten');
  const again = await refusal(clientOwner.address, escrow, escrowAbi, 'createJob', [
    clientId,
    workerId,
    PRICE,
    unique('spec'),
    300n,
    1800n,
  ]);
  expect(again === null, 'and the worker is hireable again');
}

// ───────────── B. F1: the session manager can only extend ─────────────
console.log('\nB. F1 — a session manager extends a key and keeps what it spent; nothing more');
// A throwaway hot key, funded for gas and swept back in `finally`.
const hot = privateKeyToAccount(generatePrivateKey());
try {
  await topUp(pub, D, hot.address, 2n * 10n ** 17n);
  const salt = unique('audit-account');
  const policy = {perTaskCap: 100_000n, dailyCap: 500_000n, allowlistOnly: true};
  const predicted = await read(factory, factoryAbi, 'predictAddress', [clientOwner.address, salt]);
  await call(C, factory, factoryAbi, 'createAccount', [clientOwner.address, salt, policy]);
  const account = predicted;
  const transfer = toFunctionSelector('transfer(address,uint256)');
  await call(C, account, accountAbi, 'setAllowedCall', [token, transfer, true]);
  await call(C, token, erc20, 'mint', [account, 1_000_000n]);
  const block = await pub.getBlock();
  const BUDGET = 300_000n;
  await call(C, account, accountAbi, 'grantSessionKey', [hot.address, block.timestamp + 3600n, BUDGET]);
  await call(C, account, accountAbi, 'setSessionManager', [deployer.address]);
  ok(`AgentAccount ${account}: session key ${hot.address.slice(0, 10)}…, manager = DEPLOYER`);

  // The wallet must see the funding before the key can pay for gas (Monad lag).
  const funded = await pub.getBlockNumber();
  while ((await pub.getBlockNumber()) < funded + 3n) await new Promise((r) => setTimeout(r, 400));
  const SPEND = 70_000n;
  await call(walletOf(hot), account, accountAbi, 'execute', [
    token,
    encodeFunctionData({abi: erc20, functionName: 'transfer', args: [clientOwner.address, SPEND]}),
  ]);
  const [, , spentBefore] = await read(account, accountAbi, 'sessionKeys', [hot.address]);
  expect(spentBefore === SPEND, `the session key spent ${SPEND} through the account`);

  const later = (await pub.getBlock()).timestamp + 20n * 3600n;
  await call(D, account, accountAbi, 'extendSessionKey', [hot.address, later]);
  const [expiry, budget, spent] = await read(account, accountAbi, 'sessionKeys', [hot.address]);
  expect(expiry === later, 'the manager extended the key');
  expect(budget === BUDGET && spent === SPEND, `budget kept (${budget}), spent kept (${spent}) — no refill`);

  const m = deployer.address;
  expect(
    (await refusal(m, account, accountAbi, 'sweep', [m, 1n])) === 'NotOwner',
    'the manager cannot sweep',
  );
  expect(
    (await refusal(m, account, accountAbi, 'grantSessionKey', [m, later, 10n ** 30n])) === 'NotOwner',
    'the manager cannot grant itself a key',
  );
  expect(
    (await refusal(m, account, accountAbi, 'setPolicy', [
      {perTaskCap: 10n ** 30n, dailyCap: 10n ** 30n, allowlistOnly: false},
    ])) === 'NotOwner',
    'the manager cannot raise the caps',
  );
  expect(
    (await refusal(m, account, accountAbi, 'extendSessionKey', [m, later])) === 'NotAuthorized',
    'the manager cannot create a key by extending one that was never granted',
  );
} finally {
  const gasPrice = await pub.getGasPrice();
  const left = await pub.getBalance({address: hot.address});
  const fee = 30_000n * gasPrice * 2n;
  if (left > fee) {
    const hash = await walletOf(hot).sendTransaction({
      to: deployer.address,
      value: left - fee,
      gas: 30_000n,
      gasPrice: gasPrice * 2n,
    });
    await pub.waitForTransactionReceipt({hash});
  }
  console.log("    the hot key's gas returned to DEPLOYER");
}

console.log(failures === 0 ? '\nAll audit checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
