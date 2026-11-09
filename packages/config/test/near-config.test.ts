import {cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {loadConfig} from '../src/index.js';

const realRoot = fileURLToPath(new URL('../../../chain', import.meta.url));
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, {recursive: true, force: true})));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function copyRoot(file: string, edit: (j: Json) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'pactora-config-'));
  dirs.push(root);
  cpSync(realRoot, root, {recursive: true});
  const path = join(root, file);
  const j = JSON.parse(readFileSync(path, 'utf8')) as Json;
  edit(j);
  writeFileSync(path, JSON.stringify(j));
  return root;
}

const sandbox = {ENABLED_CHAINS: 'near:sandbox'};

describe('NEAR network config (docs/NEAR-PORT.md §3)', () => {
  it('keys networks by CAIP-2 id and reads files by slug', () => {
    const c = loadConfig({contractsRoot: realRoot, env: sandbox}).chain('near:sandbox');
    expect(c.chainId).toBe('near:sandbox');
    expect(c.slug).toBe('sandbox');
    expect(c.nearNetworkId).toBe('sandbox');
    expect(c.contracts.Pactora).toBe('pactora.test.near');
    expect(c.blockSource).toEqual({kind: 'rpc'});
  });

  it('maps the on-chain params onto the names the backend uses', () => {
    const c = loadConfig({contractsRoot: realRoot, env: sandbox}).chain('near:sandbox');
    expect(c.params.reviewWindowSeconds).toBe(c.onchainParams.review_window);
    expect(c.params.disputeTimeoutSeconds).toBe(c.onchainParams.dispute_timeout);
    // Contract 1.1.0: the grace after the dispute deadline during which the arbiter may still rule.
    expect(c.params.disputeGraceSeconds).toBe(c.onchainParams.dispute_grace);
    expect(c.params.disputeGraceSeconds).toBeGreaterThan(0);
    expect(c.params.fastPathMax).toBe(BigInt(c.onchainParams.fast_path_max));
    expect(c.params.acceptWindowSeconds).toBeLessThanOrEqual(c.params.maxAcceptWindowSeconds);
  });

  it('builds nearblocks links', () => {
    const root = copyRoot('config/networks.json', (n) => {
      n['near:sandbox'].blockExplorerUrls = ['https://testnet.nearblocks.io/'];
    });
    const c = loadConfig({contractsRoot: root, env: sandbox}).chain('near:sandbox');
    expect(c.explorerTx('9xYz')).toBe('https://testnet.nearblocks.io/txns/9xYz');
    expect(c.explorerAddress('alice.testnet')).toBe('https://testnet.nearblocks.io/address/alice.testnet');
  });

  it('takes an RPC override by slug, never by number', () => {
    const c = loadConfig({
      contractsRoot: realRoot,
      env: {...sandbox, RPC_URL_SANDBOX: 'http://127.0.0.1:9999'},
    }).chain('near:sandbox');
    expect(c.rpcUrl).toBe('http://127.0.0.1:9999');
  });

  it('refuses a chain id it does not know', () => {
    expect(() => loadConfig({contractsRoot: realRoot, env: {ENABLED_CHAINS: 'cosmos:hub-4'}})).toThrow(
      /"cosmos:hub-4" is not a supported chain/,
    );
  });

  it('refuses a default chain that is not enabled', () => {
    expect(() =>
      loadConfig({contractsRoot: realRoot, env: {...sandbox, DEFAULT_CHAIN: 'near:testnet'}}),
    ).toThrow(/DEFAULT_CHAIN=near:testnet is not in ENABLED_CHAINS/);
  });

  it('refuses a deployment file that names another chain', () => {
    const root = copyRoot('deployments/sandbox.json', (d) => {
      d['chainId'] = 'near:testnet';
    });
    expect(() => loadConfig({contractsRoot: root, env: sandbox})).toThrow(/declares chainId near:testnet/);
  });

  it('refuses a contract account that is not a NEAR account id', () => {
    const root = copyRoot('deployments/sandbox.json', (d) => {
      d['contracts'].Pactora = '0x14B93E928AABD1AA9B3479C84BF168358EB27DC6';
    });
    expect(() => loadConfig({contractsRoot: root, env: sandbox})).toThrow(
      /contracts\.Pactora — must be a NEAR account id/,
    );
  });

  it('refuses default windows longer than the contract allows', () => {
    const root = copyRoot('config/params.sandbox.json', (p) => {
      p['offchain'].workWindowSeconds = p['onchain'].max_work_window + 1;
    });
    expect(() => loadConfig({contractsRoot: root, env: sandbox})).toThrow(
      /workWindowSeconds=\d+ exceeds the contract's maximum/,
    );
  });

  it('refuses an unknown on-chain parameter, so a typo cannot be ignored', () => {
    const root = copyRoot('config/params.sandbox.json', (p) => {
      p['onchain'].protocol_fee = 100;
    });
    expect(() => loadConfig({contractsRoot: root, env: sandbox})).toThrow(/protocol_fee/);
  });
});
