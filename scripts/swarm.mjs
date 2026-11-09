#!/usr/bin/env node
/**
 * An agent swarm on the local NEAR sandbox: a coordination market where 20
 * buyer agents post work and 5 seller agents bid for it, with no model in
 * the loop — simple price rules — and every job funded, delivered and
 * settled through the real API, signer, indexer and contract.
 *
 *   pnpm swarm:local                      # after `pnpm demo:local` (or any running sandbox)
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
import {createWriteStream, existsSync, mkdirSync} from 'node:fs';
import {createServer} from 'node:net';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Account, KeyPairSigner, actions} from 'near-api-js';
import postgres from 'postgres';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb} from '@pactora/db';
import {PactoraClient} from '@pactora/sdk';
import {signNep413} from '@pactora/near';
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
const CHAIN_ID = 'near:sandbox';
const RPC = 'http://127.0.0.1:3030';
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const DB_NAME = process.env.SWARM_DB_NAME ?? 'pactora_near_swarm';
if (!/^[a-z_][a-z0-9_]{0,40}$/.test(DB_NAME)) throw new Error(`SWARM_DB_NAME ${DB_NAME}: letters, digits, _`);
const DB_URL = ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${DB_NAME}$1`);
const API_PORT = Number(process.env.SWARM_API_PORT ?? 8099);
const SIGNER_PORT = Number(process.env.SWARM_SIGNER_PORT ?? 7099);
process.env.SANDBOX_KEY_FILE ??= join(ROOT, '.sandbox', 'validator_key.json');

const BUYERS = 20;
const ROUNDS = 2;
/** The sellers' price rules: never below `floor`; bid `markdown` × the buyer's ceiling; at most `capacity` bids a round. */
const SELLERS = [
  {name: 'Atlas', floor: 20_000n, markdown: 0.7, capacity: 10},
  {name: 'Birch', floor: 25_000n, markdown: 0.8, capacity: 10},
  {name: 'Cobalt', floor: 30_000n, markdown: 0.6, capacity: 6},
  {name: 'Dune', floor: 45_000n, markdown: 0.9, capacity: 10},
  {name: 'Ember', floor: 15_000n, markdown: 0.95, capacity: 4},
];
/** Buyers weigh price against reputation: score = W_PRICE·(1 − price/ceiling) + W_REP·(score/100). */
const W_PRICE = 0.55;
const W_REP = 0.45;
const SKILL = 'data-labeling';
/** Concurrent signers: the root signs on this many keys at once (one nonce each). */
const LANES = 25;

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

async function waitUntil(label, fn, {tries = 120, ms = 500} = {}) {
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
const sandbox = await fetch(`${RPC}/status`)
  .then((r) => r.json())
  .catch(() => null);
if (sandbox?.chain_id !== 'sandbox' || !existsSync(process.env.SANDBOX_KEY_FILE)) {
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
}

try {
  console.log(`\nPactora swarm on ${chain.name} (${CHAIN_ID}) — contract ${PACTORA}, database ${DB_NAME}\n`);
  await portFree(API_PORT, 'api');
  await portFree(SIGNER_PORT, 'signer');
  const run = `s${Date.now().toString(36)}`;

  // ── 1. accounts: the root signs on LANES keys at once (one nonce each) ──
  const lanes = Array.from({length: LANES}, () => KeyPair.fromRandom('ed25519'));
  await send(
    root.account,
    root.id,
    lanes.map((k) => actions.addFullAccessKey(k.getPublicKey())),
  );
  const rootLanes = lanes.map((k) => ({
    ...root,
    account: new Account(root.id, root.provider, new KeyPairSigner(k)),
  }));
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
    o.person = await createPerson(r, `${run}-${o.role}${o.i + 1}`, '2');
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
      await sleep(400);
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
  const ledger = {listings: [], bids: [], fills: [], settled: [], winsByRound: []};
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
        ledger.settled.push({buyer: b.name, seller: seller.name, amount: BigInt(j.amount), round});
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
  console.log('  reputation per seller (API score, from the indexer; history = GET /v1/agents/:id/history):');
  const rep = [];
  for (const s of sellers) {
    const a = await s.sdk.getAgent(s.agentId);
    const h = await (await fetch(`${base}/v1/agents/${s.agentId}/history`)).json();
    const won = ledger.fills.filter((f) => f.seller === s.name).length;
    const bids = ledger.bids.filter((x) => x.seller === s.name).length;
    rep.push({s, a, h, won});
    console.log(
      `    ${s.name.padEnd(7)} floor ${String(s.rule.floor).padStart(6)}  bids ${String(bids).padStart(2)}  won ${String(won).padStart(2)}  ` +
        `score ${String(a.score).padStart(3)}  completed ${String(a.completed).padStart(2)}  history ${h.totals?.settled ?? '?'} settled`,
    );
  }
  console.log('');

  // ── 7. checks, against the chain ──────────────────────────────────────
  ledger.listings.length === BUYERS
    ? ok(`every buyer posted (${BUYERS} listings)`)
    : fail(`${ledger.listings.length} listings, expected ${BUYERS}`);
  ledger.settled.length === ledger.fills.length && ledger.fills.length > 0
    ? ok(`every fill settled on chain (${ledger.settled.length})`)
    : fail(`${ledger.fills.length} fills, ${ledger.settled.length} settled`);
  rep.every(({a, won}) => a.completed === won)
    ? ok("each seller's completed count in the API equals its settled wins: reputation is the chain's record")
    : fail(`completed vs won: ${rep.map(({s, a, won}) => `${s.name} ${a.completed}/${won}`).join(', ')}`);
  rep.every(({h, won}) => h.totals?.settled === won)
    ? ok("each seller's public history (52 weeks) counts the same settlements")
    : fail(`history: ${rep.map(({s, h, won}) => `${s.name} ${h.totals?.settled}/${won}`).join(', ')}`);

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
    const expected = ledger.settled
      .filter((x) => x.seller === s.name)
      .reduce((a, x) => a + x.amount - fee(x.amount), 0n);
    const got = BigInt(after.get(s.agentId).balance) - BigInt(before.get(s.agentId).balance);
    sellerGain += got;
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
