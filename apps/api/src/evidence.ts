import type {FastifyRequest} from 'fastify';
import {and, asc, desc, eq, inArray, isNull, sql} from 'drizzle-orm';
import {sha256Hex} from '@pactora/near';
import {agents, applications, jobDrafts, jobFiles, jobMessages, jobReviews, jobs, type Db} from '@pactora/db';
import {ErrorCode, PactoraError, canonicalize} from '@pactora/shared';
import type {ChainConfig} from '@pactora/config';
import {actorOf, type Actor} from './actor.js';
import type {EventBus} from './events.js';
import {isPublicId, recordEvent, signerKey, type JobRouteDeps} from './routes/jobs.js';

/**
 * Evidence, draft rounds and their review (docs/26 F6, F7), without a
 * contract change.
 *
 * The contract has one `submit_result`, from Accepted only, and no
 * "revise". So revisions happen before it, off chain: the worker posts a
 * draft — an immutable snapshot of the job's terms, their text and output,
 * the hashes of their active photos and the conversation — and the client
 * reviews THAT snapshot by its hash: revise (at most 3 times), accept_draft
 * (every check met), or dispute_intent. Only an accepted draft can be
 * submitted, and its snapshot hash is the `result_hash` the chain commits
 * to, so anyone holding the snapshot can show it is what was delivered.
 *
 * Once the chain has that exact hash, the client's stored "accept" is
 * carried out: an agent client's approval through the signer (with the
 * review's hash as `review_hash`), a person client's offered for them to
 * sign. A different hash on chain is a mismatch (indexer.ts, confirm), and
 * only a dispute is offered.
 */

export type Job = typeof jobs.$inferSelect;
/** A transaction, as drizzle hands it to `db.transaction`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run a select: the pool or a transaction. */
export type Reader = Pick<Db, 'select'> | Pick<Tx, 'select'>;
export type Draft = typeof jobDrafts.$inferSelect;
export type Review = typeof jobReviews.$inferSelect;

/** At most this many revise decisions per job; the 4th is refused (LIMIT_REACHED). */
export const MAX_REVISIONS = 3;
/** Messages per job, also the most a snapshot carries. */
export const MAX_MESSAGES = 100;

/** The two sides of a job. */
export type Party = 'client' | 'worker';

export interface JobParty {
  actor: Actor;
  job: Job;
  chain: ChainConfig;
  role: Party;
}

/** Load a job by public id and the caller's side of it; anyone else is refused. */
export async function partyOf(
  db: Db,
  chains: Record<string, ChainConfig>,
  request: FastifyRequest,
  jobId: string,
): Promise<JobParty> {
  const actor = await actorOf(db, request);
  const job = isPublicId(jobId)
    ? await db.query.jobs.findFirst({where: eq(jobs.publicId, jobId)})
    : undefined;
  if (!job) throw new PactoraError(ErrorCode.NOT_FOUND, `no job ${jobId}`);
  const chain = chains[job.chainId];
  if (!chain) throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${job.chainId} is not enabled`);
  const role: Party | null =
    job.workerAgentId === actor.agent.id ? 'worker' : job.clientAgentId === actor.agent.id ? 'client' : null;
  if (!role) {
    throw new PactoraError(
      ErrorCode.FORBIDDEN,
      "only the job's client and worker may read or write its evidence",
    );
  }
  return {actor, job, chain, role};
}

export function requireRole(p: JobParty, role: Party, what: string): void {
  if (p.role !== role) throw new PactoraError(ErrorCode.FORBIDDEN, `only the job's ${role} may ${what}`);
}

/** A job created by selecting (or claiming) a listing bid: it is delivered through an accepted draft. */
export async function isListingJob(db: Db, jobId: number): Promise<boolean> {
  const [row] = await db
    .select({id: applications.id})
    .from(applications)
    .where(eq(applications.jobId, jobId))
    .limit(1);
  return Boolean(row);
}

export interface DraftWithReview {
  draft: Draft;
  review: Review | null;
}

/** Every draft of a job, oldest first, each with its review if it has one. */
export async function draftsOf(db: Reader, jobId: number): Promise<DraftWithReview[]> {
  const rows = await db
    .select()
    .from(jobDrafts)
    .leftJoin(jobReviews, eq(jobReviews.draftId, jobDrafts.id))
    .where(eq(jobDrafts.jobId, jobId))
    .orderBy(asc(jobDrafts.round));
  return rows.map((r) => ({draft: r.job_drafts, review: r.job_reviews}));
}

/**
 * Where a job's draft rounds stand: `none` yet, `awaiting_review`, `revise`
 * (the worker may post the next round), `accepted` (submit it), or
 * `dispute_intent` (the client will not accept; no more rounds).
 */
export type DraftPhase = 'none' | 'awaiting_review' | 'revise' | 'accepted' | 'dispute_intent';

export function phaseOf(rounds: DraftWithReview[]): DraftPhase {
  const last = rounds.at(-1);
  if (!last) return 'none';
  if (!last.review) return 'awaiting_review';
  if (last.review.decision === 'accept_draft') return 'accepted';
  if (last.review.decision === 'dispute_intent') return 'dispute_intent';
  return 'revise';
}

export async function acceptedDraftOf(db: Db, jobId: number): Promise<DraftWithReview | null> {
  const [row] = await db
    .select()
    .from(jobDrafts)
    .innerJoin(jobReviews, eq(jobReviews.draftId, jobDrafts.id))
    .where(and(eq(jobDrafts.jobId, jobId), eq(jobReviews.decision, 'accept_draft')))
    .limit(1);
  return row ? {draft: row.job_drafts, review: row.job_reviews} : null;
}

/** The internal reference `jobs.result_uri` holds for a job delivered from a draft. */
export const draftUri = (job: Pick<Job, 'publicId'>, draft: Pick<Draft, 'publicId'>) =>
  `pactora://jobs/${job.publicId}/drafts/${draft.publicId}`;

/** What a submission from an accepted draft stores, and the hash the chain commits to. */
export interface DraftDelivery {
  result: {draftId: string; snapshotHash: string; round: number};
  resultHash: string;
  resultUri: string;
  reviewHash: string;
}

/**
 * The delivery a submission must carry: the accepted draft's, if there is
 * one; refused for a listing job without one; null (today's behaviour, the
 * output's own hash) for any other job.
 */
export async function draftDeliveryOf(db: Db, job: Job): Promise<DraftDelivery | null> {
  const accepted = await acceptedDraftOf(db, job.id);
  if (accepted) {
    return {
      // A reference, not the evidence: GET /v1/jobs/:id is public, the
      // snapshot is for the two parties only.
      result: {
        draftId: accepted.draft.publicId,
        snapshotHash: accepted.draft.snapshotHash,
        round: accepted.draft.round,
      },
      resultHash: accepted.draft.snapshotHash,
      resultUri: draftUri(job, accepted.draft),
      reviewHash: accepted.review!.reviewHash,
    };
  }
  if (await isListingJob(db, job.id)) {
    throw new PactoraError(
      ErrorCode.INVALID_STATE,
      'a listing job is submitted from an accepted draft: POST /v1/jobs/:id/drafts, then the client reviews it with accept_draft',
    );
  }
  return null;
}

// ─────────────────────────── snapshots ───────────────────────────

export interface SnapshotFile {
  fileId: string;
  sha256: string;
  mime: string;
  size: number;
}

export interface SnapshotMessage {
  messageId: string;
  from: Party;
  body: string;
  inReplyTo: string | null;
  at: string;
}

/** What a draft commits to. Its sha256 over the canonical JSON is the snapshot hash. */
export interface Snapshot {
  v: 1;
  jobId: string;
  specHash: string;
  round: number;
  terms: unknown;
  text: string;
  output: Record<string, unknown> | null;
  files: SnapshotFile[];
  messages: SnapshotMessage[];
}

/** sha256 hex of the canonical JSON — what a reader recomputes to check a snapshot. */
export const snapshotHashOf = (s: Snapshot): string => sha256Hex(canonicalize(s));

/** The active files and the conversation of `job`, as a snapshot names them. Run inside the draft's transaction. */
export async function buildSnapshot(
  tx: Reader,
  job: Job,
  round: number,
  text: string,
  output: Record<string, unknown> | null,
): Promise<Snapshot> {
  const files = await tx
    .select()
    .from(jobFiles)
    .where(and(eq(jobFiles.jobId, job.id), isNull(jobFiles.withdrawnAt)))
    .orderBy(asc(jobFiles.id));
  const messages = await messagesOf(tx, job);
  return {
    v: 1,
    jobId: job.publicId,
    specHash: job.specHash,
    round,
    terms: job.spec,
    text,
    output,
    files: files.map((f) => ({fileId: f.publicId, sha256: f.sha256, mime: f.mime, size: f.size})),
    messages: messages.slice(-MAX_MESSAGES),
  };
}

/** A job's messages, oldest first, in the shape a snapshot and the API show. */
export async function messagesOf(tx: Reader, job: Job): Promise<SnapshotMessage[]> {
  const rows = await tx
    .select()
    .from(jobMessages)
    .where(eq(jobMessages.jobId, job.id))
    .orderBy(asc(jobMessages.id));
  const byId = new Map(rows.map((r) => [r.id, r.publicId]));
  return rows.map((m) => ({
    messageId: m.publicId,
    from: m.authorAgentId === job.workerAgentId ? 'worker' : 'client',
    body: m.body,
    inReplyTo: m.inReplyTo !== null ? (byId.get(m.inReplyTo) ?? null) : null,
    at: m.createdAt.toISOString(),
  }));
}

/** Lock the job row for a short re-check (the second half of "check, do the slow part, re-check"). */
export async function lockJob(tx: Tx, jobId: number): Promise<Job> {
  const [row] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for('update');
  if (!row) throw new PactoraError(ErrorCode.NOT_FOUND, 'the job is gone');
  return row;
}

// ─────────────────────────── carrying out an accepted draft ───────────────────────────

export interface SettleDeps {
  db: Db;
  bus: EventBus;
  submit: JobRouteDeps['submit'];
}

export type SettleOutcome =
  | {status: 'approved'; txHash: string; reviewHash: string}
  /** A person client signs the approval themselves: person-actions prepare {action:'approve'}. */
  | {status: 'ready_to_approve'; reviewHash: string}
  | {status: 'not_ready'; reason: string};

/**
 * Carry out the client's accept_draft once the chain holds the accepted
 * snapshot's hash. Idempotent: the signer key is fixed by the review, so a
 * second call — this one racing the sweep, or a retry — replays the same
 * transaction, and only the call that moves the row records the event.
 */
export async function settleAcceptedDraft(
  deps: SettleDeps,
  jobId: number,
  traceId?: string,
): Promise<SettleOutcome> {
  const {db, bus, submit} = deps;
  const job = await db.query.jobs.findFirst({where: eq(jobs.id, jobId)});
  if (!job) return {status: 'not_ready', reason: 'no such job'};
  if (job.state !== 'submitted') return {status: 'not_ready', reason: `job is ${job.state}`};
  if (job.resultMismatch) return {status: 'not_ready', reason: 'result_mismatch: dispute instead'};
  const accepted = await acceptedDraftOf(db, job.id);
  if (!accepted) return {status: 'not_ready', reason: 'no accepted draft'};
  if (job.resultHash !== accepted.draft.snapshotHash) {
    return {status: 'not_ready', reason: 'the result hash is not the accepted snapshot hash'};
  }
  const reviewHash = accepted.review!.reviewHash;
  const client = await db.query.agents.findFirst({where: eq(agents.id, job.clientAgentId)});
  if (!client) return {status: 'not_ready', reason: 'no client'};
  if (client.kind === 'person') return {status: 'ready_to_approve', reviewHash};
  if (!job.chainJobId) return {status: 'not_ready', reason: 'not on chain yet'};

  const out = await submit({
    agentId: client.id,
    chainId: job.chainId,
    kind: 'approve',
    job: {id: job.id, chainJobId: job.chainJobId},
    spend: 0n,
    idempotencyKey: signerKey({
      agentId: client.id,
      action: 'approve',
      jobId: job.publicId,
      clientKey: `review:${accepted.review!.publicId}`,
    }),
    ...(traceId ? {traceId} : {}),
    payload: {reviewHash},
  });
  const moved = await db
    .update(jobs)
    .set({state: 'settled', settledAt: new Date()})
    .where(and(eq(jobs.id, job.id), eq(jobs.state, 'submitted')))
    .returning({id: jobs.id});
  if (moved.length > 0) {
    await recordEvent(db, bus, job.id, job.chainId, 'job.settled', {
      jobId: job.publicId,
      txHash: out.txHash,
      via: 'review',
      reviewHash,
    });
  }
  return {status: 'approved', txHash: out.txHash, reviewHash};
}

/**
 * Jobs whose accepted snapshot is on chain and whose agent client has not
 * approved yet: what the API's sweep carries out. The sweep is the backstop
 * for a submission the API did not see — one the indexer recorded.
 */
export async function jobsReadyToSettle(db: Db, limit = 20): Promise<number[]> {
  const rows = await db
    .select({id: jobs.id})
    .from(jobs)
    .innerJoin(jobDrafts, and(eq(jobDrafts.jobId, jobs.id), eq(jobDrafts.snapshotHash, jobs.resultHash)))
    .innerJoin(jobReviews, and(eq(jobReviews.draftId, jobDrafts.id), eq(jobReviews.decision, 'accept_draft')))
    .innerJoin(agents, eq(agents.id, jobs.clientAgentId))
    .where(and(eq(jobs.state, 'submitted'), eq(jobs.resultMismatch, false), eq(agents.kind, 'agent')))
    .orderBy(asc(jobs.id))
    .limit(limit);
  return rows.map((r) => r.id);
}

export {desc, inArray, sql};
