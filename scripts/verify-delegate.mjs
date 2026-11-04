#!/usr/bin/env node
/**
 * v3, live: an EOA delegates to AgentDelegate by EIP-7702 and its agent's
 * session key is capped ON CHAIN — on Monad testnet, real transactions, every
 * claim read back from the chain.
 *
 *   set -a; . ../agentx-contracts/.env; set +a
 *   VERIFY_CHAIN_ID=10143 node scripts/verify-delegate.mjs
 *
 * Two throwaway keys — the EOA and its agent's hot key — funded from FUNDER
 * and swept back in `finally`, whatever happens.
 *
 * Asserts:
 *   A. one type-4 transaction delegates AND initialises (the EOA calling
 *      itself): code = 0xef0100 ‖ AgentDelegate, owner() = the EOA, the caps
 *   B. the EOA, as owner, allowlists the token's transfer and grants a session
 *      key; the hot key spends within the caps through execute
 *   C. refused, simulated at no cost: one spend over the per-task cap, the
 *      spend that would break the daily cap, a stranger, and the hot key
 *      reaching the EOA's own sweep through execute
 *   D. the delegation is revoked and the EOA's code is empty again
 */
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  http,
  parseAbi,
  zeroAddress,
} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {foundry} from 'viem/chains';
import {loadConfig, loadAbis} from '@pactora/config';

const CHAIN_ID = Number(process.env.VERIFY_CHAIN_ID ?? 10143);
const chain = loadConfig().chain(CHAIN_ID);
if (!chain.testnet) throw new Error(`chain ${CHAIN_ID} is not a testnet — this script sends transactions`);
const abis = loadAbis();
const delegateAbi = abis['AgentDelegate'];
const delegate = chain.contracts['AgentDelegate'];
const token = chain.contracts['PaymentToken'];
if (!delegate || !delegateAbi) throw new Error('no AgentDelegate in the deployment record / ABIs');
const erc20 = parseAbi([
  'function mint(address,uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

const viemChain = {...foundry, id: CHAIN_ID};
const pub = createPublicClient({chain: viemChain, transport: http(chain.rpcUrl)});
const walletOf = (account) => createWalletClient({account, chain: viemChain, transport: http(chain.rpcUrl)});
const funderKey = process.env.FUNDER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
if (!funderKey) throw new Error('FUNDER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) is not set');
const funder = walletOf(privateKeyToAccount(funderKey));
const eoa = privateKeyToAccount(generatePrivateKey());
const hot = privateKeyToAccount(generatePrivateKey());
const E = walletOf(eoa);
const H = walletOf(hot);

const PER_TASK = 100_000n; // 0.10 MockUSDC
const DAILY = 250_000n; // 0.25
const sink = '0x000000000000000000000000000000000000dEaD';

let failures = 0;
const expect = (cond, m) => {
  console.log(`  ${cond ? '✓' : '✗'} ${m}`);
  if (!cond) failures++;
};
const mined = async (hash) => {
  const r = await pub.waitForTransactionReceipt({hash});
  if (r.status !== 'success') throw new Error(`${hash} reverted`);
  return r;
};
const read = (functionName, args = []) =>
  pub.readContract({address: eoa.address, abi: delegateAbi, functionName, args});
/** The EOA calling itself: how an owner acts on a delegated EOA. */
const self = (functionName, args) =>
  E.sendTransaction({to: eoa.address, data: encodeFunctionData({abi: delegateAbi, functionName, args})}).then(
    mined,
  );
const exec = (from, target, data) =>
  encodeFunctionData({abi: delegateAbi, functionName: 'execute', args: [target, data]});
/** Simulate a call and name the custom error it reverts with. */
async function refusal(from, data) {
  try {
    await pub.call({account: from, to: eoa.address, data});
    return 'no revert';
  } catch (err) {
    const raw = err?.cause?.data ?? err?.data ?? err?.walk?.((e) => e?.data)?.data;
    try {
      const d = decodeErrorResult({abi: delegateAbi, data: raw});
      // CallFailed wraps the inner revert; name that too.
      if (d.errorName === 'CallFailed') {
        try {
          return `CallFailed(${decodeErrorResult({abi: delegateAbi, data: d.args[0]}).errorName})`;
        } catch {
          return 'CallFailed';
        }
      }
      return d.errorName;
    } catch {
      return String(err.shortMessage ?? err.message).slice(0, 80);
    }
  }
}

console.log(`\nAgentDelegate live check — chain ${CHAIN_ID}, delegate ${delegate}`);
console.log(`  EOA ${eoa.address}, hot key ${hot.address}`);
const f1 = await mined(await funder.sendTransaction({to: eoa.address, value: 300_000_000_000_000_000n}));
await mined(await funder.sendTransaction({to: hot.address, value: 100_000_000_000_000_000n}));
// Found by spike-7702: a balance funded in the last couple of blocks is not
// yet spendable for gas on Monad. Wait three.
while ((await pub.getBlockNumber()) < f1.blockNumber + 3n) await new Promise((r) => setTimeout(r, 400));

try {
  console.log('\nA. one type-4 transaction delegates and initialises');
  const auth = await E.signAuthorization({contractAddress: delegate, executor: 'self'});
  const init = await mined(
    await E.sendTransaction({
      to: eoa.address,
      authorizationList: [auth],
      data: encodeFunctionData({
        abi: delegateAbi,
        functionName: 'initialize',
        args: [token, {perTaskCap: PER_TASK, dailyCap: DAILY, allowlistOnly: true}],
      }),
    }),
  );
  expect(
    (await pub.getTransaction({hash: init.transactionHash})).type === 'eip7702',
    `type-4 ${init.transactionHash}`,
  );
  const code = await pub.getCode({address: eoa.address});
  expect(code?.toLowerCase() === `0xef0100${delegate.slice(2).toLowerCase()}`, `designator ${code}`);
  expect((await read('owner')).toLowerCase() === eoa.address.toLowerCase(), 'owner() is the EOA itself');
  const [perTask, daily, only] = await read('policy');
  expect(perTask === PER_TASK && daily === DAILY && only, `caps ${perTask}/${daily}, allowlist only`);

  console.log('\nB. the owner sets up a session; the hot key spends within the caps');
  await mined(
    await funder.writeContract({
      address: token,
      abi: erc20,
      functionName: 'mint',
      args: [eoa.address, 1_000_000n],
    }),
  );
  const transferSel = encodeFunctionData({abi: erc20, functionName: 'transfer', args: [sink, 0n]}).slice(
    0,
    10,
  );
  await self('setAllowedCall', [token, transferSel, true]);
  const now = (await pub.getBlock()).timestamp;
  await self('grantSessionKey', [hot.address, now + 3600n, DAILY]);
  const pay = (amount) => encodeFunctionData({abi: erc20, functionName: 'transfer', args: [sink, amount]});
  const before = await pub.readContract({
    address: token,
    abi: erc20,
    functionName: 'balanceOf',
    args: [eoa.address],
  });
  await mined(await H.sendTransaction({to: eoa.address, data: exec(hot.address, token, pay(PER_TASK))}));
  await mined(await H.sendTransaction({to: eoa.address, data: exec(hot.address, token, pay(PER_TASK))}));
  const after = await pub.readContract({
    address: token,
    abi: erc20,
    functionName: 'balanceOf',
    args: [eoa.address],
  });
  expect(before - after === 2n * PER_TASK, `the hot key spent ${before - after} through execute`);
  expect((await read('spentToday')) === 2n * PER_TASK, `spentToday ${await read('spentToday')}`);

  console.log('\nC. refused (simulated, no cost)');
  expect(
    (await refusal(hot.address, exec(hot.address, token, pay(PER_TASK + 1n)))) === 'PerTaskCapExceeded',
    'one spend over the per-task cap: PerTaskCapExceeded',
  );
  expect(
    (await refusal(hot.address, exec(hot.address, token, pay(PER_TASK)))) === 'DailyCapExceeded',
    'past the rolling daily cap: DailyCapExceeded',
  );
  const stranger = privateKeyToAccount(generatePrivateKey()).address;
  expect(
    (await refusal(stranger, exec(stranger, token, pay(1n)))) === 'NotAuthorized',
    'a stranger: NotAuthorized',
  );
  const sweepCall = encodeFunctionData({abi: delegateAbi, functionName: 'sweep', args: [hot.address, 1n]});
  expect(
    (await refusal(hot.address, exec(hot.address, eoa.address, sweepCall))) === 'TargetNotAllowed',
    "the hot key reaching the EOA's own sweep: TargetNotAllowed",
  );
  expect(
    (await refusal(hot.address, sweepCall)) === 'NotOwner',
    'the hot key calling sweep directly: NotOwner',
  );

  console.log('\nD. the delegation is revoked');
  const revoke = await E.signAuthorization({contractAddress: zeroAddress, executor: 'self'});
  const r = await mined(await E.sendTransaction({to: eoa.address, authorizationList: [revoke], data: '0x'}));
  const cleared = await pub.getCode({address: eoa.address});
  expect(!cleared || cleared === '0x', `code empty again (${r.transactionHash})`);
} catch (err) {
  failures++;
  console.log(`  ✗ ${err.shortMessage ?? err.message}`);
  if (err.details) console.log(`    details: ${err.details}`);
} finally {
  // Native coin back to the funder, from both keys. Sent to the funder, never
  // to itself: a still-delegated EOA would run the delegate on a transfer.
  const gasPrice = await pub.getGasPrice();
  for (const [w, a] of [
    [E, eoa],
    [H, hot],
  ]) {
    const left = await pub.getBalance({address: a.address});
    const fee = 30_000n * gasPrice * 2n;
    if (left > fee) {
      await mined(
        await w.sendTransaction({
          to: funder.account.address,
          value: left - fee,
          gas: 30_000n,
          gasPrice: gasPrice * 2n,
        }),
      );
    }
  }
  console.log('    native coin returned to the funder');
}

console.log(failures === 0 ? '\nAgentDelegate live check passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
