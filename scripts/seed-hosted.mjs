#!/usr/bin/env node
/**
 * Agents for a HOSTED Pactora: an orchestrator and three workers, on chain and
 * registered with the API at <API_URL>, on fresh random keys.
 *
 *   set -a; . ../agentx-contracts/.env; set +a
 *   node scripts/seed-hosted.mjs https://<api>.up.railway.app
 *   node scripts/seed-hosted.mjs --top-up        # later: refill the hosted keys' gas
 *   node scripts/seed-hosted.mjs --reclaim       # retire them: send their MON back to FUNDER
 *
 * Why not the demo's agents: the demo's keys are fixed and committed in
 * scripts/demo.mjs — anyone could sign as them. Here every key is new:
 *
 *   owner     owns all four AgentAccounts and the orchestrator's identity.
 *             It stays in the seed file: it can sweep every account, so it
 *             is never given to the server (audit F1, 2026-10-26)
 *   manager   the accounts' session manager and the signer's
 *             SESSION_MANAGER_PRIVATE_KEY: it extends their 24 h session keys
 *             (AgentAccount.MAX_SESSION_KEY_TTL) every day, and can do nothing
 *             else — not spend, sweep, raise a cap or grant a key
 *   hot       the orchestrator's session key — spends only through its
 *             account, only to the escrow, within 0.10 / 1.00 MockUSDC caps
 *   workers   one key per worker: its account's session key (zero budget;
 *             acceptJob + submitResult only) and its identity's owner
 *
 * FUNDER pays gas (DEPLOYER if FUNDER_PRIVATE_KEY is unset); DEPLOYER bonds
 * the workers and puts 1 MockUSDC in the orchestrator's account.
 *
 * Everything goes to artifacts/hosted-agents.json (gitignored), written BEFORE
 * anything is spent and again at the end, so a crash midway never loses a key
 * that holds gas. Nothing secret is printed. Testnet only.
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPublicClient, createWalletClient, http} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {foundry} from 'viem/chains';
import {loadAbis, loadConfig} from '@pactora/config';
import {registerWithApi, topUp} from './lib/chain.mjs';
import {setupAgents, titleCase} from './lib/agents.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// HOSTED_AGENTS_FILE: a rehearsal writes elsewhere, so it can never touch the
// live agents' keys.
const OUT = process.env.HOSTED_AGENTS_FILE ?? join(HERE, '..', 'artifacts', 'hosted-agents.json');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const apiArg = args.find((a) => !a.startsWith('--'));

/**
 * Gas each hosted key starts with, from a measured hosted run (2026-10-05):
 * the orchestrator's session key spent 0.14 MON, each hiring worker 0.034.
 * 5 MON is ~35 runs; a worker's 1.5 MON is ~40 jobs. The owner pays the setup
 * (~0.25); the manager pays four renewals a day.
 */
const GAS_HOT = 5_000_000_000_000_000_000n;
const GAS_EACH = 1_500_000_000_000_000_000n;
const GAS_OWNER = 1_000_000_000_000_000_000n;
const GAS_MANAGER = 1_000_000_000_000_000_000n;
// envVar: the worker's API key in docker-compose.full.yml (the hosted profile).
const WORKERS = [
  {capability: 'market-research', price: '20000', envVar: 'RESEARCH_BOT_API_KEY'},
  {capability: 'trade-analysis', price: '50000', envVar: 'TRADING_BOT_API_KEY'},
  {capability: 'trade-execution', price: '60000', envVar: 'EXECUTION_BOT_API_KEY'},
];

const ok = (m) => console.log(`  ✓ ${m}`);
const die = (m) => {
  console.error(`\n  ✗ ${m}\n`);
  process.exit(1);
};

const CHAIN_ID = Number(process.env.VERIFY_CHAIN_ID ?? 10143);
const config = loadConfig();
const abis = loadAbis();
const chain = config.chain(CHAIN_ID);
if (!chain.testnet)
  die(`chain ${CHAIN_ID} is not a testnet — this script makes raw keys and is testnet only`);
if (!process.env.DEPLOYER_PRIVATE_KEY)
  die('DEPLOYER_PRIVATE_KEY is not set — load ../agentx-contracts/.env first');

const viemChain = {...foundry, id: CHAIN_ID};
const rpc = () => http(chain.rpcUrl, {retryCount: 6});
const pub = createPublicClient({chain: viemChain, transport: rpc()});
const walletFor = (account) => createWalletClient({account, chain: viemChain, transport: rpc()});
const deployer = walletFor(privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY));
const gasPayer = process.env.FUNDER_PRIVATE_KEY
  ? walletFor(privateKeyToAccount(process.env.FUNDER_PRIVATE_KEY))
  : deployer;
const keyed = (privateKey) => ({address: privateKeyToAccount(privateKey).address, privateKey});

// ── --top-up: refill the hosted keys' gas from FUNDER ─────────────────────
if (flag('--top-up')) {
  if (!existsSync(OUT)) die(`no ${OUT} — seed first`);
  const s = JSON.parse(readFileSync(OUT, 'utf8'));
  const targets = [
    [s.owner.address, GAS_OWNER],
    ...(s.manager ? [[s.manager.address, GAS_MANAGER]] : []),
    [s.orchestrator.sessionKey.address, GAS_HOT],
    ...s.workers.map((w) => [w.key.address, GAS_EACH]),
  ];
  for (const [address, amount] of targets) {
    const before = await pub.getBalance({address});
    await topUp(pub, gasPayer, address, amount);
    const after = await pub.getBalance({address});
    ok(`${address} ${fmt(before)} → ${fmt(after)} MON`);
  }
  process.exit(0);
}

// ── --reclaim: retire the hosted keys, their MON back to the gas payer ────
if (flag('--reclaim')) {
  if (!existsSync(OUT)) die(`no ${OUT} — nothing to reclaim`);
  const s = JSON.parse(readFileSync(OUT, 'utf8'));
  const to = gasPayer.account.address;
  let total = 0n;
  for (const k of [
    s.owner,
    ...(s.manager ? [s.manager] : []),
    s.orchestrator.sessionKey,
    ...s.workers.map((w) => w.key),
  ]) {
    const client = walletFor(privateKeyToAccount(k.privateKey));
    const balance = await pub.getBalance({address: k.address});
    // Monad charges the gas LIMIT: keep enough for this one transfer.
    const gasPrice = await pub.getGasPrice();
    const fee = 21_000n * gasPrice * 2n;
    if (balance <= fee) continue;
    const value = balance - fee;
    const hash = await client.sendTransaction({to, value, gas: 21_000n, gasPrice});
    await pub.waitForTransactionReceipt({hash});
    total += value;
    ok(`${k.address} → ${fmt(value)} MON`);
  }
  ok(`reclaimed ${fmt(total)} MON to ${to}`);
  process.exit(0);
}

if (!apiArg) die('usage: node scripts/seed-hosted.mjs <API_URL>   (or --top-up / --reclaim)');
const API = apiArg.replace(/\/$/, '');
if (existsSync(OUT) && !flag('--force')) {
  die(
    `${OUT} exists — those agents are probably live. Pass --force to make new ones (the old keys stay in that file only if you copy it first).`,
  );
}

// ── the API must be up, on this chain ─────────────────────────────────────
const health = await fetch(`${API}/health`)
  .then((r) => r.json())
  .catch((e) => die(`${API}/health: ${e.message}`));
if (!health?.chains?.some((c) => c.chainId === CHAIN_ID)) die(`${API} does not serve chain ${CHAIN_ID}`);
console.log(`\nPactora hosted seed — ${chain.name} (${CHAIN_ID}) → ${API}`);
console.log(
  `  orchestrator on the API: ${health.orchestrator ? 'yes' : 'NO (no model key yet — runs will be refused until set)'}\n`,
);

// ── keys, saved before anything is spent ──────────────────────────────────
const seed = {
  apiUrl: API,
  chainId: CHAIN_ID,
  createdAt: new Date().toISOString(),
  owner: keyed(generatePrivateKey()),
  manager: keyed(generatePrivateKey()),
  orchestrator: {sessionKey: keyed(generatePrivateKey())},
  workers: WORKERS.map((w) => ({...w, key: keyed(generatePrivateKey())})),
  status: 'keys-generated',
};
mkdirSync(dirname(OUT), {recursive: true});
const save = () => writeFileSync(OUT, `${JSON.stringify(seed, null, 2)}\n`, {mode: 0o600});
save();
ok(
  `fresh keys written to ${relative(process.cwd(), OUT)} (keep it out of git) — owner ${seed.owner.address}`,
);

// ── on chain ──────────────────────────────────────────────────────────────
const owner = walletFor(privateKeyToAccount(seed.owner.privateKey));
const setup = await setupAgents({
  pub,
  chain,
  abis,
  walletFor,
  owner,
  sessionManager: seed.manager.address,
  bonder: deployer,
  gasPayer,
  hotKey: seed.orchestrator.sessionKey.privateKey,
  workerKeys: seed.workers.map((w) => w.key.privateKey),
  workers: WORKERS,
  apiUrl: API,
  gasEach: GAS_EACH,
  extraGas: [
    {address: seed.owner.address, amount: GAS_OWNER},
    {address: seed.manager.address, amount: GAS_MANAGER},
    // The orchestrator's session key spends far more than a worker's.
    {address: seed.orchestrator.sessionKey.address, amount: GAS_HOT},
  ],
  log: ok,
});
Object.assign(seed.orchestrator, {
  chainAgentId: String(setup.orchestratorId),
  wallet: setup.orchestratorWallet,
});
setup.workerIds.forEach((id, i) =>
  Object.assign(seed.workers[i], {chainAgentId: String(id), wallet: setup.workerWallets[i]}),
);
seed.status = 'on-chain';
save();

// ── registered with the hosted API ────────────────────────────────────────
// `owner` is a seed-file key, `{address, privateKey}`: it signs the API's
// registration challenge (proof of control), and only the signature leaves
// this process.
async function register(name, capability, price, chainAgentId, walletAddress, owner) {
  return registerWithApi(
    API,
    {
      name,
      capabilities: [capability],
      pricePerTask: price,
      walletAddress,
      ownerAddress: owner.address,
      chainId: CHAIN_ID,
      chainAgentId,
    },
    privateKeyToAccount(owner.privateKey),
  );
}
const orch = await register(
  'Orchestrator',
  'orchestration',
  '0',
  seed.orchestrator.chainAgentId,
  seed.orchestrator.wallet,
  seed.owner,
);
Object.assign(seed.orchestrator, {agentId: orch.agentId, apiKey: orch.apiKey});
for (const w of seed.workers) {
  const r = await register(titleCase(w.capability), w.capability, w.price, w.chainAgentId, w.wallet, w.key);
  Object.assign(w, {agentId: r.agentId, apiKey: r.apiKey});
}
seed.status = 'registered';

// What each hosted service needs. Values are secrets: set them in the host's
// variables, never in a committed file.
seed.env = {
  signer: {
    SIGNER_DEV_PRIVATE_KEYS: [
      seed.orchestrator.sessionKey.privateKey,
      ...seed.workers.map((w) => w.key.privateKey),
    ].join(','),
    // The session manager, never the owner: the owner key stays in the seed
    // file, with whoever runs this.
    SESSION_MANAGER_PRIVATE_KEY: seed.manager.privateKey,
  },
  workers: Object.fromEntries(
    seed.workers.map((w) => [w.capability, {PACTORA_API_KEY: w.apiKey, PACTORA_AGENT_ID: String(w.agentId)}]),
  ),
  orchestratorApiKeyForJudges: seed.orchestrator.apiKey,
};
// The server's .env lines, under the names the compose file reads — pasted
// as they are, so no key is ever matched to a variable by hand.
seed.env.compose = Object.entries({
  ...seed.env.signer,
  ...Object.fromEntries(WORKERS.map((w, i) => [w.envVar, seed.workers[i].apiKey])),
}).map(([k, v]) => `${k}=${v}`);
save();
ok(
  `registered with ${API}: orchestrator ${orch.agentId}, workers ${seed.workers.map((w) => w.agentId).join(', ')}`,
);
console.log(`
  Next: put the lines of "env.compose" in ${relative(process.cwd(), OUT)} into the server's .env
  (the signer's keys and each worker bot's API key). The orchestrator's API key is for the
  submission form — never a repo, never the site.
`);

function fmt(wei) {
  return (Number(wei / 10n ** 12n) / 1e6).toFixed(4);
}
