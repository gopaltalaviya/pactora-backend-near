import {defineChain, type Chain, type Hex} from 'viem';
import type {ChainConfig} from '@pactora/config';

/**
 * Which kind of wallet an agent has, decided by its CODE — never by what the
 * wallet says about itself.
 *
 * The signer and the renewer used to treat any contract that answered
 * `policy()`, `owner()` and `sessionKeys()` as an AgentAccount. Those are
 * three view functions anyone can write. A contract registered as an agent's
 * wallet could claim the renewer as its owner and every held key as a lapsing
 * session key, and the renewer paid gas to "renew" them on every pass; or it
 * could claim to trust a key held here, and the signer sent from that key into
 * a contract the attacker wrote.
 *
 * So a wallet is an account only if its runtime code proves it:
 *
 * - an ERC-1167 clone of the AgentAccountFactory's implementation — the exact
 *   45 bytes `Clones.cloneDeterministic` deploys, or
 * - an EOA delegated to AgentDelegate by EIP-7702 — code `0xef0100 ‖ delegate`.
 *
 * No code at all is a plain EOA. Any other code is a contract we did not
 * write, and nothing is signed for it.
 */
export type WalletKind = 'account' | 'eoa' | 'foreign';

export interface CodeReader {
  getCode(args: {address: Hex}): Promise<Hex | undefined>;
  readContract(args: {
    address: Hex;
    abi: typeof FACTORY_ABI;
    functionName: 'implementation';
  }): Promise<unknown>;
}

/** A clone's code cannot change, so that verdict is kept; anything else is re-read after this. */
const RECHECK_MS = 60_000;

export class WalletVerifier {
  private readonly verdicts = new Map<string, {kind: WalletKind; until: number}>();
  private implementation: Promise<string | null> | undefined;

  constructor(
    private readonly pub: CodeReader,
    private readonly contracts: {factory?: string; delegate?: string},
    private readonly now: () => number = Date.now,
  ) {}

  async kindOf(wallet: string): Promise<WalletKind> {
    const key = wallet.toLowerCase();
    const cached = this.verdicts.get(key);
    if (cached && cached.until > this.now()) return cached.kind;

    const code = ((await this.pub.getCode({address: key as Hex})) ?? '0x').toLowerCase();
    let kind: WalletKind;
    let until = this.now() + RECHECK_MS;

    if (code === '0x') {
      // May still become an account (a counterfactual clone deployed later).
      kind = 'eoa';
    } else if (this.contracts.delegate && code === delegationOf(this.contracts.delegate)) {
      // The owner can re-delegate at any time, so this is re-read too.
      kind = 'account';
    } else {
      const impl = await this.implementationAddress();
      if (impl && code === cloneCodeOf(impl)) {
        kind = 'account';
        until = Number.POSITIVE_INFINITY;
      } else {
        kind = 'foreign';
      }
    }

    this.verdicts.set(key, {kind, until});
    return kind;
  }

  /**
   * Read once from the factory itself. An unreadable factory leaves it null
   * for this call only, so an RPC blip does not condemn every account.
   */
  private implementationAddress(): Promise<string | null> {
    const factory = this.contracts.factory;
    if (!factory) return Promise.resolve(null);
    this.implementation ??= this.pub
      .readContract({address: factory as Hex, abi: FACTORY_ABI, functionName: 'implementation'})
      .then((a) => String(a).toLowerCase())
      .catch((err: unknown) => {
        this.implementation = undefined;
        throw err;
      });
    return this.implementation;
  }
}

/** `Clones.cloneDeterministic(implementation, …)`'s runtime code (OpenZeppelin, ERC-1167). */
export function cloneCodeOf(implementation: string): string {
  return `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
}

/** An EOA's code once it has delegated to `delegate` by EIP-7702. */
export function delegationOf(delegate: string): string {
  return `0xef0100${delegate.slice(2).toLowerCase()}`;
}

export const FACTORY_ABI = [
  {
    type: 'function',
    name: 'implementation',
    stateMutability: 'view',
    inputs: [],
    outputs: [{name: '', type: 'address'}],
  },
] as const;

/** The verifier for a configured chain: the factory and delegate its deployment records. */
export function walletVerifier(pub: CodeReader, chain: ChainConfig): WalletVerifier {
  return new WalletVerifier(pub, {
    ...(chain.contracts['AgentAccountFactory'] ? {factory: chain.contracts['AgentAccountFactory']} : {}),
    ...(chain.contracts['AgentDelegate'] ? {delegate: chain.contracts['AgentDelegate']} : {}),
  });
}

/**
 * The chain as viem needs it to sign. Every send passes this rather than
 * `chain: null`: with null, viem asks the RPC for its chain id and signs for
 * whatever comes back — so a testnet signer, raw keys and all, pointed at a
 * mainnet RPC by a mistyped `RPC_URL_<id>` would sign mainnet transactions.
 * Given a chain, viem checks the RPC agrees before every send.
 */
export function viemChainOf(chain: ChainConfig): Chain {
  return defineChain({
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: chain.network.nativeCurrency,
    rpcUrls: {default: {http: [chain.rpcUrl]}},
  });
}

/**
 * Refuse to start against an RPC that serves a different chain from the one
 * configured. Checked at boot by the signer, the keeper and the renewer —
 * before any key is used.
 */
export async function assertRpcChain(
  pub: {getChainId(): Promise<number>},
  chain: ChainConfig,
): Promise<void> {
  const served = await pub.getChainId();
  if (served !== chain.chainId) {
    throw new Error(
      `the RPC for chain ${chain.chainId} (${chain.name}) serves chain ${served} — ` +
        `check RPC_URL_${chain.chainId}; refusing to sign anything`,
    );
  }
}
