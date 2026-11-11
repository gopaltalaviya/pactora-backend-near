#!/usr/bin/env node
/**
 * An agent swarm on the local NEAR sandbox: a coordination market where 20
 * buyer agents post work and 5 seller agents bid for it, with no model in
 * the loop — simple price rules — and every job funded, delivered and
 * settled through the real API, signer, indexer and contract.
 *
 *   pnpm swarm:local                      # after `pnpm demo:local` (or any running sandbox)
 *   SWARM_NETWORK=testnet node --env-file=.env scripts/swarm.mjs
 *                                         # NEAR testnet, smaller: 6 buyers, 3 sellers
 *
 * The rules each agent follows are in RULES.md, beside this repo's README.
 *
 * Track: AI Swarms — coordination markets, bidding, collective purchasing
 * among agents. What it shows:
 *
 * - Sellers bid by rule: each has a floor, a mark-down from the buyer's
 *   ceiling and a capacity, so the same listing draws different prices.
 * - Buyers choose by price AND reputation. Two rounds: in round 2 the
 *   reputation that round 1's settlements wrote on chain (and the indexer
 *   read back) changes who wins.
 * - Every buyer stays inside its caps: the contract's per-task and rolling
 *   daily caps, and its own ceiling. Checked on chain, not in a log.
 * - The money reconciles: every buyer's purse fell by exactly what it paid,
 *   every seller's rose by its prices less the fee, and the contract holds
 *   exactly what it owes (I1).
 *
 * Separate from the demo: its own database (`pactora_near_swarm`, created
 * and migrated here), its own API and signer ports (8099, 7099), fresh
 * accounts under the sandbox root. It does not recreate the sandbox; it
 * deploys the contracts only if they are missing (as local-up does).
 * Ends with "Swarm passed." and exit code 0. Needs `pnpm build` first.
 */
import {spawn, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createWriteStream, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Account, KeyPairSigner, actions} from 'near-api-js';
import postgres from 'postgres';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb} from '@pactora/db';
import {PactoraClient} from '@pactora/sdk';
import {signNep413} from '@pactora/near';
import {saveKey, sweep} from './lib/throwaway.mjs';
import {
  KeyPair,
  createPerson,
  deposit,
  mintTo,
  registerOnChain,
  rootAccount,
  send,
  view,
} from './lib/near.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = resolve(process.env.PACTORA_CONTRACTS_ROOT ?? join(ROOT, '..', 'pactora-contracts-near'));
const SLUG = process.env.SWARM_NETWORK ?? 'sandbox';
if (SLUG !== 'sandbox' && SLUG !== 'testnet')
  throw new Error(`SWARM_NETWORK ${SLUG}: sandbox or testnet only`);
const TESTNET = SLUG === 'testnet';
const CHAIN_ID = `near:${SLUG}`;
const RPC = 'http://127.0.0.1:3030';
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const DB_NAME = process.env.SWARM_DB_NAME ?? 'pactora_near_swarm';
if (!/^[a-z_][a-z0-9_]{0,40}$/.test(DB_NAME)) throw new Error(`SWARM_DB_NAME ${DB_NAME}: letters, digits, _`);
const DB_URL = ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${DB_NAME}$1`);
const API_PORT = Number(process.env.SWARM_API_PORT ?? 8099);
const SIGNER_PORT = Number(process.env.SWARM_SIGNER_PORT ?? 7099);
process.env.SANDBOX_KEY_FILE ??= join(ROOT, '.sandbox', 'validator_key.json');

// Testnet: a smaller swarm, paid for with faucet NEAR. Every test account's
// key is saved under .keys/testnet/ before the account exists, and swept
// back into the deployer at the end (as the demo does).
const keep = (id, keyPair) => saveKey(ROOT, SLUG, id, keyPair, {fullAccess: true});
const BUYERS = TESTNET ? 6 : 20;
const ROUNDS = 2;
/** What the top seller's owner tops its purse up with before it subcontracts (round 4). */
const TOP_UP = 1_000_000n;
/** The sellers' price rules: never below `floor`; bid `markdown` × the buyer's ceiling; at most `capacity` bids a round. */
const ALL_SELLERS = [
  {name: 'Atlas', floor: 20_000n, markdown: 0.7, capacity: 10},
  {name: 'Birch', floor: 25_000n, markdown: 0.8, capacity: 10},
  {name: 'Cobalt', floor: 30_000n, markdown: 0.6, capacity: 6},
  {name: 'Dune', floor: 45_000n, markdown: 0.9, capacity: 10},
  {name: 'Ember', floor: 15_000n, markdown: 0.95, capacity: 4},
];
const SELLERS = TESTNET ? ALL_SELLERS.slice(0, 3) : ALL_SELLERS;
/** Buyers weigh price against reputation: score = W_PRICE·(1 − price/ceiling) + W_REP·(score/100). */
const W_PRICE = 0.55;
const W_REP = 0.45;
const SKILL = 'data-labeling';
/**
 * Concurrent signers: the root signs on this many keys at once (one nonce
 * each). On testnet the root is the owner's deployer account: one lane, its
 * own key, so no extra full-access key is ever added to it.
 */
const LANES = TESTNET ? 1 : 25;
/** Testnet blocks come through the indexer's accounts source: slower polling, longer waits. */
const WAIT = TESTNET ? {tries: 300, ms: 2000} : {tries: 120, ms: 500};
const INDEXER_TICK_MS = TESTNET ? 6000 : 400;

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.error(`  ! ${m}`);
const fail = (m) => {
  console.error(`  ✗ ${m}`);
  failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)} s`;

/** Run `fn` over `items`, at most `n` at once. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({length: Math.min(n, items.length)}, async (_, lane) => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i, lane);
      }
    }),
  );
  return out;
}

async function waitUntil(label, fn, {tries = WAIT.tries, ms = WAIT.ms} = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await sleep(ms);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function portFree(port, name) {
  await new Promise((res, rej) => {
    const s = createServer();
    s.once('error', () =>
      rej(new Error(`port ${port} (${name}) is taken — another swarm running? Nothing was spent.`)),
    );
    s.listen(port, '127.0.0.1', () => s.close(res));
  });
}

// ── 0. the sandbox, the contracts, the database ─────────────────────────
for (const f of ['apps/api/dist/main.js', 'apps/signer/dist/main.js', 'apps/indexer/dist/indexer.js']) {
  if (!existsSync(join(ROOT, f))) {
    console.error(`✗ ${f} is missing: run pnpm build first`);
    process.exit(2);
  }
}
const sandbox = TESTNET
  ? null
  : await fetch(`${RPC}/status`)
      .then((r) => r.json())
      .catch(() => null);
if (!TESTNET && (sandbox?.chain_id !== 'sandbox' || !existsSync(process.env.SANDBOX_KEY_FILE))) {
  console.error(
    '✗ no NEAR sandbox at 127.0.0.1:3030 (start it: pnpm demo:local, or docker compose --profile sandbox up -d near-sandbox)',
  );
  process.exit(2);
}
let config = loadConfig({env: {...process.env, ENABLED_CHAINS: CHAIN_ID, DEFAULT_CHAIN: CHAIN_ID}});
let chain = config.chain(CHAIN_ID);
const deployed = () =>
  view(rootAccount(chain).provider, chain.contracts.Pactora, 'get_totals').then(
    () => true,
    () => false,
  );
if (TESTNET && !(await deployed())) {
  console.error(`✗ the contracts are not on testnet at ${chain.contracts.Pactora}: deploy them first`);
  process.exit(2);
}
if (!(await deployed())) {
  console.log('▸ the contracts are not on this sandbox: deploying them as local-up does');
  const r = spawnSync('node', ['scripts/deploy.mjs', '--network', 'sandbox'], {
    cwd: CONTRACTS,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {...process.env, SANDBOX_KEY_FILE: process.env.SANDBOX_KEY_FILE},
  });
  if (r.status !== 0 || !(await deployed())) {
    console.error('✗ deploying the contracts failed');
    process.exit(1);
  }
  config = loadConfig({env: {...process.env, ENABLED_CHAINS: CHAIN_ID, DEFAULT_CHAIN: CHAIN_ID}});
  chain = config.chain(CHAIN_ID);
}
const {Pactora: PACTORA, PaymentToken: TOKEN} = chain.contracts;
const params = chain.onchainParams;

{
  const admin = postgres(ADMIN_URL, {max: 1, onnotice: () => {}});
  const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${DB_NAME}`;
  if (!exists) await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  const m = spawnSync(process.execPath, ['packages/db/bin/migrate.mjs'], {
    cwd: ROOT,
    env: {...process.env, DATABASE_URL: DB_URL},
    encoding: 'utf8',
  });
  if (m.status !== 0) {
    console.error(m.stdout, m.stderr);
    process.exit(1);
  }
}
const sql = postgres(DB_URL, {max: 2, onnotice: () => {}});
const db = createDb(DB_URL);
const root = rootAccount(chain);

const children = [];
const stopped = new AbortController();
async function cleanup() {
  stopped.abort();
  for (const c of children) c.kill('SIGTERM');
  await sql.end().catch(() => {});
  await closeDb(db).catch(() => {});
  await sweep(ROOT, SLUG, root.provider, root.id).catch((e) =>
    warn(`sweep: ${e.message}; run node --env-file=.env scripts/sweep-testnet.mjs`),
  );
}

try {
  console.log(`\nPactora swarm on ${chain.name} (${CHAIN_ID}) — contract ${PACTORA}, database ${DB_NAME}\n`);
  await portFree(API_PORT, 'api');
  await portFree(SIGNER_PORT, 'signer');
  const run = `s${Date.now().toString(36)}`;

  // ── 1. accounts: the root signs on LANES keys at once (one nonce each) ──
  // Testnet: what an earlier, interrupted run left on its saved test accounts.
  await sweep(ROOT, SLUG, root.provider, root.id);
  let rootLanes = [root];
  if (!TESTNET) {
    const lanes = Array.from({length: LANES}, () => KeyPair.fromRandom('ed25519'));
    await send(
      root.account,
      root.id,
      lanes.map((k) => actions.addFullAccessKey(k.getPublicKey())),
    );
    rootLanes = lanes.map((k) => ({
      ...root,
      account: new Account(root.id, root.provider, new KeyPairSigner(k)),
    }));
  }
  const owners = [
    ...Array.from({length: BUYERS}, (_, i) => ({
      role: 'buyer',
      i,
      name: `Buyer ${String(i + 1).padStart(2, '0')}`,
    })),
    ...SELLERS.map((s, i) => ({role: 'seller', i, name: s.name, rule: s})),
  ];
  const stakeAmount = BigInt(params.min_stake) + 2_000_000n;
  await pool(owners, LANES, async (o, _i, lane) => {
    const r = rootLanes[lane];
    o.person = await createPerson(r, `${run}-${o.role}${o.i + 1}`, TESTNET ? '1' : '2', {save: keep});
    await mintTo(r, TOKEN, o.person, o.role === 'buyer' ? 3_000_000n : stakeAmount + 1_000_000n);
  });
  ok(`${BUYERS} buyer and ${SELLERS.length} seller owners created and funded on chain (${elapsed()})`);

  // ── 2. services: the real signer and API, on their own database ─────
  await sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, signer_txs, signer_keys, signer_wallet_txs, spend_policies, token_transfers, listings, applications, listing_slots, person_actions, faucet_claims RESTART IDENTITY CASCADE`;
  await sql`DELETE FROM indexer_cursor`;
  const env = {
    ...process.env,
    DATABASE_URL: DB_URL,
    ENABLED_CHAINS: CHAIN_ID,
    DEFAULT_CHAIN: CHAIN_ID,
    SIGNER_PORT: String(SIGNER_PORT),
    SIGNER_URL: `http://127.0.0.1:${SIGNER_PORT}`,
    SIGNER_TOKEN: randomBytes(24).toString('hex'),
    SIGNER_KEY_PASSPHRASE: `swarm-only-${randomBytes(24).toString('hex')}`,
    PORT: String(API_PORT),
    LOG_LEVEL: 'warn',
    // Twenty-five agents on 127.0.0.1 share one per-IP bucket.
    RATE_LIMIT_PER_MINUTE: '50000',
    // Each agent says which address it calls from (x-forwarded-for), as it
    // would behind a proxy: the per-address registration limits (10 wallet
    // keys a minute) then count per agent, not for the whole swarm.
    TRUST_PROXY: '1',
    WEBHOOK_SECRET_KEY: randomBytes(32).toString('hex'),
    AGENT_MODE: 'cached',
  };
  const logDir = join(ROOT, 'artifacts', 'swarm-logs');
  mkdirSync(logDir, {recursive: true});
  const start = (name, script) => {
    const child = spawn(process.execPath, [script], {cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']});
    const sink = createWriteStream(join(logDir, `${name}.log`));
    child.stdout.pipe(sink);
    child.stderr.pipe(sink);
    child.once('exit', (code, signal) => {
      if (stopped.signal.aborted) return;
      console.error(
        `\n  ✗ the ${name} exited (${signal ?? `code ${code}`}) — see artifacts/swarm-logs/${name}.log`,
      );
      void cleanup().then(() => process.exit(1));
    });
    children.push(child);
  };
  start('signer', 'apps/signer/dist/main.js');
  start('api', 'apps/api/dist/main.js');
  await waitUntil('the signer', async () => (await fetch(`http://127.0.0.1:${SIGNER_PORT}/health`)).ok);
  await waitUntil('the API', async () => (await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok);
  const base = `http://127.0.0.1:${API_PORT}`;
  ok('signer and API up on their own database');

  const post = async (path, body, from) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-forwarded-for': from},
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  };

  // ── 3. every agent registered the way the website does ────────────────
  await pool(owners, LANES, async (o, k) => {
    const owner = o.person;
    const from = `10.42.${Math.floor(k / 200)}.${(k % 200) + 1}`;
    const wallet = `bot.${owner.id}`;
    const {walletPublicKey} = await post(
      '/v1/agents/wallet-key',
      {walletAddress: wallet, chainId: CHAIN_ID},
      from,
    );
    const chainAgentId = await registerOnChain(owner, {
      wallet,
      walletPublicKey,
      pactora: PACTORA,
      cardUri: `data:,${o.name}`,
    });
    const challenge = await post(
      '/v1/agents/challenge',
      {
        ownerAddress: owner.id,
        walletAddress: wallet,
        chainAgentId,
        chainId: CHAIN_ID,
      },
      from,
    );
    const signed = await signNep413({
      accountId: owner.id,
      keyPair: owner.keyPair,
      message: challenge.message,
      recipient: challenge.recipient,
      nonce: new Uint8Array(Buffer.from(challenge.nonce, 'hex')),
    });
    const agent = await post(
      '/v1/agents',
      {
        name: o.name,
        capabilities: [o.role === 'buyer' ? 'procurement' : SKILL],
        pricePerTask: o.role === 'buyer' ? '0' : String(o.rule.floor),
        walletAddress: wallet,
        ownerAddress: owner.id,
        chainId: CHAIN_ID,
        chainAgentId,
        nonce: challenge.nonce,
        publicKey: signed.publicKey,
        signature: signed.signature,
      },
      from,
    );
    Object.assign(o, {
      agentId: Number(agent.agentId),
      chainAgentId,
      sdk: new PactoraClient({baseUrl: base, apiKey: agent.apiKey, chainId: CHAIN_ID}),
    });
    // Money in: a buyer's purse (what it may spend); a seller's stake (hireable).
    if (o.role === 'buyer') {
      await deposit(owner, TOKEN, PACTORA, 2_000_000n, {Fund: {agent_id: Number(chainAgentId)}});
    } else {
      await deposit(owner, TOKEN, PACTORA, stakeAmount, {Stake: {agent_id: Number(chainAgentId)}});
    }
  });
  const buyers = owners.filter((o) => o.role === 'buyer');
  const sellers = owners.filter((o) => o.role === 'seller');
  ok(
    `${owners.length} agents registered (NEP-413 owner signatures, wallets on chain); buyers funded 2 mUSDC each, sellers staked (${elapsed()})`,
  );

  // ── 4. the indexer, in process, from the head ─────────────────────────
  const {Indexer} = await import('../apps/indexer/dist/indexer.js');
  const {openSource} = await import('../apps/indexer/dist/source.js');
  const indexer = new Indexer({db, chain, source: await openSource(chain)});
  await indexer.seedCursorToHead();
  let indexerErrors = 0;
  const indexing = (async () => {
    while (!stopped.signal.aborted) {
      try {
        await indexer.tick();
      } catch (err) {
        if (indexerErrors++ % 10 === 0) warn(`indexer: ${err.message ?? err}`);
      }
      await sleep(INDEXER_TICK_MS);
    }
  })();

  /**
   * One job action. The SDK retries a call that timed out while the signer
   * queued it behind the same seller's other jobs; the retry then finds the
   * step already done (INVALID_STATE). Done is done: the job's state decides.
   */
  const step = async (fn, b, jobId, done) => {
    try {
      await fn();
    } catch (err) {
      const state = (await b.sdk.getJob(jobId)).state;
      if (err?.code === 'INVALID_STATE' && done.includes(state)) return;
      throw err;
    }
  };
  const purse = (a) => view(root.provider, PACTORA, 'purse_of', {agent_id: Number(a.chainAgentId)});
  const onChainJob = (id) => view(root.provider, PACTORA, 'get_job', {job_id: Number(id)});
  const before = new Map(await Promise.all(owners.map(async (o) => [o.agentId, await purse(o)])));
  const fee = (amount) => {
    const bps = (amount * BigInt(params.protocol_fee_bps)) / 10_000n;
    return bps > BigInt(params.min_fee) ? bps : BigInt(params.min_fee);
  };
  const perTaskCap = (p) => BigInt(p.per_task_cap);

  // ── 5. the market, two rounds ─────────────────────────────────────────
  const ledger = {listings: [], bids: [], fills: [], settled: [], winsByRound: [], choices: []};
  const perRound = Math.ceil(BUYERS / ROUNDS);
  for (let round = 1; round <= ROUNDS; round++) {
    const inRound = buyers.slice((round - 1) * perRound, round * perRound);
    console.log(`\n  round ${round}: ${inRound.length} buyers post`);

    // Buyers post: a ceiling from 30 000 to 100 000 base units, never above
    // the contract's per-task cap (read from the chain).
    await pool(inRound, LANES, async (b) => {
      const cap = perTaskCap(before.get(b.agentId));
      const k = buyers.indexOf(b);
      const ceiling = [30_000n, 45_000n, 60_000n, 75_000n, 90_000n, 100_000n][k % 6];
      b.ceiling = ceiling < cap ? ceiling : cap;
      const l = await b.sdk.postListing(
        {
          title: `Label 200 product photos, batch ${k + 1}`,
          description: `Tag each of 200 product photos with one of 12 categories; batch ${k + 1} of the catalogue.`,
          category: 'expertise',
          interactionMode: 'task',
          skills: [SKILL],
          maxPriceBaseUnits: String(b.ceiling),
          maxWorkers: 1,
          estimatedMinutes: 30,
          deadline: new Date(Date.now() + 86_400_000).toISOString(),
          criteria: 'Every photo carries exactly one category from the list; no photo is skipped.',
          acceptWindowSeconds: 300,
          workWindowSeconds: 900,
        },
        `${run}-listing-${k}`,
      );
      b.listing = l;
      ledger.listings.push({buyer: b.name, listingId: l.listingId, ceiling: b.ceiling, round});
    });

    // Sellers bid by rule: skip a ceiling below the floor; bid the mark-down,
    // never below the floor; the richest listings first, up to capacity.
    const open = inRound
      .map((b) => b.listing)
      .sort((x, y) => Number(BigInt(y.maxPriceBaseUnits) - BigInt(x.maxPriceBaseUnits)));
    await Promise.all(
      sellers.map(async (s) => {
        let made = 0;
        for (const l of open) {
          const ceiling = BigInt(l.maxPriceBaseUnits);
          if (made >= s.rule.capacity || ceiling < s.rule.floor) continue;
          const marked = (ceiling * BigInt(Math.round(s.rule.markdown * 100))) / 100n;
          const price = marked > s.rule.floor ? marked : s.rule.floor;
          await s.sdk.applyToListing(l.listingId, {
            priceBaseUnits: String(price),
            proposal: `${s.name}: 200 photos labelled within the hour for ${price}.`,
          });
          ledger.bids.push({seller: s.name, listingId: l.listingId, price, round});
          made++;
        }
      }),
    );
    ok(
      `round ${round}: ${ledger.bids.filter((x) => x.round === round).length} bids on ${inRound.length} listings`,
    );

    // Buyers select: the best of price and reputation (the API's applicant
    // score, which the indexer writes from settlements on chain).
    await pool(inRound, LANES, async (b) => {
      const {applications} = await b.sdk.listApplications(b.listing.listingId, {sort: 'price_low'});
      if (applications.length === 0) return;
      const ceiling = Number(b.ceiling);
      const rank = (a) =>
        W_PRICE * (1 - Number(a.priceBaseUnits) / ceiling) + W_REP * (a.applicant.score / 100);
      const best = [...applications].sort(
        (x, y) => rank(y) - rank(x) || x.applicant.completed - y.applicant.completed,
      )[0];
      const d = await b.sdk.decideApplication(b.listing.listingId, {
        applicationId: best.applicationId,
        action: 'select',
        reason: `Best of price and record: ${best.priceBaseUnits} at score ${best.applicant.score}.`,
      });
      const seller = sellers.find((s) => String(s.agentId) === String(best.applicant.agentId));
      ledger.choices.push({
        round,
        buyer: b.name,
        ceiling: String(b.ceiling),
        chose: seller.name,
        options: applications.map((a) => ({
          seller: sellers.find((s) => String(s.agentId) === String(a.applicant.agentId))?.name ?? '?',
          price: String(a.priceBaseUnits),
          reputation: a.applicant.score,
          score: Math.round(rank(a) * 1000) / 1000,
        })),
      });
      b.fill = {
        jobId: d.job.jobId,
        price: BigInt(best.priceBaseUnits),
        seller,
        score: best.applicant.score,
        cheapest: applications[0].priceBaseUnits,
      };
      ledger.fills.push({buyer: b.name, seller: seller.name, price: b.fill.price, round, jobId: d.job.jobId});
    });
    const wins = {};
    for (const f of ledger.fills.filter((x) => x.round === round)) wins[f.seller] = (wins[f.seller] ?? 0) + 1;
    ledger.winsByRound.push(wins);
    const notCheapest = inRound.filter((b) => b.fill && String(b.fill.price) !== b.fill.cheapest).length;
    ok(
      `round ${round}: ${Object.values(wins).reduce((a, n) => a + n, 0)} fills — ${Object.entries(wins)
        .map(([n, w]) => `${n} ${w}`)
        .join(', ')}` + (notCheapest ? `; ${notCheapest} went to a dearer bid with the better record` : ''),
    );

    // Funded, delivered, settled: create_job by the signer from the buyer's
    // purse, accept, a draft, the buyer's review, the submission whose hash is
    // the accepted snapshot, then the API's approve for the agent client.
    await pool(
      inRound.filter((b) => b.fill),
      LANES,
      async (b) => {
        const {jobId, seller} = b.fill;
        const chainJobId = await waitUntil(
          `job ${jobId} on chain`,
          async () => (await b.sdk.getJob(jobId)).chainJobId,
        );
        b.fill.chainJobId = chainJobId;
        await step(() => seller.sdk.accept(jobId), b, jobId, ['accepted', 'submitted', 'settled']);
        await waitUntil(
          `job ${jobId} accepted`,
          async () => (await b.sdk.getJob(jobId)).state === 'accepted',
        );
        const draft = await seller.sdk.submitDraft(jobId, {
          text: `200 photos labelled, one category each (${seller.name}).`,
        });
        await b.sdk.reviewDraft(jobId, draft.draftId, {
          snapshotHash: draft.snapshotHash,
          decision: 'accept_draft',
          reason: 'Every photo labelled, as asked.',
          checks: [
            {
              criterion: 'Every photo carries exactly one category from the list; no photo is skipped.',
              met: true,
              support: 'the draft',
            },
          ],
        });
        await step(() => seller.sdk.submitResult(jobId), b, jobId, ['submitted', 'settled']);
        const j = await waitUntil(`job ${jobId} settled on chain`, async () => {
          const s = await onChainJob(chainJobId);
          return s.state === 'Settled' ? s : null;
        });
        ledger.settled.push({buyer: b.name, seller: seller.name, amount: BigInt(j.amount), round, jobId, b});
      },
    );
    ok(
      `round ${round}: ${ledger.settled.filter((x) => x.round === round).length} jobs settled on chain (${elapsed()})`,
    );
    // Reputation is read from what the indexer recorded: let it catch up.
    await waitUntil('the indexer', async () => {
      const [{n}] = await sql`SELECT count(*)::int AS n FROM jobs WHERE state = 'settled'`;
      const [{e}] =
        await sql`SELECT count(*)::int AS e FROM job_events WHERE kind = 'settled' AND tx_hash IS NOT NULL`;
      return e >= ledger.settled.length && n >= ledger.settled.length;
    });
  }

  /** Wait for a job to reach one of `states` in the API. */
  const until = (who, jobId, states) =>
    waitUntil(`job ${jobId} ${states.join('/')}`, async () =>
      states.includes((await who.sdk.getJob(jobId)).state),
    );
  const settledOnChain = (chainJobId) =>
    waitUntil(`chain job ${chainJobId} settled`, async () => {
      const j = await onChainJob(chainJobId);
      return j.state === 'Settled' ? j : null;
    });
  const chainIdOf = (who, jobId) =>
    waitUntil(`job ${jobId} on chain`, async () => (await who.sdk.getJob(jobId)).chainJobId);
  // The seller with the best record after the listing rounds is hired below,
  // by the rule a buyer uses: reputation first, then the lower floor.
  const ranked = [];
  for (const s of sellers) ranked.push({s, score: (await s.sdk.getAgent(s.agentId)).score});
  ranked.sort((x, y) => y.score - x.score || Number(x.s.rule.floor - y.s.rule.floor));
  const top = ranked[0].s;
  const capOf = (a) => perTaskCap(before.get(a.agentId));

  // ── 5b. round 3: collective purchasing ────────────────────────────────
  // Three buyers buy ONE job worth three per-task caps, which no buyer could
  // buy alone. Each funds an equal share as its own escrow job, under its own
  // caps; the worker delivers one output to every share.
  const members = buyers.slice(0, 3);
  const share = members.map(capOf).reduce((a, c) => (c < a ? c : a));
  console.log(
    `\n  round 3: ${members.length} buyers pool ${chain.formatToken(share * BigInt(members.length))} for one job`,
  );
  const opened = await members[0].sdk.openPool({
    workerAgentId: top.agentId,
    title: 'Label the whole 2 400-photo catalogue',
    capability: SKILL,
    input: {photos: 2400, categories: 12},
    shareAmount: String(share),
    shares: members.length,
    acceptWindowSeconds: 600,
    workWindowSeconds: 1800,
  });
  const poolId = opened.pool.poolId;
  const shareJobs = [{m: members[0], jobId: opened.share.jobId}];
  for (const m of members.slice(1)) shareJobs.push({m, jobId: (await m.sdk.joinPool(poolId)).share.jobId});
  const output = {photos: 2400, labelled: 2400, by: top.name, pool: poolId};
  await pool(shareJobs, LANES, async (x) => {
    x.chainJobId = await chainIdOf(x.m, x.jobId);
    await step(() => top.sdk.accept(x.jobId), x.m, x.jobId, ['accepted', 'submitted', 'settled']);
    await until(x.m, x.jobId, ['accepted']);
    await step(() => top.sdk.submitResult(x.jobId, {output}), x.m, x.jobId, ['submitted', 'settled']);
    await until(x.m, x.jobId, ['submitted', 'settled']);
    await step(() => x.m.sdk.approve(x.jobId), x.m, x.jobId, ['settled']);
    const j = await settledOnChain(x.chainJobId);
    ledger.settled.push({
      buyer: x.m.name,
      seller: top.name,
      amount: BigInt(j.amount),
      round: 3,
      jobId: x.jobId,
      b: x.m,
    });
  });
  const pooled = await members[0].sdk.getPool(poolId);
  ledger.pool = {
    poolId,
    worker: top.name,
    share: String(share),
    total: pooled.total,
    perTaskCap: String(capOf(members[0])),
    members: members.map((m) => m.name),
    resultHash: pooled.resultHash,
    sameDelivery: pooled.sameDelivery,
    state: pooled.state,
    jobs: shareJobs.map((x) => ({buyer: x.m.name, jobId: x.jobId, chainJobId: String(x.chainJobId)})),
  };
  pooled.state === 'settled' && pooled.sameDelivery && pooled.resultHash
    ? ok(
        `round 3: ${members.length} buyers pooled ${chain.formatToken(BigInt(pooled.total))} for one job from ${top.name}, above any one buyer's per-task cap (${chain.formatToken(capOf(members[0]))}); every share settled with the same result hash (${pooled.resultHash.slice(0, 12)}…)`,
      )
    : fail(
        `round 3: pool ${pooled.state}, sameDelivery ${pooled.sameDelivery}, resultHash ${pooled.resultHash}`,
      );

  // ── 5c. round 4: subcontracting ───────────────────────────────────────
  // A buyer hires the top seller; the top seller, now a client too, hires
  // the cheapest other seller for half the work from its own purse, approves
  // that delivery, then delivers its own job: agent → agent → agent.
  const client = buyers[3 % buyers.length];
  const sub = sellers.filter((s) => s !== top).sort((x, y) => Number(x.rule.floor - y.rule.floor))[0];
  console.log(`\n  round 4: ${client.name} hires ${top.name}, who subcontracts half to ${sub.name}`);
  await deposit(top.person, TOKEN, PACTORA, TOP_UP, {Fund: {agent_id: Number(top.chainAgentId)}});
  const topBefore = await purse(top);
  const parent = await client.sdk.hire({
    workerAgentId: top.agentId,
    spec: {capability: SKILL, input: {photos: 400, task: 'Label 400 product photos'}},
    maxPrice: String(top.rule.floor),
    path: 'escrow',
    idempotencyKey: `${run}-sub-parent`,
  });
  const parentChain = await chainIdOf(client, parent.jobId);
  await step(() => top.sdk.accept(parent.jobId), client, parent.jobId, ['accepted', 'submitted', 'settled']);
  await until(client, parent.jobId, ['accepted']);
  const child = await top.sdk.hire({
    workerAgentId: sub.agentId,
    spec: {
      capability: SKILL,
      input: {photos: 200, task: 'Label photos 201–400', parentJob: parent.jobId},
    },
    maxPrice: String(sub.rule.floor),
    path: 'escrow',
    idempotencyKey: `${run}-sub-child`,
  });
  const childChain = await chainIdOf(top, child.jobId);
  await step(() => sub.sdk.accept(child.jobId), top, child.jobId, ['accepted', 'submitted', 'settled']);
  await until(top, child.jobId, ['accepted']);
  await step(
    () => sub.sdk.submitResult(child.jobId, {output: {photos: 200, labelled: 200, by: sub.name}}),
    top,
    child.jobId,
    ['submitted', 'settled'],
  );
  await until(top, child.jobId, ['submitted', 'settled']);
  await step(() => top.sdk.approve(child.jobId), top, child.jobId, ['settled']);
  const childJob = await settledOnChain(childChain);
  await step(
    () =>
      top.sdk.submitResult(parent.jobId, {
        output: {photos: 400, labelled: 400, by: top.name, subcontracted: child.jobId},
      }),
    client,
    parent.jobId,
    ['submitted', 'settled'],
  );
  await until(client, parent.jobId, ['submitted', 'settled']);
  await step(() => client.sdk.approve(parent.jobId), client, parent.jobId, ['settled']);
  const parentJob = await settledOnChain(parentChain);
  ledger.settled.push({
    buyer: top.name,
    seller: sub.name,
    amount: BigInt(childJob.amount),
    round: 4,
    jobId: child.jobId,
    b: top,
  });
  ledger.settled.push({
    buyer: client.name,
    seller: top.name,
    amount: BigInt(parentJob.amount),
    round: 4,
    jobId: parent.jobId,
    b: client,
  });
  const middleNet = BigInt((await purse(top)).balance) - BigInt(topBefore.balance);
  const middleExpected = BigInt(parentJob.amount) - fee(BigInt(parentJob.amount)) - BigInt(childJob.amount);
  ledger.subcontract = {
    client: client.name,
    middle: top.name,
    sub: sub.name,
    parent: {jobId: parent.jobId, chainJobId: String(parentChain), amount: String(parentJob.amount)},
    child: {jobId: child.jobId, chainJobId: String(childChain), amount: String(childJob.amount)},
    middleNet: String(middleNet),
  };
  middleNet === middleExpected
    ? ok(
        `round 4: ${client.name} → ${top.name} → ${sub.name} settled on chain; ${top.name} kept ${chain.formatToken(middleNet)} = its price − the fee − what it paid ${sub.name}`,
      )
    : fail(`round 4: ${top.name} kept ${middleNet}, expected ${middleExpected}`);
  await waitUntil('the indexer', async () => {
    const [{e}] =
      await sql`SELECT count(*)::int AS e FROM job_events WHERE kind = 'settled' AND tx_hash IS NOT NULL`;
    return e >= ledger.settled.length;
  });

  // ── 6. the report ─────────────────────────────────────────────────────
  const prices = ledger.fills.map((f) => f.price).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const median =
    prices.length === 0
      ? 0n
      : prices.length % 2
        ? prices[(prices.length - 1) / 2]
        : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2n;
  console.log('\n  ── swarm report ──');
  console.log(`  listings     ${ledger.listings.length}`);
  console.log(`  bids         ${ledger.bids.length}`);
  console.log(`  fills        ${ledger.fills.length}`);
  console.log(
    `  median price ${chain.formatToken(median)} (${median} base units; range ${prices[0]}–${prices.at(-1)})`,
  );
  console.log(`  settlements  ${ledger.settled.length} on chain`);
  if (TESTNET) {
    // The proof a judge can open: each settlement's transaction on the explorer.
    console.log('  settled on NEAR testnet (the settling transaction of each job):');
    for (const x of ledger.settled) {
      const job = await x.b.sdk.getJob(x.jobId).catch(() => null);
      const tx = job ? [...job.events].reverse().find((e) => e.explorerUrl) : null;
      console.log(
        `    r${x.round} ${x.buyer} → ${x.seller}  ${chain.formatToken(x.amount)}  chain job ${job?.chainJobId ?? '?'}  ${tx?.explorerUrl ?? '(no link)'}`,
      );
    }
  }
  console.log('  reputation per seller (API score, from the indexer; history = GET /v1/agents/:id/history):');
  const rep = [];
  for (const s of sellers) {
    const a = await s.sdk.getAgent(s.agentId);
    const h = await (await fetch(`${base}/v1/agents/${s.agentId}/history`)).json();
    const won = ledger.settled.filter((x) => x.seller === s.name).length;
    const bids = ledger.bids.filter((x) => x.seller === s.name).length;
    rep.push({s, a, h, won});
    console.log(
      `    ${s.name.padEnd(7)} floor ${String(s.rule.floor).padStart(6)}  bids ${String(bids).padStart(2)}  won ${String(won).padStart(2)}  ` +
        `score ${String(a.score).padStart(3)}  completed ${String(a.completed).padStart(2)}  history ${h.totals?.settled ?? '?'} settled`,
    );
  }
  console.log('');

  // The run, as data (no keys, no account secrets): what the interface's
  // /swarm page shows. Every settlement carries its chain job id and, on
  // testnet, the settling transaction, so each line can be checked on chain.
  const settlements = [];
  for (const x of ledger.settled) {
    const job = await x.b.sdk.getJob(x.jobId).catch(() => null);
    const tx = job ? [...job.events].reverse().find((e) => e.txHash) : null;
    settlements.push({
      round: x.round,
      buyer: x.buyer,
      seller: x.seller,
      amount: String(x.amount),
      jobId: x.jobId,
      chainJobId: job?.chainJobId ?? null,
      resultHash: job?.resultHash ?? null,
      txHash: tx?.txHash ?? null,
      explorerUrl: TESTNET ? (tx?.explorerUrl ?? null) : null,
    });
  }
  const record = {
    network: chain.name,
    chainId: CHAIN_ID,
    contract: PACTORA,
    recordedAt: new Date().toISOString(),
    rules: {
      sellers: SELLERS.map((s) => ({...s, floor: String(s.floor)})),
      buyerScore: {price: W_PRICE, reputation: W_REP},
    },
    listings: ledger.listings.map((l) => ({...l, ceiling: String(l.ceiling)})),
    bids: ledger.bids.map((b) => ({...b, price: String(b.price)})),
    choices: ledger.choices,
    pool: ledger.pool ?? null,
    subcontract: ledger.subcontract ?? null,
    settlements,
    reputation: rep.map(({s, a, won}) => ({
      seller: s.name,
      score: a.score,
      completed: a.completed,
      settled: won,
    })),
  };
  mkdirSync(join(ROOT, 'artifacts'), {recursive: true});
  writeFileSync(join(ROOT, 'artifacts', `swarm-run-${SLUG}.json`), JSON.stringify(record, null, 2) + '\n');
  console.log(`  the run, as data: artifacts/swarm-run-${SLUG}.json\n`);

  // ── 7. checks, against the chain ──────────────────────────────────────
  ledger.listings.length === BUYERS
    ? ok(`every buyer posted (${BUYERS} listings)`)
    : fail(`${ledger.listings.length} listings, expected ${BUYERS}`);
  const listingSettled = ledger.settled.filter((x) => x.round <= ROUNDS).length;
  listingSettled === ledger.fills.length && ledger.fills.length > 0
    ? ok(
        `every fill settled on chain (${listingSettled}), plus ${ledger.settled.length - listingSettled} pooled and subcontracted jobs`,
      )
    : fail(`${ledger.fills.length} fills, ${listingSettled} settled`);
  rep.every(({a, won}) => a.completed === won)
    ? ok("each seller's completed count in the API equals its settled jobs: reputation is the chain's record")
    : fail(`completed vs won: ${rep.map(({s, a, won}) => `${s.name} ${a.completed}/${won}`).join(', ')}`);
  // History counts an agent's settlements on either side: a seller that
  // subcontracted (round 4) was also a client once.
  const sides = (s) => ledger.settled.filter((x) => x.seller === s.name || x.buyer === s.name).length;
  rep.every(({s, h}) => h.totals?.settled === sides(s))
    ? ok("each seller's public history (52 weeks) counts the same settlements, as worker and as client")
    : fail(`history: ${rep.map(({s, h}) => `${s.name} ${h.totals?.settled}/${sides(s)}`).join(', ')}`);

  // Caps: every job within the contract's per-task cap and the buyer's own
  // ceiling; the rolling day's spend within the daily cap; the purse fell by
  // exactly what was paid.
  const after = new Map(await Promise.all(owners.map(async (o) => [o.agentId, await purse(o)])));
  const capProblems = [];
  for (const b of buyers) {
    const p0 = before.get(b.agentId);
    const p1 = after.get(b.agentId);
    const paid = ledger.settled.filter((x) => x.buyer === b.name).reduce((a, x) => a + x.amount, 0n);
    if (b.fill && b.fill.price > perTaskCap(p1))
      capProblems.push(`${b.name}: ${b.fill.price} > per-task cap ${p1.per_task_cap}`);
    if (b.fill && b.fill.price > b.ceiling)
      capProblems.push(`${b.name}: ${b.fill.price} > its ceiling ${b.ceiling}`);
    if (BigInt(p1.spent_today) > BigInt(p1.daily_cap))
      capProblems.push(`${b.name}: spent ${p1.spent_today} > daily cap ${p1.daily_cap}`);
    if (BigInt(p0.balance) - BigInt(p1.balance) !== paid) {
      capProblems.push(`${b.name}: purse fell ${BigInt(p0.balance) - BigInt(p1.balance)}, paid ${paid}`);
    }
  }
  capProblems.length === 0
    ? ok(
        `every buyer stayed within its caps: each job ≤ its ceiling and the per-task cap (${chain.formatToken(perTaskCap(after.get(buyers[0].agentId)))}), each day's spend ≤ the daily cap, each purse fell by exactly what it paid`,
      )
    : fail(`caps: ${capProblems.join('; ')}`);

  // Reconcile: sellers rose by price − fee; buyers' total fall = sellers' total rise + fees; I1.
  const sellerProblems = [];
  let sellerGain = 0n;
  let fees = 0n;
  for (const s of sellers) {
    // Received less fees, less what it paid as a client (round 4), plus its
    // owner's top-up before round 4.
    const expected =
      ledger.settled.filter((x) => x.seller === s.name).reduce((a, x) => a + x.amount - fee(x.amount), 0n) -
      ledger.settled.filter((x) => x.buyer === s.name).reduce((a, x) => a + x.amount, 0n) +
      (s === top ? TOP_UP : 0n);
    const got = BigInt(after.get(s.agentId).balance) - BigInt(before.get(s.agentId).balance);
    // The owner's top-up before round 4 is not market income.
    sellerGain += got - (s === top ? TOP_UP : 0n);
    if (got !== expected) sellerProblems.push(`${s.name}: +${got}, expected +${expected}`);
  }
  for (const x of ledger.settled) fees += fee(x.amount);
  const buyerFall = buyers.reduce(
    (a, b) => a + BigInt(before.get(b.agentId).balance) - BigInt(after.get(b.agentId).balance),
    0n,
  );
  sellerProblems.length === 0 && buyerFall === sellerGain + fees
    ? ok(
        `balances reconcile on chain: buyers paid ${chain.formatToken(buyerFall)} = sellers received ${chain.formatToken(sellerGain)} + fees ${chain.formatToken(fees)}`,
      )
    : fail(
        `reconcile: ${sellerProblems.join('; ')}; buyers −${buyerFall}, sellers +${sellerGain}, fees ${fees}`,
      );
  const totals = await view(root.provider, PACTORA, 'get_totals');
  const held = await view(root.provider, TOKEN, 'ft_balance_of', {account_id: PACTORA});
  totals.sum === held
    ? ok(`I1 holds: the contract holds exactly what it owes (${chain.formatToken(BigInt(held))})`)
    : fail(`I1: owes ${totals.sum}, holds ${held}`);

  stopped.abort();
  await indexing;
  console.log(`\n  ${elapsed()} in all`);
  await cleanup();
  if (failures > 0) {
    console.error(`\nSwarm FAILED: ${failures} check(s).`);
    process.exit(1);
  }
  console.log('\nSwarm passed.');
  process.exit(0);
} catch (err) {
  console.error(`\n  ✗ ${err.stack ?? err}`);
  await cleanup();
  process.exit(1);
}
