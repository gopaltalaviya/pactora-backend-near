import {cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {loadConfig} from '../src/index.js';

/**
 * v3: a chain that is not a testnet never runs without a payment token. With
 * `paymentToken.address` null and no token in the deployment, every amount,
 * fee and balance would be read against nothing — the config refuses, rather
 * than the first hire failing on a real chain.
 */

const realRoot = fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url));
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, {recursive: true, force: true})));

/** A contracts root whose 143 has the given token address and a deployment record. */
function rootWith(token: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'pactora-config-'));
  dirs.push(root);
  cpSync(join(realRoot, 'config'), join(root, 'config'), {recursive: true});
  const networks = JSON.parse(readFileSync(join(root, 'config', 'networks.json'), 'utf8'));
  networks['143'].paymentToken.address = token;
  writeFileSync(join(root, 'config', 'networks.json'), JSON.stringify(networks));
  mkdirSync(join(root, 'deployments'));
  const testnet = JSON.parse(readFileSync(join(realRoot, 'deployments', '10143.json'), 'utf8'));
  const {MockUSDC: _m, PaymentToken: _p, ...contracts} = testnet.contracts;
  writeFileSync(join(root, 'deployments', '143.json'), JSON.stringify({...testnet, chainId: 143, contracts}));
  return root;
}

const env = {ENABLED_CHAIN_IDS: '143', DEFAULT_CHAIN_ID: '143'};

describe('a mainnet payment token', () => {
  it('is required', () => {
    expect(() => loadConfig({contractsRoot: rootWith(null), env})).toThrow(/no payment token/);
  });

  it('is taken from networks.json when set', () => {
    const usdc = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
    expect(loadConfig({contractsRoot: rootWith(usdc), env}).chain(143).network.paymentToken.address).toBe(
      usdc,
    );
  });
});
