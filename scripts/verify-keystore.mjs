import {readFileSync, mkdtempSync, rmSync, readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decryptKeystore, EnvKeystoreSource} from '../apps/signer/dist/keystore.js';
import {privateKeyToAccount} from 'viem/accounts';

// Generate the keystore here rather than depending on one lying around, so
// this runs identically on a laptop and in CI. `cast` writes the real Web3
// Secret Storage format we will actually be handed.
const dir = mkdtempSync(join(tmpdir(), 'pactora-ks-'));
execFileSync(
  'cast',
  [
    'wallet',
    'import',
    'pactora-test',
    '--unsafe-password',
    'correct horse battery staple',
    '--private-key',
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    '--keystore-dir',
    dir,
  ],
  {stdio: 'pipe'},
);

const ks = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
const EXPECTED = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const EXPECTED_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => {
  console.error(`  ✗ ${m}`);
  bad++;
};

console.log(`\nkeystore: kdf=${ks.crypto.kdf} cipher=${ks.crypto.cipher}\n`);

// 1. correct passphrase
const key = decryptKeystore(ks, 'correct horse battery staple');
key.toLowerCase() === EXPECTED
  ? ok('decrypts a real Foundry keystore to the right key')
  : no(`wrong key: ${key}`);

const acct = privateKeyToAccount(key);
acct.address === EXPECTED_ADDR
  ? ok(`derives the expected address ${acct.address}`)
  : no(`wrong address ${acct.address}`);

// 2. wrong passphrase must FAIL, not silently return garbage
try {
  decryptKeystore(ks, 'wrong passphrase');
  no('a wrong passphrase was accepted — it would sign from an unfunded address');
} catch (e) {
  /MAC mismatch/.test(e.message)
    ? ok('a wrong passphrase fails loudly on the MAC')
    : no(`failed, but not on the MAC: ${e.message}`);
}

// 3. the env source, as the signer actually loads it
const src = new EnvKeystoreSource({
  SIGNER_KEYSTORE_JSON: JSON.stringify(ks),
  SIGNER_KEYSTORE_PASSPHRASE: 'correct horse battery staple',
});
const a = await src.accountFor(1);
a?.address === EXPECTED_ADDR ? ok('EnvKeystoreSource loads a single keystore') : no('env source failed');

// 4. per-agent map
const multi = new EnvKeystoreSource({
  SIGNER_KEYSTORE_JSON: JSON.stringify({7: ks}),
  SIGNER_KEYSTORE_PASSPHRASE: 'correct horse battery staple',
});
const seven = await multi.accountFor(7);
const eight = await multi.accountFor(8);
seven?.address === EXPECTED_ADDR
  ? ok('per-agent keystore map resolves agent 7')
  : no('agent 7 lookup failed');
eight === null
  ? ok("an agent with no key returns null rather than someone else's")
  : no('agent 8 got a key it should not have');

// 5. passphrase set without keystore, and vice versa
try {
  new EnvKeystoreSource({SIGNER_KEYSTORE_JSON: JSON.stringify(ks)});
  no('a missing passphrase was tolerated');
} catch {
  ok('a keystore without a passphrase is rejected at boot');
}

// The keystore written above holds a (test) private key; do not leave it in tmp.
rmSync(dir, {recursive: true, force: true});

console.log(bad ? '\nFAILED\n' : '\nAll keystore checks passed.\n');
process.exit(bad ? 1 : 0);
