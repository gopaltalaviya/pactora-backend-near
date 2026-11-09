import {and, eq, inArray, isNotNull, not} from 'drizzle-orm';
import type {ChainConfig} from '@pactora/config';
import {type Db, isHeldSql, jobs} from '@pactora/db';
import {signFunctionCallWith, type NearClient} from '@pactora/near';
import type {Metrics} from '@pactora/service';
import type {ServiceAccount} from './keysource.js';
import {GAS, refusalOf} from './signer.js';

/**
 * The keeper: sends the contract's permissionless exits when they fall due.
 *
 * The Pactora contract promises that no job holds funds forever (its
 * invariant I5) — every open state has an exit anyone may call once its
 * deadline passes. A promise that needs a caller is only kept if something
 * calls: a worker that went offline after accepting would otherwise leave the
 * client's money in escrow, and an unreviewed result would never be paid.
 *
 * It holds its own key on its own NEAR account. Sharing an agent's would race
 * the signer for that key's nonces.
 *
 * The chain decides, not the database. Deadlines and state are read from
 * `get_job` on every sweep; the database only says which jobs are worth
 * asking about.
 *
 * An earlier keeper also re-wrote reviews an external registry had refused
 * (`retryFeedback`). NEAR has no counterpart: the contract writes reputation
 * in the same call that settles, so there is nothing left to retry.
 */

/** The contract's `JobState`, as its JSON names it. */
export const JobState = {
  CREATED: 'Created',
  ACCEPTED: 'Accepted',
  SUBMITTED: 'Submitted',
  DISPUTED: 'Disputed',
  SETTLED: 'Settled',
  REFUNDED: 'Refunded',
} as const;
export type JobStateName = (typeof JobState)[keyof typeof JobState];

export type Exit = 'expire_unaccepted' | 'expire_undelivered' | 'auto_approve' | 'expire_dispute';

/** The deadlines of a job, in seconds, as `get_job` returns them. */
export interface OnChainJob {
  /** A `JobStateName`; a string, because a newer contract may add states the keeper leaves alone. */
  state: string;
  acceptDeadline: bigint;
  workDeadline: bigint;
  reviewDeadline: bigint;
  /** Set when the job is disputed; 0 otherwise. */
  disputeDeadline: bigint;
}

/**
 * The deadline whose passing made `exit` due. For a dispute that is the
 * dispute deadline PLUS the contract's `dispute_grace` (1.1.0): the arbiter
 * may still rule during the grace, and `expire_dispute` before it ends is
 * `DeadlineNotPassed`.
 */
export function deadlineOf(job: OnChainJob, exit: Exit, disputeGrace: bigint): bigint {
  switch (exit) {
    case 'expire_unaccepted':
      return job.acceptDeadline;
    case 'expire_undelivered':
      return job.workDeadline;
    case 'auto_approve':
      return job.reviewDeadline;
    case 'expire_dispute':
      return job.disputeDeadline + disputeGrace;
  }
}

/**
 * Which exit, if any, the chain will accept for this job at `now`.
 *
 * Strictly after the deadline: the contract requires `now_s() > deadline`
 * (`DeadlineNotPassed` otherwise), so the boundary second buys a failure.
 * `disputeGrace` is the contract's current `dispute_grace` (read at expiry
 * by the contract too, so a parameter change applies to open disputes).
 */
export function dueExit(job: OnChainJob, now: bigint, disputeGrace: bigint): Exit | null {
  switch (job.state) {
    case JobState.CREATED:
      return now > job.acceptDeadline ? 'expire_unaccepted' : null;
    case JobState.ACCEPTED:
      return now > job.workDeadline ? 'expire_undelivered' : null;
    case JobState.SUBMITTED:
      return job.reviewDeadline > 0n && now > job.reviewDeadline ? 'auto_approve' : null;
    case JobState.DISPUTED:
      return job.disputeDeadline > 0n && now > job.disputeDeadline + disputeGrace ? 'expire_dispute' : null;
    default:
      return null;
  }
}

export interface KeeperDeps {
  /** Escrow jobs the database still believes are open, by on-chain id. */
  openJobs: () => Promise<bigint[]>;
  /** The job on chain; null when the contract has no such job. */
  readJob: (chainJobId: bigint) => Promise<OnChainJob | null>;
  /** Seconds, from the chain's final block rather than this machine's clock. */
  now: () => Promise<bigint>;
  /** The contract's `dispute_grace` in seconds (`get_params`), read once per sweep. */
  disputeGrace: () => Promise<bigint>;
  send: (exit: Exit, chainJobId: bigint) => Promise<string>;
  logger?: {
    info: (o: unknown, m?: string) => void;
    warn: (o: unknown, m?: string) => void;
  };
  /** Counts exits sent and failed, by exit — optional. */
  onExit?: (exit: Exit, outcome: 'sent' | 'failed') => void;
  /**
   * After each sweep: seconds since the deadline of the oldest exit that was
   * due and still not sent (0 when none is left). docs/26 F29 — an exit
   * that keeps failing is money held past its deadline, and this is what an
   * alert watches.
   */
  onBacklog?: (ageSeconds: number) => void;
}

export interface SweepResult {
  checked: number;
  sent: {chainJobId: string; exit: Exit; txHash: string}[];
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
    if (ids.length === 0) {
      this.deps.onBacklog?.(0);
      return result;
    }

    const now = await this.deps.now();
    const grace = await this.deps.disputeGrace();
    let oldestUnsent: bigint | null = null;

    for (const id of ids) {
      const job = await this.deps.readJob(id);
      const exit = job ? dueExit(job, now, grace) : null;
      if (!job || !exit) continue;

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
        const due = deadlineOf(job, exit, grace);
        if (oldestUnsent === null || due < oldestUnsent) oldestUnsent = due;
        this.deps.onExit?.(exit, 'failed');
        this.log.warn({chainJobId: id.toString(), exit, reason}, 'exit not sent');
      }
    }
    this.deps.onBacklog?.(oldestUnsent === null ? 0 : Number(now - oldestUnsent));
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
      if (!stopped) timer = setTimeout(() => void loop(), intervalMs);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }
}

/** `get_job`'s fields the keeper reads. */
interface JobView {
  state: string;
  accept_deadline: number;
  work_deadline: number;
  review_deadline: number;
  dispute_deadline: number;
}

/** The job's deadlines, from `get_job`. */
export function onChainJobOf(v: JobView): OnChainJob {
  return {
    state: v.state,
    acceptDeadline: BigInt(v.accept_deadline),
    workDeadline: BigInt(v.work_deadline),
    reviewDeadline: BigInt(v.review_deadline),
    disputeDeadline: BigInt(v.dispute_deadline),
  };
}

/**
 * The keeper's sender: signs an exit from the keeper's own account, 0
 * deposit, 100 Tgas, and waits for FINAL.
 *
 * Its nonce: the access key's + 1, but never one it already used — a send
 * whose outcome it never saw may still land, and reusing its nonce would make
 * the next one fail. Sends are sequential (one sweep, one job at a time), so
 * an in-memory high-water mark is enough; one keeper per chain is assumed,
 * as it was on EVM.
 */
export function keeperSender(near: NearClient, chain: ChainConfig, account: ServiceAccount) {
  let last = 0n;
  return async (exit: Exit, id: bigint): Promise<string> => {
    const access = await near.accessKey(account.accountId, account.key.publicKey);
    if (!access)
      throw new Error(`the keeper account ${account.accountId} has no key ${account.key.publicKey}`);
    const nonce = (access.nonce > last ? access.nonce : last) + 1n;
    last = nonce;
    const block = await near.finalBlock();
    const signed = await signFunctionCallWith({
      signerId: account.accountId,
      key: account.key,
      receiverId: chain.contracts.Pactora,
      nonce,
      blockHash: block.hash,
      method: exit,
      args: {job_id: Number(id)},
      gas: GAS,
      deposit: 0n,
    });
    const outcome = await near.sendSigned(signed);
    if (outcome.status === 'failure') throw new Error(refusalOf(outcome.failure ?? '', signed.hash).message);
    if (outcome.status !== 'success')
      throw new Error(`${exit} sent as ${signed.hash}, outcome not known yet`);
    return signed.hash;
  };
}

/**
 * The escrow jobs the keeper asks the chain about: open, on chain, and with
 * neither party on hold or blocked (docs/26 F14). The hold is soft: anyone
 * else may still send the same permissionless exit.
 */
export async function openEscrowJobs(db: Db, chainId: string): Promise<bigint[]> {
  const rows = await db
    .select({chainJobId: jobs.chainJobId})
    .from(jobs)
    .where(
      and(
        eq(jobs.chainId, chainId),
        eq(jobs.path, 'escrow'),
        isNotNull(jobs.chainJobId),
        inArray(jobs.state, ['created', 'accepted', 'submitted', 'disputed']),
        not(isHeldSql(jobs.workerAgentId)),
        not(isHeldSql(jobs.clientAgentId)),
      ),
    );
  return rows.map((r) => BigInt(r.chainJobId!));
}

/** Wire a keeper to a real chain and database. */
export function chainKeeper(opts: {
  db: Db;
  chain: ChainConfig;
  near: NearClient;
  account: ServiceAccount;
  logger?: KeeperDeps['logger'];
  /** Exported as `keeper_exits_total{exit,outcome}` when given. */
  metrics?: Metrics;
  /** Which jobs to ask the chain about. Defaults to the database's open escrow jobs. */
  openJobs?: KeeperDeps['openJobs'];
}): Keeper {
  const {db, chain, near, account} = opts;
  const exits = opts.metrics?.counter(
    'keeper_exits_total',
    'Permissionless exits the keeper sent or failed to send',
    ['exit', 'outcome'],
  );
  const backlog = opts.metrics?.gauge(
    'keeper_backlog_age_seconds',
    'Seconds since the deadline of the oldest due exit the keeper has not managed to send (0 = none)',
  );

  return new Keeper({
    ...(opts.logger ? {logger: opts.logger} : {}),
    ...(exits ? {onExit: (exit, outcome) => exits.labels(exit, outcome).inc()} : {}),
    ...(backlog ? {onBacklog: (age) => backlog.set(age)} : {}),
    openJobs: opts.openJobs ?? (() => openEscrowJobs(db, chain.chainId)),
    readJob: async (id) => {
      const v = await near.view<JobView | null>(chain.contracts.Pactora, 'get_job', {job_id: Number(id)});
      return v ? onChainJobOf(v) : null;
    },
    // The final block's clock, which is what the contract's `now_s()` will
    // be at least: the exit executes in a later block.
    now: async () => (await near.finalBlock()).timestampNs / 1_000_000_000n,
    // From the chain, not the config file: the owner may change it, and the
    // contract reads it at expiry.
    disputeGrace: async () => {
      const p = await near.view<{dispute_grace?: number | string}>(chain.contracts.Pactora, 'get_params', {});
      if (p.dispute_grace === undefined)
        throw new Error('get_params has no dispute_grace: a contract before 1.1.0');
      return BigInt(p.dispute_grace);
    },
    send: keeperSender(near, chain, account),
  });
}
