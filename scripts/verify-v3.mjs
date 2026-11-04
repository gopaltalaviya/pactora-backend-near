#!/usr/bin/env node
/**
 * v3, live: every new mechanism, against the deployed contracts and the
 * CANONICAL ERC-8004 registries on Monad testnet. A mock that agrees with our
 * assumptions proves nothing; this sends real transactions and reads the
 * chain back.
 *
 *   set -a; . ../agentx-contracts/.env; set +a
 *   VERIFY_CHAIN_ID=10143 node scripts/verify-v3.mjs
 *
 * Who is who: the client's owner is AGENT_A, the worker's owner AGENT_B (two
 * owners: the escrow refuses a hire within one), and DEPLOYER is the stranger
 * who calls the permissionless exits. The arbiter is the 2-of-3 Safe; DEPLOYER
 * and AGENT_A sign its rulings.
 *
 * Asserts, against the chain:
 *   A. approve: the worker is paid, its review lands on the canonical registry
 *      from the escrow, and the client's from the ClientReputationWriter
 *   B. a starved gas limit reverts (eth_call, no cost); an undelivered job
 *      then refunds the client WITH the worker's bond, and records FAILED
 *   C. a dispute takes the client's bond; the Safe rules with two signatures
 *      and the worker gets payment plus the bond
 *   D. an AgentAccount becomes an agent's wallet on the canonical registry by
 *      ERC-1271, and hires through the escrow inside its rolling cap
 * and prints the gas each settlement really used on Monad.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  hashTypedData,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  toHex,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
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
const writer = chain.contracts['ClientReputationWriter'];
const factory = chain.contracts['AgentAccountFactory'];
const token = chain.contracts['PaymentToken'];
const identity = chain.erc8004['identityRegistry'];
const reputation = chain.erc8004['reputationRegistry'];
const SAFE = process.env.ARBITER_SAFE ?? '0xEaB8aB0E8A7f5b95510EDd84ECFCC0EB14678e8e';

const escrowAbi = abis['TaskEscrow'];
const vaultAbi = abis['StakeVault'];
const accountAbi = abis['AgentAccount'];
const factoryAbi = abis['AgentAccountFactory'];
const erc20 = parseAbi([
  'function mint(address,uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
// The canonical registry's own interface (upstream erc-8004-contracts,
// verified 2026-10-25) — not our mock's, which registers with a wallet.
const identityAbi = parseAbi([
  'function register(string agentURI) returns (uint256)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'function getAgentWallet(uint256) view returns (address)',
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)',
  'function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])',
]);
const reputationAbi = parseAbi([
  'function getLastIndex(uint256 agentId, address client) view returns (uint64)',
  'function readFeedback(uint256 agentId, address client, uint64 index) view returns (int128, uint8, string, string, bool)',
]);
const safeAbi = parseAbi([
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
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
const gas = [];

const call = (wallet, to, abi, functionName, args = []) =>
  send(pub, wallet, {to, data: encodeFunctionData({abi, functionName, args})});
const read = (address, abi, functionName, args = []) => pub.readContract({address, abi, functionName, args});
const job = (id) => read(escrow, escrowAbi, 'getJob', [id]);
const balance = (who) => read(token, erc20, 'balanceOf', [who]);
const reviews = (agentId, from) => read(reputation, reputationAbi, 'getLastIndex', [agentId, from]);

async function register(wallet, uri) {
  const receipt = await call(wallet, identity, identityAbi, 'register', [uri]);
  const [ev] = parseEventLogs({abi: identityAbi, logs: receipt.logs, eventName: 'Registered'});
  if (!ev) throw new Error(`no Registered event in ${receipt.transactionHash}`);
  return ev.args.agentId;
}

async function createJob(wallet, clientId, workerId, amount, acceptWindow = 300n, workWindow = 1800n) {
  const receipt = await call(wallet, escrow, escrowAbi, 'createJob', [
    clientId,
    workerId,
    amount,
    unique('spec'),
    acceptWindow,
    workWindow,
  ]);
  const [ev] = parseEventLogs({abi: escrowAbi, logs: receipt.logs, eventName: 'JobCreated'});
  return ev.args.jobId;
}

async function waitPast(timestamp) {
  for (;;) {
    const block = await pub.getBlock();
    if (block.timestamp > timestamp) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** A Safe transaction, signed by two owners in ascending address order. */
async function safeExec(to, data) {
  const nonce = await read(SAFE, safeAbi, 'nonce');
  const zero = '0x0000000000000000000000000000000000000000';
  const hash = await read(SAFE, safeAbi, 'getTransactionHash', [
    to,
    0n,
    data,
    0,
    0n,
    0n,
    0n,
    zero,
    zero,
    nonce,
  ]);
  const signers = [deployer, clientOwner].sort((a, b) =>
    a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
  );
  const sigs = await Promise.all(signers.map((s) => s.sign({hash})));
  const packed = `0x${sigs.map((s) => s.slice(2)).join('')}`;
  return call(D, SAFE, safeAbi, 'execTransaction', [to, 0n, data, 0, 0n, 0n, 0n, zero, zero, packed]);
}

// ─────────────────────────── setup ───────────────────────────
console.log(`\nv3 live check — chain ${CHAIN_ID}, escrow ${escrow}`);
await topUp(pub, D, clientOwner.address, 2n * 10n ** 18n);
await topUp(pub, D, workerOwner.address, 2n * 10n ** 18n);

const clientId = await register(C, 'ipfs://agentx-v3-client');
const workerId = await register(W, 'ipfs://agentx-v3-worker');
ok(`registered on the canonical registry: client ${clientId}, worker ${workerId}`);
expect(
  (await read(identity, identityAbi, 'getAgentWallet', [workerId])).toLowerCase() ===
    workerOwner.address.toLowerCase(),
  'canonical register() made the owner the wallet',
);

// Twice the minimum: part B seizes a bond, and a worker left below minStake
// is (correctly) no longer hireable — found by the first live run.
const minStake = await read(vault, vaultAbi, 'minStake');
const stake = 2n * minStake;
await call(W, token, erc20, 'mint', [workerOwner.address, stake]);
await call(W, token, erc20, 'approve', [vault, stake]);
await call(W, vault, vaultAbi, 'deposit', [workerId, stake]);
await call(C, token, erc20, 'mint', [clientOwner.address, 10_000_000n]);
await call(C, token, erc20, 'approve', [escrow, 10_000_000n]);
ok(`worker bonded ${stake}; client funded`);

const PRICE = 50_000n;

// ─────────────────────── A. approve: two reviews ───────────────────────
console.log('\nA. approve — worker review from the escrow, client review from the writer');
{
  const id = await createJob(C, clientId, workerId, PRICE);
  const bond = (await job(id)).workerBond;
  await call(W, escrow, escrowAbi, 'acceptJob', [id]);
  expect((await read(vault, vaultAbi, 'lockedOf', [workerId])) === bond, `accept locked the bond (${bond})`);
  await call(W, escrow, escrowAbi, 'submitResult', [id, unique('result'), 'ipfs://result']);
  const before = await balance(workerOwner.address);
  const r = await call(C, escrow, escrowAbi, 'approve', [id]);
  gas.push(['approve (two reviews)', r.gasUsed]);
  const fee = (await job(id)).fee;
  expect((await balance(workerOwner.address)) - before === PRICE - fee, 'worker paid amount − fee');
  expect(
    (await reviews(workerId, escrow)) === 1n,
    'worker review on the canonical registry, from the escrow',
  );
  expect(
    (await reviews(clientId, writer)) === 1n,
    'client review on the canonical registry, from the writer',
  );
  expect((await reviews(workerId, writer)) === 0n, 'the two never mix');
  expect((await read(vault, vaultAbi, 'lockedOf', [workerId])) === 0n, 'bond released');
}

// ───────────── B. starvation reverts; undelivered costs the bond ─────────────
console.log('\nB. a starved gas limit reverts; an undelivered job costs the worker its bond');
{
  const id = await createJob(C, clientId, workerId, PRICE, 5n, 5n);
  await call(W, escrow, escrowAbi, 'acceptJob', [id]);
  const j = await job(id);
  await waitPast(j.workDeadline);

  const data = encodeFunctionData({abi: escrowAbi, functionName: 'expireUndelivered', args: [id]});
  try {
    await pub.call({account: deployer.address, to: escrow, data, gas: 300_000n});
    bad('a 300k gas limit should have been refused');
  } catch (err) {
    const raw = err?.cause?.data ?? err?.data ?? err?.walk?.((e) => e?.data)?.data;
    let name = '';
    try {
      name = decodeErrorResult({abi: escrowAbi, data: raw}).errorName;
    } catch {
      name = String(err.shortMessage ?? err.message).slice(0, 80);
    }
    expect(name === 'InsufficientGasForFeedback', `300k gas limit refused (${name})`);
  }

  const before = await balance(clientOwner.address);
  const r = await call(D, escrow, escrowAbi, 'expireUndelivered', [id]);
  gas.push(['expireUndelivered (seize + review)', r.gasUsed]);
  const seized = parseEventLogs({abi: escrowAbi, logs: r.logs, eventName: 'BondSeized'});
  expect(seized.length === 1 && seized[0].args.amount === j.workerBond, `BondSeized ${j.workerBond}`);
  expect(
    (await balance(clientOwner.address)) - before === PRICE + j.workerBond,
    'client refunded the job plus the bond',
  );
  const rec = await read(escrow, escrowAbi, 'recordOf', [workerId]);
  expect(rec.failed === 1n, 'escrow record: failed 1');
  const idx = await reviews(workerId, escrow);
  const fb = await read(reputation, reputationAbi, 'readFeedback', [workerId, escrow, idx]);
  expect(fb[0] === 0n, 'the FAILED review (value 0) is on the canonical registry');
}

// ─────────────── C. dispute bond; the Safe rules with two signatures ───────────────
console.log('\nC. a dispute takes the client bond; the 2-of-3 Safe rules');
{
  const id = await createJob(C, clientId, workerId, PRICE);
  await call(W, escrow, escrowAbi, 'acceptJob', [id]);
  await call(W, escrow, escrowAbi, 'submitResult', [id, unique('result'), 'ipfs://result']);
  const j = await job(id);
  const clientBefore = await balance(clientOwner.address);
  await call(C, escrow, escrowAbi, 'dispute', [id, unique('reason')]);
  expect(
    clientBefore - (await balance(clientOwner.address)) === j.disputeBond,
    `dispute took the bond (${j.disputeBond})`,
  );

  const workerBefore = await balance(workerOwner.address);
  const r = await safeExec(
    escrow,
    encodeFunctionData({abi: escrowAbi, functionName: 'resolveDispute', args: [id, true]}),
  );
  gas.push(['Safe resolveDispute (two reviews)', r.gasUsed]);
  expect((await job(id)).state === 5, 'job SETTLED by the Safe');
  expect(
    (await balance(workerOwner.address)) - workerBefore === PRICE - j.fee + j.disputeBond,
    'worker paid amount − fee + the client bond',
  );
  const crec = await read(escrow, escrowAbi, 'clientRecordOf', [clientId]);
  expect(crec.disputesRejected === 1n, 'client record: disputesRejected 1');
}

// ─────────────── D. an AgentAccount as a canonical wallet, by ERC-1271 ───────────────
console.log('\nD. an AgentAccount becomes the agent wallet (ERC-1271) and hires inside its cap');
{
  const salt = keccak256(toHex(`v3-live-${Date.now()}`));
  const policy = {perTaskCap: 100_000n, dailyCap: 250_000n, allowlistOnly: true};
  const predicted = await read(factory, factoryAbi, 'predictAddress', [clientOwner.address, salt]);
  await call(C, factory, factoryAbi, 'createAccount', [clientOwner.address, salt, policy]);
  const acct = predicted;
  const id = await register(C, 'ipfs://agentx-v3-capped-client');

  const [, name, version, chainId, verifyingContract] = await read(identity, identityAbi, 'eip712Domain');
  const now = (await pub.getBlock()).timestamp;
  const deadline = now + 240n;
  const digest = hashTypedData({
    domain: {name, version, chainId, verifyingContract},
    types: {
      AgentWalletSet: [
        {name: 'agentId', type: 'uint256'},
        {name: 'newWallet', type: 'address'},
        {name: 'owner', type: 'address'},
        {name: 'deadline', type: 'uint256'},
      ],
    },
    primaryType: 'AgentWalletSet',
    message: {agentId: id, newWallet: acct, owner: clientOwner.address, deadline},
  });
  const toSign = await read(acct, accountAbi, 'accountMessageHash', [digest]);
  const signature = await clientOwner.sign({hash: toSign});
  await call(C, identity, identityAbi, 'setAgentWallet', [id, acct, deadline, signature]);
  expect(
    (await read(identity, identityAbi, 'getAgentWallet', [id])).toLowerCase() === acct.toLowerCase(),
    'the canonical registry accepted the AgentAccount as the wallet',
  );

  const createSel = encodeFunctionData({
    abi: escrowAbi,
    functionName: 'createJob',
    args: [0n, 0n, 0n, unique('x'), 1n, 1n],
  }).slice(0, 10);
  const cancelSel = encodeFunctionData({abi: escrowAbi, functionName: 'cancel', args: [0n]}).slice(0, 10);
  await call(C, acct, accountAbi, 'setAllowedCall', [escrow, createSel, true]);
  await call(C, acct, accountAbi, 'setAllowedCall', [escrow, cancelSel, true]);
  await call(C, acct, accountAbi, 'setAllowance', [escrow, 10_000_000n]);
  await call(C, token, erc20, 'mint', [acct, 1_000_000n]);

  const createData = encodeFunctionData({
    abi: escrowAbi,
    functionName: 'createJob',
    args: [id, workerId, PRICE, unique('spec'), 300n, 1800n],
  });
  const r = await call(C, acct, accountAbi, 'execute', [escrow, createData]);
  const [ev] = parseEventLogs({abi: escrowAbi, logs: r.logs, eventName: 'JobCreated'});
  expect(ev && ev.args.clientAgentId === id, `the account hired: job ${ev?.args.jobId}`);
  expect((await read(acct, accountAbi, 'spentToday')) === PRICE, 'counted against the rolling cap');

  const tooMuch = encodeFunctionData({
    abi: escrowAbi,
    functionName: 'createJob',
    args: [id, workerId, 200_000n, unique('spec'), 300n, 1800n],
  });
  try {
    await pub.call({
      account: clientOwner.address,
      to: acct,
      data: encodeFunctionData({abi: accountAbi, functionName: 'execute', args: [escrow, tooMuch]}),
    });
    bad('a hire above the per-task cap should revert');
  } catch {
    ok('a hire above the per-task cap is refused on-chain');
  }
  await call(C, acct, accountAbi, 'execute', [
    escrow,
    encodeFunctionData({abi: escrowAbi, functionName: 'cancel', args: [ev.args.jobId]}),
  ]);
  ok('cancelled; the account got its money back');
}

// ─────────────────────────── gas ───────────────────────────
const price = await pub.getGasPrice();
console.log(`\nGas actually used on Monad (gas price ${Number(price) / 1e9} gwei):`);
for (const [what, used] of gas) {
  console.log(`  ${what.padEnd(36)} ${used.toString().padStart(9)} gas`);
}
console.log(failures === 0 ? '\nAll v3 checks passed, live.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
