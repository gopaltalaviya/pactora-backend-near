#!/usr/bin/env node
/**
 * v2's newest exit, live: a dispute nobody rules on expires and pays the worker.
 *
 *   node scripts/dispute-expiry.mjs start           # creates a DISPUTED job, prints its id
 *   (wait out disputeTimeoutSeconds — 1 h on testnet)
 *   node scripts/keeper-sweep.mjs <chainJobId>      # the keeper sends expireDispute
 *   node scripts/dispute-expiry.mjs verify <chainJobId> <worker wallet balance printed by start>
 *
 * What `verify` asserts, against the chain:
 *   - the job is SETTLED, and a DisputeExpired event was emitted
 *   - JobSettled carries outcome UNRESOLVED (3)
 *   - the worker was paid (its wallet rose by amount − fee)
 *   - NO feedback was written for it: disputed work earns no reputation by default
 *
 * No API and no model: the client is DEPLOYER, the worker AGENT_B (a
 * different owner — v2 refuses a hire between agents of one owner).
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  parseEventLogs,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {foundry} from 'viem/chains';
import {loadConfig, loadAbis} from '@pactora/config';
import {isCanonicalRegistry, registerAgent, send, topUp, unique} from './lib/chain.mjs';

const CHAIN_ID = Number(process.env.VERIFY_CHAIN_ID ?? 10143);
const [phase, arg1, arg2] = process.argv.slice(2);
const config = loadConfig();
const abis = loadAbis();
const chain = config.chain(CHAIN_ID);
const viemChain = {...foundry, id: CHAIN_ID};
const pub = createPublicClient({chain: viemChain, transport: http(chain.rpcUrl)});

const escrow = chain.contracts['TaskEscrow'];
const escrowAbi = abis['TaskEscrow'];
const token = chain.contracts['PaymentToken'];
const erc20 = parseAbi([
  'function mint(address,uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.error(`  ✗ ${m}`);
  process.exitCode = 1;
};

if (phase === 'start') {
  const client = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
  const worker = privateKeyToAccount(process.env.AGENT_B_PRIVATE_KEY);
  const c = createWalletClient({account: client, chain: viemChain, transport: http(chain.rpcUrl)});
  const w = createWalletClient({account: worker, chain: viemChain, transport: http(chain.rpcUrl)});
  const call = (wallet, address, abi, fn, args) =>
    send(pub, wallet, {to: address, data: encodeFunctionData({abi, functionName: fn, args})});

  await topUp(pub, c, worker.address, 300_000_000_000_000_000n);
  const idAbi = abis['MockIdentityRegistry'];
  const identity = chain.erc8004['identityRegistry'];
  const clientId = await registerAgent(pub, c, {
    identity,
    abi: idAbi,
    canonical: isCanonicalRegistry(chain),
    uri: 'ipfs://dispute-client',
    wallet: client.address,
  });
  const workerId = await registerAgent(pub, w, {
    identity,
    abi: idAbi,
    canonical: isCanonicalRegistry(chain),
    uri: 'ipfs://dispute-worker',
    wallet: worker.address,
  });
  await call(c, token, erc20, 'mint', [client.address, 100_000_000n]);
  await call(c, token, erc20, 'approve', [chain.contracts['StakeVault'], 100_000_000n]);
  await call(c, chain.contracts['StakeVault'], abis['StakeVault'], 'deposit', [workerId, 10_000_000n]);
  await call(c, token, erc20, 'approve', [escrow, 100_000_000n]);
  ok(`client ${clientId} (DEPLOYER), worker ${workerId} (AGENT_B, its own owner), worker bonded`);

  const created = await call(c, escrow, escrowAbi, 'createJob', [
    clientId,
    workerId,
    50_000n,
    unique('dispute-spec'),
    300n,
    1800n,
  ]);
  const [ev] = parseEventLogs({abi: escrowAbi, logs: created.logs, eventName: 'JobCreated'});
  const jobId = ev.args.jobId;
  await call(w, escrow, escrowAbi, 'acceptJob', [jobId]);
  await call(w, escrow, escrowAbi, 'submitResult', [jobId, unique('dispute-result'), '']);
  await call(c, escrow, escrowAbi, 'dispute', [jobId, unique('dispute-reason')]);

  const job = await pub.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: 'getJob',
    args: [jobId],
  });
  const balance = await pub.readContract({
    address: token,
    abi: erc20,
    functionName: 'balanceOf',
    args: [worker.address],
  });
  ok(
    `chain job ${jobId} is DISPUTED (state ${job.state}); the arbiter has until ${new Date(Number(job.disputeDeadline) * 1000).toISOString()}`,
  );
  console.log(`\n  then:  node scripts/keeper-sweep.mjs ${jobId}`);
  console.log(`         node scripts/dispute-expiry.mjs verify ${jobId} ${balance}\n`);
} else if (phase === 'verify') {
  const jobId = BigInt(arg1);
  const balanceBefore = BigInt(arg2);
  const job = await pub.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: 'getJob',
    args: [jobId],
  });
  job.state === 5
    ? ok(`chain job ${jobId} is SETTLED`)
    : fail(`chain job ${jobId} is in state ${job.state}, not SETTLED`);

  const head = await pub.getBlockNumber();
  const events = [];
  for (let to = head; to > head - 5_000n && events.length < 2; to -= 100n) {
    const logs = await pub.getContractEvents({
      address: escrow,
      abi: escrowAbi,
      fromBlock: to - 99n,
      toBlock: to,
      args: {jobId},
    });
    events.push(...logs.filter((l) => l.eventName === 'DisputeExpired' || l.eventName === 'JobSettled'));
  }
  const expired = events.find((e) => e.eventName === 'DisputeExpired');
  const settled = events.find((e) => e.eventName === 'JobSettled');
  expired ? ok(`DisputeExpired emitted in ${expired.transactionHash}`) : fail('no DisputeExpired event');
  settled?.args.outcome === 3
    ? ok('JobSettled outcome is UNRESOLVED (3)')
    : fail(`JobSettled outcome is ${settled?.args.outcome}, expected 3`);

  const worker = privateKeyToAccount(process.env.AGENT_B_PRIVATE_KEY);
  const after = await pub.readContract({
    address: token,
    abi: erc20,
    functionName: 'balanceOf',
    args: [worker.address],
  });
  const paid = after - balanceBefore;
  paid === job.amount - job.fee
    ? ok(`the worker was paid ${chain.formatToken(paid)} — it delivered`)
    : fail(`the worker's balance moved ${paid}, expected ${job.amount - job.fee}`);

  const receipt = expired && (await pub.getTransactionReceipt({hash: expired.transactionHash}));
  const feedback = receipt
    ? receipt.logs.filter(
        (l) => l.address.toLowerCase() === chain.erc8004['reputationRegistry'].toLowerCase(),
      )
    : [];
  feedback.length === 0
    ? ok('no feedback was written: disputed work earns no reputation by default')
    : fail(`${feedback.length} feedback log(s) written for an unresolved dispute`);
} else {
  console.error('usage: dispute-expiry.mjs start | verify <chainJobId> <workerBalanceBefore>');
  process.exit(2);
}
