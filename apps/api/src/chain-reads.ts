import {nearClient, type NearClient} from '@pactora/near';
import type {PactoraConfig} from '@pactora/config';

/**
 * Reads of on-chain state the API reports but does not own.
 *
 * Injected rather than constructed in the route, for the same reason `submit`
 * is: a test of the budget endpoint should not need an RPC. When no reader is
 * supplied the route falls back to the cached policy and SAYS SO — an agent
 * planning a spend is entitled to know whether the number it is planning
 * against came from the chain or from our copy of it.
 *
 * On NEAR every one of these is a view call on the one Pactora contract
 * (docs/NEAR-PORT.md): the registry, the purses (caps and balance) and the
 * jobs all live there.
 */

export interface BudgetReading {
  perTaskCap: bigint;
  dailyCap: bigint;
  dailyRemaining: bigint;
  /** Always false on NEAR: the contract has no allowlist mode. Kept so the response shape is unchanged. */
  allowlistOnly: boolean;
  /** The agent's spendable balance in the contract (its purse), in token base units. */
  tokenBalance: bigint;
  /**
   * Unix seconds at which the oldest counted spend leaves the rolling window
   * and capacity next returns; 0 when nothing is counted. The cap ROLLS (no
   * 24 hours may exceed it), so there is no single reset time — reporting
   * one would tell an agent to wait for a moment that changes nothing.
   */
  nextReleaseAt: bigint;
}

export type BudgetReader = (args: {chainId: string; walletAddress: string}) => Promise<BudgetReading | null>;

/** One client per RPC URL, so readers share connections. */
function clients(config: PactoraConfig): (chainId: string) => NearClient {
  const cache = new Map<string, NearClient>();
  return (chainId) => {
    const url = config.chain(chainId).rpcUrl;
    let c = cache.get(url);
    if (!c) {
      c = nearClient(url);
      cache.set(url, c);
    }
    return c;
  };
}

interface PurseView {
  balance: string;
  per_task_cap: string;
  daily_cap: string;
  spent_today: string;
  daily_remaining: string;
  next_release_at: number;
}

/**
 * Real reader, against the contract's purse for the agent that wallet signs for.
 *
 * Returns `null` rather than throwing when the wallet is no agent's or the RPC
 * is unreachable. A budget lookup that fails should degrade to the cache,
 * never 500 — an agent that cannot read its budget will otherwise fall back
 * to discovering it by hitting 402s, which is exactly the retry storm
 * `my_budget` exists to prevent.
 */
export function makeBudgetReader(config: PactoraConfig, clientFor = clients(config)): BudgetReader {
  return async ({chainId, walletAddress}) => {
    try {
      const pactora = config.chain(chainId).contracts.Pactora;
      const client = clientFor(chainId);
      const id = await client.view<number | null>(pactora, 'agent_of_wallet', {wallet: walletAddress});
      if (id === null) return null;
      const purse = await client.view<PurseView | null>(pactora, 'purse_of', {agent_id: id});
      if (!purse) return null;
      return {
        perTaskCap: BigInt(purse.per_task_cap),
        dailyCap: BigInt(purse.daily_cap),
        dailyRemaining: BigInt(purse.daily_remaining),
        allowlistOnly: false,
        tokenBalance: BigInt(purse.balance),
        nextReleaseAt: BigInt(purse.next_release_at),
      };
    } catch {
      return null;
    }
  };
}

/**
 * An agent as the contract's registry reports it.
 *
 * `wallet` is the accepted wallet, `pendingWallet` the one proposed and not
 * yet accepted (docs/NEAR-PORT.md §5: the signer accepts for it at
 * registration).
 */
export interface IdentityReading {
  owner: string;
  wallet: string | null;
  pendingWallet: string | null;
  frozen: boolean;
}

export type IdentityReader = (args: {
  chainId: string;
  chainAgentId: bigint;
}) => Promise<IdentityReading | null>;

interface AgentView {
  id: number;
  owner: string;
  wallet: string | null;
  pending_wallet: string | null;
  card_uri: string;
  frozen: boolean;
  registered_at: number;
}

/**
 * Real reader, against the contract's `get_agent`.
 *
 * `null` for an id that does not exist — and for an unreachable RPC, since a
 * registration that cannot be verified must not be recorded as verified.
 */
export function makeIdentityReader(config: PactoraConfig, clientFor = clients(config)): IdentityReader {
  return async ({chainId, chainAgentId}) => {
    try {
      const a = await clientFor(chainId).view<AgentView | null>(
        config.chain(chainId).contracts.Pactora,
        'get_agent',
        {
          agent_id: Number(chainAgentId),
        },
      );
      if (!a) return null;
      return {owner: a.owner, wallet: a.wallet, pendingWallet: a.pending_wallet, frozen: a.frozen};
    } catch {
      return null;
    }
  };
}

/**
 * A job's dispute bond, as the contract fixed it when the job was created.
 * `null` when it cannot be read: the caller then declares no spend and leaves
 * the cap to the contract, which enforces it either way.
 */
/**
 * The FULL-ACCESS public keys of an account (sorted), or null when it does
 * not exist. What a sign-in records and the session sweep re-reads: a change
 * in this set ends the account's sessions (migration 0025). Unreadable →
 * throws; the sweep then leaves the sessions alone until the next pass.
 */
export type AccessKeysReader = (args: {chainId: string; accountId: string}) => Promise<string[] | null>;

export function makeAccessKeysReader(config: PactoraConfig, clientFor = clients(config)): AccessKeysReader {
  return async ({chainId, accountId}) => {
    const keys = await clientFor(chainId).accessKeys(accountId);
    if (!keys) return null;
    return keys
      .filter((k) => k.permission === 'FullAccess')
      .map((k) => k.publicKey)
      .sort();
  };
}

export type DisputeBondReader = (args: {chainId: string; chainJobId: bigint}) => Promise<bigint | null>;

export function makeDisputeBondReader(config: PactoraConfig, clientFor = clients(config)): DisputeBondReader {
  return async ({chainId, chainJobId}) => {
    try {
      const job = await clientFor(chainId).view<{dispute_bond?: string} | null>(
        config.chain(chainId).contracts.Pactora,
        'get_job',
        {job_id: Number(chainJobId)},
      );
      return job && typeof job.dispute_bond === 'string' ? BigInt(job.dispute_bond) : null;
    } catch {
      return null;
    }
  };
}

/** A `direct_paid` event, as a transaction's receipts carry it. */
export interface DirectPaidLog {
  clientAgentId: bigint;
  workerAgentId: bigint;
  amount: bigint;
  specHash: string;
}

/** A `job_created` event (an escrow-backed x402 payment), as a transaction's receipts carry it. */
export interface JobCreatedLog {
  clientAgentId: bigint;
  workerAgentId: bigint;
  amount: bigint;
  specHash: string;
}

export type PaymentReading =
  | {status: 'pending'}
  | {status: 'reverted'}
  | {status: 'success'; directPaid: DirectPaidLog[]; jobCreated?: JobCreatedLog[]};

/**
 * NEAR's transaction status needs the signer as well as the hash: it is how
 * the node finds the shard. The x402 route knows it — the paying agent's wallet.
 */
export type PaymentReader = (args: {
  chainId: string;
  txHash: string;
  signerId: string;
}) => Promise<PaymentReading>;

/**
 * The Pactora job events a browser-signed transaction can emit, by the
 * contract's names (events.rs). Everything else it logs is ignored here.
 */
export const JOB_TX_EVENTS = [
  'job_created',
  'job_accepted',
  'result_submitted',
  'job_disputed',
  'job_settled',
  'job_refunded',
  'direct_paid',
] as const;
export type JobTxEventName = (typeof JOB_TX_EVENTS)[number];

/** One event, as the contract logged it: `data[0]` of the NEP-297 line, keys and types untouched. */
export interface JobTxEvent {
  event: JobTxEventName;
  data: Record<string, unknown>;
}

export type TxEventsReading =
  | {status: 'pending'}
  | {status: 'reverted'}
  | {status: 'success'; signerId: string | null; events: JobTxEvent[]};

/**
 * A transaction someone else signed — a person, from the browser — and the
 * Pactora job events its receipts carry (docs/26 "prepare → sign → confirm").
 * Same arguments as `PaymentReader`: NEAR needs the signer to find the shard.
 */
export type TxEventsReader = (args: {
  chainId: string;
  txHash: string;
  signerId: string;
}) => Promise<TxEventsReading>;

/** nearcore's and near-api-js's ways of saying "I do not know this transaction". */
function isUnknownTx(err: unknown): boolean {
  const text = `${(err as {name?: string}).name ?? ''} ${(err as {type?: string}).type ?? ''} ${(err as Error).message ?? ''}`;
  return /UNKNOWN_TRANSACTION|UnknownTransaction|RpcRequestParseError|TransactionInfo|does not exist|doesn't exist|parse/i.test(
    text,
  );
}

/**
 * Real reader.
 *
 * Only events logged by the configured Pactora contract, in receipts that
 * succeeded, count: anyone can log a line that looks like ours from a
 * contract of their own, and NEAR rolls a failed receipt's state back, so its
 * logs record nothing that happened. A failed transaction is `reverted`.
 */
export function makeTxEventsReader(config: PactoraConfig, clientFor = clients(config)): TxEventsReader {
  return async ({chainId, txHash, signerId}) => {
    const pactora = config.chain(chainId).contracts.Pactora;
    let out: Awaited<ReturnType<NearClient['txOutcome']>>;
    try {
      out = await clientFor(chainId).txOutcome(txHash, signerId);
    } catch (err) {
      // A hash the node has never seen can come back as a parse error of the
      // RPC's answer (RpcRequestParseError on the TransactionInfo variant)
      // rather than UNKNOWN_TRANSACTION. Either way the node does not know
      // it yet: pending, which the route answers 409 with retryAfter.
      if (isUnknownTx(err)) return {status: 'pending'};
      throw err;
    }
    if (out.status === 'pending') return {status: 'pending'};
    if (out.status === 'failure') return {status: 'reverted'};
    const events: JobTxEvent[] = [];
    for (const r of out.receipts) {
      if (!r.ok || r.executorId !== pactora) continue;
      for (const line of r.logs) {
        const e = parseLine(line);
        if (!e || !(JOB_TX_EVENTS as readonly string[]).includes(e.event)) continue;
        for (const d of e.data) {
          if (typeof d === 'object' && d !== null && !Array.isArray(d)) {
            events.push({event: e.event as JobTxEventName, data: d as Record<string, unknown>});
          }
        }
      }
    }
    return {status: 'success', signerId: out.signerId ?? null, events};
  };
}

/**
 * Real reader for x402: the payment events of a transaction, built on the
 * general reader so the two can never disagree about which logs count.
 */
export function makePaymentReader(config: PactoraConfig, clientFor = clients(config)): PaymentReader {
  const read = makeTxEventsReader(config, clientFor);
  return async (args) => {
    const r = await read(args);
    if (r.status !== 'success') return r;
    const paid = (event: JobTxEventName) =>
      r.events
        .filter((e) => e.event === event)
        .map(({data: d}) => ({
          clientAgentId: BigInt(d['client'] as number),
          workerAgentId: BigInt(d['worker'] as number),
          amount: BigInt(d['amount'] as string),
          specHash: d['spec_hash'] as string,
        }));
    return {status: 'success', directPaid: paid('direct_paid'), jobCreated: paid('job_created')};
  };
}

function parseLine(line: string): {event: string; data: unknown[]} | null {
  if (!line.startsWith('EVENT_JSON:')) return null;
  try {
    const v = JSON.parse(line.slice('EVENT_JSON:'.length)) as {
      standard?: unknown;
      event?: unknown;
      data?: unknown;
    };
    if (v.standard !== 'pactora' || typeof v.event !== 'string' || !Array.isArray(v.data)) return null;
    return {event: v.event, data: v.data as unknown[]};
  } catch {
    return null;
  }
}

/** A read-only contract view on a chain (the admin console reads roles and DAO proposals live). */
export type ChainViewer = (
  chainId: string,
  contract: string,
  method: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export function makeChainViewer(config: PactoraConfig, clientFor = clients(config)): ChainViewer {
  return (chainId, contract, method, args = {}) => clientFor(chainId).view(contract, method, args);
}
