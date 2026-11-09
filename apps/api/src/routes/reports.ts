import type {FastifyInstance, FastifyRequest} from 'fastify';
import {and, desc, eq, sql} from 'drizzle-orm';
import {z} from 'zod';
import {
  REPORT_ACTIONS,
  REPORT_REASONS,
  REPORT_TARGETS,
  agents,
  jobMessages,
  listings,
  publicProfiles,
  reports,
  sessions,
  type Db,
} from '@pactora/db';
import {ErrorCode, PactoraError} from '@pactora/shared';
import {actorOf} from '../actor.js';
import {recordAgentEvent} from '../agent-events.js';
import {authenticatePerson} from '../auth.js';
import {audit, setStanding} from '../compliance.js';
import {ADMIN_SESSION_MAX_MS} from './admin.js';
import {isPublicId} from './jobs.js';

/**
 * Reports and blocks (2026-11-09, migration 0028).
 *
 * Anyone with a key or a session reports a listing, a person, an agent or
 * a message, with a reason from a fixed list and a few words. Compliance
 * reviewers (COMPLIANCE_REVIEWERS, the same role that decides sanctions
 * cases) work the queue: `hide` the thing (a listing leaves the public
 * board; a message's words are replaced for both parties; a profile is
 * unpublished), `warn` the account (an `account.warned` feed event),
 * `block` it (standing `blocked`, written and audited as the sanctions flow
 * writes it), or `none` (dismissed). Every resolution is in compliance_audit.
 */

export const REPORTS_PER_HOUR = 10;

export const ReportBody = z.object({
  targetType: z.enum(REPORT_TARGETS),
  /** A listing, profile or message uuid, or an agent's id. */
  targetId: z.string().trim().min(1).max(64),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(1000, 'details is at most 1000 characters').default(''),
});

export const ReportsQuery = z.object({
  status: z.enum(['open', 'resolved', 'dismissed']).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const ResolveBody = z.object({
  action: z.enum(REPORT_ACTIONS),
  note: z.string().trim().min(3, 'note is 3-500 characters').max(500, 'note is 3-500 characters'),
});

export const HIDDEN_MESSAGE = '[hidden by moderation]';

export interface ReportRouteDeps {
  db: Db;
  reviewers: () => string[];
  rateLimitPerMinute?: number;
}

type Report = typeof reports.$inferSelect;

export async function registerReportRoutes(app: FastifyInstance, deps: ReportRouteDeps): Promise<void> {
  const {db} = deps;

  const view = (r: Report, reporter?: {publicId: string; kind: string} | null) => ({
    reportId: r.publicId,
    targetType: r.targetType,
    targetId: r.targetId,
    reason: r.reason,
    details: r.details,
    status: r.status,
    action: r.action,
    note: r.note,
    ...(reporter !== undefined ? {reporter} : {}),
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolvedBy: r.resolvedBy,
  });

  /** The thing reported, and the account it belongs to (what a warn or a block acts on). */
  async function resolveTarget(type: Report['targetType'], id: string): Promise<{agentId: number | null}> {
    switch (type) {
      case 'listing': {
        const l = isPublicId(id)
          ? await db.query.listings.findFirst({where: eq(listings.publicId, id)})
          : null;
        if (!l) throw new PactoraError(ErrorCode.NOT_FOUND, `no listing ${id}`);
        return {agentId: l.clientAgentId};
      }
      case 'message': {
        const m = isPublicId(id)
          ? await db.query.jobMessages.findFirst({where: eq(jobMessages.publicId, id)})
          : null;
        if (!m) throw new PactoraError(ErrorCode.NOT_FOUND, `no message ${id}`);
        return {agentId: m.authorAgentId};
      }
      case 'person': {
        const a = isPublicId(id)
          ? await db.query.agents.findFirst({where: and(eq(agents.publicId, id), eq(agents.kind, 'person'))})
          : null;
        if (!a) throw new PactoraError(ErrorCode.NOT_FOUND, `no person ${id}`);
        return {agentId: a.id};
      }
      case 'agent': {
        const a = /^[1-9]\d{0,15}$/.test(id)
          ? await db.query.agents.findFirst({where: and(eq(agents.id, Number(id)), eq(agents.kind, 'agent'))})
          : null;
        if (!a) throw new PactoraError(ErrorCode.NOT_FOUND, `no agent ${id}`);
        return {agentId: a.id};
      }
      default:
        throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, `unknown target type ${String(type)}`);
    }
  }

  /** 10 an hour per client address: a report costs a row and a reviewer's time. */
  const limited = {
    config: {
      rateLimit: {
        max: Math.min(REPORTS_PER_HOUR, deps.rateLimitPerMinute ?? REPORTS_PER_HOUR),
        timeWindow: '1 hour',
      },
    },
  };

  app.post('/v1/reports', limited, async (request, reply) => {
    const actor = await actorOf(db, request);
    const body = ReportBody.parse(request.body ?? {});
    const target = await resolveTarget(body.targetType, body.targetId);
    if (target.agentId === actor.agent.id) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        'you cannot report yourself or your own listing or message',
      );
    }
    const [row] = await db
      .insert(reports)
      .values({
        reporterAgentId: actor.agent.id,
        targetType: body.targetType,
        targetId: body.targetId,
        targetAgentId: target.agentId,
        reason: body.reason,
        details: body.details,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      throw new PactoraError(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        'you already have an open report about this; a reviewer will look at it',
      );
    }
    return reply.status(201).send(view(row));
  });

  // ── the reviewers' queue ───────────────────────────────────────────────

  /** A compliance reviewer with a fresh sign-in (the same rule as the compliance queue). */
  async function reviewer(request: FastifyRequest): Promise<string> {
    const person = await authenticatePerson(db, request);
    const s = await db.query.sessions.findFirst({where: eq(sessions.id, person.sessionId)});
    if (!s || Date.now() - s.createdAt.getTime() > ADMIN_SESSION_MAX_MS) {
      throw new PactoraError(
        ErrorCode.UNAUTHORIZED,
        'admin needs a sign-in less than an hour old: sign in again',
      );
    }
    if (!deps.reviewers().includes(person.account)) {
      throw new PactoraError(ErrorCode.FORBIDDEN, 'only compliance reviewers may see or resolve reports');
    }
    return person.account;
  }

  app.get('/v1/admin/reports', async (request) => {
    await reviewer(request);
    const q = ReportsQuery.parse(request.query ?? {});
    const rows = await db
      .select({r: reports, reporterPublicId: agents.publicId, reporterKind: agents.kind})
      .from(reports)
      .innerJoin(agents, eq(agents.id, reports.reporterAgentId))
      .where(eq(reports.status, q.status))
      .orderBy(desc(reports.id))
      .limit(q.limit);
    return {
      status: q.status,
      reports: rows.map(({r, reporterPublicId, reporterKind}) =>
        view(r, {publicId: reporterPublicId, kind: reporterKind}),
      ),
    };
  });

  app.post('/v1/admin/reports/:id/resolve', async (request) => {
    const who = await reviewer(request);
    const {id} = request.params as {id: string};
    if (!isPublicId(id)) throw new PactoraError(ErrorCode.NOT_FOUND, `no report ${id}`);
    const body = ResolveBody.parse(request.body ?? {});
    const out = await db.transaction(async (tx) => {
      const [r] = await tx.select().from(reports).where(eq(reports.publicId, id)).for('update');
      if (!r) throw new PactoraError(ErrorCode.NOT_FOUND, `no report ${id}`);
      if (r.status !== 'open') {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          `this report is already ${r.status} (${r.action ?? 'no action'})`,
        );
      }
      const subject = r.targetAgentId;
      switch (body.action) {
        case 'hide':
          if (r.targetType === 'listing') {
            await tx
              .update(listings)
              .set({hiddenAt: new Date(), updatedAt: new Date()})
              .where(eq(listings.publicId, r.targetId));
          } else if (r.targetType === 'message') {
            await tx
              .update(jobMessages)
              .set({body: HIDDEN_MESSAGE, hiddenAt: new Date()})
              .where(eq(jobMessages.publicId, r.targetId));
          } else if (subject !== null) {
            await tx
              .update(publicProfiles)
              .set({published: false, publishedAt: null, updatedAt: new Date()})
              .where(eq(publicProfiles.agentId, subject));
          }
          break;
        case 'warn':
          if (subject === null)
            throw new PactoraError(ErrorCode.INVALID_STATE, 'this report names no account to warn');
          await recordAgentEvent(tx, {
            agentId: subject,
            role: 'account',
            kind: 'account.warned',
            payload: {reportId: r.publicId, targetType: r.targetType, reason: r.reason, note: body.note},
            dedupeKey: `account.warned:${r.publicId}`,
          });
          break;
        case 'block':
          if (subject === null)
            throw new PactoraError(ErrorCode.INVALID_STATE, 'this report names no account to block');
          await setStanding(
            tx,
            subject,
            'blocked',
            `blocked after a moderation report (${r.reason}): ${body.note}`,
            who,
          );
          break;
        case 'none':
          break;
      }
      const [updated] = await tx
        .update(reports)
        .set({
          status: body.action === 'none' ? 'dismissed' : 'resolved',
          action: body.action,
          note: body.note,
          resolvedBy: who,
          resolvedAt: new Date(),
        })
        .where(eq(reports.id, r.id))
        .returning();
      await audit(tx, who, `report.${body.action}`, {
        ...(subject !== null ? {agentId: subject} : {}),
        detail: {
          report: r.publicId,
          targetType: r.targetType,
          targetId: r.targetId,
          reason: r.reason,
          note: body.note,
        },
      });
      return updated!;
    });
    return {reportId: out.publicId, status: out.status, action: out.action};
  });

  void sql;
}
