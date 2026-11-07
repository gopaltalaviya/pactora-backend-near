/**
 * Throwaway test accounts, with no NEAR stranded on a key nobody holds.
 *
 * On the sandbox nothing is kept. On testnet every new account's key is written
 * to `.keys/<network>/<account id>.json` (gitignored) BEFORE the account is
 * created and funded. `sweep` later deletes each full-access test account with
 * the deployer (your own account) as beneficiary, which returns its whole
 * balance.
 *
 * Agent wallets hold ONLY a function-call key scoped to Pactora, and that is
 * the security property under test, so no key can ever move their NEAR. Their
 * key is saved too, they are funded with only what their calls burn, and the
 * sweep reports what they still hold.
 */
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Account, KeyPair, KeyPairSigner, actions} from 'near-api-js';

export const keysDir = (root, network) => join(root, '.keys', network);

/** Save a test account's key before the account exists. No-op on the sandbox. */
export function saveKey(root, network, accountId, keyPair, {fullAccess}) {
  if (network === 'sandbox') return;
  const dir = keysDir(root, network);
  mkdirSync(dir, {recursive: true});
  writeFileSync(
    join(dir, `${accountId}.json`),
    JSON.stringify({account_id: accountId, secret_key: keyPair.toString(), full_access: fullAccess}),
    {mode: 0o600},
  );
}

const balanceOf = (provider, id) =>
  provider.viewAccount({accountId: id, blockQuery: {finality: 'final'}}).then(
    (a) => BigInt(a.amount),
    () => null,
  );

const near = (y) => `${(Number(y / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;

/**
 * Delete every saved full-access test account of `network`, its balance going
 * to `beneficiaryId`. Safe to run again: an account already gone just has its
 * file removed. Answers the yoctoNEAR returned.
 */
export async function sweep(root, network, provider, beneficiaryId, log = console.log) {
  if (network === 'sandbox') return 0n;
  const dir = keysDir(root, network);
  if (!existsSync(dir)) return 0n;
  let back = 0n;
  let deleted = 0;
  let scoped = 0n;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const file = join(dir, f);
    const k = JSON.parse(readFileSync(file, 'utf8'));
    const bal = await balanceOf(provider, k.account_id);
    if (bal === null) {
      // Never created (a run that stopped first), or already deleted.
      rmSync(file);
      continue;
    }
    if (!k.full_access) {
      scoped += bal;
      continue;
    }
    try {
      const acct = new Account(k.account_id, provider, new KeyPairSigner(KeyPair.fromString(k.secret_key)));
      // Success is judged by the chain, not the receipts: the gas refund for a
      // delete always fails (it is addressed to the account just deleted).
      await acct
        .signAndSendTransaction({
          receiverId: k.account_id,
          actions: [actions.deleteAccount(beneficiaryId)],
          waitUntil: 'FINAL',
        })
        .catch(() => {});
      // The key file goes only once the account is gone at final.
      if ((await balanceOf(provider, k.account_id)) !== null)
        throw new Error('still exists after the delete');
      back += bal;
      deleted++;
      rmSync(file);
    } catch (e) {
      log(
        `  ! ${k.account_id} not deleted (its key stays in ${dir}): ${String(e.message ?? e).slice(0, 200)}`,
      );
    }
  }
  if (deleted) log(`  swept ${deleted} test account(s): about ${near(back)} back to ${beneficiaryId}`);
  if (scoped > 0n)
    log(
      `  agent wallets (function-call keys only, keys saved in ${dir}) still hold ${near(scoped)}; no key can move it, by design`,
    );
  return back;
}
