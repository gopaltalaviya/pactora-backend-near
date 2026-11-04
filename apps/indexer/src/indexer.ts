import {
  createPublicClient,
  hexToString,
  http,
  parseAbiItem,
  type Abi,
  type Log,
  type PublicClient,
} from 'viem';
import {and, eq, gte, inArray, isNotNull, isNull, lte, sql} from 'drizzle-orm';
import type {ChainConfig} from '@pactora/config';
import {
  type Db,
  OUTCOME_SUCCESS,
  WORKER_FAULT,
  indexerCursor,
  jobEvents,
  jobs,
  agents,
  agentStats,
  payments,
  reputationScoreSql,
  tokenTransfers,
} from '@pactora/db';

/** ERC-20 Transfer, for the funding graph (v3). */
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/**
 * A decoded event field as text. Fields arrive as `unknown`; `String()` on an
 * object writes "[object Object]" into a column instead of failing, so only
 * the shapes an event can carry are accepted.
 */
function text(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint' || typeof v === 'number') return v.toString();
  return fallback;
}

/** `ITaskEscrow.Outcome.SUCCESS`. Only this outcome earns reputation. */

/** `JobRefunded.reason` is a left-aligned bytes32 string. */
function refundReason(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  if (!raw.startsWith('0x')) return raw;
  try {
    return hexToString(raw as `0x${string}`).replace(/\0+$/, '');
  } catch {
    return '';
  }
}

/**
 * Chain → Postgres, one worker per enabled chain.
 *
 * Two properties this is built around:
 *
 * 1. **Re-runnable.** Every write is idempotent, guaranteed by
 *    `UNIQUE (chain_id, tx_hash, log_index)` on job_events rather than by
 *    application care. Replaying a block range is a no-op.
 *
 * 2. **Reorg-aware.** The cursor stores the hash of the last block it
 *    processed. If that hash no longer matches what the chain reports, the
 *    chain reorganised underneath us, so we rewind and replay. Without this a
 *    payment from an orphaned block stays in the database forever.
 *
 * It only ever writes what the chain said. It never invents state, which is
 * why the UI can never show a payment that did not happen.
 */

/**
 * A handle that is either the pool or an open transaction.
 *
 * Written out rather than taking `Db` everywhere, so that a method which MUST
 * run inside the caller's transaction cannot silently be handed the pool and
 * commit on its own.
 */
type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface IndexerDeps {
  db: Db;
  chain: ChainConfig;
  abis: Record<string, Abi>;
  logger?: {info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void};
  /** The chain client. Injected in tests; by default one for `chain.rpcUrl`. */
  client?: PublicClient;
}

type JobState = 'created' | 'accepted' | 'submitted' | 'disputed' | 'settled' | 'refunded';

/**
 * The states a job may be in for an event to move it to each state: any
 * earlier one, or the same one — the API often writes a state first, and the
 * event must still land its chain facts (the fee, the result hash). The
 * lifecycle only goes one way — created → accepted → submitted → disputed →
 * settled or refunded — with every step skippable (a directPay is created and
 * settled at once; an unaccepted offer is refunded).
 */
const AT_OR_BEFORE: Record<Exclude<JobState, 'created'>, JobState[]> = {
  accepted: ['created', 'accepted'],
  submitted: ['created', 'accepted', 'submitted'],
  disputed: ['created', 'accepted', 'submitted', 'disputed'],
  settled: ['created', 'accepted', 'submitted', 'disputed', 'settled'],
  refunded: ['created', 'accepted', 'submitted', 'disputed', 'refunded'],
};

export class Indexer {
  private readonly client: PublicClient;
  private readonly log: NonNullable<IndexerDeps['logger']>;

  /**
   * How far behind the head to stay, and how far to rewind on a reorg.
   *
   * Taken from the network's declared `confirmations` rather than hardcoded:
   * 1 on a local chain you can re-run, 2 on Monad testnet, 5 on mainnet. A
   * fixed depth of 12 would mean a freshly-started chain with 7 blocks never
   * indexes anything at all, because the safe head sits below block zero.
   */
  private readonly reorgDepth: bigint;
  private readonly maxRange: bigint;

  /** The last head read and the last block indexed to — see `progress()`. */
  private lastHead: bigint | null = null;
  private lastIndexed: bigint | null = null;

  constructor(private readonly deps: IndexerDeps) {
    this.client = deps.client ?? createPublicClient({transport: http(deps.chain.rpcUrl)});
    this.log = deps.logger ?? {info: () => {}, warn: () => {}};
    this.reorgDepth = BigInt(deps.chain.confirmations);
    // Public RPCs cap eth_getLogs. Monad's rejects anything over 100 blocks,
    // which a 2000-block default discovers only in production, as an error
    // rather than as a slow query.
    this.maxRange = BigInt(deps.chain.maxLogRange);
  }

  /**
   * How far the last tick got: the chain head it read and the block it has
   * indexed up to. Their difference is the lag an operator alerts on — a
   * tick can succeed every time while falling further behind a backlog.
   */
  progress(): {headBlock: bigint | null; indexedBlock: bigint | null} {
    return {headBlock: this.lastHead, indexedBlock: this.lastIndexed};
  }

  /** Process one batch. Returns the block it advanced to. */
  async tick(): Promise<bigint> {
    const to = await this.step();
    this.lastIndexed = to;
    return to;
  }

  private async step(): Promise<bigint> {
    const {chain} = this.deps;
    const head = await this.client.getBlockNumber();
    this.lastHead = head;
    const safeHead = head > this.reorgDepth ? head - this.reorgDepth : 0n;

    const cursor = await this.readCursor();
    let from = cursor ? BigInt(cursor.lastBlock) + 1n : BigInt(chain.startBlock);

    if (cursor && (await this.hasReorged(cursor))) {
      // Rewind past the reorg and replay. Safe because every write is keyed
      // by (chain, tx, logIndex).
      const back = this.reorgDepth * 2n; // rewind further than we trail
      const rewindTo =
        BigInt(cursor.lastBlock) > back ? BigInt(cursor.lastBlock) - back : BigInt(chain.startBlock);
      this.log.warn(
        {chainId: chain.chainId, from: cursor.lastBlock, rewindTo: rewindTo.toString()},
        'reorg detected, rewinding',
      );
      // Throws — and so halts the indexer where it stands — if anything we
      // recorded in the window is no longer on the chain at all.
      await this.checkRewindWindow(rewindTo, BigInt(cursor.lastBlock));
      // v3: the funding graph is a plain copy of the token's logs, with
      // nothing derived from it — so unlike the job projection it can simply
      // be re-read. Left in place, a transfer from an orphaned block could mark
      // a payment self-funded on money that never moved. If the replay below
      // fails, the cursor still names the orphaned block, so the next tick
      // detects the reorg again and repeats this: it converges.
      await this.deps.db
        .delete(tokenTransfers)
        .where(
          and(eq(tokenTransfers.chainId, chain.chainId), gte(tokenTransfers.blockNumber, Number(rewindTo))),
        );
      from = rewindTo;
    }

    if (from > safeHead) return from - 1n;

    const to = from + this.maxRange - 1n > safeHead ? safeHead : from + this.maxRange - 1n;
    const escrow = chain.contracts['TaskEscrow'];
    if (!escrow) throw new Error(`chain ${chain.chainId}: no TaskEscrow address in the deployment`);

    const logs = await this.client.getLogs({
      address: escrow as `0x${string}`,
      fromBlock: from,
      toBlock: to,
    });

    for (const entry of logs) await this.handleLog(entry);

    // v3: the funding graph, from the same chunk. Before the cursor moves, so
    // a failed read retries the whole chunk rather than leaving a gap.
    const paymentToken = chain.contracts['PaymentToken'];
    if (paymentToken) await this.recordTransfers(paymentToken, from, to);

    const toBlock = await this.client.getBlock({blockNumber: to});
    await this.writeCursor('TaskEscrow', to, toBlock.hash);

    if (logs.length > 0) {
      this.log.info(
        {chainId: chain.chainId, from: from.toString(), to: to.toString(), logs: logs.length},
        'indexed',
      );
    }
    return to;
  }

  /**
   * Payment-token transfers in [from, to] that touch a known agent's wallet or
   * owner, into `token_transfers` — what the trust check reads to tell a
   * client the worker's side funded from one that paid with its own money.
   *
   * Kept when EITHER side is known: a rater wallet funded before it
   * registered is still caught, because the worker's side was known. One
   * extra `eth_getLogs` per chunk, filtered in memory; on a token with heavy
   * traffic (mainnet USDC) this should move to topic filters on the known
   * addresses. Idempotent on (chain, tx, logIndex), so a replay adds nothing.
   */
  private async recordTransfers(token: string, from: bigint, to: bigint): Promise<void> {
    const {db, chain} = this.deps;
    const logs = (await this.client.getLogs({
      address: token as `0x${string}`,
      event: TRANSFER,
      fromBlock: from,
      toBlock: to,
    })) as unknown as {
      args: {from?: string; to?: string; value?: bigint};
      blockNumber: bigint | null;
      logIndex: number | null;
      transactionHash: string | null;
    }[];
    if (logs.length === 0) return;

    const known = new Set<string>();
    const rows = (await db.execute(
      sql`SELECT lower(wallet_address) AS w, lower(owner_address) AS o FROM agents WHERE chain_id = ${chain.chainId}`,
    )) as unknown as {w: string; o: string}[];
    for (const r of rows) {
      known.add(r.w);
      known.add(r.o);
    }

    const keep = logs
      .map((l) => ({
        from: String(l.args.from ?? '').toLowerCase(),
        to: String(l.args.to ?? '').toLowerCase(),
        value: l.args.value,
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
        txHash: l.transactionHash,
      }))
      .filter(
        (t) =>
          (known.has(t.from) || known.has(t.to)) &&
          t.value !== undefined &&
          t.blockNumber !== null &&
          t.logIndex !== null &&
          t.txHash !== null,
      );
    if (keep.length === 0) return;

    await db
      .insert(tokenTransfers)
      .values(
        keep.map((t) => ({
          chainId: chain.chainId,
          blockNumber: Number(t.blockNumber),
          txHash: t.txHash!,
          logIndex: t.logIndex!,
          fromAddress: t.from,
          toAddress: t.to,
          amount: t.value!.toString(),
        })),
      )
      .onConflictDoNothing();
  }

  /**
   * Is everything we recorded between `from` and `to` still on the chain?
   *
   * A transaction that was re-mined elsewhere has a receipt and the same
   * effects, so replaying is correct. One that was DROPPED has no receipt, and
   * its effects — a settlement, a reputation credit — are now false. They
   * cannot be quietly undone: job_events is append-only by design, because it
   * is the audit log. So the indexer stops here, names every orphaned
   * transaction, and waits for an operator, rather than carrying a projection
   * it knows to be wrong. The indexer trails the head by the network's
   * confirmation depth, so this takes a reorg deeper than that.
   */
  private async checkRewindWindow(from: bigint, to: bigint): Promise<void> {
    const {db, chain} = this.deps;
    const recorded = await db
      .selectDistinct({txHash: jobEvents.txHash})
      .from(jobEvents)
      .where(
        and(
          eq(jobEvents.chainId, chain.chainId),
          isNotNull(jobEvents.txHash),
          gte(jobEvents.blockNumber, Number(from)),
          lte(jobEvents.blockNumber, Number(to)),
        ),
      );

    const orphaned: string[] = [];
    for (const {txHash} of recorded) {
      // ONLY "not found" means the chain no longer has it. Any other error is
      // the RPC failing to answer — it used to count as an orphan too, so one
      // blip during this check halted the indexer as if for a reorg. Thrown
      // instead: the tick fails and the loop retries it with backoff.
      const receipt = await this.client
        .getTransactionReceipt({hash: txHash as `0x${string}`})
        .catch((err: unknown) => {
          const e = err as {name?: string; message?: string};
          if (e.name === 'TransactionReceiptNotFoundError' || /receipt not found/i.test(e.message ?? '')) {
            return null;
          }
          throw err;
        });
      if (!receipt) orphaned.push(txHash!);
    }

    if (orphaned.length > 0) {
      throw new Error(
        `reorg dropped ${orphaned.length} transaction(s) this indexer had already applied: ${orphaned.join(', ')} — ` +
          'their events are in the append-only log and their effects are in the projection; halting for an operator ' +
          'to reconcile rather than indexing on top of state the chain no longer backs',
      );
    }
  }

  /**
   * The chain is trusted; our record of it is not. If the block we last
   * processed no longer hashes the same, it was orphaned.
   */
  private async hasReorged(cursor: {lastBlock: number; lastBlockHash: string}): Promise<boolean> {
    try {
      const block = await this.client.getBlock({blockNumber: BigInt(cursor.lastBlock)});
      return block.hash !== cursor.lastBlockHash;
    } catch {
      // The block is gone entirely — that is a reorg too.
      return true;
    }
  }

  private async handleLog(entry: Log): Promise<void> {
    const {db, chain} = this.deps;
    const decoded = await this.decode(entry);
    if (!decoded) return;

    // A log with no block is a pending one. We only ever query a range below
    // the safe head, so this should not happen — and if it ever does, an
    // unmined event has no place in a record of settled payments.
    if (entry.blockNumber === null) {
      this.log.warn({kind: decoded.kind}, 'skipping a pending log with no block number');
      return;
    }
    const blockNumber = entry.blockNumber;

    const {kind, chainJobId, payload} = decoded;

    let job = await db.query.jobs.findFirst({
      where: and(eq(jobs.chainId, chain.chainId), eq(jobs.chainJobId, chainJobId)),
    });

    // No chainJobId yet.
    //
    // The API cannot know it: the signer returns as soon as the transaction is
    // BROADCAST, and the id is only assigned when the contract runs. Waiting
    // for a receipt would make every hire cost a block of latency.
    //
    // So the first event a job ever emits carries its specHash, and that is
    // what links the two. Matching on the hash of the work — rather than on an
    // id neither side knew in advance — is also self-healing: it works no
    // matter which of the two writes landed first.
    if (!job && payload['specHash']) {
      const candidate = await db.query.jobs.findFirst({
        where: and(
          eq(jobs.chainId, chain.chainId),
          eq(jobs.specHash, text(payload['specHash'])),
          isNull(jobs.chainJobId),
        ),
      });
      // The hash alone is not enough. It is scoped to this database's job id,
      // and ids repeat when a database is rebuilt or two deployments share a
      // chain — a live run linked an unaccepted escrow job to an OLD run's
      // fast-path payment, called it settled, and credited the worker. The
      // event names both parties; they must be this row's.
      job = candidate && (await this.samePartiesAs(candidate, payload)) ? candidate : undefined;
      if (candidate && !job) {
        this.log.warn(
          {jobId: candidate.id, chainJobId, specHash: payload['specHash']},
          'spec hash matched a job between different agents — not linked',
        );
      }
      if (job) {
        await db.update(jobs).set({chainJobId}).where(eq(jobs.id, job.id));
        this.log.info({jobId: job.id, chainJobId}, 'linked job to its on-chain id');
      }
    }

    // A job the API did not create — someone called the contract directly.
    // The chain is the source of truth, so this is expected, not an error.
    if (!job) {
      this.log.warn({chainId: chain.chainId, chainJobId, kind}, 'event for a job this API did not create');
      return;
    }

    // Recording the event and applying it are ONE transaction, and the
    // insert's own uniqueness decides whether the rest runs.
    //
    // This is what makes a replay safe. Replays are ordinary: the cursor is
    // written after a batch is processed, so a restart mid-batch re-reads it,
    // and every reorg deliberately rewinds 2x the confirmation depth. The
    // event and payment rows were already idempotent, but the reputation bump
    // is `completed + 1` — so before this, each replay credited the worker
    // again, with no payment behind it. That inflates the exact number this
    // project claims only a settled payment can write.
    //
    // One transaction also closes the narrower window: a crash between
    // recording an event and applying it would otherwise leave the event
    // stored and its effect skipped forever on replay.
    const jobRow = job;
    await db.transaction(async (tx) => {
      // A transaction re-mined in a later block keeps its hash but can move
      // position, and logIndex is block-level — so the unique key below sees
      // a new event, and a settlement would be credited twice. One
      // transaction emits at most one event of a kind for a job; if this one
      // is already recorded, it is the same event, wherever it now sits.
      const seen = await tx.query.jobEvents.findFirst({
        where: and(
          eq(jobEvents.chainId, chain.chainId),
          eq(jobEvents.txHash, entry.transactionHash ?? ''),
          eq(jobEvents.jobId, jobRow.id),
          eq(jobEvents.kind, kind),
        ),
      });
      if (seen) return;

      const [recorded] = await tx
        .insert(jobEvents)
        .values({
          chainId: chain.chainId,
          jobId: jobRow.id,
          kind,
          payload,
          txHash: entry.transactionHash,
          blockNumber: Number(blockNumber),
          logIndex: entry.logIndex,
        })
        .onConflictDoNothing()
        .returning({id: jobEvents.id});

      // Already seen. Its effects are already in the projection.
      if (!recorded) return;

      await this.applyStateChange(tx, jobRow.id, kind, payload, blockNumber, entry.transactionHash ?? '');
    });
  }

  /** Whether an event's client and worker are this job row's, by ERC-8004 id. */
  private async samePartiesAs(
    job: {clientAgentId: number; workerAgentId: number},
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const client = payload['clientAgentId'];
    const worker = payload['workerAgentId'];
    // Every event that carries a specHash also names both parties. One that
    // did not could not be checked, and an unchecked link is how the wrong
    // job gets paid for.
    if (client === undefined || worker === undefined) return false;
    const [c, w] = await Promise.all([
      this.deps.db.query.agents.findFirst({where: eq(agents.id, job.clientAgentId)}),
      this.deps.db.query.agents.findFirst({where: eq(agents.id, job.workerAgentId)}),
    ]);
    return text(c?.chainAgentId) === text(client) && text(w?.chainAgentId) === text(worker);
  }

  private async decode(
    entry: Log,
  ): Promise<{kind: string; chainJobId: string; payload: Record<string, unknown>} | null> {
    const {decodeEventLog} = await import('viem');
    const abi = this.deps.abis['TaskEscrow'];
    if (!abi) return null;

    try {
      const ev = decodeEventLog({abi, data: entry.data, topics: entry.topics});
      const args = (ev.args ?? {}) as Record<string, unknown>;
      const jobId = args['jobId'];
      if (jobId === undefined) return null;

      const kindOf: Record<string, string> = {
        JobCreated: 'created',
        JobAccepted: 'accepted',
        ResultSubmitted: 'submitted',
        JobSettled: 'settled',
        JobRefunded: 'refunded',
        JobDisputed: 'disputed',
        DisputeResolved: 'dispute_resolved',
        DirectPaid: 'direct_paid',
        FeedbackFailed: 'feedback_failed',
        // v2: a dispute nobody ruled on, and a payment held for its recipient.
        DisputeExpired: 'dispute_expired',
        PaymentDeferred: 'payment_deferred',
        // v3: the worker's bond paid to the client, and the dispute bond paid
        // to whoever the ruling favoured.
        BondSeized: 'bond_seized',
        DisputeBondSettled: 'dispute_bond_settled',
        // Audit M-1: a refused review was written later (retryFeedback).
        FeedbackRetried: 'feedback_retried',
      };
      const kind = ev.eventName ? kindOf[ev.eventName] : undefined;
      if (!kind) return null;

      return {
        kind,
        chainJobId: text(jobId),
        // bigints do not survive JSON, and these are money.
        payload: JSON.parse(
          JSON.stringify(args, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
        ) as Record<string, unknown>,
      };
    } catch {
      return null;
    }
  }

  /** Project the event onto the job row and the reputation counters. */
  private async applyStateChange(
    db: Tx,
    jobId: number,
    kind: string,
    payload: Record<string, unknown>,
    blockNumber: bigint,
    txHash: string,
  ): Promise<void> {
    const stateOf: Record<string, 'accepted' | 'submitted' | 'settled' | 'refunded' | 'disputed'> = {
      accepted: 'accepted',
      submitted: 'submitted',
      settled: 'settled',
      refunded: 'refunded',
      disputed: 'disputed',
    };
    const next = stateOf[kind];
    if (next) {
      // Forward only. The API advances a job when its transaction is
      // broadcast, and this indexer trails the head by its confirmations — so
      // it routinely reaches an event older than the state already written.
      // Projecting that walked the job backwards: a delivered job read
      // "accepted" again and the client's approve was refused. A reorg that
      // drops an applied event halts the indexer instead (checkRewindWindow),
      // so there is no legitimate backwards move to allow.
      await db
        .update(jobs)
        .set({
          state: next,
          ...(next === 'settled' ? {settledAt: new Date(), fee: text(payload['fee'], '0')} : {}),
          ...(kind === 'submitted' ? {resultHash: text(payload['resultHash'])} : {}),
        })
        .where(and(eq(jobs.id, jobId), inArray(jobs.state, AT_OR_BEFORE[next])));
    }

    // ONLY on 'settled'. directPay emits DirectPaid *and* JobSettled for the
    // same job, so counting both double-credits every fast-path payment —
    // which would inflate exactly the reputation this project claims is
    // trustworthy. JobSettled is emitted on both paths, so it alone is
    // complete as well as correct.
    if (kind === 'settled') {
      const job = await db.query.jobs.findFirst({where: eq(jobs.id, jobId)});
      if (!job) return;

      await db
        .insert(payments)
        .values({
          chainId: job.chainId,
          jobId: job.id,
          fromAgentId: job.clientAgentId,
          toAgentId: job.workerAgentId,
          amount: job.amount,
          fee: text(payload['fee'], '0'),
          // From the log. No event carries a tx hash in its arguments, so
          // reading one from the payload stored '' on every payment row.
          txHash,
          // The real block, not 0. A payment row that claims block zero is a
          // payment nobody can find again on the chain it came from.
          blockNumber: Number(blockNumber),
          confirmedAt: new Date(),
        })
        .onConflictDoNothing();

      // An UNRESOLVED settlement — a dispute that timed out — pays the worker
      // but earns nothing: the escrow writes no feedback for it, and the
      // projection must not credit what the chain did not. Money moved, so
      // the payment row above still stands.
      if (Number(payload['outcome'] ?? OUTCOME_SUCCESS) === OUTCOME_SUCCESS) {
        await this.bumpReputation(db, job.workerAgentId, true, job.amount);
      }
    }

    if (kind === 'refunded') {
      const job = await db.query.jobs.findFirst({where: eq(jobs.id, jobId)});
      // Only what the contract itself records as the worker's failure:
      // accepted and never delivered, or a dispute the worker lost. A client
      // cancelling, or an offer nobody accepted, is not the worker's fault —
      // and the contract writes no feedback for either.
      //
      // This tested `reason !== undefined`, which is always true: the event
      // always carries a reason, as bytes32. So every refund, a client's own
      // cancel included, was counted against the worker.
      if (job && WORKER_FAULT.has(refundReason(payload['reason']))) {
        await this.bumpReputation(db, job.workerAgentId, false, '0');
      }
    }
  }

  /**
   * Score mirrors the on-chain formula in docs/04 §2.3: Laplace-smoothed and
   * volume-damped, so a fresh agent is 50 (unknown) rather than 0 or 100, and
   * one lucky job cannot outrank a proven record.
   */
  private async bumpReputation(db: Tx, agentId: number, success: boolean, amount: string): Promise<void> {
    await db
      .insert(agentStats)
      .values({
        agentId,
        completed: success ? 1 : 0,
        failed: success ? 0 : 1,
        volume: success ? amount : '0',
        lastActiveAt: new Date(),
        score: 50,
      })
      .onConflictDoUpdate({
        target: agentStats.agentId,
        set: {
          completed: sql`${agentStats.completed} + ${success ? 1 : 0}`,
          failed: sql`${agentStats.failed} + ${success ? 0 : 1}`,
          volume: sql`${agentStats.volume} + ${success ? amount : '0'}::numeric`,
          lastActiveAt: new Date(),
        },
      });

    // The floor is per chain: more evidence is demanded where a reputation is
    // worth more to fake. This was a literal 25, so mainnet's 50 did nothing.
    const floor = Number(this.deps.chain.params['confidenceFloor'] ?? 25);
    // The formula is shared with discovery's per-skill scores (@pactora/db).
    await db.execute(sql`
      UPDATE agent_stats SET score = ${reputationScoreSql(sql`completed`, sql`failed`, floor)}
      WHERE agent_id = ${agentId}
    `);
  }

  /**
   * Start here, not at the deployment block.
   *
   * With no cursor `tick()` begins at `startBlock` and backfills every block
   * since. That is right for production — the history IS the record — and
   * catastrophic for anything that needs to see a transaction it just sent.
   * On Monad testnet the deployment sits ~1.6 million blocks behind the head
   * and `eth_getLogs` is capped at 100 blocks a call: about two hours of
   * backfill before the indexer reaches the present.
   *
   * The demo truncated the cursor on startup and then waited ninety seconds
   * for its own events. They were never going to arrive. Nothing settled, no
   * reputation was ever written, and five runs were misread as the agents
   * failing.
   *
   * An existing cursor is left alone. A restart that skipped its backlog
   * would drop real payments on the floor — this is for a FIRST start only,
   * and it is the same thing an operator wants when adding a chain whose
   * history they do not need.
   *
   * @returns the block seeded to, or null if a cursor already existed.
   */
  async seedCursorToHead(): Promise<bigint | null> {
    if (await this.readCursor()) return null;

    const head = await this.client.getBlockNumber();
    // Seed BELOW the safe head, so the first tick has a range to read rather
    // than an empty one — and so a transaction sent a moment ago is still
    // ahead of the cursor rather than behind it.
    const from = head > this.reorgDepth ? head - this.reorgDepth : 0n;
    const block = await this.client.getBlock({blockNumber: from});

    await this.writeCursor('TaskEscrow', from, block.hash);
    this.log.info(
      {chainId: this.deps.chain.chainId, block: from.toString()},
      'seeded the cursor at the head; history before this block is not indexed',
    );
    return from;
  }

  private async readCursor() {
    const {db, chain} = this.deps;
    return db.query.indexerCursor.findFirst({
      where: and(eq(indexerCursor.chainId, chain.chainId), eq(indexerCursor.contract, 'TaskEscrow')),
    });
  }

  private async writeCursor(contract: string, block: bigint, hash: string): Promise<void> {
    const {db, chain} = this.deps;
    await db
      .insert(indexerCursor)
      .values({
        chainId: chain.chainId,
        contract,
        lastBlock: Number(block),
        lastBlockHash: hash,
      })
      .onConflictDoUpdate({
        target: [indexerCursor.chainId, indexerCursor.contract],
        set: {lastBlock: Number(block), lastBlockHash: hash, updatedAt: new Date()},
      });
  }
}
