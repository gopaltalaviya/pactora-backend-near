import type {FastifyInstance} from 'fastify';
import {and, asc, desc, eq, gt, inArray, isNull, or, sql} from 'drizzle-orm';
import {z} from 'zod';
import {
  accountDeleteChallenges,
  agentCapabilities,
  agentEventReads,
  agentEvents,
  agents,
  apiKeys,
  applications,
  channelLinks,
  disputeNotes,
  identityVerifications,
  jobDrafts,
  jobFiles,
  jobMessages,
  jobs,
  linkCodes,
  listings,
  partyReviews,
  publicProfiles,
  reports,
  revokeSessionsOf,
  sessions,
  standingOf,
  webhookDeliveries,
  webhooks,
  type Db,
} from '@pactora/db';
import type {ChainConfig} from '@pactora/config';
import {ErrorCode, PactoraError} from '@pactora/shared';
import type {ObjectStore} from '@pactora/storage';
import {personAgentOf} from '../actor.js';
import {authenticatePerson} from '../auth.js';
import {CHALLENGE_TTL_MS, NONCE_RE, newNonce} from '../challenges.js';
import {audit} from '../compliance.js';
import {notifyApplicants} from '../listing-slots.js';

/**
 * A person's data: all of it out (GET /v1/me/export) and, on request, gone
 * (DELETE /v1/me) — 2026-11-09, migration 0029.
 *
 * Deletion scrubs what is personal and off chain: profile and listing
 * texts, bids, chat, drafts, dispute notes, photos (bytes and keys),
 * channel links, sessions, API keys, webhooks, the KYC name. It keeps what
 * the other party's history and the chain need: job rows with their ids,
 * amounts, states and hashes; job events; reviews' ratings; standing and
 * the compliance audit. Nothing on chain can be deleted, and the response
 * says so. Refused while any job of the account is open: an open escrow
 * has a counterparty waiting on it.
 */

export const DeleteMeBody = z.object({
  nonce: z.string().regex(NONCE_RE, 'nonce comes from POST /v1/me/delete/challenge'),
});

export const DELETED_NAME = 'deleted account';
/** Long enough for every text column's minimum length (listings, proposals, reviews). */
export const DELETED_TEXT = '[deleted by the account owner]';
export const OPEN_STATES = ['created', 'accepted', 'submitted', 'disputed'] as const;

export interface AccountRouteDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  objectStore?: ObjectStore;
}

export async function registerAccountRoutes(app: FastifyInstance, deps: AccountRouteDeps): Promise<void> {
  const {db} = deps;

  app.get('/v1/me/export', async (request, reply) => {
    const caller = await authenticatePerson(db, request);
    const me = await personAgentOf(db, caller.account, caller.chainId);
    const sessionsOf = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.accountId, caller.account), isNull(sessions.revokedAt)))
      .orderBy(asc(sessions.id));
    const base = {
      exportedAt: new Date().toISOString(),
      account: caller.account,
      chainId: caller.chainId,
      sessions: sessionsOf.map((s) => ({
        sessionId: String(s.id),
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        expiresAt: s.expiresAt,
        current: s.id === caller.sessionId,
      })),
      onChain:
        'Agent registrations, jobs, payments, reputation reviews and the hashes committed by them live on the NEAR blockchain and cannot be deleted or changed by Pactora.',
    };
    reply.header('content-disposition', `attachment; filename="pactora-export-${caller.account}.json"`);
    if (!me) return {...base, person: null};

    const id = me.id;
    const [
      profile,
      caps,
      myListings,
      myBids,
      myJobs,
      myMessages,
      myDrafts,
      myNotes,
      myFiles,
      kyc,
      channels,
      hooks,
      feed,
      myReports,
      reviews,
    ] = await Promise.all([
      db.query.publicProfiles.findFirst({where: eq(publicProfiles.agentId, id)}),
      db
        .select({c: agentCapabilities.capability})
        .from(agentCapabilities)
        .where(eq(agentCapabilities.agentId, id)),
      db.select().from(listings).where(eq(listings.clientAgentId, id)).orderBy(asc(listings.id)),
      db
        .select({a: applications, listingPublicId: listings.publicId, jobPublicId: jobs.publicId})
        .from(applications)
        .innerJoin(listings, eq(listings.id, applications.listingId))
        .leftJoin(jobs, eq(jobs.id, applications.jobId))
        .where(eq(applications.applicantAgentId, id))
        .orderBy(asc(applications.id)),
      db
        .select()
        .from(jobs)
        .where(or(eq(jobs.clientAgentId, id), eq(jobs.workerAgentId, id)))
        .orderBy(asc(jobs.id)),
      db
        .select({m: jobMessages, jobPublicId: jobs.publicId})
        .from(jobMessages)
        .innerJoin(jobs, eq(jobs.id, jobMessages.jobId))
        .where(eq(jobMessages.authorAgentId, id))
        .orderBy(asc(jobMessages.id)),
      db
        .select({d: jobDrafts, jobPublicId: jobs.publicId})
        .from(jobDrafts)
        .innerJoin(jobs, eq(jobs.id, jobDrafts.jobId))
        .where(eq(jobDrafts.authorAgentId, id))
        .orderBy(asc(jobDrafts.id)),
      db
        .select({n: disputeNotes, jobPublicId: jobs.publicId})
        .from(disputeNotes)
        .innerJoin(jobs, eq(jobs.id, disputeNotes.jobId))
        .where(eq(disputeNotes.authorAgentId, id))
        .orderBy(asc(disputeNotes.id)),
      db
        .select({f: jobFiles, jobPublicId: jobs.publicId})
        .from(jobFiles)
        .innerJoin(jobs, eq(jobs.id, jobFiles.jobId))
        .where(eq(jobFiles.uploaderAgentId, id))
        .orderBy(asc(jobFiles.id)),
      db
        .select()
        .from(identityVerifications)
        .where(eq(identityVerifications.agentId, id))
        .orderBy(desc(identityVerifications.id))
        .limit(1),
      db.select().from(channelLinks).where(eq(channelLinks.agentId, id)),
      db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.agentId, id), isNull(webhooks.deletedAt))),
      db
        .select({e: agentEvents, jobPublicId: jobs.publicId, listingPublicId: listings.publicId})
        .from(agentEvents)
        .leftJoin(jobs, eq(jobs.id, agentEvents.jobId))
        .leftJoin(listings, eq(listings.id, agentEvents.listingId))
        .where(eq(agentEvents.agentId, id))
        .orderBy(asc(agentEvents.seq)),
      db.select().from(reports).where(eq(reports.reporterAgentId, id)).orderBy(asc(reports.id)),
      db.select().from(partyReviews).where(eq(partyReviews.authorAgentId, id)).orderBy(asc(partyReviews.id)),
    ]);
    const v = kyc[0];
    return {
      ...base,
      person: {
        publicId: me.publicId,
        agentId: String(me.id),
        chainAgentId: me.chainAgentId,
        name: me.name,
        description: me.description,
        location: me.location,
        active: me.active,
        registeredAt: me.registeredAt,
        deletedAt: me.deletedAt,
      },
      profile: profile
        ? {
            displayName: profile.displayName,
            headline: profile.headline,
            bio: profile.bio,
            published: profile.published,
            showAccount: profile.showAccount,
            skills: profile.skills,
            location: profile.location,
            availability: profile.available,
            showTaskList: profile.showTaskList,
            alerts: profile.alerts,
            publishedAt: profile.publishedAt,
          }
        : null,
      capabilities: caps.map((c) => c.c),
      standing: await standingOf(db, id),
      listings: myListings.map((l) => ({
        listingId: l.publicId,
        title: l.title,
        description: l.description,
        category: l.category,
        skills: l.skills,
        location: l.location,
        maxPriceBaseUnits: l.maxPrice,
        maxWorkers: l.maxWorkers,
        status: l.status,
        criteria: l.criteria,
        deadline: l.deadline,
        createdAt: l.createdAt,
      })),
      applications: myBids.map(({a, listingPublicId, jobPublicId}) => ({
        applicationId: a.publicId,
        listingId: listingPublicId,
        priceBaseUnits: a.price,
        proposal: a.proposal,
        status: a.status,
        reason: a.reason,
        jobId: jobPublicId,
        createdAt: a.createdAt,
        decidedAt: a.decidedAt,
      })),
      // Metadata, plus what I wrote: the spec I posted as client, the result I delivered as worker.
      jobs: myJobs.map((j) => ({
        jobId: j.publicId,
        chainJobId: j.chainJobId,
        role: j.clientAgentId === id ? 'client' : 'worker',
        state: j.state,
        path: j.path,
        amount: j.amount,
        fee: j.fee,
        specHash: j.specHash,
        resultHash: j.resultHash,
        ...(j.clientAgentId === id ? {spec: j.spec} : {}),
        ...(j.workerAgentId === id ? {result: j.result} : {}),
        createdAt: j.createdAt,
        settledAt: j.settledAt,
      })),
      messages: myMessages.map(({m, jobPublicId}) => ({
        messageId: m.publicId,
        jobId: jobPublicId,
        body: m.body,
        at: m.createdAt,
      })),
      drafts: myDrafts.map(({d, jobPublicId}) => ({
        draftId: d.publicId,
        jobId: jobPublicId,
        round: d.round,
        snapshotHash: d.snapshotHash,
        snapshot: d.snapshot,
        at: d.createdAt,
      })),
      disputeNotes: myNotes.map(({n, jobPublicId}) => ({
        noteId: n.publicId,
        jobId: jobPublicId,
        text: n.body,
        at: n.createdAt,
      })),
      files: myFiles.map(({f, jobPublicId}) => ({
        fileId: f.publicId,
        jobId: jobPublicId,
        sha256: f.sha256,
        mime: f.mime,
        size: f.size,
        purpose: f.purpose,
        withdrawnAt: f.withdrawnAt,
        /** Readable with this session while it lasts; the bytes are never in the export itself. */
        url:
          f.objectKey.startsWith('purged/') || f.objectKey.startsWith('deleted/')
            ? null
            : `/v1/files/${f.publicId}`,
      })),
      kyc: v
        ? {
            verificationId: v.publicId,
            provider: v.provider,
            status: v.status,
            documentVerified: v.documentVerified,
            legalName: v.legalName,
            createdAt: v.createdAt,
            decidedAt: v.decidedAt,
          }
        : null,
      channels: channels.map((c) => ({channel: c.channel, address: c.address, since: c.createdAt})),
      webhooks: hooks.map((h) => ({
        webhookId: h.publicId,
        url: h.url,
        kinds: h.kinds,
        active: h.active,
        createdAt: h.createdAt,
      })),
      events: feed.map(({e, jobPublicId, listingPublicId}) => ({
        seq: e.seq,
        kind: e.kind,
        role: e.role,
        jobId: jobPublicId,
        listingId: listingPublicId,
        payload: e.payload,
        at: e.createdAt,
      })),
      reviewsWritten: reviews.map((r) => ({
        reviewId: r.publicId,
        rating: r.rating,
        body: r.body,
        at: r.createdAt,
      })),
      reportsFiled: myReports.map((r) => ({
        reportId: r.publicId,
        targetType: r.targetType,
        reason: r.reason,
        status: r.status,
        at: r.createdAt,
      })),
    };
  });

  /** The confirmation a deletion needs: a nonce for this account, five minutes, used once. */
  app.post('/v1/me/delete/challenge', async (request, reply) => {
    const caller = await authenticatePerson(db, request);
    const nonce = newNonce();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    await db.transaction(async (tx) => {
      await tx.delete(accountDeleteChallenges).where(eq(accountDeleteChallenges.accountId, caller.account));
      await tx
        .insert(accountDeleteChallenges)
        .values({nonce, accountId: caller.account, chainId: caller.chainId, expiresAt});
    });
    return reply.status(201).send({
      nonce,
      expiresAt: expiresAt.toISOString(),
      warning:
        'Deleting scrubs your off-chain data and ends every session. Jobs, payments and reviews on the NEAR blockchain cannot be deleted.',
    });
  });

  app.delete('/v1/me', async (request) => {
    const caller = await authenticatePerson(db, request);
    const body = DeleteMeBody.parse(request.body ?? {});
    const used = await db
      .delete(accountDeleteChallenges)
      .where(
        and(
          eq(accountDeleteChallenges.nonce, body.nonce),
          eq(accountDeleteChallenges.accountId, caller.account),
          gt(accountDeleteChallenges.expiresAt, new Date()),
        ),
      )
      .returning({nonce: accountDeleteChallenges.nonce});
    if (used.length === 0) {
      throw new PactoraError(
        ErrorCode.UNAUTHORIZED,
        'no live deletion challenge for this account — request one from POST /v1/me/delete/challenge',
      );
    }

    const me = await personAgentOf(db, caller.account, caller.chainId);
    const scrubbed = {
      profile: 0,
      listingsCancelled: 0,
      applications: 0,
      messages: 0,
      drafts: 0,
      disputeNotes: 0,
      files: 0,
      reviews: 0,
      channels: 0,
      webhooks: 0,
      apiKeys: 0,
      sessions: 0,
    };
    if (me) {
      const open = await db
        .select({publicId: jobs.publicId, state: jobs.state})
        .from(jobs)
        .where(
          and(
            or(eq(jobs.clientAgentId, me.id), eq(jobs.workerAgentId, me.id)),
            inArray(jobs.state, [...OPEN_STATES]),
          ),
        );
      if (open.length > 0) {
        const err = new PactoraError(
          ErrorCode.INVALID_STATE,
          `${open.length} job(s) are still open (${open.map((j) => `${j.publicId}: ${j.state}`).join(', ')}); finish or cancel them first`,
        );
        // The ids as a list too (`openJobs` in the problem body), so a page can link them.
        throw Object.assign(err, {extra: {openJobs: open.map((j) => j.publicId)}});
      }
      const files = await db.select().from(jobFiles).where(eq(jobFiles.uploaderAgentId, me.id));
      // The bytes first: a row that names a key nothing serves is the one safe order.
      for (const f of files) {
        if (deps.objectStore && !f.objectKey.startsWith('purged/') && !f.objectKey.startsWith('deleted/')) {
          await deps.objectStore.delete(f.objectKey);
        }
      }
      await db.transaction(async (tx) => {
        const now = new Date();
        // My open listings: cancelled, their pending bidders told.
        const mine = await tx
          .select()
          .from(listings)
          .where(and(eq(listings.clientAgentId, me.id), inArray(listings.status, ['open', 'closed'])));
        for (const l of mine) {
          await tx
            .update(listings)
            .set({status: 'cancelled', closedAt: now, reserved: '0', updatedAt: now})
            .where(eq(listings.id, l.id));
          const set = await tx
            .update(applications)
            .set({
              status: 'rejected',
              reason: 'The client deleted their account.',
              reopenable: false,
              decidedAt: now,
            })
            .where(and(eq(applications.listingId, l.id), eq(applications.status, 'pending')))
            .returning({publicId: applications.publicId, applicantAgentId: applications.applicantAgentId});
          await notifyApplicants(tx, l, set, 'listing.cancelled', '');
        }
        scrubbed.listingsCancelled = mine.length;
        await tx
          .update(listings)
          .set({
            title: DELETED_TEXT,
            description: DELETED_TEXT,
            criteria: DELETED_TEXT,
            location: '',
            updatedAt: now,
          })
          .where(eq(listings.clientAgentId, me.id));
        scrubbed.applications = (
          await tx
            .update(applications)
            .set({proposal: DELETED_TEXT})
            .where(eq(applications.applicantAgentId, me.id))
            .returning({id: applications.id})
        ).length;
        await tx
          .update(applications)
          .set({status: 'withdrawn', decidedAt: now})
          .where(and(eq(applications.applicantAgentId, me.id), eq(applications.status, 'pending')));
        scrubbed.messages = (
          await tx
            .update(jobMessages)
            .set({body: DELETED_TEXT, hiddenAt: now})
            .where(eq(jobMessages.authorAgentId, me.id))
            .returning({id: jobMessages.id})
        ).length;
        scrubbed.drafts = (
          (await tx.execute(sql`
            UPDATE job_drafts SET snapshot = jsonb_build_object('deleted', true, 'snapshotHash', snapshot_hash)
             WHERE author_agent_id = ${me.id} RETURNING id`)) as unknown as unknown[]
        ).length;
        scrubbed.disputeNotes = (
          await tx
            .update(disputeNotes)
            .set({body: DELETED_TEXT})
            .where(eq(disputeNotes.authorAgentId, me.id))
            .returning({id: disputeNotes.id})
        ).length;
        for (const f of files) {
          await tx
            .update(jobFiles)
            .set({objectKey: `deleted/${f.publicId}`, withdrawnAt: f.withdrawnAt ?? now})
            .where(eq(jobFiles.id, f.id));
        }
        scrubbed.files = files.length;
        scrubbed.reviews = (
          await tx
            .update(partyReviews)
            .set({body: DELETED_TEXT})
            .where(eq(partyReviews.authorAgentId, me.id))
            .returning({id: partyReviews.id})
        ).length;
        scrubbed.profile = (
          await tx
            .delete(publicProfiles)
            .where(eq(publicProfiles.agentId, me.id))
            .returning({id: publicProfiles.agentId})
        ).length;
        await tx.delete(agentCapabilities).where(eq(agentCapabilities.agentId, me.id));
        await tx
          .update(identityVerifications)
          .set({legalName: '[deleted]', providerSessionId: null})
          .where(eq(identityVerifications.agentId, me.id));
        scrubbed.channels = (
          await tx
            .delete(channelLinks)
            .where(eq(channelLinks.agentId, me.id))
            .returning({id: channelLinks.id})
        ).length;
        await tx.delete(linkCodes).where(eq(linkCodes.agentId, me.id));
        const hooks = await tx
          .update(webhooks)
          .set({deletedAt: now, active: false})
          .where(and(eq(webhooks.agentId, me.id), isNull(webhooks.deletedAt)))
          .returning({id: webhooks.id});
        scrubbed.webhooks = hooks.length;
        if (hooks.length > 0) {
          await tx
            .update(webhookDeliveries)
            .set({status: 'failed', lastError: 'account deleted'})
            .where(
              and(
                inArray(
                  webhookDeliveries.webhookId,
                  hooks.map((h) => h.id),
                ),
                eq(webhookDeliveries.status, 'pending'),
              ),
            );
        }
        scrubbed.apiKeys = (
          await tx
            .update(apiKeys)
            .set({revokedAt: now})
            .where(and(eq(apiKeys.agentId, me.id), isNull(apiKeys.revokedAt)))
            .returning({id: apiKeys.id})
        ).length;
        // My feed is mine: gone, with the read marker.
        await tx.delete(agentEvents).where(eq(agentEvents.agentId, me.id));
        await tx.delete(agentEventReads).where(eq(agentEventReads.agentId, me.id));
        await tx
          .update(agents)
          .set({
            name: DELETED_NAME,
            description: null,
            location: '',
            endpointUrl: null,
            metadataUri: null,
            active: false,
            deletedAt: now,
          })
          .where(eq(agents.id, me.id));
        await audit(tx, caller.account, 'account.deleted', {agentId: me.id, detail: {scrubbed}});
      });
    } else {
      await audit(db, caller.account, 'account.deleted', {detail: {person: false}});
    }
    // Last: every session, this one included — the response is the last thing it gets.
    scrubbed.sessions = await revokeSessionsOf(db, [caller.account], 'signed out: the account was deleted');
    return {
      deleted: true,
      account: caller.account,
      scrubbed,
      kept: 'job rows (ids, amounts, states, hashes), job events, review ratings, standing and the compliance audit',
      onChain: 'Agent registrations, jobs, payments and reviews on the NEAR blockchain cannot be deleted.',
    };
  });
}
