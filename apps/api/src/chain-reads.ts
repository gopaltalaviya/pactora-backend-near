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

interface PaidEventData {
  client: number;
  worker: number;
  amount: string;
  spec_hash: string;
}

/**
 * Real reader: the transaction's outcome, and the Pactora events in its
 * receipts.
 *
 * Only events logged by the configured Pactora contract count: anyone can log
 * a line that looks like ours from a contract of their own. A failed
 * transaction is `reverted`, whatever it logged before failing (NEAR rolls a
 * failed receipt's state back, so its logs record nothing that happened).
 */
export function makePaymentReader(config: PactoraConfig, clientFor = clients(config)): PaymentReader {
  return async ({chainId, txHash, signerId}) => {
    const pactora = config.chain(chainId).contracts.Pactora;
    const out = await clientFor(chainId).txOutcome(txHash, signerId);
    if (out.status === 'pending') return {status: 'pending'};
    if (out.status === 'failure') return {status: 'reverted'};

    const directPaid: DirectPaidLog[] = [];
    const jobCreated: JobCreatedLog[] = [];
    for (const r of out.receipts) {
      if (!r.ok || r.executorId !== pactora) continue;
      for (const line of r.logs) {
        const e = parseLine(line);
        if (!e) continue;
        const target = e.event === 'direct_paid' ? directPaid : e.event === 'job_created' ? jobCreated : null;
        if (!target) continue;
        for (const d of e.data) {
          target.push({
            clientAgentId: BigInt(d.client),
            workerAgentId: BigInt(d.worker),
            amount: BigInt(d.amount),
            specHash: d.spec_hash,
          });
        }
      }
    }
    return {status: 'success', directPaid, jobCreated};
  };
}

function parseLine(line: string): {event: string; data: PaidEventData[]} | null {
  if (!line.startsWith('EVENT_JSON:')) return null;
  try {
    const v = JSON.parse(line.slice('EVENT_JSON:'.length)) as {
      standard?: unknown;
      event?: unknown;
      data?: unknown;
    };
    if (v.standard !== 'pactora' || typeof v.event !== 'string' || !Array.isArray(v.data)) return null;
    return {event: v.event, data: v.data as PaidEventData[]};
  } catch {
    return null;
  }
}
