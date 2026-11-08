import type {FastifyInstance} from 'fastify';
import {and, count, eq} from 'drizzle-orm';
import {z} from 'zod';
import {sha256Hex} from '@pactora/near';
import {jobDrafts, jobReviews, type Db} from '@pactora/db';
import {ErrorCode, type JobSpec, PactoraError, canonicalize, validateShape} from '@pactora/shared';
import type {ChainConfig} from '@pactora/config';
import {
  MAX_REVISIONS,
  buildSnapshot,
  draftsOf,
  lockJob,
  partyOf,
  phaseOf,
  requireRole,
  snapshotHashOf,
  type DraftWithReview,
  type Job,
} from '../evidence.js';
import type {EventBus} from '../events.js';
import {isPublicId, recordEvent} from './jobs.js';

/** POST /v1/jobs/:id/drafts — the worker's next round. */
export const DraftBody = z.object({
  text: z.string().trim().min(10, 'text is 10-10000 characters').max(10_000, 'text is 10-10000 characters'),
  /** Structured output, checked against the job's outputSchema when it has one. */
  output: z.record(z.string(), z.unknown()).optional(),
});

/** One acceptance criterion, judged. */
export const ReviewCheck = z.object({
  criterion: z.string().trim().min(1).max(500),
  met: z.boolean(),
  /** What in the snapshot shows it (or why it does not). */
  support: z.string().trim().max(2000).default(''),
});

/** POST /v1/jobs/:id/drafts/:draftId/review — the client's decision on that snapshot. */
export const ReviewBody = z.object({
  /** The hash of the snapshot reviewed: a review of anything else is stale (409). */
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/, 'snapshotHash is 64 lowercase hex'),
  decision: z.enum(['revise', 'accept_draft', 'dispute_intent']),
  reason: z.string().trim().min(10, 'reason is 10-2000 characters').max(2000, 'reason is 10-2000 characters'),
  checks: z.array(ReviewCheck).min(1, 'at least one check').max(30, 'at most 30 checks'),
});

export interface DraftRouteDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  bus: EventBus;
}

function reviewView(r: typeof jobReviews.$inferSelect | null) {
  if (!r) return null;
  return {
    reviewId: r.publicId,
    decision: r.decision,
    reason: r.reason,
    checks: r.checks,
    reviewHash: r.reviewHash,
    decidedAt: r.createdAt,
  };
}

function draftView(d: DraftWithReview) {
  return {
    draftId: d.draft.publicId,
    round: d.draft.round,
    snapshotHash: d.draft.snapshotHash,
    snapshot: d.draft.snapshot,
    createdAt: d.draft.createdAt,
    review: reviewView(d.review),
  };
}

const revisionsUsed = (rounds: DraftWithReview[]) =>
  rounds.filter((r) => r.review?.decision === 'revise').length;

/** The payload a review hash commits to; anyone with the review can recompute it. */
export function reviewHashOf(p: {
  jobId: string;
  draftId: string;
  snapshotHash: string;
  decision: string;
  reason: string;
  checks: unknown;
}): string {
  return sha256Hex(canonicalize({v: 1, ...p}));
}

export async function registerDraftRoutes(app: FastifyInstance, deps: DraftRouteDeps): Promise<void> {
  const {db, chains, bus} = deps;

  /** The state, from a job and its rounds, that both GET and every write answer with. */
  function summary(job: Job, rounds: DraftWithReview[]) {
    const phase = phaseOf(rounds);
    const accepted = rounds.find((r) => r.review?.decision === 'accept_draft');
    const used = revisionsUsed(rounds);
    return {
      jobId: job.publicId,
      phase,
      revisionsUsed: used,
      revisionsLeft: Math.max(0, MAX_REVISIONS - used),
      acceptedSnapshotHash: accepted?.draft.snapshotHash ?? null,
      acceptedReviewHash: accepted?.review?.reviewHash ?? null,
      /**
       * The chain holds the accepted snapshot's hash and the client still
       * has to approve: an agent client is approved by the API, a person
       * client signs person-actions prepare {action: 'approve'}.
       */
      readyToApprove: Boolean(
        accepted &&
        job.state === 'submitted' &&
        !job.resultMismatch &&
        job.resultHash === accepted.draft.snapshotHash,
      ),
      resultMismatch: job.resultMismatch,
    };
  }

  app.get('/v1/jobs/:id/drafts', async (request) => {
    const p = await partyOf(db, chains, request, (request.params as {id: string}).id);
    const rounds = await draftsOf(db, p.job.id);
    return {...summary(p.job, rounds), role: p.role, drafts: rounds.map(draftView)};
  });

  app.post('/v1/jobs/:id/drafts', async (request, reply) => {
    const p = await partyOf(db, chains, request, (request.params as {id: string}).id);
    requireRole(p, 'worker', 'submit a draft');
    const body = DraftBody.parse(request.body ?? {});
    const spec = p.job.spec as JobSpec;
    if (body.output && spec.outputSchema) {
      const shape = validateShape(body.output, spec.outputSchema);
      if (!shape.ok) {
        throw new PactoraError(
          ErrorCode.SCHEMA_MISMATCH,
          `${shape.reason} — the job asked for ${JSON.stringify(spec.outputSchema['required'] ?? [])}`,
        );
      }
    }

    const outcome = await db.transaction(async (tx) => {
      const job = await lockJob(tx, p.job.id);
      if (job.state !== 'accepted') {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          `job is "${job.state}"; drafts are taken while it is "accepted" (accept it first)`,
        );
      }
      const rounds = await draftsOf(tx, job.id);
      const phase = phaseOf(rounds);
      const last = rounds.at(-1);
      if (phase === 'awaiting_review' && last) {
        // A retry of the same draft is the same draft; anything else waits.
        const same = buildSnapshot(tx, job, last.draft.round, body.text, body.output ?? null).then(
          (s) => snapshotHashOf(s) === last.draft.snapshotHash,
        );
        if (await same) return {draft: last, replayed: true, job};
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          `draft ${last.draft.round} is awaiting the client's review; the next round opens after a revise`,
        );
      }
      if (phase === 'accepted') {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          'a draft was accepted: submit it (POST /v1/jobs/:id/result)',
        );
      }
      if (phase === 'dispute_intent') {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          'the client intends to dispute; no more drafts are taken',
        );
      }
      const round = rounds.length + 1;
      if (round > MAX_REVISIONS + 1) {
        throw new PactoraError(ErrorCode.LIMIT_REACHED, `at most ${MAX_REVISIONS + 1} draft rounds per job`);
      }
      const snapshot = await buildSnapshot(tx, job, round, body.text, body.output ?? null);
      const [draft] = await tx
        .insert(jobDrafts)
        .values({
          jobId: job.id,
          round,
          authorAgentId: p.actor.agent.id,
          snapshot,
          snapshotHash: snapshotHashOf(snapshot),
        })
        .returning();
      return {draft: {draft: draft!, review: null}, replayed: false, job};
    });

    if (!outcome.replayed) {
      await recordEvent(db, bus, p.job.id, p.job.chainId, 'job.draft.submitted', {
        jobId: p.job.publicId,
        draftId: outcome.draft.draft.publicId,
        round: outcome.draft.draft.round,
        snapshotHash: outcome.draft.draft.snapshotHash,
      });
    }
    const rounds = await draftsOf(db, p.job.id);
    return reply
      .status(outcome.replayed ? 200 : 201)
      .send({...summary(outcome.job, rounds), ...draftView(outcome.draft), replayed: outcome.replayed});
  });

  app.post('/v1/jobs/:id/drafts/:draftId/review', async (request) => {
    const {id, draftId} = request.params as {id: string; draftId: string};
    const p = await partyOf(db, chains, request, id);
    requireRole(p, 'client', 'review a draft');
    const body = ReviewBody.parse(request.body ?? {});
    if (!isPublicId(draftId)) throw new PactoraError(ErrorCode.NOT_FOUND, `no draft ${draftId}`);

    const outcome = await db.transaction(async (tx) => {
      const job = await lockJob(tx, p.job.id);
      const rounds = await draftsOf(tx, job.id);
      const target = rounds.find((r) => r.draft.publicId === draftId);
      if (!target) throw new PactoraError(ErrorCode.NOT_FOUND, `no draft ${draftId} on this job`);

      // Written once per snapshot: the same decision again is a replay,
      // a different one a conflict.
      if (target.review) {
        if (target.review.decision === body.decision) return {target, replayed: true, job};
        throw new PactoraError(
          ErrorCode.IDEMPOTENCY_CONFLICT,
          `draft ${target.draft.round} was already reviewed: ${target.review.decision}`,
        );
      }
      const latest = rounds.at(-1)!;
      if (body.snapshotHash !== target.draft.snapshotHash || latest.draft.id !== target.draft.id) {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          `stale snapshot: the draft under review is round ${latest.draft.round}, hash ${latest.draft.snapshotHash}`,
        );
      }
      if (job.state !== 'accepted') {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          `job is "${job.state}"; drafts are reviewed while it is "accepted"`,
        );
      }
      if (body.decision === 'accept_draft') {
        const unmet = body.checks.filter((c) => !c.met).map((c) => c.criterion);
        if (unmet.length > 0) {
          throw new PactoraError(
            ErrorCode.SCHEMA_MISMATCH,
            `accept_draft needs every check met; not met: ${unmet.join('; ')}`,
          );
        }
      }
      if (body.decision === 'revise') {
        const [{n} = {n: 0}] = await tx
          .select({n: count()})
          .from(jobReviews)
          .where(and(eq(jobReviews.jobId, job.id), eq(jobReviews.decision, 'revise')));
        if (Number(n) >= MAX_REVISIONS) {
          throw new PactoraError(
            ErrorCode.LIMIT_REACHED,
            `at most ${MAX_REVISIONS} revision rounds per job — accept_draft or dispute_intent`,
          );
        }
      }
      const reviewHash = reviewHashOf({
        jobId: job.publicId,
        draftId: target.draft.publicId,
        snapshotHash: target.draft.snapshotHash,
        decision: body.decision,
        reason: body.reason,
        checks: body.checks,
      });
      const [review] = await tx
        .insert(jobReviews)
        .values({
          draftId: target.draft.id,
          jobId: job.id,
          decision: body.decision,
          reason: body.reason,
          checks: body.checks,
          reviewHash,
          decidedBy: p.actor.agent.id,
        })
        .returning();
      return {target: {draft: target.draft, review: review!}, replayed: false, job};
    });

    if (!outcome.replayed) {
      await recordEvent(db, bus, p.job.id, p.job.chainId, 'job.draft.reviewed', {
        jobId: p.job.publicId,
        draftId: outcome.target.draft.publicId,
        round: outcome.target.draft.round,
        decision: outcome.target.review!.decision,
        reviewHash: outcome.target.review!.reviewHash,
      });
    }
    const rounds = await draftsOf(db, p.job.id);
    const decision = outcome.target.review!.decision;
    return {
      ...summary(outcome.job, rounds),
      draftId: outcome.target.draft.publicId,
      round: outcome.target.draft.round,
      snapshotHash: outcome.target.draft.snapshotHash,
      review: reviewView(outcome.target.review),
      replayed: outcome.replayed,
      next:
        decision === 'accept_draft'
          ? 'the worker submits this snapshot hash on chain; once it is there the approval is carried out'
          : decision === 'revise'
            ? 'the worker posts the next round'
            : 'no more rounds; the client disputes once a result is submitted, else the work window refunds',
    };
  });
}
