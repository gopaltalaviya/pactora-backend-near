import type {FastifyInstance, FastifyRequest} from 'fastify';
import {and, desc, eq, inArray, lt} from 'drizzle-orm';
import {z} from 'zod';
import {complianceCases, complianceDecisions, identityVerifications, standingOf, type Db} from '@pactora/db';
import type {ChainConfig} from '@pactora/config';
import {ErrorCode, PactoraError} from '@pactora/shared';
import {actorOf} from '../actor.js';
import {authenticatePerson} from '../auth.js';
import {
  audit,
  decide,
  openCases,
  SimulatedIdentityProvider,
  type IdentityProvider,
  type SanctionsIndex,
} from '../compliance.js';
import {isPublicId} from './jobs.js';

/**
 * Identity checks for people, and the compliance reviewers' queue
 * (docs/26 F13, F14). Screening runs BEFORE any vendor session: a strong
 * match holds the account and no session is created. Only the minimum is
 * kept: the legal name screened, the outcome, whether a document was
 * verified, and the provider's session id.
 */

export const StartBody = z.object({
  legalName: z
    .string()
    .trim()
    .min(2, 'legalName is 2-200 characters')
    .max(200, 'legalName is 2-200 characters'),
});
export const SimulatedBody = z.object({
  outcome: z.enum(['approved', 'rejected']),
  documentVerified: z.boolean().default(true),
});
export const DecisionBody = z.object({
  decision: z.enum(['clear', 'confirm']),
  reason: z.string(),
  caseVersion: z.number().int().min(1),
});
export const CasesQuery = z.object({status: z.enum(['open', 'cleared', 'confirmed']).default('open')});

export interface KycRouteDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  provider?: IdentityProvider;
  sanctions?: SanctionsIndex;
  /** Screening off (development only; production refuses to start without it). */
  screening: boolean;
  /** NEAR accounts allowed to decide cases. Read on every request. */
  reviewers: () => string[];
}

const view = (v: typeof identityVerifications.$inferSelect) => ({
  verificationId: v.publicId,
  provider: v.provider,
  status: v.status,
  documentVerified: v.documentVerified,
  createdAt: v.createdAt,
  decidedAt: v.decidedAt,
});

/** Re-read a session from its provider and record what it says. Never trusts a webhook body. */
export async function refreshVerification(
  db: Db,
  provider: IdentityProvider,
  row: typeof identityVerifications.$inferSelect,
) {
  if (row.status !== 'pending' || !row.providerSessionId) return row;
  const d = await provider.fetchDecision(row.providerSessionId);
  // The session must be the one we opened for this verification.
  if (d.vendorData !== row.publicId) {
    await audit(db, 'system', 'kyc.vendor_data_mismatch', {
      agentId: row.agentId,
      detail: {verification: row.publicId},
    });
    return row;
  }
  if (d.status === 'pending') return row;
  // "Approved" without a verified identity document is not approval.
  const status = d.status === 'approved' && !d.documentVerified ? 'rejected' : d.status;
  const [updated] = await db
    .update(identityVerifications)
    .set({status, documentVerified: status === 'approved' && d.documentVerified, decidedAt: new Date()})
    .where(and(eq(identityVerifications.id, row.id), eq(identityVerifications.status, 'pending')))
    .returning();
  if (updated) {
    await audit(db, 'system', `kyc.${status}`, {
      agentId: row.agentId,
      detail: {
        verification: row.publicId,
        provider: provider.name,
        ...(d.status === 'approved' && !d.documentVerified ? {why: 'no verified document'} : {}),
      },
    });
  }
  return updated ?? row;
}

/** The sweep: poll pending sessions (a webhook can be lost) and apply retention. */
export async function kycSweep(db: Db, provider: IdentityProvider | undefined, now = new Date()) {
  if (provider) {
    const pending = await db
      .select()
      .from(identityVerifications)
      .where(
        and(eq(identityVerifications.status, 'pending'), eq(identityVerifications.provider, provider.name)),
      )
      .limit(100);
    for (const row of pending) await refreshVerification(db, provider, row).catch(() => undefined);
  }
  // Retention (docs/26 F27): an unfinished check expires after 30 days; a
  // rejected or expired one is deleted after 90. Approved ones are kept,
  // with the minimum fields above. The audit trail is never deleted.
  const day = 86_400_000;
  await db
    .update(identityVerifications)
    .set({status: 'expired', decidedAt: now})
    .where(
      and(
        eq(identityVerifications.status, 'pending'),
        lt(identityVerifications.createdAt, new Date(now.getTime() - 30 * day)),
      ),
    );
  await db
    .delete(identityVerifications)
    .where(
      and(
        inArray(identityVerifications.status, ['rejected', 'expired']),
        lt(identityVerifications.decidedAt, new Date(now.getTime() - 90 * day)),
      ),
    );
}

export async function registerKycRoutes(app: FastifyInstance, deps: KycRouteDeps): Promise<void> {
  const {db} = deps;

  const reviewer = async (request: FastifyRequest) => {
    const person = await authenticatePerson(db, request);
    if (!deps.reviewers().includes(person.account)) {
      throw new PactoraError(ErrorCode.FORBIDDEN, 'only compliance reviewers may see or decide cases');
    }
    return person.account;
  };

  app.get('/v1/kyc', async (request) => {
    const actor = await actorOf(db, request);
    if (actor.via !== 'person') throw new PactoraError(ErrorCode.FORBIDDEN, 'identity checks are for people');
    const [latest] = await db
      .select()
      .from(identityVerifications)
      .where(eq(identityVerifications.agentId, actor.agent.id))
      .orderBy(desc(identityVerifications.id))
      .limit(1);
    const row = latest && deps.provider ? await refreshVerification(db, deps.provider, latest) : latest;
    return {
      standing: await standingOf(db, actor.agent.id),
      provider: deps.provider ? {name: deps.provider.name, simulated: deps.provider.simulated} : null,
      screening: deps.screening,
      // What wallet screening covers, said plainly rather than faked.
      walletScreening: 'not available: no sanctions list names NEAR accounts',
      verification: row ? view(row) : null,
    };
  });

  app.post('/v1/kyc/start', async (request, reply) => {
    const actor = await actorOf(db, request);
    if (actor.via !== 'person') throw new PactoraError(ErrorCode.FORBIDDEN, 'identity checks are for people');
    const provider = deps.provider;
    if (!provider)
      throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'no identity provider is configured');
    const body = StartBody.parse(request.body ?? {});
    const standing = await standingOf(db, actor.agent.id);
    if (standing === 'blocked')
      throw new PactoraError(ErrorCode.FORBIDDEN, 'this account is blocked after a compliance review');

    const current = await db.query.identityVerifications.findFirst({
      where: and(
        eq(identityVerifications.agentId, actor.agent.id),
        inArray(identityVerifications.status, ['pending', 'approved', 'held']),
      ),
      orderBy: [desc(identityVerifications.id)],
    });
    if (current) return reply.status(200).send({...view(current), replayed: true});

    // Screening first. With it on and no list loaded, nothing proceeds: an
    // empty list is not a clean result.
    let hits: Awaited<ReturnType<SanctionsIndex['screen']>>['hits'] = [];
    if (deps.screening) {
      if (!deps.sanctions)
        throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'sanctions screening is not configured');
      const r = await deps.sanctions.screen(body.legalName);
      if (r.sources.length === 0) {
        throw new PactoraError(
          ErrorCode.UPSTREAM_UNAVAILABLE,
          'no sanctions list is loaded yet; try again later',
        );
      }
      hits = r.hits;
    }
    const account = actor.caller.kind === 'person' ? actor.caller.account : actor.agent.ownerAddress;
    const row = await db.transaction(async (tx) => {
      const [v] = await tx
        .insert(identityVerifications)
        .values({agentId: actor.agent.id, provider: provider.name, legalName: body.legalName})
        .returning();
      const {held} = await openCases(tx, actor.agent.id, account, body.legalName, hits.slice(0, 5));
      if (held) {
        const [h] = await tx
          .update(identityVerifications)
          .set({status: 'held'})
          .where(eq(identityVerifications.id, v!.id))
          .returning();
        return {row: h!, held: true};
      }
      return {row: v!, held: false};
    });
    if (row.held) {
      return reply.status(202).send({
        ...view(row.row),
        next: 'a compliance review is needed before the identity check can start; you will be told the outcome',
      });
    }
    const session = await provider.createSession({vendorData: row.row.publicId});
    const [pending] = await db
      .update(identityVerifications)
      .set({status: 'pending', providerSessionId: session.sessionId})
      .where(eq(identityVerifications.id, row.row.id))
      .returning();
    await audit(db, 'system', 'kyc.session', {
      agentId: actor.agent.id,
      detail: {verification: row.row.publicId, provider: provider.name},
    });
    return reply.status(201).send({...view(pending!), url: session.url, simulated: provider.simulated});
  });

  // The provider's call: verified, then used only to know WHICH session to
  // re-read. Its own scope keeps the body as the raw string the vendor
  // signed: a parsed-then-reserialised body need not be byte-identical.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', {parseAs: 'string'}, (_req, body, done) =>
      done(null, body),
    );
    scope.post('/v1/kyc/webhook', async (request, reply) => {
      const provider = deps.provider;
      if (!provider) throw new PactoraError(ErrorCode.NOT_FOUND, 'no identity provider');
      const raw = typeof request.body === 'string' ? request.body : '';
      const headers = Object.fromEntries(
        Object.entries(request.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
      );
      const sessionId = provider.verifyWebhook(raw, headers, Math.floor(Date.now() / 1000));
      // A bad signature is acknowledged and ignored: answering differently tells a forger what works.
      if (!sessionId) return reply.status(202).send({accepted: false});
      const row = await db.query.identityVerifications.findFirst({
        where: and(
          eq(identityVerifications.provider, provider.name),
          eq(identityVerifications.providerSessionId, sessionId),
        ),
      });
      if (row) await refreshVerification(db, provider, row);
      return reply.status(202).send({accepted: true});
    });
  });

  // Testnet only: what the simulated provider's page buttons do.
  app.post('/v1/kyc/simulated/:sessionId', async (request) => {
    const provider = deps.provider;
    if (!(provider instanceof SimulatedIdentityProvider))
      throw new PactoraError(ErrorCode.NOT_FOUND, 'no simulated provider');
    const person = await authenticatePerson(db, request);
    if (!deps.chains[person.chainId]?.testnet)
      throw new PactoraError(ErrorCode.FORBIDDEN, 'the simulated provider is testnet only');
    const {sessionId} = request.params as {sessionId: string};
    const body = SimulatedBody.parse(request.body ?? {});
    const row = await db.query.identityVerifications.findFirst({
      where: and(
        eq(identityVerifications.provider, 'simulated'),
        eq(identityVerifications.providerSessionId, sessionId),
      ),
    });
    const actor = await actorOf(db, request);
    if (!row || row.agentId !== actor.agent.id)
      throw new PactoraError(ErrorCode.NOT_FOUND, 'no such session of yours');
    provider.complete(sessionId, body.outcome, body.documentVerified);
    return {
      verificationId: row.publicId,
      status: (await refreshVerification(db, provider, row)).status,
      simulated: true,
    };
  });

  // ── the reviewers' queue ─────────────────────────────────────────────

  app.get('/v1/compliance/cases', async (request) => {
    await reviewer(request);
    const q = CasesQuery.parse(request.query ?? {});
    const rows = await db
      .select()
      .from(complianceCases)
      .where(eq(complianceCases.status, q.status))
      .orderBy(desc(complianceCases.id))
      .limit(100);
    const decisions = rows.length
      ? await db
          .select()
          .from(complianceDecisions)
          .where(
            inArray(
              complianceDecisions.caseId,
              rows.map((r) => r.id),
            ),
          )
      : [];
    return {
      cases: rows.map((c) => ({
        caseId: c.publicId,
        subjectAccount: c.subjectAccount,
        source: c.source,
        entryRef: c.entryRef,
        queryName: c.queryName,
        matchedName: c.matchedName,
        score: Number(c.score),
        strength: c.strength,
        status: c.status,
        version: c.version,
        createdAt: c.createdAt,
        decisions: decisions
          .filter((d) => d.caseId === c.id)
          .map((d) => ({reviewer: d.reviewer, decision: d.decision, reason: d.reason, at: d.createdAt})),
      })),
    };
  });

  app.post('/v1/compliance/cases/:id/decisions', async (request, reply) => {
    const who = await reviewer(request);
    const {id} = request.params as {id: string};
    if (!isPublicId(id)) throw new PactoraError(ErrorCode.NOT_FOUND, `no case ${id}`);
    const body = DecisionBody.parse(request.body ?? {});
    const out = await decide(db, {casePublicId: id, reviewer: who, ...body});
    return reply.status(out.replayed ? 200 : 201).send({caseId: id, ...out});
  });
}
