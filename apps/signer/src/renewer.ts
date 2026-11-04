import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Account,
  type Hex,
  type PublicClient,
} from 'viem';
import {eq} from 'drizzle-orm';
import type {ChainConfig} from '@pactora/config';
import {agents, type Db} from '@pactora/db';
import type {Metrics} from '@pactora/service';
import {viemChainOf, walletVerifier} from './accounts.js';

/**
 * The renewer: keeps the session keys of accounts that named it from lapsing.
 *
 * `AgentAccount` lets a hot key spend only through a SESSION key, and caps
 * every grant at 24 hours (`MAX_SESSION_KEY_TTL`) — a stolen hot key is
 * useless by tomorrow. The cost of that rule is that something must renew the
 * grant every day. A hosted orchestrator with nobody renewing stopped hiring a
 * day after it was set up.
 *
 * It is each hosted account's SESSION MANAGER (audit F1, 2026-10-26), which
 * can only push out the expiry of a key the owner granted — `spent` and the
 * budget stay. It used to be the OWNER, re-granting: the signer process then
 * held a key that could sweep every hosted account, and each re-grant
 * refilled a stolen key's lifetime budget. The owner key now stays offline.
 *
 * Never the deployer's key, and never one the signer signs agent calls with
 * (two processes drawing nonces from one account race). It leaves alone any
 * account that did not name it. The chain decides: grants and managers are
 * read on every pass.
 */

export interface RenewerDeps {
  /** The renewer's own address — the session manager it acts as. */
  manager: string;
  /** Held keys that may hold grants (the signer's session keys). */
  keys: string[];
  /** Renew a grant that lapses within this many seconds. */
  renewBeforeSeconds: bigint;
  /** New grants run this long. Under the contract's 24 h maximum. */
  ttlSeconds: bigint;
  /** Candidate accounts: registered agents' wallets. */
  accounts: () => Promise<string[]>;
  /**
   * Whether the wallet's CODE proves it is an AgentAccount (accounts.ts).
   * Anyone can register a wallet, and a contract that merely answers
   * `owner()` and `sessionKeys()` as an account would had this renewer pay
   * gas for it on every pass (audit H3).
   */
  isAgentAccount: (account: string) => Promise<boolean>;
  /** The account's session manager; throws for a wallet that is not an AgentAccount. */
  managerOf: (account: string) => Promise<string>;
  /** The account's grant to `key`; expiry 0 = never granted. */
  grantOf: (account: string, key: string) => Promise<{expiry: bigint; budget: bigint}>;
  now: () => Promise<bigint>;
  /** `extendSessionKey`: a new expiry for an existing grant, nothing else. */
  extend: (account: string, key: string, expiry: bigint) => Promise<string>;
  onRenew?: (outcome: 'renewed' | 'failed') => void;
  logger?: {info: (o: object, m: string) => void; warn: (o: object, m: string) => void};
}

export interface RenewResult {
  checked: number;
  renewed: {account: string; key: string; expiry: string; txHash: string}[];
  failed: {account: string; key: string; reason: string}[];
}

export class Renewer {
  private readonly log: NonNullable<RenewerDeps['logger']>;

  constructor(private readonly deps: RenewerDeps) {
    this.log = deps.logger ?? {info: () => {}, warn: () => {}};
  }

  async renew(): Promise<RenewResult> {
    const result: RenewResult = {checked: 0, renewed: [], failed: []};
    const me = this.deps.manager.toLowerCase();
    const now = await this.deps.now();

    for (const account of await this.deps.accounts()) {
      if (!(await this.deps.isAgentAccount(account).catch(() => false))) continue;
      let manager: string;
      try {
        manager = await this.deps.managerOf(account);
      } catch {
        continue; // unreadable: leave it for the next pass
      }
      if (manager.toLowerCase() !== me) continue;
      result.checked++;

      for (const key of this.deps.keys) {
        const {expiry} = await this.deps.grantOf(account, key);
        if (expiry === 0n) continue; // never granted: not ours to create
        if (expiry > now + this.deps.renewBeforeSeconds) continue;

        const next = now + this.deps.ttlSeconds;
        try {
          const txHash = await this.deps.extend(account, key, next);
          result.renewed.push({account, key, expiry: next.toString(), txHash});
          this.deps.onRenew?.('renewed');
          this.log.info({account, key, expiry: next.toString(), txHash}, 'session key renewed');
        } catch (err) {
          const reason = err instanceof Error ? err.message.split('\n')[0]! : String(err);
          result.failed.push({account, key, reason});
          this.deps.onRenew?.('failed');
          this.log.warn({account, key, reason}, 'session key not renewed');
        }
      }
    }
    return result;
  }

  /** Renew forever. Returns a function that stops it. */
  start(intervalMs: number): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const loop = async () => {
      try {
        await this.renew();
      } catch (err) {
        this.log.warn({reason: (err as Error).message}, 'renewal pass failed');
      }
      if (!stopped) timer = setTimeout(() => void loop(), intervalMs);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }
}

/**
 * Gas for one `extendSessionKey`. A grant measures ~48 k in the contract suite
 * and an extension writes less; three times that, and Monad charges the whole
 * limit, so it is not set higher than a renewal can need.
 */
export const RENEW_GAS = 150_000n;

/** Wire a renewer to a real chain and database. */
export function chainRenewer(opts: {
  db: Db;
  chain: ChainConfig;
  abis: Record<string, Abi>;
  /** The session manager the hosted accounts named. */
  account: Account;
  /** Addresses of the session keys the signer holds. */
  keys: string[];
  renewBeforeSeconds: number;
  logger?: RenewerDeps['logger'];
  /** Exported as `session_renewals_total{outcome}` when given. */
  metrics?: Metrics;
}): Renewer {
  const {db, chain, abis, account} = opts;
  const pub = createPublicClient({transport: http(chain.rpcUrl)}) as PublicClient;
  const viemChain = viemChainOf(chain);
  const wallet = createWalletClient({account, chain: viemChain, transport: http(chain.rpcUrl)});
  const abi = abis['AgentAccount'] as Abi;
  const wallets = walletVerifier(pub, chain);
  const renewals = opts.metrics?.counter(
    'session_renewals_total',
    'Session-key grants the renewer re-sent or failed to',
    ['outcome'],
  );

  return new Renewer({
    manager: account.address,
    keys: opts.keys,
    renewBeforeSeconds: BigInt(opts.renewBeforeSeconds),
    ttlSeconds: 23n * 3600n,
    ...(opts.logger ? {logger: opts.logger} : {}),
    ...(renewals ? {onRenew: (outcome) => renewals.labels(outcome).inc()} : {}),
    accounts: async () =>
      (
        await db.select({wallet: agents.walletAddress}).from(agents).where(eq(agents.chainId, chain.chainId))
      ).map((r) => r.wallet),
    isAgentAccount: async (a) => (await wallets.kindOf(a)) === 'account',
    managerOf: async (a) =>
      (await pub.readContract({address: a as Hex, abi, functionName: 'sessionManager'})) as string,
    grantOf: async (a, key) => {
      const [expiry, budget] = (await pub.readContract({
        address: a as Hex,
        abi,
        functionName: 'sessionKeys',
        args: [key as Hex],
      })) as readonly [bigint, bigint, bigint];
      return {expiry, budget};
    },
    now: async () => (await pub.getBlock({blockTag: 'latest'})).timestamp,
    extend: async (a, key, expiry) => {
      // Simulate first: a refusal costs a read, not gas.
      const {request} = await pub.simulateContract({
        account,
        address: a as Hex,
        abi,
        functionName: 'extendSessionKey',
        args: [key as Hex, expiry],
      });
      // A fixed limit, not the estimate: a grant is a known, small call, and
      // the chain is checked against the configured one before it is signed.
      const hash = await wallet.writeContract({...request, gas: RENEW_GAS, chain: viemChain});
      const receipt = await pub.waitForTransactionReceipt({hash});
      if (receipt.status !== 'success') throw new Error(`extendSessionKey reverted in ${hash}`);
      return hash;
    },
  });
}
