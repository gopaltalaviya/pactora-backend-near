#!/usr/bin/env node
/**
 * Everything, locally, in one command — no keys, no API quota, no testnet:
 *
 *   pnpm demo:local
 *
 * 1. Postgres and a fresh local NEAR node (docker compose, profile sandbox).
 * 2. The contracts deployed from ../pactora-contracts-near (its committed,
 *    hash-checked wasm), so no Rust toolchain is needed.
 * 3. Migrations, a build, then `scripts/demo.mjs` with AGENT_MODE=cached:
 *    agents registered, hired, judged and paid on chain, then the attack.
 *
 * Needs Docker, Node 22+, pnpm, and the contracts repo cloned beside this one
 * (or PACTORA_CONTRACTS_ROOT). Ends with "Demo passed." and exit code 0.
 */
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = resolve(process.env.PACTORA_CONTRACTS_ROOT ?? join(ROOT, '..', 'pactora-contracts-near'));
const KEY_FILE = join(ROOT, '.sandbox', 'validator_key.json');
const RPC = 'http://127.0.0.1:3030';
const shell = process.platform === 'win32';

function step(title, cmd, args, opts = {}) {
  console.log(`\n▸ ${title}\n  $ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell,
    cwd: ROOT,
    ...opts,
    env: {...process.env, ...opts.env},
  });
  if (r.status !== 0) {
    console.error(`\n✗ ${title} failed (exit ${r.status ?? r.signal}).`);
    process.exit(r.status ?? 1);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(join(CONTRACTS, 'scripts', 'deploy.mjs'))) {
  console.error(
    `✗ no contracts repo at ${CONTRACTS} — clone pactora-contracts-near beside this repo, or set PACTORA_CONTRACTS_ROOT`,
  );
  process.exit(2);
}

step('Postgres and a fresh NEAR sandbox', 'docker', [
  'compose',
  '--profile',
  'sandbox',
  'up',
  '-d',
  '--build',
  '--force-recreate',
  '--wait',
  'postgres',
  'near-sandbox',
]);
for (let i = 0; ; i++) {
  try {
    const s = await (await fetch(`${RPC}/status`)).json();
    if (s.chain_id === 'sandbox' && existsSync(KEY_FILE)) break;
  } catch {
    // not up yet
  }
  if (i > 90) {
    console.error(
      '✗ the sandbox did not answer at 127.0.0.1:3030 within 3 minutes (docker compose logs near-sandbox)',
    );
    process.exit(1);
  }
  await sleep(2000);
}
// The compose Postgres above, unless the caller points elsewhere. A fresh clone
// has no .env, and the migrator refuses to guess a database on its own.
const env = {
  SANDBOX_KEY_FILE: KEY_FILE,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near',
};
if (!existsSync(join(CONTRACTS, 'node_modules', 'near-api-js')))
  step('contracts tooling', 'npm', ['ci'], {cwd: CONTRACTS});
step('deploy the contracts to the sandbox', 'node', ['scripts/deploy.mjs', '--network', 'sandbox'], {
  cwd: CONTRACTS,
  env,
});
step('database migrations', 'pnpm', ['db:migrate'], {env});
step('build', 'pnpm', ['build']);
step('the demo (cached models: no key, no quota)', 'node', ['scripts/demo.mjs', ...process.argv.slice(2)], {
  env: {...env, AGENT_MODE: process.env.AGENT_MODE ?? 'cached'},
});
