import {and, eq, sql} from 'drizzle-orm';
import {applications, listingSlots, listings, lockAgentEventSeqs, type Db} from '@pactora/db';
import {recordAgentEvent} from './agent-events.js';

/**
 * The bids a listing set aside, and the slot a worker gives back.
 *
 * In a module of its own because two routes need it: listings.ts (close,
 * reopen, cancel, fill) and the job declines in jobs.ts and
 * person-actions.ts — and jobs.ts cannot import listings.ts, which imports
 * it.
 */

type Writer = Pick<Db, 'execute'>;

export const DECLINED_REASON = 'The worker declined the job.';

/**
 * One feed event per applicant about their bid: set aside by a close or a
 * fill, revived by a reopen, dropped by a cancel. The dedupe suffix tells
 * one close from a later one; the application id alone would let a listing
 * closed, reopened and closed again notify its bidders once.
 */
export async function notifyApplicants(
  tx: Writer,
  listing: {id: number; publicId: string},
  rows: {publicId: string; applicantAgentId: number}[],
  kind: 'listing.closed' | 'listing.reopened' | 'listing.cancelled' | 'listing.expired',
  dedupeSuffix: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  // Agent-id order, all locks first: in row order this deadlocked with the
  // indexer's batch (pnpm swarm:local, 2026-11-09; packages/db event-locks).
  await lockAgentEventSeqs(
    tx,
    rows.map((r) => r.applicantAgentId),
  );
  for (const r of [...rows].sort((a, b) => a.applicantAgentId - b.applicantAgentId)) {
    await recordAgentEvent(tx, {
      agentId: r.applicantAgentId,
      role: 'applicant',
      kind,
      payload: {listingId: listing.publicId, applicationId: r.publicId, ...extra},
      listingId: listing.id,
      dedupeKey: `${kind}:${r.publicId}${dedupeSuffix}`,
    });
  }
}

/**
 * Put back exactly the bids a close or a fill set aside — by the flag, never
 * by the reason text — skipping an applicant who has made a live bid since.
 * Answers the revived rows, so their applicants can be told.
 */
export async function reviveSetAsideBids(
  tx: Writer,
  listingId: number,
): Promise<{publicId: string; applicantAgentId: number}[]> {
  const rows = (await tx.execute(sql`
    UPDATE applications a SET status = 'pending', reopenable = false, reason = NULL, decided_at = NULL
     WHERE a.listing_id = ${listingId} AND a.reopenable AND a.status = 'rejected'
       AND NOT EXISTS (SELECT 1 FROM applications b
                        WHERE b.listing_id = a.listing_id AND b.applicant_agent_id = a.applicant_agent_id
                          AND b.status IN ('pending', 'selected'))
       AND a.id = (SELECT max(c.id) FROM applications c
                    WHERE c.listing_id = a.listing_id AND c.applicant_agent_id = a.applicant_agent_id AND c.reopenable)
     RETURNING a.public_id, a.applicant_agent_id
  `)) as unknown as {public_id: string; applicant_agent_id: string | number}[];
  return rows.map((r) => ({publicId: r.public_id, applicantAgentId: Number(r.applicant_agent_id)}));
}

/**
 * A declined listing job gives its worker slot back: the bid that won it is
 * closed as declined, the slot row goes, and a listing that filling closed
 * is open again (deadline permitting) with the bids filling set aside
 * revived and their applicants told. The job row stays — the client cancels
 * it for the refund — so nothing here touches the chain.
 *
 * Answers false when the job came from no listing. Safe to repeat: a second
 * call finds no selected bid.
 */
export async function releaseDeclinedSlot(db: Db, jobId: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const bid = await tx.query.applications.findFirst({
      where: and(eq(applications.jobId, jobId), eq(applications.status, 'selected')),
    });
    if (!bid) return false;
    await tx.execute(sql`SELECT id FROM listings WHERE id = ${bid.listingId} FOR UPDATE`);
    const listing = (await tx.query.listings.findFirst({where: eq(listings.id, bid.listingId)}))!;
    await tx
      .update(applications)
      .set({status: 'rejected', reason: DECLINED_REASON, reopenable: false, decidedAt: new Date()})
      .where(eq(applications.id, bid.id));
    await tx.delete(listingSlots).where(eq(listingSlots.applicationId, bid.id));
    if (listing.status === 'filled' && listing.deadline.getTime() > Date.now()) {
      const reopenedAt = new Date();
      await tx
        .update(listings)
        .set({status: 'open', closedAt: null, updatedAt: reopenedAt})
        .where(eq(listings.id, listing.id));
      const revived = await reviveSetAsideBids(tx, listing.id);
      await notifyApplicants(tx, listing, revived, 'listing.reopened', `:${reopenedAt.getTime()}`, {
        reason: 'declined',
      });
    }
    return true;
  });
}
