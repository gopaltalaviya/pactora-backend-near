/**
 * Live drill of the v3 pause roles on Monad testnet, after the hand-over
 * (agentx-contracts `make handover`, docs/21): the Safe holds PAUSER and the
 * default admin; the deployer holds neither.
 *
 * 1. Nobody but a pauser can pause: the deployer and an agent key are refused.
 * 2. The Safe pauses (as PAUSER) — `createJob` now reverts EnforcedPause.
 * 3. The deployer cannot unpause; the Safe (as admin) does.
 *
 * Exits stay open while paused — unit-tested (TaskEscrow.t.sol,
 * V3Pauser.t.sol); here the roles are what is proven on the real chain.
 *
 *   set -a; . ../agentx-contracts/.env; set +a
 *   node scripts/verify-pause.mjs        # two Safe transactions, ~0.01 MON
 */
import {createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {foundry} from 'viem/chains';
import {loadConfig, loadAbis} from '@pactora/config';
import {send} from './lib/chain.mjs';

const CHAIN_ID = Number(process.env.VERIFY_CHAIN_ID ?? 10143);
const chain = loadConfig().chain(CHAIN_ID);
if (!chain.testnet) throw new Error(`chain ${CHAIN_ID} is not a testnet — this script sends transactions`);
const escrowAbi = loadAbis()['TaskEscrow'];
const viemChain = {...foundry, id: CHAIN_ID};
const pub = createPublicClient({chain: viemChain, transport: http(chain.rpcUrl)});
const escrow = chain.contracts['TaskEscrow'];
const SAFE = process.env.ADMIN_SAFE ?? '0xEaB8aB0E8A7f5b95510EDd84ECFCC0EB14678e8e';

const keyed = (name) => {
  if (!process.env[name]) throw new Error(`${name} is not set — load agentx-contracts/.env first`);
  return privateKeyToAccount(process.env[name]);
};
const deployer = keyed('DEPLOYER_PRIVATE_KEY');
const ownerA = keyed('AGENT_A_PRIVATE_KEY');
const agent = keyed('AGENT_B_PRIVATE_KEY');
const D = createWalletClient({account: deployer, chain: viemChain, transport: http(chain.rpcUrl)});

const safeAbi = parseAbi([
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
]);
const zero = '0x0000000000000000000000000000000000000000';

/** A Safe transaction, signed by two owners in ascending address order. */
async function safeExec(to, data) {
  const nonce = await pub.readContract({address: SAFE, abi: safeAbi, functionName: 'nonce'});
  const hash = await pub.readContract({
    address: SAFE,
    abi: safeAbi,
    functionName: 'getTransactionHash',
    args: [to, 0n, data, 0, 0n, 0n, 0n, zero, zero, nonce],
  });
  const signers = [deployer, ownerA].sort((a, b) =>
    a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
  );
  const packed = `0x${(await Promise.all(signers.map((s) => s.sign({hash})))).map((s) => s.slice(2)).join('')}`;
  return send(pub, D, {
    to: SAFE,
    data: encodeFunctionData({
      abi: safeAbi,
      functionName: 'execTransaction',
      args: [to, 0n, data, 0, 0n, 0n, 0n, zero, zero, packed],
    }),
  });
}

let failures = 0;
const expect = (cond, m) => {
  console.log(`  ${cond ? '✓' : '✗'} ${m}`);
  if (!cond) failures++;
};
const paused = () => pub.readContract({address: escrow, abi: escrowAbi, functionName: 'paused'});
/** The revert's error name, or null when the call would succeed. */
async function refusal(account, functionName, args = []) {
  try {
    await pub.simulateContract({account, address: escrow, abi: escrowAbi, functionName, args});
    return null;
  } catch (err) {
    return err.cause?.data?.errorName ?? err.shortMessage ?? 'reverted';
  }
}
const createJobArgs = [1n, 2n, 50_000n, `0x${'ab'.repeat(32)}`, 300n, 1800n];

console.log(`TaskEscrow ${escrow}, Safe ${SAFE}\n`);
expect(!(await paused()), 'not paused to begin with');
expect(
  (await refusal(deployer, 'pause')) === 'AccessControlUnauthorizedAccount',
  'the deployer cannot pause',
);
expect((await refusal(agent, 'pause')) === 'AccessControlUnauthorizedAccount', 'an agent key cannot pause');

try {
  await safeExec(escrow, encodeFunctionData({abi: escrowAbi, functionName: 'pause'}));
  expect(await paused(), 'the Safe paused, as PAUSER');
  expect(
    (await refusal(agent, 'createJob', createJobArgs)) === 'EnforcedPause',
    'createJob now reverts EnforcedPause',
  );
  expect(
    (await refusal(deployer, 'unpause')) === 'AccessControlUnauthorizedAccount',
    'the deployer cannot unpause',
  );
} finally {
  // Never leave the testnet escrow paused, whatever failed above.
  if (await paused()) await safeExec(escrow, encodeFunctionData({abi: escrowAbi, functionName: 'unpause'}));
}
expect(!(await paused()), 'the Safe unpaused, as admin');

console.log(failures ? `\n✗ ${failures} check(s) failed` : '\nPause roles verified, live.');
process.exit(failures ? 1 : 0);
