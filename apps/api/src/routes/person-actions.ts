import type {FastifyInstance} from 'fastify';
import {and, desc, eq, inArray, isNull} from 'drizzle-orm';
import {z} from 'zod';
import {sha256Hex} from '@pactora/near';
import {agents, applications, jobs, listings, personActions, type Db} from '@pactora/db';
import {ErrorCode, JobResult, type JobSpec, PactoraError, canonicalize, validateShape} from '@pactora/shared';
import type {ChainConfig} from '@pactora/config';
import {authenticatePerson} from '../auth.js';
import {personAgentOf, type AgentRow} from '../actor.js';
import {requireClear} from '../compliance.js';
import type {TxEventsReader, JobTxEvent, JobTxEventName} from '../chain-reads.js';
import type {EventBus} from '../events.js';
import {contractCall} from '../submit.js';
import {acceptedDraftOf, draftDeliveryOf, settleAcceptedDraft, type SettleOutcome} from '../evidence.js';
import {DisputeBody, isPublicId, recordEvent, refuseMismatched, type JobRouteDeps} from './jobs.js';

/**
 * People act on jobs by signing in their own wallet (docs/26 "prepare →
 * sign → confirm").
 *
 * 1. `prepare` checks what the API would check for an agent — the party,
 *    the state, a delivery against the spec's outputSchema, a mismatched
 *    result — writes any off-chain half first (the delivery and its hash,
 *    a dispute's reason), and answers the exact FunctionCall to sign.
 * 2. The browser signs and sends it (`signAndSendTransactions`).
 * 3. `confirm` reads the transaction from the chain and moves the job only
 *    if the expected Pactora event for THIS job, from THIS person's agent,
 *    is in a successful receipt of the Pactora contract. Replaying the same
 *    hash answers the first result.
 *
 * The contract is the authority either way: it checks the wallet
 * (`only_wallet_of`) and the state itself. The indexer sees the same events
 * and agrees, whichever writes first.
 */

export const PERSON_ACTIONS = ['create', 'accept', 'submit', 'approve', 'dispute', 'cancel'] as const;
export type PersonAction = (typeof PERSON_ACTIONS)[number];

/** What `prepare` takes: the action and, for a delivery or a dispute, its words. */
export const PrepareBody = z.discriminatedUnion('action', [
  z.object({action: z.literal('create')}),
  z.object({action: z.literal('accept')}),
  // `output` is required unless the job has an accepted draft, whose
  // snapshot is then the delivery (docs/26 F7).
  JobResult.partial().extend({action: z.literal('submit')}),
  z.object({action: z.literal('approve')}),
  DisputeBody.extend({action: z.literal('dispute')}),
  z.object({action: z.literal('cancel')}),
]);

export const ConfirmBody = z.object({
  action: z.enum(PERSON_ACTIONS),
  /** base58, as the wallet returns it. */
  txHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, 'txHash is a base58 NEAR transaction hash'),
});

/** The gas every Pactora call is sent with (the signer's GAS); none of these methods takes a deposit. */
export const PERSON_GAS = '100000000000000';

export interface FunctionCallPayload {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: string;
  deposit: string;
}

/** Per action: the party who signs, the states it starts from, where it ends, and the event that proves it. */
const RULES: Record<
  PersonAction,
  {party: 'client' | 'worker'; from: string[]; to: string; event: JobTxEventName; kind: string}
> = {
  create: {party: 'client', from: ['created'], to: 'created', event: 'job_created', kind: 'job.created'},
  accept: {party: 'worker', from: ['created'], to: 'accepted', event: 'job_accepted', kind: 'job.accepted'},
  submit: {
    party: 'worker',
    from: ['accepted'],
    to: 'submitted',
    event: 'result_submitted',
    kind: 'job.submitted',
  },
  approve: {party: 'client', from: ['submitted'], to: 'settled', event: 'job_settled', kind: 'job.settled'},
  dispute: {
    party: 'client',
    from: ['submitted'],
    to: 'disputed',
    event: 'job_disputed',
    kind: 'job.disputed',
  },
  cancel: {party: 'client', from: ['created'], to: 'refunded', event: 'job_refunded', kind: 'job.refunded'},
};

const KIND: Record<PersonAction, Parameters<typeof contractCall>[0]> = {
  create: 'createJob',
  accept: 'accept',
  submit: 'submitResult',
  approve: 'approve',
  dispute: 'dispute',
  cancel: 'cancel',
};

export interface PersonActionDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  bus: EventBus;
  /** Omitted, nothing a person signed can be confirmed (the indexer still records it). */
  readTxEvents?: TxEventsReader;
  /** The signer: carries out an agent client's accepted draft once a person worker's submission is confirmed. */
  submit?: JobRouteDeps['submit'];
}

type Job = typeof jobs.$inferSelect;

/**
 * The FunctionCall that creates `job` on chain, signed by its client's
 * wallet. Used by `prepare` and by a person's selection of a bid.
 */
export async function createJobCall(db: Db, chain: ChainConfig, job: Job): Promise<FunctionCallPayload> {
  return functionCall(db, chain, job, 'create', {});
}

async function functionCall(
  db: Db,
  chain: ChainConfig,
  job: Job,
  action: PersonAction,
  hashes: {resultHash?: string; reasonHash?: string; reviewHash?: string},
): Promise<FunctionCallPayload> {
  const payload: Record<string, unknown> = {...hashes};
  if (action === 'create') {
    const [client, worker] = await Promise.all([
      db.query.agents.findFirst({where: eq(agents.id, job.clientAgentId)}),
      db.query.agents.findFirst({where: eq(agents.id, job.workerAgentId)}),
    ]);
    payload['clientChainAgentId'] = client?.chainAgentId;
    payload['workerChainAgentId'] = worker?.chainAgentId;
    payload['specHash'] = job.specHash;
    const windows = await listingWindowsOf(db, job.id);
    if (windows) Object.assign(payload, windows);
  }
  const call = contractCall(KIND[action], {
    job: {id: job.id, chainJobId: job.chainJobId},
    payload,
    chain,
    ...(action === 'create' ? {spend: BigInt(job.amount)} : {}),
  });
  return {
    receiverId: chain.contracts.Pactora,
    methodName: call.method,
    args: call.args,
    gas: PERSON_GAS,
    deposit: '0',
  };
}

/** A listing job's windows, from the listing its bid was on. */
async function listingWindowsOf(
  db: Db,
  jobId: number,
): Promise<{acceptWindowSeconds: number; workWindowSeconds: number} | null> {
  const [row] = await db
    .select({accept: listings.acceptWindowSeconds, work: listings.workWindowSeconds})
    .from(applications)
    .innerJoin(listings, eq(listings.id, applications.listingId))
    .where(eq(applications.jobId, jobId))
    .limit(1);
  return row ? {acceptWindowSeconds: row.accept, workWindowSeconds: row.work} : null;
}

export async function registerPersonActionRoutes(
  app: FastifyInstance,
  deps: PersonActionDeps,
): Promise<void> {
  const {db, chains, bus} = deps;

  async function context(request: {params: unknown}, raw: Parameters<typeof authenticatePerson>[1]) {
    const caller = await authenticatePerson(db, raw);
    const person = await personAgentOf(db, caller.account, caller.chainId);
    if (!person?.chainAgentId) {
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        `${caller.account} has no person agent on ${caller.chainId} — register on chain, then POST /v1/people`,
      );
    }
    const id = (request.params as {id: string}).id;
    const job = isPublicId(id) ? await db.query.jobs.findFirst({where: eq(jobs.publicId, id)}) : undefined;
    if (!job) throw new PactoraError(ErrorCode.NOT_FOUND, `no job ${id}`);
    const chain = chains[job.chainId];
    if (!chain) throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${job.chainId} is not enabled`);
    if (job.chainId !== caller.chainId) {
      throw new PactoraError(ErrorCode.CHAIN_MISMATCH, `job is on chain ${job.chainId}`);
    }
    return {caller, person: person as AgentRow & {chainAgentId: string}, job, chain};
  }

  function checkParty(job: Job, person: AgentRow, action: PersonAction) {
    const party = RULES[action].party;
    const id = party === 'client' ? job.clientAgentId : job.workerAgentId;
    if (id !== person.id) {
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        `only the job's ${party} may ${action === 'create' ? 'fund' : action} it`,
      );
    }
  }

  app.post('/v1/jobs/:id/person-actions/prepare', async (request) => {
    const {caller, person, job, chain} = await context(request, request);
    const body = PrepareBody.parse(request.body);
    const action = body.action;
    checkParty(job, person, action);
    if (action === 'accept') await requireClear(db, person.id, 'accept work');

    const rule = RULES[action];
    if (!rule.from.includes(job.state)) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        `job is "${job.state}", ${action} needs ${rule.from.map((s) => `"${s}"`).join(' or ')}`,
      );
    }
    if (action === 'create' && job.chainJobId) {
      throw new PactoraError(ErrorCode.INVALID_STATE, `job is already on chain as ${job.chainJobId}`);
    }
    if (action !== 'create' && !job.chainJobId) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        'the job is not confirmed on-chain yet — retry in a moment',
        2,
      );
    }
    if (action === 'approve') refuseMismatched(job);

    const hashes: {resultHash?: string; reasonHash?: string; reviewHash?: string} = {};
    const words: Record<string, unknown> = {};
    if (action === 'approve') {
      // An accepted draft's approval carries its review's hash on chain.
      const accepted = await acceptedDraftOf(db, job.id);
      if (accepted && accepted.draft.snapshotHash === job.resultHash) {
        hashes.reviewHash = accepted.review!.reviewHash;
      }
    }
    const delivery = body.action === 'submit' ? await draftDeliveryOf(db, job) : null;
    if (delivery) {
      // The accepted snapshot's hash, stored before the browser signs: the
      // chain will commit to it, and the indexer compares the two.
      hashes.resultHash = delivery.resultHash;
      await db
        .update(jobs)
        .set({result: delivery.result, resultHash: delivery.resultHash, resultUri: delivery.resultUri})
        .where(and(eq(jobs.id, job.id), eq(jobs.state, 'accepted')));
    } else if (body.action === 'submit') {
      if (!body.output) {
        throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, 'output: a submission needs the delivered output');
      }
      // The same two checks POST /v1/jobs/:id/result makes, and the same hash.
      const spec = job.spec as JobSpec;
      const shape = validateShape(body.output, spec.outputSchema);
      if (!shape.ok) {
        throw new PactoraError(
          ErrorCode.SCHEMA_MISMATCH,
          `${shape.reason} — the job asked for ${JSON.stringify(spec.outputSchema?.['required'] ?? [])}`,
        );
      }
      hashes.resultHash = sha256Hex(canonicalize(body.output));
      // Stored before the browser signs: the chain will commit to this hash,
      // and the indexer compares what it commits against it.
      await db
        .update(jobs)
        .set({result: body.output, resultHash: hashes.resultHash})
        .where(and(eq(jobs.id, job.id), eq(jobs.state, 'accepted')));
    }
    if (body.action === 'dispute') {
      hashes.reasonHash = sha256Hex(canonicalize({reason: body.reason}));
      words['reason'] = body.reason;
      words['reasonHash'] = hashes.reasonHash;
    }

    const call = await functionCall(db, chain, job, action, hashes);
    await db.insert(personActions).values({jobId: job.id, agentId: person.id, action, call, payload: words});
    return {
      jobId: job.publicId,
      action,
      signerId: caller.account,
      functionCall: call,
      expectedEvent: rule.event,
      ...hashes,
    };
  });

  app.post('/v1/jobs/:id/person-actions/confirm', async (request) => {
    const {caller, person, job, chain} = await context(request, request);
    const body = ConfirmBody.parse(request.body);
    const {action, txHash} = body;
    checkParty(job, person, action);

    const answer = (
      state: string,
      j: {chainJobId: string | null; resultMismatch: boolean},
      replayed: boolean,
    ) => ({
      jobId: job.publicId,
      action,
      txHash,
      state,
      chainJobId: j.chainJobId,
      resultMismatch: j.resultMismatch,
      explorerUrl: chain.explorerTx(txHash),
      replayed,
    });

    const done = await db.query.personActions.findFirst({
      where: and(eq(personActions.jobId, job.id), eq(personActions.txHash, txHash)),
    });
    if (done) {
      if (done.action !== action) {
        throw new PactoraError(
          ErrorCode.IDEMPOTENCY_CONFLICT,
          `transaction ${txHash} was already confirmed as ${done.action} for this job`,
        );
      }
      return answer(job.state, job, true);
    }

    if (!deps.readTxEvents) {
      throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'this API cannot read the chain to confirm', 5);
    }
    const reading = await deps.readTxEvents({chainId: job.chainId, txHash, signerId: caller.account});
    if (reading.status === 'pending') {
      throw new PactoraError(ErrorCode.INVALID_STATE, `transaction ${txHash} is not final yet — retry`, 2);
    }
    if (reading.status === 'reverted') {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        `transaction ${txHash} failed on chain; nothing changed`,
      );
    }
    if (reading.signerId !== null && reading.signerId !== caller.account) {
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        `transaction ${txHash} was signed by ${reading.signerId}, not ${caller.account}`,
      );
    }

    const counterpart = RULES[action].party === 'client' ? job.workerAgentId : job.clientAgentId;
    const other = await db.query.agents.findFirst({where: eq(agents.id, counterpart)});
    const event = findEvent(reading.events, action, job, person.chainAgentId, other?.chainAgentId ?? null);
    if (!event) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        `transaction ${txHash} carries no ${RULES[action].event} event for this job from your agent`,
      );
    }

    const d = event.data;
    const patch: Partial<typeof jobs.$inferInsert> = {};
    let mismatch = job.resultMismatch;
    if (action === 'create') patch.chainJobId = String(d['job_id']);
    if (action === 'submit') {
      const onChain = String(d['result_hash']);
      if (job.resultHash && job.resultHash !== onChain) {
        // Never overwritten: the stored delivery is what the hash should have been.
        patch.resultMismatch = true;
        mismatch = true;
        request.log.warn({jobId: job.publicId, stored: job.resultHash, onChain}, 'result hash mismatch');
      } else if (!job.resultHash) {
        patch.resultHash = onChain;
      }
    }
    if (action === 'approve') {
      patch.settledAt = new Date();
      if (typeof d['fee'] === 'string') patch.fee = d['fee'];
    }

    // The words a dispute committed to, from the prepare that hashed them.
    let words: Record<string, unknown> = {};
    if (action === 'dispute') {
      const prepared = await db.query.personActions.findMany({
        where: and(
          eq(personActions.jobId, job.id),
          eq(personActions.action, 'dispute'),
          isNull(personActions.txHash),
        ),
        orderBy: [desc(personActions.id)],
      });
      const match = prepared.find(
        (p) => (p.payload as {reasonHash?: string}).reasonHash === d['reason_hash'],
      );
      if (match) words = match.payload as Record<string, unknown>;
    }

    const recorded = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(personActions)
        .values({
          jobId: job.id,
          agentId: person.id,
          action,
          call: {methodName: event.event},
          payload: words,
          txHash,
          confirmedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({id: personActions.id});
      if (!row) return false;
      const rule = RULES[action];
      // Forward only: the indexer may have moved the job already.
      await tx
        .update(jobs)
        .set({...(rule.to !== job.state ? {state: rule.to as Job['state']} : {}), ...patch})
        .where(and(eq(jobs.id, job.id), inArray(jobs.state, rule.from as Job['state'][])));
      return true;
    });

    const fresh = (await db.query.jobs.findFirst({where: eq(jobs.id, job.id)}))!;
    if (!recorded) return answer(fresh.state, fresh, true);

    await recordEvent(db, bus, job.id, job.chainId, RULES[action].kind, {
      jobId: job.publicId,
      txHash,
      via: 'person',
      ...words,
    });
    // A submission of an accepted draft: carry out the client's acceptance
    // (an agent client through the signer; a person client is told to sign).
    let settlement: SettleOutcome | undefined;
    if (action === 'submit' && !mismatch && deps.submit) {
      settlement = await settleAcceptedDraft({db, bus, submit: deps.submit}, job.id, request.id).catch(
        (err: unknown) => {
          request.log.warn({err, jobId: job.publicId}, 'accepted draft not approved yet; the sweep retries');
          return {status: 'not_ready' as const, reason: err instanceof Error ? err.message : String(err)};
        },
      );
    }
    const after = settlement?.status === 'approved' ? 'settled' : fresh.state;
    return {
      ...answer(after, {chainJobId: fresh.chainJobId, resultMismatch: mismatch}, false),
      ...(settlement ? {settlement} : {}),
    };
  });
}

/**
 * The event that proves `action` on `job` by `mine` (the person's contract
 * agent id), or undefined. `theirs` is the other party's contract agent id.
 */
function findEvent(
  events: JobTxEvent[],
  action: PersonAction,
  job: Job,
  mine: string,
  theirs: string | null,
): JobTxEvent | undefined {
  const rule = RULES[action];
  const num = (v: unknown) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '');
  return events.find((e) => {
    if (e.event !== rule.event) return false;
    const d = e.data;
    if (action === 'create') {
      return d['spec_hash'] === job.specHash && num(d['client']) === mine && num(d['worker']) === theirs;
    }
    if (num(d['job_id']) !== job.chainJobId) return false;
    switch (action) {
      case 'accept':
        return num(d['worker']) === mine;
      case 'approve':
        // Paid in the client's own transaction, with the outcome an approval writes.
        return d['outcome'] === 'Success';
      case 'cancel':
        return num(d['client']) === mine && d['reason'] === 'cancelled';
      default:
        return true;
    }
  });
}
