/**
 * The tracked `.env.example` is what a judge copies. It must describe THIS
 * build: every name in it passes the services' own legacy-env guard (or the
 * copy refuses to start), every name is one the code actually reads, and
 * every network value is a NEAR CAIP-2 id — not the Monad build's.
 */
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {legacyEnvProblems} from '../src/legacy-env.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** `NAME=value` lines, as `node --env-file` and dotenv read them (comments after `#` dropped). */
function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/\s+#.*$/, '').trim();
  }
  return out;
}

function sources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'test' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, acc);
    else if (/\.(ts|mjs|js)$/.test(name)) acc.push(readFileSync(p, 'utf8'));
  }
  return acc;
}

const example = parse(readFileSync(join(ROOT, '.env.example'), 'utf8'));
const code = [
  ...sources(join(ROOT, 'apps')),
  ...sources(join(ROOT, 'packages')),
  ...sources(join(ROOT, 'scripts')),
].join('\n');

/** Read by libraries, not by name in our code — or by docker-compose.full.yml's minio service (MINIO_KMS_SECRET_KEY). */
const READ_ELSEWHERE = new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'MINIO_KMS_SECRET_KEY']);
/** Built from the network slug: `RPC_URL_${slug}` (packages/config). */
const RPC_PER_NETWORK = /^RPC_URL_(TESTNET|SANDBOX|MAINNET)$/;

describe('.env.example', () => {
  it('passes the legacy-env guard every service runs at boot', () => {
    expect(legacyEnvProblems(example)).toEqual([]);
  });

  it('names only variables the code reads', () => {
    const unread = Object.keys(example).filter(
      (k) => !READ_ELSEWHERE.has(k) && !RPC_PER_NETWORK.test(k) && !new RegExp(`\\b${k}\\b`).test(code),
    );
    expect(unread).toEqual([]);
  });

  it('points at the NEAR contracts and NEAR networks', () => {
    const near = /^near:(testnet|sandbox|mainnet)$/;
    for (const k of ['DEFAULT_CHAIN', 'PACTORA_CHAIN_ID'])
      if (example[k]) expect(example[k], k).toMatch(near);
    if (example['ENABLED_CHAINS'])
      for (const id of example['ENABLED_CHAINS'].split(',')) expect(id.trim()).toMatch(near);
    if (example['PACTORA_CONTRACTS_ROOT'])
      expect(example['PACTORA_CONTRACTS_ROOT']).toBe('../pactora-contracts-near');
    for (const [k, v] of Object.entries(example))
      expect(`${k}=${v}`).not.toMatch(/monad|10143|agentx-contracts/i);
  });

  it('ships no secret: every key and token line is empty', () => {
    const secret = /(SECRET|PRIVATE|PASSPHRASE|TOKEN|API_KEY|CREDENTIALS)/;
    const filled = Object.entries(example).filter(([k, v]) => secret.test(k) && v !== '');
    expect(filled).toEqual([]);
  });
});
