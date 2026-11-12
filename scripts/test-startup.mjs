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
  notifier: 'apps/notifier/dist/main.js',
  channels: 'apps/channels/dist/main.js',
};

/** 32 random-looking bytes, hex: a WEBHOOK_SECRET_KEY the check accepts. */
const GOOD_WEBHOOK_KEY = '6cfc0d92f0c955451da1eba2e406374a7dc6d27894befff1e298f1a297e626cc';

/** [service, what is wrong, env on top of BASE, what the refusal must say, what it must NOT say] */
const CASES = [
  // The NEAR AI Cloud judge: off by default; chosen, it needs its key. The key is never echoed.
  [
    'api',
    'the NEAR AI judge without its key',
    {DATABASE_URL: CLOSED_DB, JUDGE_PROVIDER: 'near-ai'},
    /JUDGE_PROVIDER=near-ai needs NEAR_AI_API_KEY/,
  ],
  [
    'api',
    'the NEAR AI judge with an empty key',
    {DATABASE_URL: CLOSED_DB, JUDGE_PROVIDER: 'near-ai', NEAR_AI_API_KEY: ''},
    /JUDGE_PROVIDER=near-ai needs NEAR_AI_API_KEY/,
  ],
  [
    'api',
    'an unknown judge provider',
    {DATABASE_URL: CLOSED_DB, JUDGE_PROVIDER: 'openai'},
    /JUDGE_PROVIDER must be one of/,
  ],
  [
    'api',
    'an attestation flag that is neither 0 nor 1',
    {
      DATABASE_URL: CLOSED_DB,
      JUDGE_PROVIDER: 'near-ai',
      NEAR_AI_API_KEY: 'test-only-not-a-real-key',
      JUDGE_REQUIRE_ATTESTATION: 'maybe',
    },
    /JUDGE_REQUIRE_ATTESTATION must be 0 or 1/,
  ],
  [
    'api',
    'a NEAR AI base URL that is not https (the key must not be printed)',
    {
      DATABASE_URL: CLOSED_DB,
      JUDGE_PROVIDER: 'near-ai',
      NEAR_AI_API_KEY: 'startup-test-not-a-real-key-7f3a',
      NEAR_AI_BASE_URL: 'http://plain.example/v1',
    },
    /NEAR_AI_BASE_URL must be an https URL/,
    /startup-test-not-a-real-key-7f3a/,
  ],
  // docs/26 F11, F12 (branch human-work)
  ['channels', 'no DATABASE_URL', {}, /DATABASE_URL/],
  [
    'channels',
    'a malformed Telegram token',
    {DATABASE_URL: CLOSED_DB, TELEGRAM_BOT_TOKEN: 'not-a-token'},
    /TELEGRAM_BOT_TOKEN is not a bot token/,
  ],
  [
    'channels',
    'production with the fake email provider',
    {NODE_ENV: 'production', DATABASE_URL: CLOSED_DB, EMAIL_PROVIDER: 'fake'},
    /EMAIL_PROVIDER=fake/,
  ],
  [
    'api',
    'a bot username that is not one',
    {DATABASE_URL: CLOSED_DB, TELEGRAM_BOT_USERNAME: 'hello'},
    /TELEGRAM_BOT_USERNAME/,
  ],
  // docs/26 F13, F14 (branch human-work)
  [
    'api',
    'production with screening off',
    {
      NODE_ENV: 'production',
      DATABASE_URL: CLOSED_DB,
      CORS_ORIGINS: 'https://p.example',
      EVIDENCE_UPLOADS: 'off',
      SANCTIONS_SCREENING: 'off',
    },
    /SANCTIONS_SCREENING=off is refused/,
  ],
  [
    'api',
    'production screening with one reviewer',
    {
      NODE_ENV: 'production',
      DATABASE_URL: CLOSED_DB,
      CORS_ORIGINS: 'https://p.example',
      EVIDENCE_UPLOADS: 'off',
      COMPLIANCE_REVIEWERS: 'one.testnet',
    },
    /at least two COMPLIANCE_REVIEWERS/,
  ],
  [
    'api',
    'an identity provider without its webhook secret',
    {DATABASE_URL: CLOSED_DB, IDENTITY_PROVIDER: 'simulated'},
    /KYC_WEBHOOK_SECRET/,
  ],
  // docs/26 F9, F23 (branch human-work)
  [
    'api',
    'WEBHOOK_SECRET_KEY too weak',
    {DATABASE_URL: CLOSED_DB, WEBHOOK_SECRET_KEY: 'a passphrase'},
    /WEBHOOK_SECRET_KEY must be 32/,
  ],
  [
    'api',
    'WEBHOOK_SECRET_KEY of one repeated byte',
    {DATABASE_URL: CLOSED_DB, WEBHOOK_SECRET_KEY: '7e'.repeat(32)},
    /WEBHOOK_SECRET_KEY must be 32/,
  ],
  [
    'api',
    'production allowing private webhook targets',
    {
      NODE_ENV: 'production',
      DATABASE_URL: CLOSED_DB,
      CORS_ORIGINS: 'https://p.example',
      EVIDENCE_UPLOADS: 'off',
      WEBHOOK_ALLOW_PRIVATE: '1',
    },
    /WEBHOOK_ALLOW_PRIVATE is for local development/,
  ],
  [
    'api',
    'a faucet claim above the daily cap',
    {DATABASE_URL: CLOSED_DB, FAUCET_AMOUNT: '10', FAUCET_DAILY_CAP: '5'},
    /FAUCET_AMOUNT must not exceed FAUCET_DAILY_CAP/,
  ],
  ['notifier', 'no DATABASE_URL', {WEBHOOK_SECRET_KEY: GOOD_WEBHOOK_KEY}, /DATABASE_URL/],
  ['notifier', 'no WEBHOOK_SECRET_KEY', {DATABASE_URL: CLOSED_DB}, /WEBHOOK_SECRET_KEY/],
  [
    'notifier',
    'WEBHOOK_SECRET_KEY too weak',
    {DATABASE_URL: CLOSED_DB, WEBHOOK_SECRET_KEY: 'ab'.repeat(31)},
    /WEBHOOK_SECRET_KEY must be 32/,
  ],
  [
    'notifier',
    'production allowing private webhook targets',
    {
      NODE_ENV: 'production',
      DATABASE_URL: CLOSED_DB,
      WEBHOOK_SECRET_KEY: GOOD_WEBHOOK_KEY,
      WEBHOOK_ALLOW_PRIVATE: '1',
    },
    /WEBHOOK_ALLOW_PRIVATE is for local development/,
  ],
  [
    'notifier',
    'a database that does not answer',
    {DATABASE_URL: CLOSED_DB, WEBHOOK_SECRET_KEY: GOOD_WEBHOOK_KEY},
    /ECONNREFUSED|connect|database/i,
  ],
  [
    'signer',
    'FAUCET_SECRET_KEY malformed',
    {DATABASE_URL: CLOSED_DB, FAUCET_SECRET_KEY: 'not-a-key'},
    /FAUCET_SECRET_KEY/,
  ],
  [
    'signer',
    'MINTER_SECRET_KEY malformed',
    {DATABASE_URL: CLOSED_DB, MINTER_SECRET_KEY: 'not-a-key'},
    /MINTER_SECRET_KEY/,
  ],
  [
    'signer',
    'the minter sharing the faucet account',
    {DATABASE_URL: CLOSED_DB, MINTER_ACCOUNT_ID: 'ops.test.near', FAUCET_ACCOUNT_ID: 'ops.test.near'},
    /MINTER_ACCOUNT_ID must not be FAUCET_ACCOUNT_ID/,
  ],
  [
    'signer',
    'the minter sharing the keeper account',
    {DATABASE_URL: CLOSED_DB, MINTER_ACCOUNT_ID: 'ops.test.near', KEEPER_ACCOUNT_ID: 'ops.test.near'},
    /MINTER_ACCOUNT_ID must not be KEEPER_ACCOUNT_ID/,
  ],
  [
    'signer',
    'FAUCET_MAX_PER_SEND not a number',
    {DATABASE_URL: CLOSED_DB, FAUCET_MAX_PER_SEND: 'lots'},
    /FAUCET_MAX_PER_SEND/,
  ],
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
    'a numeric-network variable',
    {DATABASE_URL: CLOSED_DB, DEFAULT_CHAIN_ID: '1'},
    /DEFAULT_CHAIN_ID is an unsupported variable/,
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
      CASES.slice(i, i + 4).map(async ([service, what, extra, expect, forbid]) => ({
        service,
        what,
        expect,
        forbid,
        ...(await runCase(ENTRY[service], extra)),
      })),
    )),
  );
}

let failed = 0;
for (const r of results) {
  const refused = r.code !== null && r.code !== 0;
  const named = r.expect.test(r.out);
  const leaked = r.forbid ? r.forbid.test(r.out) : false;
  if (refused && named && !leaked) {
    console.log(`✓ ${r.service}: ${r.what} — refused (exit ${r.code})`);
    continue;
  }
  failed += 1;
  const why = leaked
    ? `printed what it must not (${r.forbid})`
    : r.signal
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
