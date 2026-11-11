import {randomBytes} from 'node:crypto';
import {nearClient, verifyNep413, type NearClient} from '@pactora/near';
import type {PactoraConfig} from '@pactora/config';

/**
 * Owner challenges: a server nonce an owner signs to prove it controls its
 * NEAR account. Used to re-issue an agent's API key and, since audit M1, to
 * register an agent at all.
 *
 * The signature is NEP-413 (a wallet's `signMessage`), and the key that made
 * it must be a FULL-ACCESS key of the owner's account: an agent's
 * function-call key, which the signer holds, can sign NEP-413 too, and must
 * not be able to speak for its owner (docs/NEAR-WIRE.md §5).
 */

/** How long a challenge stays signable. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Live challenges one requester address keeps per subject; asking again drops
 * its own oldest. Per requester, so nobody else's asking can evict yours
 * (audit L2), and bounded, so asking cannot grow a table without limit.
 */
export const LIVE_PER_REQUESTER = 3;

/** NEP-413's nonce is exactly 32 bytes; carried as 64 hex characters. */
export const newNonce = (): string => randomBytes(32).toString('hex');
export const NONCE_RE = /^[0-9a-f]{64}$/;

/**
 * NEP-413 `recipient`: who the message is meant for, so a signature made for
 * another app cannot be replayed here. `PACTORA_SIGN_RECIPIENT` overrides it.
 */
export const DEFAULT_SIGN_RECIPIENT = 'pactora';

/**
 * What an owner signs to register an agent. Names everything the
 * registration claims — chain, owner, wallet, contract agent id — so a
 * signature for one registration cannot be spent on another.
 */
export function registrationMessage(r: {
  chainId: string;
  ownerAddress: string;
  walletAddress: string;
  chainAgentId: string;
  nonce: string;
}): string {
  return [
    'Pactora: register an agent.',
    `Chain: ${r.chainId}`,
    `Owner: ${r.ownerAddress}`,
    `Wallet: ${r.walletAddress}`,
    `Agent id: ${r.chainAgentId}`,
    `Nonce: ${r.nonce}`,
  ].join('\n');
}

/**
 * What a person signs to sign in (docs/26 F1). Names the chain and the
 * account, so a signature for one cannot open a session for another; the
 * nonce makes it single-use. Signing it moves no funds and approves nothing
 * on chain — the first line says what it is, and the site shows it.
 */
export function loginMessage(r: {chainId: string; accountId: string; nonce: string}): string {
  return ['Pactora: sign in.', `Chain: ${r.chainId}`, `Account: ${r.accountId}`, `Nonce: ${r.nonce}`].join(
    '\n',
  );
}

/** A NEP-413 signature as a wallet returns it, plus what it was over. */
export interface OwnerSignature {
  chainId: string;
  accountId: string;
  /** `ed25519:<base58>` */
  publicKey: string;
  /** base64 */
  signature: string;
  message: string;
  /** 64 hex = the 32 NEP-413 nonce bytes */
  nonce: string;
}

/** Whether the signature is a full-access key of `accountId` over the message. Never throws. */
export type OwnerVerifier = (s: OwnerSignature) => Promise<boolean>;

/** The real verifier: NEP-413 plus an RPC check of the key's permission, on the named chain. */
export function makeOwnerVerifier(
  config: PactoraConfig,
  recipient: string = DEFAULT_SIGN_RECIPIENT,
  clientFor: (chainId: string) => Pick<NearClient, 'accessKey'> = (c) => nearClient(config.chain(c).rpcUrl),
): OwnerVerifier {
  return async (s) => {
    if (!NONCE_RE.test(s.nonce)) return false;
    try {
      return await verifyNep413(
        {
          accountId: s.accountId,
          publicKey: s.publicKey,
          signature: s.signature,
          message: s.message,
          recipient,
          nonce: new Uint8Array(Buffer.from(s.nonce, 'hex')),
        },
        clientFor(s.chainId),
      );
    } catch {
      return false;
    }
  };
}
