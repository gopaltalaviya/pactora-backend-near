import type {FastifyInstance} from 'fastify';
import {and, asc, count, eq} from 'drizzle-orm';
import {z} from 'zod';
import {disputeNotes, jobEvents, jobFiles, type Db} from '@pactora/db';
import {ErrorCode, PactoraError} from '@pactora/shared';
import type {ChainConfig} from '@pactora/config';
import {lockJob, partyOf, requireRole} from '../evidence.js';
import type {EventBus} from '../events.js';
import {fileView, refuseNotDisputable} from './files.js';
import {recordEvent} from './jobs.js';

/**
 * The client's side of a dispute (2026-11-09, migration 0027).
 *
 * The chain holds one hash: `reason_hash`, of the dispute reason's text.
 * Everything a client wants to add — what was wrong, in words; photos of
 * what they received — is off chain, attached while the job is submitted
 * or disputed, read by both parties, and part of the DAO desk's evidence
 * bundle and hash (routes/admin.ts). Nothing here needs a contract change.
 */

export const MAX_DISPUTE_NOTES = 10;

export const DisputeNoteBody = z.object({
  text: z.string().trim().min(1, 'a note is 1-2000 characters').max(2000, 'a note is 1-2000 characters'),
});

export interface DisputeRouteDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  bus: EventBus;
}

export async function registerDisputeRoutes(app: FastifyInstance, deps: DisputeRouteDeps): Promise<void> {
  const {db, chains, bus} = deps;

  const noteView = (n: typeof disputeNotes.$inferSelect) => ({
    noteId: n.publicId,
    text: n.body,
    at: n.createdAt.toISOString(),
  });

  /** Written evidence: client only, while submitted or disputed, at most 10. */
  app.post('/v1/jobs/:id/dispute/notes', async (request, reply) => {
    const p = await partyOf(db, chains, request, (request.params as {id: string}).id);
    requireRole(p, 'client', 'attach dispute evidence');
    const body = DisputeNoteBody.parse(request.body ?? {});
    refuseNotDisputable(p.job);
    const row = await db.transaction(async (tx) => {
      const job = await lockJob(tx, p.job.id);
      refuseNotDisputable(job);
      const [{n} = {n: 0}] = await tx
        .select({n: count()})
        .from(disputeNotes)
        .where(eq(disputeNotes.jobId, job.id));
      if (Number(n) >= MAX_DISPUTE_NOTES) {
        throw new PactoraError(ErrorCode.LIMIT_REACHED, `at most ${MAX_DISPUTE_NOTES} dispute notes per job`);
      }
      const [inserted] = await tx
        .insert(disputeNotes)
        .values({jobId: job.id, authorAgentId: p.actor.agent.id, body: body.text})
        .returning();
      return inserted!;
    });
    // Announced without its words, like a chat message: the stream is public.
    await recordEvent(db, bus, p.job.id, p.job.chainId, 'job.dispute.note', {
      jobId: p.job.publicId,
      noteId: row.publicId,
    });
    return reply.status(201).send({jobId: p.job.publicId, ...noteView(row)});
  });

  /** Both parties: the reason the chain committed to, and everything the client attached. */
  app.get('/v1/jobs/:id/dispute', async (request) => {
    const p = await partyOf(db, chains, request, (request.params as {id: string}).id);
    const disputed = await db.query.jobEvents.findFirst({
      where: and(eq(jobEvents.jobId, p.job.id), eq(jobEvents.kind, 'job.disputed')),
    });
    if (!disputed && p.job.state !== 'submitted') {
      throw new PactoraError(ErrorCode.NOT_FOUND, 'this job was not disputed');
    }
    const payload = (disputed?.payload ?? {}) as {reason?: string; reasonHash?: string};
    const [notes, files] = await Promise.all([
      db.select().from(disputeNotes).where(eq(disputeNotes.jobId, p.job.id)).orderBy(asc(disputeNotes.id)),
      db
        .select()
        .from(jobFiles)
        .where(and(eq(jobFiles.jobId, p.job.id), eq(jobFiles.purpose, 'dispute')))
        .orderBy(asc(jobFiles.id)),
    ]);
    return {
      jobId: p.job.publicId,
      state: p.job.state,
      role: p.role,
      reason: payload.reason ?? null,
      reasonHash: payload.reasonHash ?? null,
      raisedAt: disputed ? new Date(disputed.occurredAt).toISOString() : null,
      notes: notes.map(noteView),
      files: files.map(fileView),
      limits: {maxNotes: MAX_DISPUTE_NOTES},
      /** Whether the client may still add to it: client, and the job submitted or disputed. */
      canAttach: p.role === 'client' && (p.job.state === 'submitted' || p.job.state === 'disputed'),
    };
  });
}
