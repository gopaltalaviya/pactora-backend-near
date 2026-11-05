import {cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {loadConfig} from '../src/index.js';

/**
 * A network that is not a testnet never runs without a payment token named in
 * networks.json. With `paymentToken.accountId` null, every amount, fee and
 * balance would be read against whatever the deployment happened to name —
 * the config refuses, rather than the first hire failing on a real network.
 */

const realRoot = fileURLToPath(new URL('../../../chain', import.meta.url));
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, {recursive: true, force: true})));

/** A copy of chain/ whose sandbox entry is marked "not a testnet", with the given token. */
function rootWith(token: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'pactora-config-'));
  dirs.push(root);
  cpSync(realRoot, root, {recursive: true});
  const file = join(root, 'config', 'networks.json');
  const networks = JSON.parse(readFileSync(file, 'utf8'));
  networks['near:sandbox'].testnet = false;
  networks['near:sandbox'].paymentToken.accountId = token;
  writeFileSync(file, JSON.stringify(networks));
  return root;
}

const env = {ENABLED_CHAINS: 'near:sandbox'};

describe('a real-money payment token', () => {
  it('is required', () => {
    expect(() => loadConfig({contractsRoot: rootWith(null), env})).toThrow(/no payment token/);
  });

  it('is taken from networks.json when set', () => {
    // NEAR mainnet USDC (docs/24 §4).
    const usdc = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
    const c = loadConfig({contractsRoot: rootWith(usdc), env}).chain('near:sandbox');
    expect(c.network.paymentToken.accountId).toBe(usdc);
  });
});
