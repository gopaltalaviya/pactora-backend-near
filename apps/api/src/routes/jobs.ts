import type {FastifyInstance, FastifyRequest} from 'fastify';
import {and, asc, desc, eq, exists, gt, inArray, isNotNull, or} from 'drizzle-orm';
import {sha256Hex} from '@pactora/near';
import {z} from 'zod';
import {agents, agentStats, jobEvents, jobs, type Db} from '@pactora/db';
import {
  PactoraError,
  BaseUnits,
  ErrorCode,
  HireRequest,
  JobResult,
  type JobSpec,
  JobState,
  canonicalize,
  validateShape,
} from '@pactora/shared';
import type {ChainConfig} from '@pactora/config';
import {authenticate, resolveChainId, type Caller} from '../auth.js';
import {Cursor, page} from '../cursor.js';
import {lastEventIdOf, streamEventOf, streamEvents, type EventBus} from '../events.js';

/** Query for `GET /v1/jobs`. Coerced, because query strings are strings. */
export const JobListQuery = z.object({
  role: z.enum(['worker', 'client']).optional(),
  state: JobState.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** v3: the `nextCursor` of the previous page. */
  cursor: Cursor.optional(),
});

export interface JobRouteDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  defaultChainId: string;
  bus: EventBus;
  /** Submits a policy-checked transaction. Injected so tests need no signer. */
  submit: (args: {
    agentId: number;
    chainId: string;
    kind: 'createJob' | 'directPay' | 'accept' | 'submitResult' | 'approve' | 'dispute' | 'cancel';
    job?: {id: number; chainJobId: string | null};
    spend: bigint;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
    /** The caller's request id, carried to the signer. */
    traceId?: string;
  }) => Promise<{txHash: string; chainJobId?: string}>;
  /** v3: a job's dispute bond, read from the chain. Omitted or null: spend 0. */
  readDisputeBond?: (args: {chainId: string; chainJobId: bigint}) => Promise<bigint | null>;
}

export async function registerJobRoutes(app: FastifyInstance, deps: JobRouteDeps): Promise<void> {
  const {db, chains, bus, submit, readDisputeBond} = deps;
  const enabled = Object.keys(chains);

  /**
   * Hire an agent.
   *
   * Requires an Idempotency-Key. Agents retry — a dropped response, a timeout,
   * a restart — and a retried hire must never create a second job or a second
   * payment.
   */
  app.post('/v1/jobs', async (request, reply) => {
    const caller = await authenticate(db, request);
    const chainId = resolveChainId(request, caller, enabled);
    const chain = chains[chainId]!;

    const hireKey = requiredIdempotencyKey(request);

    const body = HireRequest.parse(request.body);
    return reply
      .status(201)
      .send(
        await hire(
          {db, bus, submit},
          {caller, chainId, chain, idempotencyKey: hireKey, traceId: request.id},
          body,
        ),
      );
  });

  /**
   * The caller's jobs.
   *
   * A worker has no other way to learn it was hired: the hire happens on the
   * client's side, and `/v1/jobs/:id/events` needs an id the worker does not
   * have yet. Without this a worker can only be told out of band, which is
   * not a marketplace.
   *
   * Polling rather than a push: a worker that drops its connection must still
   * pick the job up, and a missed offer expires on-chain into a refund the
   * client did not want.
   */
  app.get('/v1/jobs', async (request) => {
    const caller = await authenticate(db, request);
    const query = JobListQuery.parse(request.query ?? {});

    // Work is offered only once it is paid for (audit H2). The row is written
    // before the signer is asked, so a hire the signer refused — no funds, a
    // budget cap, a revert — left a row that looked exactly like owed work,
    // and a worker spent model time on it. Paid means a creation the API saw
    // the signer broadcast, or one the indexer saw on chain.
    const asWorker = and(
      eq(jobs.workerAgentId, caller.agentId),
      or(
        isNotNull(jobs.chainJobId),
        exists(
          db
            .select({id: jobEvents.id})
            .from(jobEvents)
            .where(and(eq(jobEvents.jobId, jobs.id), inArray(jobEvents.kind, PAID_EVENTS))),
        ),
      ),
    );
    const side =
      query.role === 'worker'
        ? asWorker
        : query.role === 'client'
          ? eq(jobs.clientAgentId, caller.agentId)
          : // Default to both: an orchestrator is a client AND is itself
            // hireable, and having to ask twice invites asking once.
            or(asWorker, eq(jobs.clientAgentId, caller.agentId));

    const fetched = await db
      .select()
      .from(jobs)
      .where(
        and(
          side,
          eq(jobs.chainId, caller.chainId),
          query.state ? eq(jobs.state, query.state) : undefined,
          // v3: oldest first, so the next page starts after the cursor.
          query.cursor !== undefined ? gt(jobs.id, query.cursor) : undefined,
        ),
      )
      // Oldest first: a worker should take the job closest to its accept
      // deadline, not the one that just arrived.
      .orderBy(asc(jobs.id))
      // One extra row says whether there is another page.
      .limit(query.limit + 1);
    const {rows, nextCursor} = page(fetched, query.limit);

    return {
      count: rows.length,
      nextCursor,
      jobs: rows.map((job) => {
        const chain = chains[job.chainId]!;
        return {
          jobId: job.publicId,
          chainJobId: job.chainJobId,
          chainId: job.chainId,
          state: job.state,
          path: job.path,
          amount: job.amount,
          amountDisplay: chain.formatToken(BigInt(job.amount)),
          spec: job.spec,
          specHash: job.specHash,
          /** Which side the caller is on, so an agent need not infer it. */
          role: job.workerAgentId === caller.agentId ? ('worker' as const) : ('client' as const),
          /**
           * Whether the work has been delivered.
           *
           * State is not enough to tell. A fast-path job is `settled` the
           * moment it is created — the client has already paid — but nobody
           * has done the work yet, so a worker polling for `created` never
           * saw it and the client waited for a result no one was producing.
           */
          hasResult: job.result !== null,
          clientAgentId: String(job.clientAgentId),
          workerAgentId: String(job.workerAgentId),
          createdAt: job.createdAt,
        };
      }),
    };
  });

  app.get('/v1/jobs/:id', async (request) => {
    const {job, chain} = await loadJob(request.params as {id: string});
    const events = await db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, job.id))
      .orderBy(asc(jobEvents.id));

    return {
      jobId: job.publicId,
      chainJobId: job.chainJobId,
      chainId: job.chainId,
      network: chain.name,
      state: job.state,
      path: job.path,
      amount: job.amount,
      amountDisplay: chain.formatToken(BigInt(job.amount)),
      fee: job.fee,
      spec: job.spec,
      specHash: job.specHash,
      result: job.result,
      resultHash: job.resultHash,
      createdAt: job.createdAt,
      settledAt: job.settledAt,
      events: events.map((e) => ({
        kind: e.kind,
        txHash: e.txHash,
        explorerUrl: e.txHash ? chain.explorerTx(e.txHash) : null,
        occurredAt: e.occurredAt,
      })),
      declined: declinedOf(events),
      dispute: disputeOf(events),
    };
  });

  /** Worker accepts. Only the assigned worker, only from `created`. */
  app.post('/v1/jobs/:id/accept', async (request) =>
    transition(request, 'accept', 'created', 'accepted', (job, caller) => {
      if (job.workerAgentId !== caller.agentId) {
        throw new PactoraError(ErrorCode.FORBIDDEN, 'only the assigned worker may accept');
      }
    }),
  );

  /**
   * Worker submits a result.
   *
   * Checked twice before anything is stored or signed: the envelope, then the
   * output against the spec's own `outputSchema`.
   *
   * The second check is the one that matters, and it is checked HERE rather
   * than left to the client. Without it a worker can deliver an object with
   * none of the fields the client asked for, the API stores it, an on-chain
   * `submitResult` is sent for it, and the client discovers the problem only
   * by paying gas to dispute — while the worker learns it failed via a
   * permanent reputation hit instead of a 422 it could have acted on. The
   * transaction is not sent, because this runs before the transition submits
   * anything (docs/04 §7.3).
   */
  app.post('/v1/jobs/:id/result', async (request) =>
    transition(request, 'submitResult', ['accepted', 'settled'], 'submitted', (job, caller, body) => {
      if (job.workerAgentId !== caller.agentId) {
        throw new PactoraError(ErrorCode.FORBIDDEN, 'only the assigned worker may submit a result');
      }
      // `settled` is open only to the fast path, where it means "paid up
      // front, still owed the work". On an escrow job it means the client
      // has already approved and released — accepting a result then would
      // let a worker replace the thing that was paid for after the fact.
      if (job.state === 'settled' && job.path !== 'direct') {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          'this job is settled — a result cannot be changed after the payment was released',
        );
      }
      const parsed = JobResult.safeParse(body);
      if (!parsed.success) {
        throw new PactoraError(
          ErrorCode.SCHEMA_MISMATCH,
          parsed.error.issues.map((i) => i.message).join('; '),
        );
      }

      const spec = job.spec as JobSpec;
      const shape = validateShape(parsed.data.output, spec.outputSchema);
      if (!shape.ok) {
        throw new PactoraError(
          ErrorCode.SCHEMA_MISMATCH,
          `${shape.reason} — the job asked for ${JSON.stringify(spec.outputSchema?.['required'] ?? [])}`,
        );
      }
    }),
  );

  app.post('/v1/jobs/:id/approve', async (request) =>
    transition(request, 'approve', 'submitted', 'settled', (job, caller) => {
      if (job.clientAgentId !== caller.agentId) {
        throw new PactoraError(ErrorCode.FORBIDDEN, 'only the client may approve');
      }
    }),
  );

  app.post('/v1/jobs/:id/dispute', async (request) =>
    transition(request, 'dispute', 'submitted', 'disputed', (job, caller) => {
      if (job.clientAgentId !== caller.agentId) {
        throw new PactoraError(ErrorCode.FORBIDDEN, 'only the client may dispute');
      }
    }),
  );

  /**
   * The hired worker turns the job down, and says why.
   *
   * Off-chain: no transaction, nothing to pay. The job stays `created` on
   * chain; the client, told at once instead of after its accept window,
   * cancels for a refund and hires someone else. Before this a decline was
   * silence, and a run waited 45 s to report "never accepted".
   */
  app.post('/v1/jobs/:id/decline', async (request) => {
    const caller = await authenticate(db, request);
    const {job} = await loadJob(request.params as {id: string});

    if (job.chainId !== caller.chainId) {
      throw new PactoraError(ErrorCode.CHAIN_MISMATCH, `job is on chain ${job.chainId}`);
    }
    if (job.workerAgentId !== caller.agentId) {
      throw new PactoraError(ErrorCode.FORBIDDEN, 'only the assigned worker may decline');
    }
    const parsed = DeclineBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, parsed.error.issues.map((i) => i.message).join('; '));
    }

    // Answered once. A second call returns the first answer rather than a
    // second event: a retried request must not read as two refusals.
    const events = await db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id));
    const already = declinedOf(events);
    if (already) return {jobId: job.publicId, declined: already};

    if (job.state !== 'created') {
      throw new PactoraError(ErrorCode.INVALID_STATE, `job is "${job.state}", a decline needs "created"`);
    }

    const declined = {reason: parsed.data.reason, at: new Date().toISOString()};
    await recordEvent(db, bus, job.id, job.chainId, 'job.declined', declined);
    return {jobId: job.publicId, declined};
  });

  app.post('/v1/jobs/:id/cancel', async (request) =>
    transition(request, 'cancel', 'created', 'refunded', (job, caller) => {
      if (job.clientAgentId !== caller.agentId) {
        throw new PactoraError(ErrorCode.FORBIDDEN, 'only the client may cancel');
      }
    }),
  );

  /** Live job feed. Replays history first so a late subscriber sees it all. */
  app.get('/v1/jobs/:id/events', async (request, reply) => {
    const {job} = await loadJob(request.params as {id: string});
    // v3: a reconnect resumes after the last event it saw.
    const after = lastEventIdOf(request);
    // The query runs inside streamEvents, after it has subscribed: see there.
    await streamEvents(reply, bus, job.id, async () => {
      const past = await db
        .select()
        .from(jobEvents)
        .where(
          after === null
            ? eq(jobEvents.jobId, job.id)
            : and(eq(jobEvents.jobId, job.id), gt(jobEvents.id, after)),
        )
        .orderBy(asc(jobEvents.id));
      return past.map(streamEventOf);
    });
    return reply;
  });

  // ── helpers ────────────────────────────────────────────────────────────

  async function loadJob(params: {id: string}) {
    // Public ids only. A serial id — or anything else — names no job: 404,
    // not a 500 from handing NaN to Postgres.
    const job = isPublicId(params.id)
      ? await db.query.jobs.findFirst({where: eq(jobs.publicId, params.id)})
      : undefined;
    if (!job) throw new PactoraError(ErrorCode.NOT_FOUND, `no job ${params.id}`);
    const chain = chains[job.chainId];
    if (!chain) throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${job.chainId} is not enabled`);
    return {job, chain};
  }

  /**
   * One implementation for every state change: authenticate, check the
   * transition is legal, submit on-chain, record, publish.
   *
   * The contract is the authority — this check exists so a caller gets a clear
   * error instead of a bare revert, not because the API is trusted.
   */
  async function transition(
    request: FastifyRequest,
    kind: 'accept' | 'submitResult' | 'approve' | 'dispute' | 'cancel',
    from: string | string[],
    to: string,
    check: (job: typeof jobs.$inferSelect, caller: Caller, body: unknown) => void,
  ) {
    const caller = await authenticate(db, request);
    const {job, chain} = await loadJob(request.params as {id: string});

    if (job.chainId !== caller.chainId) {
      throw new PactoraError(ErrorCode.CHAIN_MISMATCH, `job is on chain ${job.chainId}`);
    }
    const allowed = Array.isArray(from) ? from : [from];
    if (!allowed.includes(job.state)) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        `job is "${job.state}", this action needs ${allowed.map((s) => `"${s}"`).join(' or ')}`,
      );
    }

    // Every transition addresses the job by its ON-CHAIN id, which is assigned
    // when the contract runs and observed by the indexer a moment later.
    // Acting before then would encode id 0 and revert — so say plainly that
    // it is not ready yet, rather than emitting a doomed transaction.
    if (!job.chainJobId) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        'the job is not confirmed on-chain yet — retry in a moment',
        2,
      );
    }
    check(job, caller, request.body);

    // Never the caller's raw header, and never the serial (audit H1). The
    // signer replays a key as "already sent", so a key another caller could
    // guess or choose let them make this action look done when it was not.
    // Scoped to the caller, the action and the job, it names only this.
    const idempotencyKey = signerKey({
      agentId: caller.agentId,
      action: kind,
      jobId: job.publicId,
      clientKey: optionalIdempotencyKey(request) ?? `default:${job.state}`,
    });

    // Computed BEFORE the transaction, because the chain commits to it.
    //
    // `result` means the worker's OUTPUT everywhere it is read — the worker
    // checks its own output against the job's outputSchema, and so do the API
    // and the orchestrator. Storing the delivery envelope under the same name
    // made those checks disagree about what they were looking at: a perfectly
    // good delivery would be read as `{output, producedAt}`, fail the
    // required-field check, and be disputed.
    //
    // The hash covers the output alone for the same reason, and because
    // including `producedAt` would give the same content a different
    // commitment on every delivery.
    const delivered =
      kind === 'submitResult'
        ? ((request.body as {output: Record<string, unknown>}).output ?? {})
        : undefined;
    const resultHash = delivered ? await sha256Of(canonicalize(delivered)) : undefined;

    // A dispute commits to its REASON the same way: the chain gets the hash,
    // the job's record gets the words, and anyone can check one against the
    // other. Before this the encoder found no `reasonHash`, fell back to the
    // spec hash — so every dispute committed to what was ASKED FOR — and the
    // reason itself was stored nowhere. Required, like a decline's.
    const disputeReason = kind === 'dispute' ? DisputeBody.parse(request.body ?? {}).reason : undefined;
    const reasonHash =
      disputeReason !== undefined ? await sha256Of(canonicalize({reason: disputeReason})) : undefined;

    // A direct-pay job is already finished on chain.
    //
    // `directPay` transfers, records the feedback and returns in one
    // transaction; there is no later call to attach a result to, and the
    // contract would revert on one. So the delivery is recorded off-chain
    // against the payment that already happened — the client paid up front
    // and is entitled to the work, and the hash still lets them prove what
    // they were given.
    const offChainOnly = kind === 'submitResult' && job.path === 'direct';

    // The hire moves money, and since v3 so does a dispute: the client posts
    // the bond the job captured at creation, and the account's caps count it.
    // Declared here so the signer can refuse early with a 402 that says why,
    // instead of letting the call revert. Unreadable: 0, and the contract
    // still enforces the cap.
    const spend =
      kind === 'dispute' && readDisputeBond
        ? ((await readDisputeBond({chainId: job.chainId, chainJobId: BigInt(job.chainJobId)}).catch(
            () => null,
          )) ?? 0n)
        : 0n;

    const result = offChainOnly
      ? {txHash: null as string | null}
      : await submit({
          agentId: caller.agentId,
          chainId: job.chainId,
          kind,
          job: {id: job.id, chainJobId: job.chainJobId},
          spend,
          idempotencyKey,
          traceId: request.id,
          payload: {
            ...((request.body ?? {}) as Record<string, unknown>),
            // Without this the encoder falls back to the SPEC hash, so the chain
            // would commit to what was ASKED FOR rather than to what was
            // delivered — and T4's "the result hash is committed on-chain before
            // release" would not be true.
            ...(resultHash ? {resultHash} : {}),
            ...(reasonHash ? {reasonHash} : {}),
          },
        });

    // Advance the state optimistically, once the transaction is accepted for
    // broadcast.
    //
    // The indexer is authoritative and will rewrite this from the chain's own
    // events. But it trails the head by `confirmations`, and a worker that
    // accepts a job and immediately submits its result cannot be made to wait
    // several blocks for our database to catch up — it would get a 409 for
    // doing exactly the right thing.
    //
    // So: the API writes what it believes, the indexer corrects it, and if
    // they ever disagree the chain wins.
    // A settled job stays settled: recording its delivery must not walk the
    // state backwards to `submitted` and un-settle a completed payment.
    const patch: Record<string, unknown> = offChainOnly ? {} : {state: to};
    if (delivered && resultHash) {
      patch['result'] = delivered;
      patch['resultHash'] = resultHash;
    }
    if (to === 'settled') patch['settledAt'] = new Date();

    if (Object.keys(patch).length > 0) {
      await db.update(jobs).set(patch).where(eq(jobs.id, job.id));
    }

    const finalState = offChainOnly ? job.state : to;

    await recordEvent(db, bus, job.id, job.chainId, offChainOnly ? 'job.delivered' : `job.${to}`, {
      jobId: job.publicId,
      txHash: result.txHash,
      ...(disputeReason !== undefined ? {reason: disputeReason, reasonHash} : {}),
    });

    return {
      jobId: job.publicId,
      chainId: job.chainId,
      state: finalState,
      txHash: result.txHash,
      explorerUrl: result.txHash ? chain.explorerTx(result.txHash) : null,
    };
  }
}

/**
 * Off-chain event row plus a live publish.
 *
 * `txHash` is deliberately NULL here: these are API-side events. The indexer
 * writes the on-chain ones with their real hash and log index, and the unique
 * constraint keeps the two from colliding.
 */
/** A hire the client already made under this key, if any. */
/**
 * Hire an agent: the part of `POST /v1/jobs` after the caller is known.
 *
 * Exported because an x402 payment IS a hire — a fast-path one, bound to a
 * URL — and a second copy of this logic would be a second place for the
 * rules about idempotency, on-chain agent ids and the fast path to drift apart.
 */
export async function hire(
  deps: Pick<JobRouteDeps, 'db' | 'bus' | 'submit'>,
  ctx: {caller: Caller; chainId: string; chain: ChainConfig; idempotencyKey: string; traceId: string},
  body: z.infer<typeof HireRequest>,
): Promise<ReturnType<typeof receipt>> {
  const {db, bus, submit} = deps;
  const {caller, chainId, chain, idempotencyKey} = ctx;
  const hireKey = idempotencyKey;
  const workerAgentId = Number(body.workerAgentId);

  if (workerAgentId === caller.agentId) {
    throw new PactoraError(ErrorCode.INVALID_STATE, 'an agent cannot hire itself');
  }

  const worker = await db.query.agents.findFirst({
    where: and(eq(agents.id, workerAgentId), eq(agents.chainId, chainId)),
  });
  if (!worker) {
    throw new PactoraError(ErrorCode.AGENT_NOT_HIREABLE, `no agent ${workerAgentId} on chain ${chainId}`);
  }

  const clientRow = await db.query.agents.findFirst({where: eq(agents.id, caller.agentId)});

  // The contract addresses agents by its own agent id; the database uses
  // its own serial. Sending one where the other is expected targets a
  // different agent entirely — the transaction still succeeds, and pays
  // the wrong wallet. Refuse until both sides are known.
  if (!clientRow?.chainAgentId || !worker.chainAgentId) {
    throw new PactoraError(
      ErrorCode.AGENT_NOT_HIREABLE,
      'an agent has no on-chain agent id — register it on chain (register_agent) and link it',
      2,
    );
  }
  if (!worker.active) {
    throw new PactoraError(ErrorCode.AGENT_NOT_HIREABLE, `agent ${workerAgentId} is not accepting work`);
  }

  const price = BigInt(worker.pricePerTask);
  const maxPrice = BigInt(body.maxPrice);

  // The escrow refuses any job below its minimum (v2): said here, before a
  // transaction is paid for only to revert.
  const minJobAmount = BigInt(chain.params.minJobAmount ?? 0n);
  if (price < minJobAmount) {
    throw new PactoraError(
      ErrorCode.AGENT_NOT_HIREABLE,
      `agent ${workerAgentId} charges ${chain.formatToken(price)}, below the escrow minimum of ${chain.formatToken(minJobAmount)}`,
    );
  }
  if (price > maxPrice) {
    throw new PactoraError(
      ErrorCode.PRICE_ABOVE_MAX,
      `agent charges ${chain.formatToken(price)}, above your maxPrice of ${chain.formatToken(maxPrice)}`,
    );
  }

  // Fast path vs escrow, decided here and always reported back, so a caller
  // is never uncertain whether its money is protected.
  //
  // The fast path pays before any work is done and has no recourse, so it
  // is a bet on the worker as much as a saving on gas: cheap is not enough,
  // the worker must also have the record `fastPathMinScore` asks for. That
  // parameter was configured and documented and read by nothing, so every
  // cheap hire of an agent with no history paid up front. An explicit
  // `path: 'direct'` is still the client's own call to make.
  const fastPathMax = chain.params.fastPathMax;
  const fastPathMinScore = Number(chain.params.fastPathMinScore ?? 0);
  const workerStats = await db.query.agentStats.findFirst({where: eq(agentStats.agentId, worker.id)});
  const earnedFastPath = (workerStats?.score ?? 0) >= fastPathMinScore;
  const path =
    body.path === 'auto' ? (price <= fastPathMax && earnedFastPath ? 'direct' : 'escrow') : body.path;

  // Insert first so the job has an id, then commit to a hash that includes
  // it.
  //
  // The hash of a spec alone is NOT unique: two jobs asking the same
  // question produce the same hash, and the indexer — which links a job to
  // its on-chain event by this hash — would match an unrelated earlier
  // payment. Scoping the commitment to the job makes it identify THIS job,
  // which is what it was always meant to do. A client can still verify it:
  // sha256(canonicalJson + ':' + jobId), both of which are in the receipt.
  //
  // A retried hire — same client, same Idempotency-Key — is the SAME job.
  // It used to insert a new row every time: the signer rightly returned the
  // original transaction, so nothing was paid twice, but the retry answered
  // with a job id no transaction backed, and the worker was offered work
  // that had been paid for once.
  const prior = await findHire(db, caller.agentId, idempotencyKey);
  if (prior) {
    if (prior.workerAgentId !== workerAgentId || canonicalize(prior.spec) !== canonicalize(body.spec)) {
      // The serial is never shown: it is the one id that makes jobs countable.
      throw new PactoraError(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        `Idempotency-Key ${idempotencyKey} was already used for a different hire`,
      );
    }
    const txHash = await createdTxHash(db, prior.id);
    // Finished before: answer exactly as then. If it never got as far as a
    // transaction — the signer refused, or the wallet was out of gas — fall
    // through and submit again for the SAME row; the signer retries a
    // failed broadcast under the same key.
    if (txHash) return receipt(prior, chain, txHash);
  }

  const job = prior ?? (await insertHire());

  async function insertHire() {
    const [inserted] = await db
      .insert(jobs)
      .values({
        chainId,
        clientAgentId: caller.agentId,
        workerAgentId,
        path,
        amount: price.toString(),
        spec: body.spec,
        specHash: '',
        traceId: ctx.traceId,
        idempotencyKey: hireKey,
      })
      .returning();
    // The PUBLIC id — the one in the receipt — so the client can recompute it.
    const hashed = await sha256Of(`${canonicalize(body.spec)}:${inserted!.publicId}`);
    const [row] = await db.update(jobs).set({specHash: hashed}).where(eq(jobs.id, inserted!.id)).returning();
    return row!;
  }

  const specHash = job.specHash;
  const jobPath = job.path;
  const amount = BigInt(job.amount);

  const result = await submit({
    agentId: caller.agentId,
    chainId,
    kind: jobPath === 'direct' ? 'directPay' : 'createJob',
    job: {id: job.id, chainJobId: null},
    spend: amount,
    // The row's public id is fixed for every retry under the client's key,
    // so a retry reaches the signer under the same key and is replayed — even
    // one whose first attempt broadcast and then lost its answer.
    idempotencyKey: signerKey({
      agentId: caller.agentId,
      action: 'hire',
      jobId: job.publicId,
      clientKey: hireKey,
    }),
    traceId: ctx.traceId,
    payload: {
      // Contract agent ids, never the database's.
      clientChainAgentId: clientRow.chainAgentId,
      workerChainAgentId: worker.chainAgentId,
      amount: amount.toString(),
      specHash,
    },
  });

  // What the row says and what the response says must be the same thing.
  //
  // A direct-pay job is paid, settled and terminal on chain the moment it
  // is created — `directPay` transfers, records the feedback and returns.
  // The response said `settled` while the row stayed `created`, so the API
  // reported one state and enforced another: every subsequent check read
  // `created` and refused, including the worker's own delivery.
  const settledNow = jobPath === 'direct';
  const creationPatch: Record<string, unknown> = {
    ...(result.chainJobId ? {chainJobId: result.chainJobId} : {}),
    ...(settledNow ? {state: 'settled', settledAt: new Date()} : {}),
  };
  // An escrow hire whose chain id the indexer has not linked yet leaves
  // nothing to write here, and drizzle rejects an empty `set` with "No
  // values to set" — a 500 on the ordinary path.
  if (Object.keys(creationPatch).length > 0) {
    await db.update(jobs).set(creationPatch).where(eq(jobs.id, job.id));
  }

  await recordEvent(db, bus, job.id, chainId, 'job.created', {
    jobId: job.publicId,
    txHash: result.txHash,
  });

  return receipt({...job, chainJobId: result.chainJobId ?? job.chainJobId}, chain, result.txHash);
}

/** Job events that prove a creation was paid: the API's own, or the indexer's from the chain. */
const PAID_EVENTS = ['job.created', 'created', 'direct_paid'];

/** The signer's limit on a key (apps/signer SignBody), and the floor every spend has had. */
const KEY_MIN = 8;
const KEY_MAX = 200;

/** The caller's Idempotency-Key on a request that spends money: required, and bounded. */
export function requiredIdempotencyKey(request: FastifyRequest): string {
  const key = optionalIdempotencyKey(request);
  if (key === undefined || key.length < KEY_MIN) {
    throw new PactoraError(
      ErrorCode.IDEMPOTENCY_CONFLICT,
      'Idempotency-Key header is required on any request that spends money',
    );
  }
  return key;
}

/**
 * The caller's Idempotency-Key, if it sent one. Bounded here, before anything
 * is stored: one the API accepted and the signer's schema then refused left a
 * job row behind with nothing paid for it (audit H2).
 */
function optionalIdempotencyKey(request: FastifyRequest): string | undefined {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string') return undefined;
  if (key.length > KEY_MAX) {
    throw new PactoraError(
      ErrorCode.SCHEMA_MISMATCH,
      `Idempotency-Key is at most ${KEY_MAX} characters; this one is ${key.length}`,
    );
  }
  return key;
}

/**
 * The key the signer sees for one action: the caller, the action, the job's
 * public id and the caller's own key, hashed together. No two callers, jobs
 * or actions can share one, whatever header they send.
 */
export function signerKey(parts: {
  agentId: number;
  action: string;
  jobId: string;
  clientKey: string;
}): string {
  return sha256Hex(`pactora:sign:v1:${parts.agentId}:${parts.action}:${parts.jobId}:${parts.clientKey}`);
}

async function findHire(db: Db, clientAgentId: number, idempotencyKey: string) {
  return db.query.jobs.findFirst({
    where: and(eq(jobs.clientAgentId, clientAgentId), eq(jobs.idempotencyKey, idempotencyKey)),
  });
}

/** The transaction that created this job, once there was one. */
async function createdTxHash(db: Db, jobId: number): Promise<string | null> {
  const event = await db.query.jobEvents.findFirst({
    where: and(eq(jobEvents.jobId, jobId), eq(jobEvents.kind, 'job.created')),
  });
  const txHash = (event?.payload as {txHash?: string} | undefined)?.txHash;
  return txHash ?? null;
}

/** What a hire answers with — the same for the first request and every retry of it. */
function receipt(
  job: {publicId: string; chainJobId: string | null; path: string; amount: string; specHash: string},
  chain: ChainConfig,
  txHash: string,
) {
  const amount = BigInt(job.amount);
  return {
    jobId: job.publicId,
    chainJobId: job.chainJobId ?? null,
    chainId: chain.chainId,
    network: chain.name,
    state: job.path === 'direct' ? 'settled' : 'created',
    path: job.path,
    amount: job.amount,
    amountDisplay: chain.formatToken(amount),
    specHash: job.specHash,
    txHash,
    explorerUrl: chain.explorerTx(txHash),
  };
}

export const DisputeBody = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'a dispute needs a reason')
    .max(1000, 'a reason is at most 1000 characters'),
});

export const DeclineBody = z.object({
  reason: z.string().trim().min(1, 'a decline needs a reason').max(500, 'a reason is at most 500 characters'),
});

/** The worker's off-chain "no", if it gave one. */
function declinedOf(
  events: {kind: string; payload: unknown; occurredAt: Date | string}[],
): {reason: string; at: string} | null {
  const e = events.find((x) => x.kind === 'job.declined');
  if (!e) return null;
  const p = e.payload as {reason?: unknown; at?: unknown};
  return {
    reason: typeof p.reason === 'string' ? p.reason : 'no reason given',
    at: typeof p.at === 'string' ? p.at : new Date(e.occurredAt).toISOString(),
  };
}

/**
 * The client's dispute, as the arbiter needs it: the words, and the hash the
 * chain committed to, which anyone can recompute as
 * sha256(canonicalize({reason})). Null for a dispute made before the
 * reason was recorded, or none at all.
 */
function disputeOf(
  events: {kind: string; payload: unknown; occurredAt: Date | string}[],
): {reason: string; reasonHash: string; at: string} | null {
  const e = events.find((x) => x.kind === 'job.disputed');
  const p = (e?.payload ?? {}) as {reason?: unknown; reasonHash?: unknown};
  if (!e || typeof p.reason !== 'string' || typeof p.reasonHash !== 'string') return null;
  return {reason: p.reason, reasonHash: p.reasonHash, at: new Date(e.occurredAt).toISOString()};
}

async function recordEvent(
  db: Db,
  bus: EventBus,
  jobId: number,
  chainId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const [row] = await db
    .insert(jobEvents)
    .values({chainId, jobId, kind, payload})
    .onConflictDoNothing()
    .returning({id: jobEvents.id});
  bus.publish(jobId, {event: kind, data: payload, ...(row ? {id: row.id} : {})});
}

const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this a public id (a uuid)? Anything else names nothing. */
export function isPublicId(id: string): boolean {
  return PUBLIC_ID.test(id);
}

/** sha256, 64 lowercase hex: the hash form the contract accepts (`check_hash`). */
async function sha256Of(input: string): Promise<string> {
  return Promise.resolve(sha256Hex(input));
}

export {desc, agentStats, BaseUnits, z};
