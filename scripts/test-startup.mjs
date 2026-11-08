#!/usr/bin/env node
/**
 * Startup guards (docs/26 F26): each service, given a bad configuration,
 * must REFUSE to start — exit non-zero, naming the problem — rather than boot
 * on a default and fail later with an error about something else.
 *
 * Spawns the BUILT entry points (`pnpm -r build` first), each with a clean
 * environment: nothing from this shell or a `.env` leaks in, and every case
 * points at the local sandbox chain id and a closed local port, so no case
 * can reach a real network — testnet or mainnet.
 *
 *   pnpm test:startup
 */
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** A port nothing listens on: an RPC or database "there" refuses at once. */
const CLOSED = 'http://127.0.0.1:9';
const CLOSED_DB = 'postgres://pactora:pactora@127.0.0.1:9/pactora_near';
const TIMEOUT_MS = 30_000;

/** What every case shares: a local-only chain, and only what Node needs to run. */
const BASE = {
  ENABLED_CHAINS: 'near:sandbox',
  DEFAULT_CHAIN: 'near:sandbox',
  RPC_URL_SANDBOX: CLOSED,
  LOG_LEVEL: 'error',
};
const PASS_THROUGH = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'windir',
];

const ENTRY = {
  api: 'apps/api/dist/main.js',
  signer: 'apps/signer/dist/main.js',
  indexer: 'apps/indexer/dist/main.js',
};

/** [service, what is wrong, env on top of BASE, what the refusal must say] */
const CASES = [
  ['api', 'no DATABASE_URL', {}, /DATABASE_URL/],
  ['api', 'DATABASE_URL is not postgres', {DATABASE_URL: 'mysql://x@127.0.0.1/db'}, /DATABASE_URL.*postgres/],
  [
    'api',
    'production without CORS_ORIGINS',
    {NODE_ENV: 'production', DATABASE_URL: CLOSED_DB},
    /CORS_ORIGINS is required when NODE_ENV=production/,
  ],
  [
    'api',
    'production with evidence uploads on and no object store',
    {NODE_ENV: 'production', DATABASE_URL: CLOSED_DB, CORS_ORIGINS: 'https://pactora.example'},
    /OBJECT_STORE_BUCKET is required when NODE_ENV=production and EVIDENCE_UPLOADS=on/,
  ],
  [
    'api',
    'an object store key id without its secret',
    {DATABASE_URL: CLOSED_DB, OBJECT_STORE_BUCKET: 'evidence', OBJECT_STORE_ACCESS_KEY_ID: 'id'},
    /OBJECT_STORE_ACCESS_KEY_ID and OBJECT_STORE_SECRET_ACCESS_KEY together/,
  ],
  ['api', 'SIGNER_URL is not http(s)', {DATABASE_URL: CLOSED_DB, SIGNER_URL: 'ftp://signer'}, /SIGNER_URL/],
  ['api', 'SIGNER_TOKEN too short', {DATABASE_URL: CLOSED_DB, SIGNER_TOKEN: 'short'}, /SIGNER_TOKEN/],
  ['api', 'PORT out of range', {DATABASE_URL: CLOSED_DB, PORT: '70000'}, /PORT/],
  ['api', 'unknown chain', {DATABASE_URL: CLOSED_DB, ENABLED_CHAINS: 'near:nowhere'}, /near:nowhere/],
  [
    'api',
    'a pre-rename variable',
    {DATABASE_URL: CLOSED_DB, AGENTX_API_URL: 'x'},
    /AGENTX_API_URL was renamed/,
  ],
  [
    'api',
    'an RPC that does not answer',
    {DATABASE_URL: CLOSED_DB},
    /RPC at http:\/\/127\.0\.0\.1:9.*did not answer.*refusing to start/,
  ],
  ['signer', 'no DATABASE_URL', {}, /DATABASE_URL/],
  [
    'signer',
    'SIGNER_TOKEN too short',
    {DATABASE_URL: CLOSED_DB, SIGNER_TOKEN: 'short'},
    /SIGNER_TOKEN must be at least 32/,
  ],
  [
    'signer',
    'SIGNER_KEY_PASSPHRASE too short',
    {DATABASE_URL: CLOSED_DB, SIGNER_KEY_PASSPHRASE: 'short'},
    /SIGNER_KEY_PASSPHRASE must be at least 32/,
  ],
  [
    'signer',
    'KEEPER_SECRET_KEY malformed',
    {DATABASE_URL: CLOSED_DB, KEEPER_SECRET_KEY: 'hunter2'},
    /KEEPER_SECRET_KEY/,
  ],
  [
    'signer',
    'an RPC that does not answer',
    {DATABASE_URL: CLOSED_DB},
    /RPC at http:\/\/127\.0\.0\.1:9.*did not answer.*refusing to start/,
  ],
  ['indexer', 'no DATABASE_URL', {}, /DATABASE_URL/],
  [
    'indexer',
    'INDEXER_HEALTH_PORT out of range',
    {DATABASE_URL: CLOSED_DB, INDEXER_HEALTH_PORT: '99999'},
    /INDEXER_HEALTH_PORT/,
  ],
  [
    'indexer',
    'INDEXER_START_AT_HEAD not a flag',
    {DATABASE_URL: CLOSED_DB, INDEXER_START_AT_HEAD: 'yes'},
    /INDEXER_START_AT_HEAD/,
  ],
];

function run(entry, extra) {
  const env = {...BASE, ...extra};
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, entry)], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    // 'close', not 'exit': 'exit' can fire before the pipes are drained, and
    // then the refusal's own words are not in `out` yet (seen as a flaky
    // "refused without naming").
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({code, signal, out});
    });
  });
}

for (const entry of Object.values(ENTRY)) {
  if (!existsSync(join(ROOT, entry))) {
    console.error(`✗ ${entry} is not built — run pnpm -r build first`);
    process.exit(2);
  }
}

/**
 * Node itself can die with a Windows access violation (exit 0xC0000005,
 * nothing printed) when many processes start at once — seen 1 in ~40 starts
 * with all cases in parallel. That is not a guard failing, so such a run is
 * retried once and said so; any other outcome counts as it is.
 */
const NATIVE_CRASH = 0xc0000005;
async function runCase(entry, extra) {
  const first = await run(entry, extra);
  if (first.code !== NATIVE_CRASH) return first;
  console.warn(`! ${entry}: node crashed natively (0xC0000005) before running — retrying once`);
  return run(entry, extra);
}

// Four at a time: starting every case at once is what makes node crash.
const results = [];
for (let i = 0; i < CASES.length; i += 4) {
  results.push(
    ...(await Promise.all(
      CASES.slice(i, i + 4).map(async ([service, what, extra, expect]) => ({
        service,
        what,
        expect,
        ...(await runCase(ENTRY[service], extra)),
      })),
    )),
  );
}

let failed = 0;
for (const r of results) {
  const refused = r.code !== null && r.code !== 0;
  const named = r.expect.test(r.out);
  if (refused && named) {
    console.log(`✓ ${r.service}: ${r.what} — refused (exit ${r.code})`);
    continue;
  }
  failed += 1;
  const why = r.signal
    ? `still running after ${TIMEOUT_MS / 1000} s`
    : refused
      ? `refused without naming ${r.expect}`
      : 'started';
  console.error(`✗ ${r.service}: ${r.what} — ${why}`);
  console.error(
    r.out
      .split('\n')
      .slice(0, 12)
      .map((l) => `    ${l}`)
      .join('\n'),
  );
}

if (failed) {
  console.error(`${failed} of ${results.length} startup guards did not hold`);
  process.exit(1);
}
console.log(`✓ all ${results.length} bad configurations refused`);
