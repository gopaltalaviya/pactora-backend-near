#!/usr/bin/env node
/**
 * Seed a running Pactora with agents a visitor can hire, published profiles
 * and open listings, over HTTP only (2026-11-12).
 *
 *   SEED_API_URL=https://api.example node --env-file=../pactora-contracts-near/.env scripts/live-seed.mjs
 *   SEED_API_URL=http://127.0.0.1:8098 SANDBOX_KEY_FILE=… node scripts/live-seed.mjs   # rehearsal on a held demo:local
 *
 * Why a separate script, not `demo.mjs` with DEMO_NETWORK=testnet:
 * - demo.mjs empties the database it is pointed at (TRUNCATE) and starts its
 *   own signer, whose key encryption the server's signer cannot read;
 * - it sweeps (deletes) its test accounts at the end.
 * This script never opens a database. Agents are registered through the
 * API, so the server's own signer makes and keeps their wallet keys, and
 * nothing it creates is ever deleted. Owner keys go to `.keys/live-seed/`
 * (gitignored, and not a folder `sweep` reads). Run it again and it reuses
 * what it made (`.keys/live-seed/<network>.json`) and only adds what is
 * missing.
 *
 * What it leaves:
 * - three worker agents (market-research, trade-analysis, trade-execution:
 *   the capabilities of the hosted bots), staked so they can be hired, with
 *   published profiles;
 * - one client agent with a funded purse, whose three listings stay open
 *   for a week.
 * The bots' API keys are written to `.keys/live-seed/<network>.bots.env` in
 * the shape the server's `.env` wants (RESEARCH_BOT_API_KEY=…). Printed:
 * names and ids only, never a key.
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Account, KeyPairSigner} from 'near-api-js';
import {PactoraClient} from '@pactora/sdk';
import {signNep413} from '@pactora/near';
import {KeyPair, createPerson, deposit, mintTo, registerOnChain, rootAccount, view} from './lib/near.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = (process.env.SEED_API_URL ?? '').replace(/\/+$/, '');
if (!API) throw new Error('SEED_API_URL must name the API to seed, e.g. http://127.0.0.1:8098');

const WORKERS = [
  {
    key: 'research',
    env: 'RESEARCH_BOT_API_KEY',
    name: 'Atlas Research',
    capability: 'market-research',
    price: '20000',
    headline: 'Market research on NEAR tokens and pools, with sources',
    skills: ['market-research'],
  },
  {
    key: 'analysis',
    env: 'TRADING_BOT_API_KEY',
    name: 'Cobalt Analysis',
    capability: 'trade-analysis',
    price: '30000',
    headline: 'Turns research into a trade plan with risks stated',
    skills: ['trade-analysis'],
  },
  {
    key: 'execution',
    env: 'EXECUTION_BOT_API_KEY',
    name: 'Delta Execution',
    capability: 'trade-execution',
    price: '40000',
    headline: 'Writes the exact order to place, sized to a stated budget',
    skills: ['trade-execution'],
  },
];

const CLIENT = {
  key: 'client',
  name: 'Demo Client',
  capability: 'orchestration',
  price: '0',
  headline: 'Posts tasks for agents and people to bid on',
};

/** Open for a week: plain tasks a person or an agent could take (as `demo.mjs` OPEN_LISTINGS). */
const LISTINGS = [
  {
    title: "Summarise this week's NEAR governance proposals",
    description:
      'One paragraph per open proposal on the NEAR governance forum: what it asks, who proposed it, and the vote so far.',
    category: 'expertise',
    interactionMode: 'task',
    skills: ['market-research'],
    maxPriceBaseUnits: '50000',
    criteria: 'Every open proposal is covered, each with its link and current vote count.',
  },
  {
    title: 'Check 20 token prices against two sources',
    description:
      'For 20 listed tokens, read the price from two public sources and flag any that differ by more than 1%.',
    category: 'expertise',
    interactionMode: 'task',
    skills: ['trade-analysis'],
    maxPriceBaseUnits: '60000',
    criteria: 'A table with both prices per token and every difference over 1% flagged.',
  },
  {
    title: 'Photograph the opening hours sign of a café',
    description: 'One clear photo of the posted opening hours at the entrance of any café in Berlin Mitte.',
    category: 'physical',
    interactionMode: 'capture',
    skills: ['shop-photos'],
    location: 'Berlin',
    maxPriceBaseUnits: '40000',
    criteria: 'The hours are readable and the café name is in the frame.',
  },
];

const ok = (m) => console.log(`  ✓ ${m}`);
const step = (m) => console.log(`\n▸ ${m}`);

async function api(method, path, body, apiKey) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? {authorization: `Bearer ${apiKey}`} : {}),
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(`${method} ${path}: ${res.status} ${json.code ?? ''} ${json.detail ?? ''}`.trim());
  return json;
}

// ── where we are ──────────────────────────────────────────────────────────
const network = await api('GET', '/v1/network');
const CHAIN_ID = network.chainId;
if (CHAIN_ID !== 'near:testnet' && CHAIN_ID !== 'near:sandbox') {
  throw new Error(`refusing ${CHAIN_ID}: this seeds testnet or the local sandbox only`);
}
const PACTORA = network.contracts?.Pactora;
const TOKEN = network.paymentToken?.accountId;
const MIN_STAKE = BigInt(network.minStake);
if (!PACTORA || !TOKEN) throw new Error('the API names no Pactora contract or payment token');
const slug = CHAIN_ID.split(':')[1];
const chain = {chainId: CHAIN_ID, rpcUrl: network.rpcUrls[0]};
const root = rootAccount(chain);

const dir = join(ROOT, '.keys', 'live-seed');
mkdirSync(dir, {recursive: true});
const stateFile = join(dir, `${slug}.json`);
/** owners: id → secret; agents: key → {agentId, chainAgentId, apiKey, owner}; listings: done idempotency keys. */
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, 'utf8'))
  : {owners: {}, agents: {}, listings: []};
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2), {mode: 0o600});

console.log(`\nSeeding ${network.name} (${CHAIN_ID}) through ${API}: contract ${PACTORA}`);

// ── owners and agents ─────────────────────────────────────────────────────
async function ownerFor(key) {
  const known = Object.entries(state.owners).find(([id]) => id.startsWith(`seed-${key}-`));
  if (known) {
    const keyPair = KeyPair.fromString(known[1]);
    return {
      id: known[0],
      keyPair,
      provider: root.provider,
      account: new Account(known[0], root.provider, new KeyPairSigner(keyPair)),
    };
  }
  const name = `seed-${key}-${Date.now().toString(36)}`;
  // The key is on disk before the account exists, so a crash cannot strand it.
  const person = await createPerson(root, name, '2', {
    save: (id, kp) => {
      state.owners[id] = kp.toString();
      save();
    },
  });
  return person;
}

async function registerAgent(spec) {
  if (state.agents[spec.key]) return state.agents[spec.key];
  const owner = await ownerFor(spec.key);
  const wallet = `bot.${owner.id}`;
  const {walletPublicKey} = await api('POST', '/v1/agents/wallet-key', {
    walletAddress: wallet,
    chainId: CHAIN_ID,
  });
  const chainAgentId = await registerOnChain(owner, {
    wallet,
    walletPublicKey,
    pactora: PACTORA,
    cardUri: `data:,${spec.name}`,
  });
  const challenge = await api('POST', '/v1/agents/challenge', {
    ownerAddress: owner.id,
    walletAddress: wallet,
    chainAgentId,
    chainId: CHAIN_ID,
  });
  const signed = await signNep413({
    accountId: owner.id,
    keyPair: owner.keyPair,
    message: challenge.message,
    recipient: challenge.recipient,
    nonce: new Uint8Array(Buffer.from(challenge.nonce, 'hex')),
  });
  const agent = await api('POST', '/v1/agents', {
    name: spec.name,
    description: `${spec.headline}.`,
    capabilities: [spec.capability],
    pricePerTask: spec.price,
    walletAddress: wallet,
    ownerAddress: owner.id,
    chainId: CHAIN_ID,
    chainAgentId,
    nonce: challenge.nonce,
    publicKey: signed.publicKey,
    signature: signed.signature,
  });
  state.agents[spec.key] = {
    agentId: String(agent.agentId),
    chainAgentId: String(chainAgentId),
    apiKey: agent.apiKey,
    owner: owner.id,
    staked: false,
    funded: false,
    profile: false,
  };
  save();
  return state.agents[spec.key];
}

step('agents, registered through the API (the server signer keeps their wallet keys)');
for (const spec of [...WORKERS, CLIENT]) {
  const a = await registerAgent(spec);
  ok(`${spec.name}: agent ${a.agentId}, chain agent ${a.chainAgentId}, owner ${a.owner}`);
}

// ── money: stakes for the workers, a purse for the client ─────────────────
step('stakes and purse (test mUSDC, minted by the deployer)');
for (const spec of WORKERS) {
  const a = state.agents[spec.key];
  if (a.staked) {
    ok(`${spec.name} already staked`);
    continue;
  }
  const o = await ownerFor(spec.key);
  const amount = MIN_STAKE + 1_000_000n;
  await mintTo(root, TOKEN, o, amount);
  await deposit(o, TOKEN, PACTORA, amount, {Stake: {agent_id: Number(a.chainAgentId)}});
  const stake = await view(root.provider, PACTORA, 'stake_of', {agent_id: Number(a.chainAgentId)});
  if (!stake?.hireable) throw new Error(`${spec.name}: staked but not hireable: ${JSON.stringify(stake)}`);
  a.staked = true;
  save();
  ok(`${spec.name} staked ${amount} base units and is hireable`);
}
{
  const a = state.agents[CLIENT.key];
  if (a.funded) ok(`${CLIENT.name} purse already funded`);
  else {
    const o = await ownerFor(CLIENT.key);
    await mintTo(root, TOKEN, o, 2_000_000);
    await deposit(o, TOKEN, PACTORA, 2_000_000, {Fund: {agent_id: Number(a.chainAgentId)}});
    a.funded = true;
    save();
    ok(`${CLIENT.name} funded 2 mUSDC into its purse`);
  }
}

// ── profiles on /people ───────────────────────────────────────────────────
step('published profiles');
for (const spec of [...WORKERS, CLIENT]) {
  const a = state.agents[spec.key];
  const sdk = new PactoraClient({baseUrl: API, apiKey: a.apiKey, chainId: CHAIN_ID});
  await sdk.updateMyProfile({
    displayName: spec.name,
    headline: spec.headline,
    ...(spec.skills ? {skills: spec.skills} : {}),
    published: true,
  });
  a.profile = true;
  save();
  ok(`${spec.name}: profile published`);
}

// ── open listings on /jobs ────────────────────────────────────────────────
step('open listings, posted by the client agent');
{
  const client = new PactoraClient({
    baseUrl: API,
    apiKey: state.agents[CLIENT.key].apiKey,
    chainId: CHAIN_ID,
  });
  const week = new Date(Date.now() + 7 * 86_400_000).toISOString();
  for (const [i, l] of LISTINGS.entries()) {
    // One key per listing per day: re-running the same day never posts twice.
    const key = `seed-open-${i}-${new Date().toISOString().slice(0, 10)}`;
    if (state.listings.includes(key)) {
      ok(`"${l.title}" already posted today`);
      continue;
    }
    await client.postListing(
      {
        ...l,
        maxWorkers: 1,
        estimatedMinutes: 45,
        deadline: week,
        // Within testnet's max_accept_window (3000 s) and max_work_window (18000 s).
        acceptWindowSeconds: 1800,
        workWindowSeconds: 14_400,
      },
      key,
    );
    state.listings.push(key);
    save();
    ok(`"${l.title}" open for a week`);
  }
}

// ── the bots' keys, for the server's .env ─────────────────────────────────
const botsEnv = join(dir, `${slug}.bots.env`);
writeFileSync(botsEnv, WORKERS.map((w) => `${w.env}=${state.agents[w.key].apiKey}`).join('\n') + '\n', {
  mode: 0o600,
});
console.log(`\nSeed done. The bots' API keys are in ${botsEnv} (not printed; never commit it).`);
