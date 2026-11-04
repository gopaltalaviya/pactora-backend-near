import {randomBytes} from 'node:crypto';
import {verifyMessage, type Hex} from 'viem';

/**
 * Owner challenges: a server nonce an address signs to prove it controls
 * itself. Used to re-issue an agent's API key and, since audit M1, to
 * register an agent at all.
 */

/** How long a challenge stays signable. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Live challenges one requester address keeps per subject; asking again drops
 * its own oldest. Per requester, so nobody else's asking can evict yours
 * (audit L2), and bounded, so asking cannot grow a table without limit.
 */
export const LIVE_PER_REQUESTER = 3;

export const newNonce = (): string => randomBytes(16).toString('hex');

/**
 * What an owner signs to register an agent. Names everything the
 * registration claims — chain, owner, wallet, ERC-8004 id — so a signature
 * for one registration cannot be spent on another. Addresses lower-case.
 */
export function registrationMessage(r: {
  chainId: number;
  ownerAddress: string;
  walletAddress: string;
  chainAgentId?: string | null | undefined;
  nonce: string;
}): string {
  return [
    'Pactora: register an agent.',
    `Chain: ${r.chainId}`,
    `Owner: ${r.ownerAddress.toLowerCase()}`,
    `Wallet: ${r.walletAddress.toLowerCase()}`,
    `ERC-8004 id: ${r.chainAgentId ?? 'none'}`,
    `Nonce: ${r.nonce}`,
  ].join('\n');
}

/** Whether `signature` is `address`'s EIP-191 signature over `message`. Never throws. */
export async function signedBy(address: string, message: string, signature: string): Promise<boolean> {
  return verifyMessage({address: address as Hex, message, signature: signature as Hex}).catch(() => false);
}
