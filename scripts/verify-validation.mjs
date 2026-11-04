#!/usr/bin/env node
/**
 * v3, live: ERC-8004 validation answered by SettlementValidator, against the
 * DEPLOYED Validation Registry on Monad testnet. Real transactions; every
 * claim is read back from the chain.
 *
 *   set -a; . ../agentx-contracts/.env; set +a
 *   VERIFY_CHAIN_ID=10143 node scripts/verify-validation.mjs
 *
 * Who is who, as in verify-v3: the client's owner is AGENT_A, the worker's
 * AGENT_B, DEPLOYER the stranger who asks the validator to answer. The arbiter
 * is the 2-of-3 Safe; DEPLOYER and AGENT_A sign its ruling.
 *
 * Asserts, against the chain:
 *   A. an approved job: the worker's owner requests, a stranger has the
 *      validator respond, and the registry holds 100 tagged agentx-settlement
 *   B. an upheld dispute: the registry holds 0
 *   C. refusals (eth_call, no cost): the same job again, an open job, and a
 *      request answered with another job
 *   D. getSummary over this validator: 2 answers, average 50
 */
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
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
const token = chain.contracts['PaymentToken'];
const validator = chain.contracts['SettlementValidator'];
const identity = chain.erc8004['identityRegistry'];
const registry = chain.erc8004['validationRegistry'];
if (!validator || !registry)
  throw new Error('no SettlementValidator / validationRegistry in the deployment record');
const SAFE = process.env.ARBITER_SAFE ?? '0xEaB8aB0E8A7f5b95510EDd84ECFCC0EB14678e8e';

const escrowAbi = abis['TaskEscrow'];
const vaultAbi = abis['StakeVault'];
const validatorAbi = abis['SettlementValidator'];
const erc20 = parseAbi([
  'function mint(address,uint256)',
  'function approve(address,uint256) returns (bool)',
]);
const identityAbi = parseAbi([
  'function register(string agentURI) returns (uint256)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
]);
// The deployed registry's own interface (upstream 27caef9, version 2.0.0).
const registryAbi = parseAbi([
  'function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)',
  'function getValidationStatus(bytes32 requestHash) view returns (address, uint256, uint8, bytes32, string, uint256)',
  'function getSummary(uint256 agentId, address[] validatorAddresses, string tag) view returns (uint64, uint8)',
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

const call = (wallet, to, abi, functionName, args = []) =>
  send(pub, wallet, {to, data: encodeFunctionData({abi, functionName, args})});
const read = (address, abi, functionName, args = []) => pub.readContract({address, abi, functionName, args});

async function register(wallet, uri) {
  const receipt = await call(wallet, identity, identityAbi, 'register', [uri]);
  const [ev] = parseEventLogs({abi: identityAbi, logs: receipt.logs, eventName: 'Registered'});
  if (!ev) throw new Error(`no Registered event in ${receipt.transactionHash}`);
  return ev.args.agentId;
}

async function submitted(clientId, workerId) {
  const receipt = await call(C, escrow, escrowAbi, 'createJob', [
    clientId,
    workerId,
    PRICE,
    unique('spec'),
    300n,
    1800n,
  ]);
  const [ev] = parseEventLogs({abi: escrowAbi, logs: receipt.logs, eventName: 'JobCreated'});
  const id = ev.args.jobId;
  await call(W, escrow, escrowAbi, 'acceptJob', [id]);
  await call(W, escrow, escrowAbi, 'submitResult', [id, unique('result'), 'ipfs://result']);
  return id;
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

/** The worker's owner asks; a stranger has the validator answer. */
async function validate(jobId, workerId) {
  const salt = keccak256(toHex(`validate-${jobId}-${Date.now()}`));
  const requestHash = await read(validator, validatorAbi, 'requestHashOf', [jobId, salt]);
  await call(W, registry, registryAbi, 'validationRequest', [
    validator,
    workerId,
    chain.explorerAddress(escrow),
    requestHash,
  ]);
  const r = await call(D, validator, validatorAbi, 'respond', [jobId, salt]);
  return {requestHash, salt, gasUsed: r.gasUsed, tx: r.transactionHash};
}

/** Simulate a call and name the custom error it reverts with. */
async function refusal(fn, args) {
  try {
    await pub.call({
      account: deployer.address,
      to: validator,
      data: encodeFunctionData({abi: validatorAbi, functionName: fn, args}),
    });
    return 'no revert';
  } catch (err) {
    const raw = err?.cause?.data ?? err?.data ?? err?.walk?.((e) => e?.data)?.data;
    try {
      return decodeErrorResult({abi: validatorAbi, data: raw}).errorName;
    } catch {
      return String(err.shortMessage ?? err.message).slice(0, 80);
    }
  }
}

const PRICE = 50_000n;

console.log(`\nvalidation live check — chain ${CHAIN_ID}, validator ${validator}, registry ${registry}`);
await topUp(pub, D, clientOwner.address, 2n * 10n ** 18n);
await topUp(pub, D, workerOwner.address, 2n * 10n ** 18n);
const clientId = await register(C, 'ipfs://agentx-v3-validation-client');
const workerId = await register(W, 'ipfs://agentx-v3-validation-worker');
const minStake = await read(vault, vaultAbi, 'minStake');
await call(W, token, erc20, 'mint', [workerOwner.address, 2n * minStake]);
await call(W, token, erc20, 'approve', [vault, 2n * minStake]);
await call(W, vault, vaultAbi, 'deposit', [workerId, 2n * minStake]);
await call(C, token, erc20, 'mint', [clientOwner.address, 10_000_000n]);
await call(C, token, erc20, 'approve', [escrow, 10_000_000n]);
ok(`fresh agents on the canonical registry: client ${clientId}, worker ${workerId}`);

console.log('\nA. an approved job validates at 100');
const approvedId = await submitted(clientId, workerId);
await call(C, escrow, escrowAbi, 'approve', [approvedId]);
const a = await validate(approvedId, workerId);
{
  const [v, agentId, response, , tag] = await read(registry, registryAbi, 'getValidationStatus', [
    a.requestHash,
  ]);
  expect(v.toLowerCase() === validator.toLowerCase(), 'the registry names SettlementValidator');
  expect(agentId === workerId, `for worker ${workerId}`);
  expect(response === 100 && tag === 'agentx-settlement', `response ${response}, tag ${tag}`);
  console.log(`    respond ${a.tx} — ${a.gasUsed} gas`);
}

console.log('\nB. an upheld dispute validates at 0');
const disputedId = await submitted(clientId, workerId);
await call(C, escrow, escrowAbi, 'dispute', [disputedId, unique('reason')]);
await safeExec(
  escrow,
  encodeFunctionData({abi: escrowAbi, functionName: 'resolveDispute', args: [disputedId, false]}),
);
expect((await read(escrow, escrowAbi, 'getJob', [disputedId])).state === 6, 'the Safe upheld it: REFUNDED');
const b = await validate(disputedId, workerId);
{
  const [, , response] = await read(registry, registryAbi, 'getValidationStatus', [b.requestHash]);
  expect(response === 0, `response ${response}`);
}

console.log('\nC. refusals (simulated, no cost)');
expect(
  (await refusal('respond', [approvedId, a.salt])) === 'AlreadyAnswered',
  'the same job again: AlreadyAnswered',
);
const openId = await submitted(clientId, workerId);
{
  const salt = keccak256(toHex(`open-${openId}`));
  const h = await read(validator, validatorAbi, 'requestHashOf', [openId, salt]);
  await call(W, registry, registryAbi, 'validationRequest', [validator, workerId, '', h]);
  expect((await refusal('respond', [openId, salt])) === 'NotAttributable', 'an open job: NotAttributable');
  // The request was for the open job; answering it as the approved one is a
  // different hash, so there is nothing to answer.
  expect((await refusal('respond', [disputedId, salt])) === 'AlreadyAnswered', 'job B already answered');
  const fresh = await submitted(clientId, workerId);
  await call(C, escrow, escrowAbi, 'approve', [fresh]);
  expect(
    (await refusal('respond', [fresh, salt])) === 'NoSuchRequest',
    "another job with the open job's salt: NoSuchRequest",
  );
  await call(C, escrow, escrowAbi, 'approve', [openId]); // leave nothing open
}

console.log('\nD. the registry summary over this validator');
{
  const [count, avg] = await read(registry, registryAbi, 'getSummary', [
    workerId,
    [validator],
    'agentx-settlement',
  ]);
  expect(count === 2n && avg === 50, `getSummary: ${count} answers, average ${avg}`);
}

console.log(failures === 0 ? '\nValidation live check passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
