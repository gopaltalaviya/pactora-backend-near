#!/usr/bin/env node
/**
 * Spike: does Monad testnet accept EIP-7702 (type-4) transactions?
 *
 * A fact to establish before designing on it (plan Phase 4.1), with real
 * transactions rather than a reading of the docs:
 *   1. a throwaway EOA, funded with a little MON, signs an authorization
 *      delegating to the v3 MockUSDC, and sends it in a type-4 transaction
 *      that calls decimals() on itself — calldata the delegate understands.
 *      (The first two runs sent empty calldata, which MockUSDC, having no
 *      fallback, rightly reverted — and stranded 0.05 MON each, because the
 *      key lived only in memory. Hence the `finally` below.)
 *   2. its code must become 0xef0100 ‖ MockUSDC, and a read of the EOA must
 *      run MockUSDC's code (decimals() = 6, from an address with no contract);
 *   3. it delegates to address(0) and its code must be empty again;
 *   4. what is left of the MON goes back to the funder, whatever happened.
 *
 *   set -a; . ../agentx-contracts/.env; set +a
 *   VERIFY_CHAIN_ID=10143 node scripts/spike-7702.mjs
 */
import {createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, zeroAddress} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {foundry} from 'viem/chains';
import {loadConfig} from '@pactora/config';

const CHAIN_ID = Number(process.env.VERIFY_CHAIN_ID ?? 10143);
const chain = loadConfig().chain(CHAIN_ID);
if (!chain.testnet) throw new Error(`chain ${CHAIN_ID} is not a testnet`);
const viemChain = {...foundry, id: CHAIN_ID};
const pub = createPublicClient({chain: viemChain, transport: http(chain.rpcUrl)});
const funderKey = process.env.FUNDER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
if (!funderKey) throw new Error('FUNDER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) is not set');
const funder = createWalletClient({
  account: privateKeyToAccount(funderKey),
  chain: viemChain,
  transport: http(chain.rpcUrl),
});
const eoa = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({account: eoa, chain: viemChain, transport: http(chain.rpcUrl)});
const target = chain.contracts['PaymentToken']; // v3 MockUSDC
const decimalsAbi = parseAbi(['function decimals() view returns (uint8)']);
const decimalsCall = encodeFunctionData({abi: decimalsAbi, functionName: 'decimals'});

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

console.log(`\nEIP-7702 spike — chain ${CHAIN_ID}, throwaway ${eoa.address}, target ${target}`);
const funded = await mined(await funder.sendTransaction({to: eoa.address, value: 50_000_000_000_000_000n}));
// Sending straight after the funding block failed 2 of 4 runs with "Signer had
// insufficient balance" — consistent with Monad checking the gas payer's
// balance against state a few blocks behind the head. Wait three blocks.
while ((await pub.getBlockNumber()) < funded.blockNumber + 3n) await new Promise((r) => setTimeout(r, 400));

try {
  // 1–2. Delegate, in a type-4 transaction that calls the delegate's code.
  const auth = await wallet.signAuthorization({contractAddress: target, executor: 'self'});
  const set = await mined(
    await wallet.sendTransaction({to: eoa.address, authorizationList: [auth], data: decimalsCall}),
  );
  const tx = await pub.getTransaction({hash: set.transactionHash});
  expect(tx.type === 'eip7702', `the chain mined a type-4 transaction (${set.transactionHash})`);
  const code = await pub.getCode({address: eoa.address});
  expect(
    code?.toLowerCase() === `0xef0100${target.slice(2).toLowerCase()}`,
    `the EOA's code is the delegation designator: ${code}`,
  );
  const decimals = await pub.readContract({address: eoa.address, abi: decimalsAbi, functionName: 'decimals'});
  expect(decimals === 6, `a call to the EOA runs the delegate's code (decimals() = ${decimals})`);
  console.log(`    gas used: ${set.gasUsed}`);

  // 3. Revoke: the authorization is applied before the call runs, so the
  // call meets an EOA with no code again.
  const revoke = await wallet.signAuthorization({contractAddress: zeroAddress, executor: 'self'});
  const cleared = await mined(
    await wallet.sendTransaction({to: eoa.address, authorizationList: [revoke], data: '0x'}),
  );
  const after = await pub.getCode({address: eoa.address});
  expect(!after || after === '0x', `delegating to address(0) clears it (${cleared.transactionHash})`);
} catch (err) {
  failures++;
  console.log(`  ✗ ${err.shortMessage ?? err.message}`);
  // The RPC's own words, for the record.
  console.log(`    details: ${err.details ?? '-'}`);
  console.log(`    cause: ${err.cause?.shortMessage ?? err.cause?.message ?? '-'}`);
} finally {
  // 4. Sent to the funder, never to itself: a still-delegated EOA would run
  // the delegate on a plain transfer. Monad charges the gas limit — margin.
  const gasPrice = await pub.getGasPrice();
  const left = await pub.getBalance({address: eoa.address});
  const fee = 30_000n * gasPrice * 2n;
  if (left > fee) {
    await mined(
      await wallet.sendTransaction({
        to: funder.account.address,
        value: left - fee,
        gas: 30_000n,
        gasPrice: gasPrice * 2n,
      }),
    );
    console.log(`    returned ${left - fee} wei to the funder`);
  }
}

console.log(failures === 0 ? '\nEIP-7702 works on this chain.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
