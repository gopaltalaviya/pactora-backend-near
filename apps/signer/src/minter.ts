import type {ChainConfig} from '@pactora/config';
import {signFunctionCallWith, TGAS, type NearClient, type SignedTx, type TxOutcome} from '@pactora/near';
import {ErrorCode, PactoraError} from '@pactora/shared';
import type {ServiceAccount} from './keysource.js';
import {refusalOf} from './signer.js';

/**
 * The work-credential minter (feature/work-credentials), testnet and sandbox
 * only.
 *
 * It holds the key of a SEPARATE account — the one the credentials contract
 * (`chain.contracts.Credentials`) names as its `minter` — and makes exactly
 * one call: `nft_mint`. The API decides who may claim which credential and
 * builds its metadata from the job; this side only validates the shape and
 * sends. A soulbound token cannot be transferred, so a mistaken mint cannot
 * be moved on, only never repeated (the contract refuses a duplicate id).
 *
 * Like the faucet: one send at a time on a nonce high-water mark; a contract
 * refusal is a PactoraError (nothing was minted — except a duplicate id,
 * IDEMPOTENCY_CONFLICT: that token exists), and an outcome the node
 * did not report is a plain error — the API keeps its claim and reads
 * `nft_token` before it ever tries again.
 */

/** NEP-177 token metadata, the fields Pactora sets. */
export interface CredentialMetadata {
  title: string;
  description: string;
  media: string;
  issued_at: string;
  extra: string;
}

export interface MintResult {
  txHash: string;
}

export interface Minter {
  accountId: string;
  /** The credentials contract it mints on. */
  contract: string;
  mint(tokenId: string, receiverId: string, metadata: CredentialMetadata): Promise<MintResult>;
}

/** `nft_mint` writes one token and its enumeration entries: well under 50 TGas. */
export const MINT_GAS = 50n * TGAS;

/** NEAR storage staking: 10^19 yoctoNEAR per byte (0.01 NEAR per 1 000 bytes). */
export const STORAGE_YOCTO_PER_BYTE = 10_000_000_000_000_000_000n;

/**
 * Attached to every `nft_mint` to pay for the token's storage (NEP-171
 * `internal_mint` charges the bytes it adds and REFUNDS the excess to the
 * minter, in the same transaction). 0.05 NEAR buys 5 000 bytes.
 *
 * What a mint stores (`mintStorageBytes`): the borsh metadata plus five
 * trie records — owner_by_id, token_metadata_by_id, and the per-owner set's
 * map entry, element and index — each with ~40 B of record overhead and its
 * key prefix. A real Pactora credential (media ~740 B, extra ~470 B) comes to
 * about 1.8 kB, ≤ 2.1 kB by this estimate (≈ 0.02 NEAR). The largest body POST /credentials/mint accepts
 * (MintBody: title 100, description 300, media 1 024, issued_at 16,
 * extra 1 024; a 20-digit id and a 64-char receiver) is
 * 2 464 + 32 metadata bytes + 5 × (40 + 64) + 4 × 24 + 3 × 68 + 16
 * = 3 332 B ≈ 0.033 NEAR: within the deposit with a third to spare.
 */
export const MINT_STORAGE_DEPOSIT = 50n * 1_000_000_000_000_000_000_000n;

/** Per trie record: NEAR's fixed storage overhead (~40 B) and a generous key prefix (a hashed one is 33 B). */
const RECORD_OVERHEAD = 40;
const KEY_PREFIX = 64;

/**
 * An upper estimate of the bytes one `nft_mint` adds (near-contract-standards
 * NonFungibleToken with metadata and enumeration), for the deposit above.
 */
export function mintStorageBytes(tokenId: string, receiverId: string, metadata: CredentialMetadata): number {
  // borsh Option<String>: 1 tag + 4 length + the bytes; the seven fields Pactora leaves None: 1 each.
  const field = (s: string) => 1 + 4 + Buffer.byteLength(s);
  const meta =
    field(metadata.title) +
    field(metadata.description) +
    field(metadata.media) +
    field(metadata.issued_at) +
    field(metadata.extra) +
    7;
  const token = 4 + Buffer.byteLength(tokenId);
  const owner = 4 + Buffer.byteLength(receiverId);
  // Five records; the token id is in four of them, the owner in three, two u64 index entries.
  return meta + 5 * (RECORD_OVERHEAD + KEY_PREFIX) + 4 * token + 3 * owner + 2 * 8;
}

/**
 * The contract's own refusal of a duplicate id (near-contract-standards:
 * `"token_id must be unique"`): the token EXISTS — never "nothing minted".
 * Its own code, so the API reads `nft_token` instead of freeing its claim.
 */
export function mintRefusalOf(failure: string, txHash: string, tokenId: string): PactoraError {
  if (/token_id must be unique/.test(failure)) {
    return new PactoraError(
      ErrorCode.IDEMPOTENCY_CONFLICT,
      `token ${tokenId} already exists on the credentials contract (transaction ${txHash})`,
    );
  }
  return refusalOf(failure, txHash);
}

/**
 * The minter account must be the credentials contract's `minter`, or every
 * mint fails on chain. Read at start; an RPC failure REFUSES to start, as
 * the faucet's owner guard does — a check that was skipped is no check.
 */
export async function assertMinterMatches(
  near: Pick<NearClient, 'view'>,
  contract: string,
  minter: Pick<ServiceAccount, 'accountId'>,
): Promise<void> {
  let onChain: string;
  try {
    onChain = await near.view<string>(contract, 'minter', {});
  } catch (err) {
    throw new Error(
      `could not read the credentials contract's minter from ${contract} ` +
        `(${err instanceof Error ? err.message : String(err)}) — refusing to start`,
    );
  }
  if (onChain !== minter.accountId) {
    throw new Error(
      `MINTER_ACCOUNT_ID ${minter.accountId} is not the minter of ${contract} (it is ${onChain}) — ` +
        'fix MINTER_ACCOUNT_ID/MINTER_SECRET_KEY or unset them; refusing to start',
    );
  }
}

/** Only one send at a time: the nonce high-water mark below assumes it. */
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
}

export function makeMinter(opts: {near: NearClient; chain: ChainConfig; account: ServiceAccount}): Minter {
  const {near, chain, account} = opts;
  if (!chain.testnet) throw new Error('the credential minter runs on testnet or the sandbox only');
  const contract = chain.contracts['Credentials'];
  if (!contract) throw new Error(`${chain.chainId} has no Credentials contract to mint on`);
  const once = serial();
  let last = 0n;

  return {
    accountId: account.accountId,
    contract,
    mint: (tokenId, receiverId, metadata) =>
      once(async () => {
        const access = await near.accessKey(account.accountId, account.key.publicKey);
        if (!access)
          throw new Error(`the minter account ${account.accountId} has no key ${account.key.publicKey}`);
        const nonce = (access.nonce > last ? access.nonce : last) + 1n;
        last = nonce;
        const block = await near.finalBlock();
        const signed: SignedTx = await signFunctionCallWith({
          signerId: account.accountId,
          key: account.key,
          receiverId: contract,
          nonce,
          blockHash: block.hash,
          method: 'nft_mint',
          args: {token_id: tokenId, receiver_id: receiverId, metadata},
          gas: MINT_GAS,
          deposit: MINT_STORAGE_DEPOSIT,
        });
        const outcome: TxOutcome = await near.sendSigned(signed);
        if (outcome.status === 'failure') throw mintRefusalOf(outcome.failure ?? '', signed.hash, tokenId);
        if (outcome.status !== 'success')
          throw new Error(`nft_mint sent as ${signed.hash}, outcome not known yet`);
        return {txHash: signed.hash};
      }),
  };
}
