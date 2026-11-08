#!/usr/bin/env node
/**
 * The real stack for the interface's live browser tests
 * (pactora-interface-near/e2e-live): signer, api, indexer and notifier on
 * their own ports, against a database of their own and the local
 * near-sandbox, plus a small "wallet service" the browser tests call instead
 * of a wallet extension.
 *
 *   SANDBOX_KEY_FILE=.sandbox/validator_key.json node scripts/live-ui-stack.mjs
 *
 * The wallet service holds the full-access keys of the test accounts it
 * creates (sandbox only; they live in this process's memory and nowhere
 * else) and does for real what a wallet does for the page: NEP-413
 * `signMessage` with near-api-js's own implementation, and
 * `signAndSendTransactions`, signed and sent to the sandbox and awaited to
 * finality. Nothing on the page or in the API is mocked.
 *
 * It refuses anything but the local sandbox. Service ports, the database
 * name and the bucket are env-overridable (LIVE_*). POST /shutdown (or
 * Ctrl+C) restores the arbiter if a DAO was installed, stops the services,
 * drops the database and removes the bucket.
 */
import {spawn, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Account, KeyPair, KeyPairSigner, PublicKey, actions} from 'near-api-js';
import {signMessage} from 'near-api-js/nep413';
import postgres from 'postgres';
import {loadConfig} from '@pactora/config';
import {call, createPerson, mintTo, rootAccount, view} from './lib/near.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHAIN_ID = 'near:sandbox';
const PG = process.env.LIVE_PG ?? 'postgres://pactora:pactora@127.0.0.1:5443';
const DB_NAME = process.env.LIVE_DB ?? 'pactora_live_ui';
if (!/^pactora_live_[a-z0-9_]+$/.test(DB_NAME)) throw new Error('LIVE_DB must start with pactora_live_');
const DB_URL = `${PG}/${DB_NAME}`;
const API_PORT = Number(process.env.LIVE_API_PORT ?? 8188);
const SIGNER_PORT = Number(process.env.LIVE_SIGNER_PORT ?? 7188);
const WALLET_PORT = Number(process.env.LIVE_WALLET_PORT ?? 7288);
const WEB_ORIGIN = process.env.LIVE_WEB_ORIGIN ?? 'http://127.0.0.1:3188';
const BUCKET = process.env.LIVE_BUCKET ?? 'pactora-live-ui-evidence';
const MINIO = {
  endpoint: 'http://127.0.0.1:9110',
  // The compose MinIO's dev-only credentials (docker-compose.yml).
  accessKeyId: 'pactora',
  secretAccessKey: 'pactora-dev-only',
};
const STATE_FILE = process.env.LIVE_STATE ?? join(ROOT, 'artifacts', 'live-ui', 'state.json');
const LOG_DIR = join(ROOT, 'artifacts', 'live-ui');
mkdirSync(LOG_DIR, {recursive: true});

const config = loadConfig({env: {...process.env, ENABLED_CHAINS: CHAIN_ID, DEFAULT_CHAIN: CHAIN_ID}});
const chain = config.chain(CHAIN_ID);
if (chain.chainId !== 'near:sandbox') throw new Error('the live UI stack runs on the local sandbox only');
const {Pactora: PACTORA, PaymentToken: TOKEN, Arbiter: ARBITER} = chain.contracts;
const root = rootAccount(chain);
const run = `ui${Date.now().toString(36)}`;
const log = (m) => console.log(`[live-ui] ${m}`);

// ── one queue per signing account: a NEAR nonce is per access key ──────
const queues = new Map();
function serial(id, fn) {
  const prev = queues.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(
    id,
    next.catch(() => undefined),
  );
  return next;
}

/** accountId → {keyPair, account}: the keys this "wallet" holds. */
const keys = new Map();
const rootSerial = (fn) => serial(root.id, fn);

async function newPerson(name, near = '5', musdc = 0n) {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 30);
  const person = await rootSerial(() => createPerson(root, `${run}-${safe}`, near));
  if (musdc > 0n) await rootSerial(() => mintTo(root, TOKEN, person, musdc));
  keys.set(person.id, person);
  return person;
}

// ── the database ─────────────────────────────────────────────────────────
const admin = postgres(`${PG}/postgres`, {max: 1, onnotice: () => {}});
await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
const migrated = spawnSync(process.execPath, [join(ROOT, 'packages/db/bin/migrate.mjs')], {
  env: {...process.env, DATABASE_URL: DB_URL},
  encoding: 'utf8',
});
if (migrated.status !== 0) throw new Error(`migrate failed: ${migrated.stderr}`);
log(`database ${DB_NAME} created and migrated`);
const sql = postgres(DB_URL, {max: 3, onnotice: () => {}});

// A sanctions list of two names, so a strong match is a real screening hit.
const [ver] = await sql`
  INSERT INTO sanctions_list_versions (source, sha256, entry_count, active)
  VALUES ('ofac', ${randomBytes(32).toString('hex')}, 2, true) RETURNING id`;
await sql`
  INSERT INTO sanctions_entries (version_id, source, ref, kind, names)
  VALUES (${ver.id}, 'ofac', 'LIVE-UI-1', 'individual', ${['Ivan Petrovich Sanctionov']}),
         (${ver.id}, 'ofac', 'LIVE-UI-2', 'entity', ${['Blackwater Shell Holdings']})`;

// ── accounts that must exist before the API starts ──────────────────────
const reviewers = [await newPerson('reviewer1', '3'), await newPerson('reviewer2', '3')];
const keeperKey = KeyPair.fromRandom('ed25519');
const keeperId = `${run}-keeper.${root.id}`;
await rootSerial(() =>
  root.account.signAndSendTransaction({
    receiverId: keeperId,
    actions: [
      actions.createAccount(),
      actions.transfer((1n * 10n ** 24n) / 2n),
      actions.addFunctionCallAccessKey(keeperKey.getPublicKey(), PACTORA, [], 5n * 10n ** 23n),
    ],
    waitUntil: 'FINAL',
  }),
);
const faucet = await newPerson('faucet', '3', 100_000_000n);
log(`reviewers ${reviewers.map((r) => r.id).join(', ')}; keeper and faucet created`);

// ── the services ─────────────────────────────────────────────────────────
const env = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: DB_URL,
  ENABLED_CHAINS: CHAIN_ID,
  DEFAULT_CHAIN: CHAIN_ID,
  SIGNER_PORT: String(SIGNER_PORT),
  SIGNER_URL: `http://127.0.0.1:${SIGNER_PORT}`,
  SIGNER_TOKEN: randomBytes(24).toString('hex'),
  SIGNER_KEY_PASSPHRASE: `live-ui-only-${randomBytes(24).toString('hex')}`,
  KEEPER_ACCOUNT_ID: keeperId,
  KEEPER_SECRET_KEY: keeperKey.toString(),
  // Slow by default: the sandbox review window is 10 s, and a keeper auto-approving
  // would race the client's own Approve in the browser.
  KEEPER_INTERVAL_MS: process.env.LIVE_KEEPER_INTERVAL_MS ?? '600000',
  PORT: String(API_PORT),
  LOG_LEVEL: 'warn',
  RATE_LIMIT_PER_MINUTE: '20000',
  OBJECT_STORE_BUCKET: BUCKET,
  OBJECT_STORE_ENDPOINT: MINIO.endpoint,
  OBJECT_STORE_ACCESS_KEY_ID: MINIO.accessKeyId,
  OBJECT_STORE_SECRET_ACCESS_KEY: MINIO.secretAccessKey,
  OBJECT_STORE_FORCE_PATH_STYLE: '1',
  WEBHOOK_SECRET_KEY: randomBytes(32).toString('hex'),
  WEBHOOK_ALLOW_PRIVATE: '1',
  NOTIFIER_IDLE_MS: '200',
  FAUCET_ACCOUNT_ID: faucet.id,
  FAUCET_SECRET_KEY: faucet.keyPair.toString(),
  FAUCET_AMOUNT: '5000000',
  // Every browser project claims from 127.0.0.1.
  FAUCET_PER_IP_PER_DAY: '1000',
  SANCTIONS_SCREENING: 'on',
  IDENTITY_PROVIDER: 'simulated',
  KYC_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
  KYC_PAGE_BASE: WEB_ORIGIN,
  COMPLIANCE_REVIEWERS: reviewers.map((r) => r.id).join(','),
  INDEXER_START_AT_HEAD: '1',
  INDEXER_POLL_MS: '500',
  AGENT_MODE: 'cached',
};
const children = [];
let stopping = false;
function start(name, script) {
  const child = spawn(process.execPath, [join(ROOT, script)], {env, stdio: ['ignore', 'pipe', 'pipe']});
  const sink = createWriteStream(join(LOG_DIR, `${name}.log`));
  child.stdout.pipe(sink);
  child.stderr.pipe(sink);
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[live-ui] the ${name} exited (${signal ?? code}); see artifacts/live-ui/${name}.log`);
      void shutdown(1);
    }
  });
  children.push(child);
}
async function waitFor(url, label) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return log(`${label} is up`);
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} never became healthy at ${url}`);
}
start('signer', 'apps/signer/dist/main.js');
await waitFor(`http://127.0.0.1:${SIGNER_PORT}/health`, 'signer');
start('api', 'apps/api/dist/main.js');
start('indexer', 'apps/indexer/dist/main.js');
start('notifier', 'apps/notifier/dist/main.js');
await waitFor(`http://127.0.0.1:${API_PORT}/health`, 'api');

// ── the wallet: what a NEAR wallet does for the page, for real ──────────
function toAction(a) {
  const p = a.params ?? {};
  switch (a.type) {
    case 'CreateAccount':
      return actions.createAccount();
    case 'Transfer':
      return actions.transfer(BigInt(p.deposit));
    case 'AddKey': {
      const perm = p.accessKey?.permission;
      if (perm === 'FullAccess' || !perm) return actions.addFullAccessKey(PublicKey.from(p.publicKey));
      return actions.addFunctionCallAccessKey(
        PublicKey.from(p.publicKey),
        perm.receiverId,
        perm.methodNames ?? [],
        perm.allowance ? BigInt(perm.allowance) : undefined,
      );
    }
    case 'FunctionCall':
      return actions.functionCall(p.methodName, p.args ?? {}, BigInt(p.gas), BigInt(p.deposit ?? '0'));
    default:
      throw new Error(`this wallet does not sign ${a.type}`);
  }
}

const holder = (id) => {
  const k = keys.get(id);
  if (!k) throw Object.assign(new Error(`this wallet holds no key for ${id}`), {status: 403});
  return k;
};

const handlers = {
  'GET /health': async () => ({ok: true}),
  'GET /facts': async () => facts,
  'POST /account': async ({name, near = '5', musdc = '0'}) => {
    const p = await newPerson(String(name), String(near), BigInt(musdc));
    return {accountId: p.id, publicKey: p.keyPair.getPublicKey().toString()};
  },
  'POST /sign-message': async ({accountId, message, recipient, nonce}) => {
    const k = holder(accountId);
    const s = await signMessage({
      signerAccount: new Account(accountId, root.provider, new KeyPairSigner(k.keyPair)),
      payload: {message, recipient, nonce: Uint8Array.from(nonce)},
    });
    return {
      accountId,
      publicKey: k.keyPair.getPublicKey().toString(),
      signature: Buffer.from(s.signature).toString('base64'),
    };
  },
  'POST /send': async ({signerId, transactions}) => {
    const k = holder(signerId);
    return serial(signerId, async () => {
      const out = [];
      for (const tx of transactions) {
        const outcome = await k.account.signAndSendTransaction({
          receiverId: tx.receiverId,
          actions: tx.actions.map(toAction),
          waitUntil: 'FINAL',
          throwOnFailure: false,
        });
        out.push(outcome);
        if (typeof outcome.status === 'object' && 'Failure' in outcome.status) break;
      }
      return out;
    });
  },
  'POST /view': async ({contract, method, args}) => ({
    value: await view(root.provider, contract ?? PACTORA, method, args ?? {}),
  }),
  'POST /standing': async ({accountId, standing, reason}) => {
    const [agent] = await sql`SELECT id FROM agents WHERE owner_address = ${accountId} ORDER BY id LIMIT 1`;
    if (!agent) throw Object.assign(new Error(`no agent owned by ${accountId}`), {status: 404});
    await sql`
      INSERT INTO account_standing (agent_id, standing, reason, updated_at)
      VALUES (${agent.id}, ${standing}, ${reason}, now())
      ON CONFLICT (agent_id) DO UPDATE SET standing = EXCLUDED.standing, reason = EXCLUDED.reason, updated_at = now()`;
    return {agentId: String(agent.id), standing};
  },
  'POST /sql-read': async ({query}) => {
    // Read-only checks for the tests: SELECT only.
    if (!/^\s*select\b/i.test(query) || /;\s*\S/.test(query)) throw new Error('SELECT only');
    return {rows: await sql.unsafe(query)};
  },
  'POST /dao': async ({members}) => {
    if (daoId) return {daoId, members: daoMembers};
    const contractsRoot = process.env.PACTORA_CONTRACTS_ROOT ?? join(ROOT, '..', 'pactora-contracts-near');
    const wasm = join(contractsRoot, 'dao.wasm');
    if (!existsSync(wasm)) throw new Error(`no Sputnik DAO code at ${wasm}`);
    const {deployDaoSandbox} = await import(
      pathToFileURL(join(contractsRoot, 'scripts', 'lib', 'dao.mjs')).href
    );
    const id = `${run}-dao${++daoCount}.${root.id}`;
    await rootSerial(() => deployDaoSandbox(root.account, id, readFileSync(wasm), members));
    await rootSerial(() => call(root.account, PACTORA, 'set_arbiter', {arbiter: id}, {deposit: 1n}));
    daoId = id;
    daoMembers = members;
    log(`arbiter set to the DAO ${id} (members ${members.join(', ')})`);
    return {daoId, members};
  },
  'POST /dao/restore': async () => restoreArbiter(),
  'POST /shutdown': async () => {
    setTimeout(() => void shutdown(0), 50);
    return {stopping: true};
  },
};

let daoId = null;
let daoCount = 0;
let daoMembers = [];
async function restoreArbiter() {
  if (!daoId) return {arbiter: ARBITER};
  await rootSerial(() => call(root.account, PACTORA, 'set_arbiter', {arbiter: ARBITER}, {deposit: 1n}));
  log(`arbiter restored to ${ARBITER}`);
  daoId = null;
  return {arbiter: ARBITER};
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const h = handlers[`${req.method} ${req.url}`];
    if (!h) return res.writeHead(404).end();
    try {
      const body = raw ? JSON.parse(raw) : {};
      const out = await h(body);
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch (err) {
      res.writeHead(err.status ?? 500, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: String(err.message ?? err)}));
    }
  });
});
await new Promise((r) => server.listen(WALLET_PORT, '127.0.0.1', r));

const facts = {
  run,
  api: `http://127.0.0.1:${API_PORT}`,
  wallet: `http://127.0.0.1:${WALLET_PORT}`,
  rpc: chain.rpcUrl,
  chainId: CHAIN_ID,
  pactora: PACTORA,
  token: TOKEN,
  arbiter: ARBITER,
  reviewers: reviewers.map((r) => r.id),
  minStake: chain.onchainParams.min_stake,
};
mkdirSync(dirname(STATE_FILE), {recursive: true});
writeFileSync(STATE_FILE, JSON.stringify(facts, null, 2));
log(`ready: api ${facts.api}, wallet service ${facts.wallet}; facts in ${STATE_FILE}`);

// ── shutdown ─────────────────────────────────────────────────────────────
async function removeBucket() {
  const require = createRequire(join(ROOT, 'packages', 'storage', 'package.json'));
  const s3 = await import(pathToFileURL(require.resolve('@aws-sdk/client-s3')).href);
  const client = new s3.S3Client({
    endpoint: MINIO.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {accessKeyId: MINIO.accessKeyId, secretAccessKey: MINIO.secretAccessKey},
  });
  try {
    for (;;) {
      const list = await client.send(new s3.ListObjectsV2Command({Bucket: BUCKET}));
      const objects = (list.Contents ?? []).map((o) => ({Key: o.Key}));
      if (objects.length === 0) break;
      await client.send(new s3.DeleteObjectsCommand({Bucket: BUCKET, Delete: {Objects: objects}}));
    }
    await client.send(new s3.DeleteBucketCommand({Bucket: BUCKET}));
    log(`bucket ${BUCKET} removed`);
  } catch (err) {
    if (err?.name !== 'NoSuchBucket') console.error(`[live-ui] bucket: ${err.message ?? err}`);
  }
}

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  await restoreArbiter().catch((e) => console.error(`[live-ui] restore arbiter: ${e.message}`));
  for (const c of children) c.kill();
  await new Promise((r) => setTimeout(r, 1500));
  server.close();
  await sql.end().catch(() => {});
  if (process.env.LIVE_KEEP_DB !== '1') {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch((e) => console.error(e));
    log(`database ${DB_NAME} dropped`);
  }
  await admin.end().catch(() => {});
  await removeBucket();
  process.exit(code);
}
process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));
