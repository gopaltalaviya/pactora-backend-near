import {and, asc, eq, inArray, isNull, sql} from 'drizzle-orm';
import type {ChainConfig} from '@pactora/config';
import {eventsOf, type BlockRead, type BlockSource, type ChainEvent} from '@pactora/near';
import {
  type Db,
  OUTCOME_SUCCESS,
  REVOKED_WALLET_CHANGED,
  WORKER_FAULT,
  revokeSessionsOf,
  indexerCursor,
  indexerState,
  jobEvents,
  jobs,
  agents,
  agentStats,
  lockAgentEventSeqs,
  payments,
  reputationScoreSql,
  tokenTransfers,
} from '@pactora/db';
import {
  decodeFtTransfers,
  decodeFunded,
  decodePactoraEvent,
  decodeWalletChange,
  type DecodedJobEvent,
} from './events.js';

/**
 * NEAR final blocks → Postgres, one worker per enabled chain
 * (docs/NEAR-WIRE.md §7).
 *
 * Three properties this is built around:
 *
 * 1. **Final blocks only, read in order.** Each tick reads the blocks after
 *    the cursor up to the newest FINAL block. Final blocks do not reorg, so
 *    there is no rewind: every block must name the previous one as its
 *    parent, and a block that does not is a wrong source or a bug — the
 *    indexer halts there (`ChainLinkError`) rather than index on top of it.
 *
 * 2. **One transaction per batch.** A batch's events, their effects on the
 *    projection and the cursor that moves past them commit together, so a
 *    crash anywhere replays the whole batch, and nothing of it is half-applied.
 *
 * 3. **Re-runnable.** Every write is idempotent, guaranteed by unique keys
 *    rather than application care: job_events on (chain_id, receipt_id,
 *    log_index), token_transfers likewise, payments on (chain_id, tx_hash,
 *    job_id). A replayed batch adds nothing, and an event's effects run only
 *    when its row is new.
 *
 * It only ever writes what the chain said. It never invents state, which is
 * why the UI can never show a payment that did not happen.
 */

/**
 * Blocks read per tick, at most. neardata serves one block per request, so a
 * tick is this many HTTP reads (FETCH_CONCURRENCY at a time) and one
 * transaction. 50 blocks is ~30 s of testnet (≈0.6 s a block), so a worker
 * polling every 2 s catches up from a backlog about ten times faster than the
 * chain grows, while a tick stays short enough that a failure retries little.
 */
export const MAX_BLOCKS_PER_TICK = 50;
/**
 * A sparse source's range per tick: a few API calls whatever its width, so a
 * backlog clears quickly (testnet makes ~100 blocks a minute).
 */
export const MAX_BLOCKS_PER_SPARSE_TICK = 600;

/** Block reads in flight at once. Polite to a public endpoint; the order of processing is unaffected. */
const FETCH_CONCURRENCY = 5;

/** `indexer_cursor.contract`: one cursor per chain, for everything this worker reads. */
export const CURSOR_CONTRACT = 'Pactora';

/** What an indexer stuck on a pruned start block reports (`/health`, `/v1/status`). */
export const STALLED_START_PRUNED = 'stalled: start block pruned';
export const START_PRUNED_FIX =
  'set INDEXER_START_AT_HEAD=1 (a first start begins at the head) or use an archival RPC';

/**
 * The start block is older than anything the RPC keeps (a non-archival node
 * keeps a few epochs). Retrying cannot help: the indexer used to read the
 * pruned heights as empty, or fail on them, forever. Only the operator can
 * fix it, so it says how, once, and waits.
 */
export class StartBlockPrunedError extends Error {
  override name = 'StartBlockPrunedError';
  readonly state = STALLED_START_PRUNED;
  readonly fix = START_PRUNED_FIX;
  /** The loop waits its longest backoff between attempts: no tight loop. */
  readonly stalled = true;
  constructor(
    readonly chainId: string,
    readonly startBlock: number,
    readonly earliest: number | null,
  ) {
    super(
      `chain ${chainId}: start block ${startBlock} has been garbage collected by the RPC` +
        `${earliest !== null ? ` (its earliest block is ${earliest})` : ''}; ${START_PRUNED_FIX}`,
    );
  }
}

const PRUNED = /garbage.collected|BlockPrunedError/i;

/** A block that does not follow the last one read. The indexer does not move past it. */
export class ChainLinkError extends Error {
  override name = 'ChainLinkError';
}

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
  /** Where final blocks come from: neardata on testnet/mainnet, RPC polling on the sandbox. */
  source: BlockSource;
  logger?: {info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void};
}

type JobState = 'created' | 'accepted' | 'submitted' | 'disputed' | 'settled' | 'refunded';

/**
 * The states a job may be in for an event to move it to each state: any
 * earlier one, or the same one — the API often writes a state first, and the
 * event must still land its chain facts (the fee, the result hash). The
 * lifecycle only goes one way — created → accepted → submitted → disputed →
 * settled or refunded — with every step skippable (a direct_pay is created
 * and settled at once; an unaccepted offer is refunded).
 */
const AT_OR_BEFORE: Record<Exclude<JobState, 'created'>, JobState[]> = {
  accepted: ['created', 'accepted'],
  submitted: ['created', 'accepted', 'submitted'],
  disputed: ['created', 'accepted', 'submitted', 'disputed'],
  settled: ['created', 'accepted', 'submitted', 'disputed', 'settled'],
  refunded: ['created', 'accepted', 'submitted', 'disputed', 'refunded'],
};

const STATE_OF: Record<string, Exclude<JobState, 'created'>> = {
  accepted: 'accepted',
  submitted: 'submitted',
  disputed: 'disputed',
  settled: 'settled',
  refunded: 'refunded',
};

/** The kinds whose event names the spec hash and both parties — the ones that can link a job row. */
const LINKING_KINDS = new Set(['created', 'direct_paid']);

/** ft_transfer entries per log line that `256 × line + entry` can number without colliding. */
const ENTRIES_PER_LINE = 256;

export class Indexer {
  private readonly log: NonNullable<IndexerDeps['logger']>;
  private readonly pactora: ReadonlySet<string>;
  private readonly token: ReadonlySet<string>;

  /** The last final height read and the block indexed up to — see `progress()`. */
  private lastHead: number | null = null;
  private lastIndexed: number | null = null;

  constructor(private readonly deps: IndexerDeps) {
    this.log = deps.logger ?? {info: () => {}, warn: () => {}};
    this.pactora = new Set([deps.chain.contracts.Pactora]);
    this.token = new Set([deps.chain.contracts.PaymentToken]);
  }

  /**
   * How far the last tick got: the final height it read and the block it has
   * indexed up to. Their difference is the lag an operator alerts on — a
   * tick can succeed every time while falling further behind a backlog.
   */
  progress(): {headBlock: number | null; indexedBlock: number | null} {
    return {headBlock: this.lastHead, indexedBlock: this.lastIndexed};
  }

  /** Process one batch. Returns the height it has indexed up to. */
  async tick(): Promise<number> {
    let to: number;
    try {
      to = await this.step();
    } catch (err) {
      if (err instanceof StartBlockPrunedError) await this.writeState(err.state, err.fix);
      throw err;
    }
    this.lastIndexed = to;
    // A stall recorded by this process or an earlier one ends with a good tick.
    if (!this.stateClear) {
      await this.deps.db.delete(indexerState).where(eq(indexerState.chainId, this.deps.chain.chainId));
      this.stateClear = true;
    }
    return to;
  }

  /** False until a good tick has cleared any recorded stall. */
  private stateClear = false;

  private async writeState(state: string, fix: string): Promise<void> {
    const {db, chain} = this.deps;
    await db
      .insert(indexerState)
      .values({chainId: chain.chainId, state, fix})
      .onConflictDoUpdate({target: indexerState.chainId, set: {state, fix, updatedAt: new Date()}});
    this.stateClear = false;
  }

  private async step(): Promise<number> {
    const {chain, source} = this.deps;
    const final = await source.finalHeight();
    this.lastHead = final;

    const cursor = await this.readCursor();
    const from = cursor ? cursor.lastBlock + 1 : chain.startBlock;
    if (!cursor && source.earliestHeight) {
      // A first start: is the start block still on the node at all?
      const earliest = await source.earliestHeight();
      if (earliest !== null && chain.startBlock < earliest) {
        throw new StartBlockPrunedError(chain.chainId, chain.startBlock, earliest);
      }
    }
    if (from > final) return from - 1;

    // A sparse source (`accounts`) answers for a whole range with only the
    // blocks our receipts executed in, so a tick can take a much wider range
    // for the same few calls; it has no per-block chain to check (see
    // `accountsSource`: completeness comes from its head bound instead).
    if (source.blocksIn) {
      const to = Math.min(final, from + MAX_BLOCKS_PER_SPARSE_TICK - 1);
      const sparse = await source.blocksIn(from, to);
      for (const b of sparse) {
        if (b.height < from || b.height > to) {
          throw new ChainLinkError(
            `chain ${chain.chainId}: asked the ${source.kind} source for ${from}..${to}, got block ${b.height}`,
          );
        }
      }
      const lastHash = sparse.at(-1)?.hash ?? cursor?.lastBlockHash ?? '';
      return this.apply(sparse, to, lastHash, from);
    }

    const to = Math.min(final, from + MAX_BLOCKS_PER_TICK - 1);

    const blocks = await this.readBlocks(from, to).catch((err: unknown) => {
      // The node answered "garbage collected" for the start block itself.
      if (!cursor && PRUNED.test(`${(err as Error)?.name} ${(err as Error)?.message}`)) {
        throw new StartBlockPrunedError(
          chain.chainId,
          chain.startBlock,
          (err as {earliest?: number}).earliest ?? null,
        );
      }
      throw err;
    });

    // Every block must follow the one before it, the first one the cursor's.
    // Checked for the whole batch before anything is written. A height with
    // no block (null) is skipped; the next block's parent is then the last
    // real one, which is the hash the cursor keeps — so a source that wrongly
    // reports a height empty is caught here too. '' is "no hash yet": a
    // first batch, before any real block has been seen.
    let parent = cursor?.lastBlockHash ?? '';
    let parentHeight = cursor ? cursor.lastBlock : from - 1;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!;
      const height = from + i;
      if (b === null) continue;
      if (b.height !== height) {
        throw new ChainLinkError(
          `chain ${chain.chainId}: asked the ${source.kind} source for block height ${height}, got ${b.height}`,
        );
      }
      if (parent !== '' && b.prevHash !== parent) {
        throw new ChainLinkError(
          `chain ${chain.chainId}: block ${height} (${b.hash}) has prev_hash ${b.prevHash}, but the last block ` +
            `read, at or before ${parentHeight}, was ${parent}. Final blocks do not reorg: this is a wrong ` +
            `${source.kind} source or a bug. Halting here; nothing past block ${parentHeight} is indexed.`,
        );
      }
      parent = b.hash;
      parentHeight = height;
    }

    const real = blocks.filter((b): b is BlockRead => b !== null);
    return this.apply(real, to, parent, from);
  }

  /** Decode and write one batch's events, and move the cursor to `to`, in one transaction. */
  private async apply(real: BlockRead[], to: number, parent: string, from: number): Promise<number> {
    const {chain} = this.deps;
    const protocol = real.flatMap((b) => eventsOf(b.receipts, b, this.pactora));
    const token = real.flatMap((b) => eventsOf(b.receipts, b, this.token));
    // Decoded before the transaction, so an event this code cannot read
    // fails the tick without opening one.
    const decoded = protocol
      .map((ev) => ({ev, d: decodePactoraEvent(ev)}))
      .filter((x): x is {ev: ChainEvent; d: DecodedJobEvent} => x.d !== null);

    await this.deps.db.transaction(async (tx) => {
      // Every party's event counter, locked in agent-id order before the
      // first event is written: in event order, the batch deadlocked with
      // the API's own event writes (pnpm swarm:local, 2026-11-09).
      if (decoded.length > 0)
        await this.lockParties(
          tx,
          decoded.map((x) => x.d),
        );
      for (const {ev, d} of decoded) await this.handleEvent(tx, ev, d);
      await this.recordTransfers(tx, token);
      await this.recordFunding(tx, protocol);
      await this.endSessionsOnWalletChange(tx, protocol);
      await this.writeCursor(tx, to, parent);
    });

    if (decoded.length > 0) {
      this.log.info({chainId: chain.chainId, from, to, events: decoded.length}, 'indexed');
    }
    return to;
  }

  /** Blocks `from..to` in height order, FETCH_CONCURRENCY reads at a time. */
  private async readBlocks(from: number, to: number): Promise<(BlockRead | null)[]> {
    const n = to - from + 1;
    const out = new Array<BlockRead | null>(n);
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < n) {
        const i = next++;
        try {
          out[i] = await this.deps.source.blockAt(from + i);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(FETCH_CONCURRENCY, n)}, worker));
    return out;
  }

  /**
   * Payment-token transfers that touch a known agent's wallet or owner, into
   * `token_transfers` — what the trust check reads to tell a client the
   * worker's side funded from one that paid with its own money.
   *
   * Kept when EITHER side is known: a rater wallet funded before it
   * registered is still caught, because the worker's side was known. One
   * log line can list several transfers, so `log_index` is 256 × the log
   * line + the entry (packages/db schema). Idempotent on (chain, receipt,
   * log_index), so a replay adds nothing.
   */
  private async recordTransfers(tx: Tx, events: ChainEvent[]): Promise<void> {
    const {chain} = this.deps;
    const transfers = events.flatMap((ev) =>
      decodeFtTransfers(ev).map((t) => {
        if (t.entry >= ENTRIES_PER_LINE) {
          // Numbering it would collide with the next line's first entry and
          // drop one of the two on the unique key.
          throw new Error(
            `chain ${chain.chainId}: ft_transfer in receipt ${ev.receiptId} log ${ev.logIndex} lists more than ` +
              `${ENTRIES_PER_LINE} transfers; log_index cannot number them`,
          );
        }
        return {ev, t};
      }),
    );
    if (transfers.length === 0) return;

    const known = new Set<string>();
    const rows = (await tx.execute(
      sql`SELECT wallet_address AS w, owner_address AS o FROM agents WHERE chain_id = ${chain.chainId}`,
    )) as unknown as {w: string; o: string}[];
    for (const r of rows) {
      known.add(r.w);
      known.add(r.o);
    }

    const keep = transfers.filter(({t}) => known.has(t.from) || known.has(t.to));
    if (keep.length === 0) return;

    await tx
      .insert(tokenTransfers)
      .values(
        keep.map(({ev, t}) => ({
          chainId: chain.chainId,
          blockNumber: ev.blockHeight,
          txHash: ev.txHash,
          receiptId: ev.receiptId,
          logIndex: ev.logIndex * ENTRIES_PER_LINE + t.entry,
          fromAddress: t.from,
          toAddress: t.to,
          amount: t.amount,
        })),
      )
      .onConflictDoNothing();
  }

  /**
   * Deposits into an agent's balance, as transfers to that agent's wallet.
   *
   * On NEAR the money an agent spends sits in its balance inside the Pactora
   * contract, so the worker's owner topping up a client sends ft_transfer_call
   * to Pactora: the token's own event names Pactora, never the client. The
   * contract's `funded` event names the agent, and without this the
   * self-funding check could not see the one funding pattern it exists for.
   * Kept only for agents this indexer knows (the attribution needs the
   * wallet). Keyed by the Pactora receipt, which no token event shares.
   */
  /**
   * A wallet proposed or accepted for an agent ends the person sessions of
   * its owner and of the wallets involved (migration 0025): the account's
   * signing arrangement changed on chain, so what it signed in with may no
   * longer be in its hands. Idempotent: a replayed batch finds no live
   * session to end.
   */
  private async endSessionsOnWalletChange(tx: Tx, events: ChainEvent[]): Promise<void> {
    const {chain} = this.deps;
    const changes = events.flatMap((ev) => decodeWalletChange(ev) ?? []);
    if (changes.length === 0) return;
    for (const c of changes) {
      // A first wallet (wallet_accepted with no previous one) changes no
      // hands: a person joining accepts their own account as the wallet, and
      // must keep the session they joined with.
      if (c.event === 'wallet_accepted' && !c.hadPrevious) continue;
      const rows = (await tx.execute(
        sql`SELECT owner_address AS o, wallet_address AS w FROM agents
            WHERE chain_id = ${chain.chainId} AND chain_agent_id = ${String(c.agentId)}`,
      )) as unknown as {o: string; w: string}[];
      const accounts = [...c.wallets, ...rows.flatMap((r) => [r.o, r.w])];
      const n = await revokeSessionsOf(tx, accounts, REVOKED_WALLET_CHANGED);
      if (n > 0) {
        this.log.info(
          {chainId: chain.chainId, agentId: c.agentId, event: c.event, sessions: n},
          'sessions ended: wallet changed',
        );
      }
    }
  }

  private async recordFunding(tx: Tx, events: ChainEvent[]): Promise<void> {
    const {chain} = this.deps;
    const funded = events.flatMap((ev) => {
      const f = decodeFunded(ev);
      return f ? [{ev, f}] : [];
    });
    if (funded.length === 0) return;

    const rows = (await tx.execute(
      sql`SELECT chain_agent_id::text AS id, wallet_address AS w FROM agents
          WHERE chain_id = ${chain.chainId} AND chain_agent_id IS NOT NULL`,
    )) as unknown as {id: string; w: string}[];
    const walletOf = new Map(rows.map((r) => [r.id, r.w]));

    // Every deposit keeps the agent it was for. One not linked yet (funded
    // straight after register_agent, before the API knows it) has no wallet
    // to name: it is recorded as what it was — a transfer into the Pactora
    // contract for that agent. Dropping it would let a farmer fund its client
    // first and link it afterwards, unseen.
    const keep = funded.map(({ev, f}) => ({
      ev,
      f,
      to: walletOf.get(String(f.agentId)) ?? chain.contracts.Pactora,
    }));

    await tx
      .insert(tokenTransfers)
      .values(
        keep.map(({ev, f, to}) => ({
          chainId: chain.chainId,
          blockNumber: ev.blockHeight,
          txHash: ev.txHash,
          receiptId: ev.receiptId,
          logIndex: ev.logIndex * ENTRIES_PER_LINE,
          fromAddress: f.from,
          toAddress: to,
          toChainAgentId: f.agentId,
          amount: f.amount,
        })),
      )
      .onConflictDoNothing();
  }

  private async handleEvent(tx: Tx, ev: ChainEvent, decoded: DecodedJobEvent): Promise<void> {
    const {chain} = this.deps;
    const {kind, chainJobId, payload} = decoded;

    let job = await tx.query.jobs.findFirst({
      where: and(eq(jobs.chainId, chain.chainId), eq(jobs.chainJobId, chainJobId)),
    });

    // No chain_job_id yet.
    //
    // The API cannot know it in advance: the contract assigns it when the
    // call runs. So the first event a job emits carries its spec hash and
    // both parties, and that is what links the two. Matching on the hash of
    // the work — rather than on an id neither side knew — is self-healing: it
    // works whichever of the two writes landed first.
    if (!job && LINKING_KINDS.has(kind)) job = await this.linkBySpecHash(tx, chainJobId, payload);

    // A job the API did not create — someone called the contract directly.
    // The chain is the source of truth, so this is expected, not an error.
    if (!job) {
      this.log.warn({chainId: chain.chainId, chainJobId, kind}, 'event for a job this API did not create');
      return;
    }

    // The insert's own uniqueness decides whether the effects run: an event
    // already recorded has its effects in the projection already. This is
    // what keeps a replay from crediting the worker twice — the reputation
    // bump is `completed + 1`.
    const [recorded] = await tx
      .insert(jobEvents)
      .values({
        chainId: chain.chainId,
        jobId: job.id,
        kind,
        payload,
        txHash: ev.txHash,
        receiptId: ev.receiptId,
        blockNumber: ev.blockHeight,
        logIndex: ev.logIndex,
      })
      .onConflictDoNothing()
      .returning({id: jobEvents.id});
    if (!recorded) return;

    await this.applyStateChange(tx, job.id, kind, payload, ev);
  }

  /**
   * The job row this job_created / direct_paid belongs to: same spec hash, no
   * chain id yet, and the same two parties.
   *
   * The hash alone is not enough. A spec can repeat — the same work hired
   * twice, a database rebuilt, two deployments sharing a chain — and a
   * live run once linked an unaccepted escrow job to an OLD fast-path
   * payment, called it settled, and credited the worker. The event names
   * both parties by contract agent id; they must be this row's.
   */
  private async linkBySpecHash(tx: Tx, chainJobId: string, payload: Record<string, unknown>) {
    const {chain} = this.deps;
    const specHash = payload['specHash'];
    const client = payload['clientAgentId'];
    const worker = payload['workerAgentId'];
    if (typeof specHash !== 'string' || typeof client !== 'string' || typeof worker !== 'string') {
      return undefined;
    }
    const candidates = await tx.query.jobs.findMany({
      where: and(eq(jobs.chainId, chain.chainId), eq(jobs.specHash, specHash), isNull(jobs.chainJobId)),
      orderBy: [asc(jobs.id)],
    });
    for (const candidate of candidates) {
      if (await this.samePartiesAs(tx, candidate, client, worker)) {
        await tx.update(jobs).set({chainJobId}).where(eq(jobs.id, candidate.id));
        this.log.info({jobId: candidate.id, chainJobId}, 'linked job to its on-chain id');
        return {...candidate, chainJobId};
      }
    }
    if (candidates.length > 0) {
      this.log.warn(
        {jobIds: candidates.map((c) => c.id), chainJobId, specHash},
        'spec hash matched a job between different agents — not linked',
      );
    }
    return undefined;
  }

  /** Whether the event's client and worker (contract agent ids) are this job row's. */
  private async samePartiesAs(
    tx: Tx,
    job: {clientAgentId: number; workerAgentId: number},
    client: string,
    worker: string,
  ): Promise<boolean> {
    const [c, w] = await Promise.all([
      tx.query.agents.findFirst({where: eq(agents.id, job.clientAgentId)}),
      tx.query.agents.findFirst({where: eq(agents.id, job.workerAgentId)}),
    ]);
    return c?.chainAgentId === client && w?.chainAgentId === worker;
  }

  /** Project the event onto the job row and the reputation counters. */
  private async applyStateChange(
    tx: Tx,
    jobId: number,
    kind: string,
    payload: Record<string, unknown>,
    ev: ChainEvent,
  ): Promise<void> {
    const blockTime = new Date(ev.blockTimestamp * 1000);
    const next = STATE_OF[kind];

    // The chain's result hash against the delivery the API stored (docs/26
    // gap 2). A different one is never written over ours: the job is
    // flagged, the API refuses to approve it, and a dispute is the way out.
    let resultPatch: {resultHash?: string} = {};
    if (kind === 'submitted') {
      const onChain = payload['resultHash'] as string;
      const stored = await tx.query.jobs.findFirst({where: eq(jobs.id, jobId)});
      if (stored?.resultHash && stored.resultHash !== onChain) {
        // Whatever state the job has reached: the flag is about what was paid for.
        await tx.update(jobs).set({resultMismatch: true}).where(eq(jobs.id, jobId));
        this.log.warn(
          {jobId, stored: stored.resultHash, onChain, txHash: ev.txHash},
          'result hash on chain differs from the stored delivery — flagged result_mismatch',
        );
      } else {
        resultPatch = {resultHash: onChain};
      }
    }
    if (next) {
      // Forward only. The API advances a job when its transaction is
      // broadcast, and this indexer reads final blocks, so it routinely
      // reaches an event older than the state already written. Projecting
      // that walked the job backwards: a delivered job read "accepted" again
      // and the client's approve was refused.
      await tx
        .update(jobs)
        .set({
          state: next,
          // The block's time: a backfill must not date a payment by when it was indexed.
          ...(next === 'settled' ? {settledAt: blockTime, fee: payload['fee'] as string} : {}),
          ...resultPatch,
        })
        .where(and(eq(jobs.id, jobId), inArray(jobs.state, AT_OR_BEFORE[next])));
    }

    // ONLY on 'settled'. direct_pay emits direct_paid *and* job_settled for
    // the same job, so counting both double-credits every fast-path payment.
    // job_settled is emitted on both paths, so it alone is complete as well
    // as correct.
    if (kind === 'settled') {
      const job = await tx.query.jobs.findFirst({where: eq(jobs.id, jobId)});
      if (!job) return;
      const fee = payload['fee'] as string;
      // What the chain moved: the worker's pay plus the protocol fee.
      const amount = (BigInt(payload['paid'] as string) + BigInt(fee)).toString();

      await tx
        .insert(payments)
        .values({
          chainId: job.chainId,
          jobId: job.id,
          fromAgentId: job.clientAgentId,
          toAgentId: job.workerAgentId,
          amount,
          fee,
          txHash: ev.txHash,
          blockNumber: ev.blockHeight,
          confirmedAt: blockTime,
        })
        .onConflictDoNothing();

      // An UNRESOLVED settlement — a dispute that timed out — pays the worker
      // but earns nothing: the contract writes no review for it, and the
      // projection must not credit what the chain did not. Money moved, so
      // the payment row above still stands.
      if (payload['outcome'] === OUTCOME_SUCCESS) {
        await this.bumpReputation(tx, job.workerAgentId, true, amount);
      }
    }

    // Only what the contract itself records as the worker's failure:
    // accepted and never delivered, or a dispute the worker lost. A client
    // cancelling, or an offer nobody accepted, is not the worker's fault.
    if (kind === 'refunded' && WORKER_FAULT.has(payload['reason'] as string)) {
      const job = await tx.query.jobs.findFirst({where: eq(jobs.id, jobId)});
      if (job) await this.bumpReputation(tx, job.workerAgentId, false, '0');
    }
  }

  /**
   * Score mirrors the on-chain formula in docs/04 §2.3: Laplace-smoothed and
   * volume-damped, so a fresh agent is 50 (unknown) rather than 0 or 100, and
   * one lucky job cannot outrank a proven record.
   */
  private async bumpReputation(tx: Tx, agentId: number, success: boolean, amount: string): Promise<void> {
    await tx
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
    // worth more to fake. The formula is shared with discovery's per-skill
    // scores (@pactora/db).
    const floor = this.deps.chain.params.confidenceFloor;
    await tx.execute(sql`
      UPDATE agent_stats SET score = ${reputationScoreSql(sql`completed`, sql`failed`, floor)}
      WHERE agent_id = ${agentId}
    `);
  }

  /**
   * Start at the newest final block, not at the deployment block.
   *
   * With no cursor `tick()` begins at `startBlock` and backfills every block
   * since. That is right for production — the history IS the record — and
   * wrong for a new deployment whose database holds none of that history, or
   * a demo that needs to see a transaction it just sent. A transaction sent
   * a moment ago is not final yet, so it is still ahead of this cursor.
   *
   * An existing cursor is left alone. A restart that skipped its backlog
   * would drop real payments on the floor — this is for a FIRST start only.
   *
   * @returns the height seeded to, or null if a cursor already existed.
   */
  async seedCursorToHead(): Promise<number | null> {
    if (await this.readCursor()) return null;
    const final = await this.deps.source.finalHeight();
    const block = await this.deps.source.blockAt(final);
    if (!block) throw new Error(`chain ${this.deps.chain.chainId}: final block ${final} is missing`);
    await this.writeCursor(this.deps.db, final, block.hash);
    this.log.info(
      {chainId: this.deps.chain.chainId, block: final},
      'seeded the cursor at the final head; history before this block is not indexed',
    );
    return final;
  }

  /** The agents these events will write feed rows for: the jobs' parties, and a linking event's named ones. */
  private async lockParties(tx: Tx, events: DecodedJobEvent[]): Promise<void> {
    const {chain} = this.deps;
    const arr = (xs: string[]) =>
      sql`ARRAY[${sql.join(
        xs.map((x) => sql`${x}`),
        sql`, `,
      )}]::text[]`;
    const jobIds = [...new Set(events.map((e) => e.chainJobId))];
    const named = [
      ...new Set(
        events
          .filter((e) => LINKING_KINDS.has(e.kind))
          .flatMap((e) => [e.payload['clientAgentId'], e.payload['workerAgentId']])
          .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
          .map(String),
      ),
    ];
    const rows = (await tx.execute(sql`
      SELECT p.id FROM jobs j CROSS JOIN LATERAL (VALUES (j.client_agent_id), (j.worker_agent_id)) AS p(id)
       WHERE j.chain_id = ${chain.chainId} AND j.chain_job_id::text = ANY(${arr(jobIds)})
      UNION
      SELECT a.id FROM agents a WHERE a.chain_id = ${chain.chainId} AND a.chain_agent_id::text = ANY(${arr(named)})`)) as unknown as {
      id: string | number;
    }[];
    await lockAgentEventSeqs(
      tx,
      rows.map((r) => Number(r.id)),
    );
  }

  private async readCursor() {
    const {db, chain} = this.deps;
    return db.query.indexerCursor.findFirst({
      where: and(eq(indexerCursor.chainId, chain.chainId), eq(indexerCursor.contract, CURSOR_CONTRACT)),
    });
  }

  /**
   * `last_block` is the last height read; `last_block_hash` the hash of the
   * last block that existed at or before it — the parent the next block must
   * name. After skipped heights the two refer to different heights, on purpose.
   */
  private async writeCursor(tx: Tx, block: number, hash: string): Promise<void> {
    const {chain} = this.deps;
    await tx
      .insert(indexerCursor)
      .values({chainId: chain.chainId, contract: CURSOR_CONTRACT, lastBlock: block, lastBlockHash: hash})
      .onConflictDoUpdate({
        target: [indexerCursor.chainId, indexerCursor.contract],
        set: {lastBlock: block, lastBlockHash: hash, updatedAt: new Date()},
      });
  }
}
