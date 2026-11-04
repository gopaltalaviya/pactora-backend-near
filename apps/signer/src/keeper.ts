import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Account,
  type Hex,
  type PublicClient,
} from 'viem';
import {and, eq, inArray, isNotNull} from 'drizzle-orm';
import type {ChainConfig} from '@pactora/config';
import {type Db, jobEvents, jobs} from '@pactora/db';
import type {Metrics} from '@pactora/service';
import {viemChainOf} from './accounts.js';

/**
 * The keeper: sends the escrow's permissionless exits when they fall due.
 *
 * `TaskEscrow` promises that no job holds funds forever — every non-terminal
 * state has an exit anyone may call once its deadline passes. A promise that
 * needs a caller is only kept if something calls. Until this existed nothing
 * did: a worker that went offline after accepting left the client's money in
 * escrow indefinitely, and a result the client never reviewed was never paid,
 * while the orchestrator told the user both would resolve on their own.
 *
 * It holds its own key. It must not share one with the signer: two processes
 * drawing nonces from one account is a race the signer's advisory lock cannot
 * see across processes.
 *
 * The chain decides, not the database. Deadlines and state are read from
 * `getJob` on every sweep; the database only says which jobs are worth
 * asking about.
 */

/** Mirrors `ITaskEscrow.JobState`. */
export const JobState = {
  NONE: 0,
  CREATED: 1,
  ACCEPTED: 2,
  SUBMITTED: 3,
  DISPUTED: 4,
} as const;

export type Exit = 'expireUnaccepted' | 'expireUndelivered' | 'autoApprove' | 'expireDispute';

export interface OnChainJob {
  state: number;
  acceptDeadline: bigint;
  workDeadline: bigint;
  reviewDeadline: bigint;
  /** v2: set when the job is disputed; 0 otherwise. */
  disputeDeadline?: bigint;
}

/**
 * Which exit, if any, the chain will accept for this job at `now`.
 *
 * Strictly after the deadline, matching the contract's `<=` revert. Sending
 * on the boundary second would buy a certain `DeadlineNotPassed`.
 */
export function dueExit(job: OnChainJob, now: bigint): Exit | null {
  switch (job.state) {
    case JobState.CREATED:
      return now > job.acceptDeadline ? 'expireUnaccepted' : null;
    case JobState.ACCEPTED:
      return now > job.workDeadline ? 'expireUndelivered' : null;
    case JobState.SUBMITTED:
      return job.reviewDeadline > 0n && now > job.reviewDeadline ? 'autoApprove' : null;
    // v2: an arbiter who never rules no longer holds the funds forever.
    case JobState.DISPUTED:
      return (job.disputeDeadline ?? 0n) > 0n && now > job.disputeDeadline! ? 'expireDispute' : null;
    default:
      return null;
  }
}

export interface KeeperDeps {
  /** Escrow jobs the database still believes are open, by on-chain id. */
  openJobs: () => Promise<bigint[]>;
  readJob: (chainJobId: bigint) => Promise<OnChainJob>;
  /** Seconds, from the chain's latest block rather than this machine's clock. */
  now: () => Promise<bigint>;
  send: (exit: Exit, chainJobId: bigint) => Promise<Hex>;
  logger?: {
    info: (o: unknown, m?: string) => void;
    warn: (o: unknown, m?: string) => void;
  };
  /** Counts exits sent and failed, by exit — optional. */
  onExit?: (exit: Exit, outcome: 'sent' | 'failed') => void;
  /**
   * Audit M-1: reviews the registry refused at settlement and nobody has
   * written yet, by job and side. The escrow keeps them, and the agent can
   * neither hire nor be hired until they are written — so after a registry
   * outage someone must write them, and anyone may.
   */
  unwrittenReviews?: () => Promise<{chainJobId: bigint; client: boolean}[]>;
  /** `retryFeedback(jobId, client)`; throws while the registry still refuses. */
  retryReview?: (chainJobId: bigint, client: boolean) => Promise<Hex>;
}

export interface RetryResult {
  written: {chainJobId: string; client: boolean; txHash: Hex}[];
  stillRefused: {chainJobId: string; client: boolean; reason: string}[];
}

export interface SweepResult {
  checked: number;
  sent: {chainJobId: string; exit: Exit; txHash: Hex}[];
  failed: {chainJobId: string; exit: Exit; reason: string}[];
}

export class Keeper {
  private readonly log: NonNullable<KeeperDeps['logger']>;

  constructor(private readonly deps: KeeperDeps) {
    this.log = deps.logger ?? {info: () => {}, warn: () => {}};
  }

  async sweep(): Promise<SweepResult> {
    const ids = await this.deps.openJobs();
    const result: SweepResult = {checked: ids.length, sent: [], failed: []};
    if (ids.length === 0) return result;

    const now = await this.deps.now();

    for (const id of ids) {
      const exit = dueExit(await this.deps.readJob(id), now);
      if (!exit) continue;

      try {
        const txHash = await this.deps.send(exit, id);
        result.sent.push({chainJobId: id.toString(), exit, txHash});
        this.deps.onExit?.(exit, 'sent');
        this.log.info({chainJobId: id.toString(), exit, txHash}, 'exit sent');
      } catch (err) {
        // One job's failure must not stop the others — the likeliest cause is
        // someone else calling the same exit first, which is the system
        // working, not breaking.
        const reason = err instanceof Error ? err.message.split('\n')[0]! : String(err);
        result.failed.push({chainJobId: id.toString(), exit, reason});
        this.deps.onExit?.(exit, 'failed');
        this.log.warn({chainJobId: id.toString(), exit, reason}, 'exit not sent');
      }
    }
    return result;
  }

  /**
   * Write every refused review the registry now takes. One still refused —
   * the agent is still the writer's operator, or the registry is still down —
   * is left for the next pass; the contract changes nothing when it reverts.
   */
  async retryReviews(): Promise<RetryResult> {
    const result: RetryResult = {written: [], stillRefused: []};
    const {unwrittenReviews, retryReview} = this.deps;
    if (!unwrittenReviews || !retryReview) return result;
    for (const {chainJobId, client} of await unwrittenReviews()) {
      try {
        const txHash = await retryReview(chainJobId, client);
        result.written.push({chainJobId: chainJobId.toString(), client, txHash});
        this.log.info({chainJobId: chainJobId.toString(), client, txHash}, 'refused review written');
      } catch (err) {
        const reason = err instanceof Error ? err.message.split('\n')[0]! : String(err);
        result.stillRefused.push({chainJobId: chainJobId.toString(), client, reason});
        this.log.warn({chainJobId: chainJobId.toString(), client, reason}, 'review still refused');
      }
    }
    return result;
  }

  /** Sweep forever. Returns a function that stops it. */
  start(intervalMs: number): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const loop = async () => {
      try {
        await this.sweep();
      } catch (err) {
        this.log.warn({reason: (err as Error).message}, 'sweep failed');
      }
      try {
        await this.retryReviews();
      } catch (err) {
        this.log.warn({reason: (err as Error).message}, 'review pass failed');
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

/** Wire a keeper to a real chain and database. */
export function chainKeeper(opts: {
  db: Db;
  chain: ChainConfig;
  abis: Record<string, Abi>;
  account: Account;
  logger?: KeeperDeps['logger'];
  /** Exported as `keeper_exits_total{exit,outcome}` when given. */
  metrics?: Metrics;
  /** Which jobs to ask the chain about. Defaults to the database's open escrow jobs. */
  openJobs?: KeeperDeps['openJobs'];
}): Keeper {
  const {db, chain, abis, account} = opts;
  const pub = createPublicClient({
    transport: http(chain.rpcUrl),
  }) as PublicClient;
  const viemChain = viemChainOf(chain);
  const wallet = createWalletClient({account, chain: viemChain, transport: http(chain.rpcUrl)});
  const escrow = chain.contracts['TaskEscrow'] as Hex;
  const abi = abis['TaskEscrow'] as Abi;

  const exits = opts.metrics?.counter(
    'keeper_exits_total',
    'Permissionless exits the keeper sent or failed to send',
    ['exit', 'outcome'],
  );

  return new Keeper({
    ...(opts.logger ? {logger: opts.logger} : {}),
    ...(exits ? {onExit: (exit, outcome) => exits.labels(exit, outcome).inc()} : {}),
    openJobs:
      opts.openJobs ??
      (async () => {
        const rows = await db
          .select({chainJobId: jobs.chainJobId})
          .from(jobs)
          .where(
            and(
              eq(jobs.chainId, chain.chainId),
              eq(jobs.path, 'escrow'),
              isNotNull(jobs.chainJobId),
              inArray(jobs.state, ['created', 'accepted', 'submitted', 'disputed']),
            ),
          );
        return rows.map((r) => BigInt(r.chainJobId!));
      }),
    readJob: async (id) =>
      (await pub.readContract({
        address: escrow,
        abi,
        functionName: 'getJob',
        args: [id],
      })) as OnChainJob,
    now: async () => (await pub.getBlock({blockTag: 'latest'})).timestamp,
    unwrittenReviews: async () => {
      // Refused reviews minus those written since, from the indexed trail.
      const rows = await db
        .select({kind: jobEvents.kind, payload: jobEvents.payload})
        .from(jobEvents)
        .where(
          and(
            eq(jobEvents.chainId, chain.chainId),
            inArray(jobEvents.kind, ['feedback_failed', 'feedback_retried']),
          ),
        );
      const open = new Map<string, {jobId: string; agentId: string}>();
      for (const r of rows) {
        const p = r.payload as {jobId?: string; agentId?: string};
        if (!p.jobId || !p.agentId) continue;
        const k = `${p.jobId}:${p.agentId}`;
        if (r.kind === 'feedback_failed') open.set(k, {jobId: p.jobId, agentId: p.agentId});
        else open.delete(k);
      }
      // The event names the agent, not the side: the job on chain says which.
      const out: {chainJobId: bigint; client: boolean}[] = [];
      for (const {jobId, agentId} of open.values()) {
        const job = (await pub.readContract({
          address: escrow,
          abi,
          functionName: 'getJob',
          args: [BigInt(jobId)],
        })) as {clientAgentId: bigint};
        out.push({chainJobId: BigInt(jobId), client: job.clientAgentId === BigInt(agentId)});
      }
      return out;
    },
    retryReview: async (id, client) => {
      // Simulate first: still refused costs a read, not gas.
      const {request} = await pub.simulateContract({
        account,
        address: escrow,
        abi,
        functionName: 'retryFeedback',
        args: [id, client],
      });
      const hash = await wallet.writeContract({...request, chain: viemChain});
      const receipt = await pub.waitForTransactionReceipt({hash});
      if (receipt.status !== 'success') throw new Error(`retryFeedback reverted in ${hash}`);
      return hash;
    },
    send: async (exit, id) => {
      // Simulate first: if another caller got there, this costs a read, not gas.
      const {request} = await pub.simulateContract({
        account,
        address: escrow,
        abi,
        functionName: exit,
        args: [id],
      });
      // The configured chain, never null: viem then refuses an RPC serving
      // another one instead of signing for it.
      const hash = await wallet.writeContract({...request, chain: viemChain});
      const receipt = await pub.waitForTransactionReceipt({hash});
      if (receipt.status !== 'success') throw new Error(`${exit} reverted in ${hash}`);
      return hash;
    },
  });
}
