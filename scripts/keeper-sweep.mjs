#!/usr/bin/env node
/**
 * One keeper sweep, then exit — and proof of what it did.
 *
 *   node scripts/keeper-sweep.mjs            # every open escrow job in the database
 *   node scripts/keeper-sweep.mjs 41 42      # these on-chain job ids only
 *
 * The signer runs the same sweep on a timer when KEEPER_PRIVATE_KEY is set.
 * This exists for the checks that outlive a demo run: `DEMO_CHAOS=mid-job`
 * leaves a job in escrow until its work deadline, half an hour later, and
 * every demo run wipes the database — so explicit ids are accepted.
 *
 * For each exit it sends, it reads the job back from the chain and reports
 * the state it ended in, and the client's refund where there was one. It
 * asserts on the chain, not on its own log.
 *
 * Needs: KEEPER_PRIVATE_KEY (falls back to FUNDER_PRIVATE_KEY, which is what
 * the testnet .env holds), VERIFY_CHAIN_ID, PACTORA_CONTRACTS_ROOT.
 */

import {createPublicClient, http} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {loadConfig, loadAbis} from '@pactora/config';
import {createDb, closeDb} from '@pactora/db';
import {chainKeeper, dueExit} from '../apps/signer/dist/keeper.js';

const CHAIN_ID = Number(process.env.VERIFY_CHAIN_ID ?? 31337);
const config = loadConfig({
  env: {...process.env, ENABLED_CHAIN_IDS: String(CHAIN_ID), DEFAULT_CHAIN_ID: String(CHAIN_ID)},
});
const chain = config.chain(CHAIN_ID);
const abis = loadAbis();

const key = process.env.KEEPER_PRIVATE_KEY ?? process.env.FUNDER_PRIVATE_KEY;
if (!key) {
  console.error('KEEPER_PRIVATE_KEY (or FUNDER_PRIVATE_KEY) is not set');
  process.exit(2);
}
if (!chain.testnet) {
  console.error(`chain ${CHAIN_ID} is not a testnet; a raw keeper key is for testnet only`);
  process.exit(2);
}

const STATE = ['NONE', 'CREATED', 'ACCEPTED', 'SUBMITTED', 'DISPUTED', 'SETTLED', 'REFUNDED'];
const escrow = chain.contracts['TaskEscrow'];
const pub = createPublicClient({transport: http(chain.rpcUrl)});
const readJob = (id) =>
  pub.readContract({address: escrow, abi: abis['TaskEscrow'], functionName: 'getJob', args: [id]});

const db = createDb(process.env.DATABASE_URL ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near');
const ids = process.argv.slice(2).map((a) => BigInt(a));
const keeper = chainKeeper({
  db,
  chain,
  abis,
  account: privateKeyToAccount(key),
  // Same sweep, over the ids given rather than the database's view.
  ...(ids.length > 0 ? {openJobs: async () => ids} : {}),
});

const now = (await pub.getBlock({blockTag: 'latest'})).timestamp;
if (ids.length > 0) {
  for (const id of ids) {
    const job = await readJob(id);
    const exit = dueExit(job, now);
    const waitFor =
      [0n, job.acceptDeadline, job.workDeadline, job.reviewDeadline, job.disputeDeadline ?? 0n][job.state] ??
      0n;
    console.log(
      `  job ${id}: ${STATE[job.state]}` +
        (exit
          ? ` — ${exit} is due`
          : waitFor > now
            ? ` — nothing due for ${waitFor - now}s`
            : ' — nothing to do'),
    );
  }
}

const result = await keeper.sweep();
let failures = result.failed.length;

for (const s of result.sent) {
  const after = await readJob(BigInt(s.chainJobId));
  const state = STATE[after.state];
  // An expired dispute settles in the worker's favour (outcome UNRESOLVED),
  // so it ends SETTLED like an auto-approval; only the refunds end REFUNDED.
  const expected = s.exit === 'autoApprove' || s.exit === 'expireDispute' ? 'SETTLED' : 'REFUNDED';
  if (state === expected) {
    console.log(`  ✓ job ${s.chainJobId}: ${s.exit} → ${state}  ${chain.explorerTx(s.txHash)}`);
  } else {
    failures++;
    console.log(`  ✗ job ${s.chainJobId}: ${s.exit} sent, but the chain says ${state}`);
  }
}
for (const f of result.failed) console.log(`  ✗ job ${f.chainJobId}: ${f.exit} not sent — ${f.reason}`);
if (result.sent.length === 0 && result.failed.length === 0)
  console.log(`  checked ${result.checked}, nothing was due`);

await closeDb(db);
process.exit(failures ? 1 : 0);
