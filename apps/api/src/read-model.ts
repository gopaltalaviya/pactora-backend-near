/**
 * The words a feed item or a job carries for a human reader (2026-11-09,
 * UI audit): a title, who did it, and whether it is only the chain
 * confirming something the API already said.
 */

/** A job's title: its listing's, else its capability in words ("market-research" → "Market research"). */
export function jobTitleOf(spec: unknown): string {
  const s = (spec ?? {}) as {capability?: unknown; input?: {listing?: {title?: unknown}}};
  const t = s.input?.listing?.title;
  if (typeof t === 'string' && t.length > 0) return t;
  const cap = typeof s.capability === 'string' ? s.capability.replace(/-/g, ' ') : 'job';
  return cap.charAt(0).toUpperCase() + cap.slice(1);
}

/** The listing a job came from, if it did. */
export function listingOfSpec(spec: unknown): {listingId: string; title: string} | null {
  const l = (spec as {input?: {listing?: {listingId?: unknown; title?: unknown}}} | null)?.input?.listing;
  return l && typeof l.listingId === 'string' && typeof l.title === 'string'
    ? {listingId: l.listingId, title: l.title}
    : null;
}

/**
 * The indexer's names for what the chain recorded. Each echoes an API event
 * of the same name with the `job.` prefix, written when the request went
 * out; the echo is the confirmation.
 */
export const CHAIN_KINDS = new Set([
  'created',
  'accepted',
  'submitted',
  'disputed',
  'settled',
  'refunded',
  'direct_paid',
]);

/** Which side acts in each kind, so a feed can say "you" or "the other party". */
const ACTED_BY: Record<string, 'client' | 'worker' | 'system'> = {
  'job.created': 'client',
  'job.settled': 'client',
  'job.disputed': 'client',
  'job.refunded': 'client',
  'job.draft.reviewed': 'client',
  'job.dispute.note': 'client',
  'job.dispute.file.added': 'client',
  'job.accepted': 'worker',
  'job.submitted': 'worker',
  'job.declined': 'worker',
  'job.delivered': 'worker',
  'job.draft.submitted': 'worker',
  'job.file.added': 'worker',
  'job.file.withdrawn': 'worker',
};

/**
 * Who did what an item reports, from the recipient's side: `me`, the
 * `counterparty`, or the `system` (the chain, a sweep, moderation).
 */
export function actorOf(kind: string, role: string, payload: unknown): 'me' | 'counterparty' | 'system' {
  if (CHAIN_KINDS.has(kind)) return 'system';
  if (kind === 'job.message') {
    const from = (payload as {from?: unknown} | null)?.from;
    return from === role ? 'me' : 'counterparty';
  }
  const by = ACTED_BY[kind];
  if (by === 'client' || by === 'worker') return by === role ? 'me' : 'counterparty';
  // Listing events reach the party they are about; the other party (or a sweep) caused them.
  if (kind.startsWith('listing.') || kind.startsWith('application.')) {
    return kind === 'listing.expired' || kind === 'listing.match' ? 'system' : 'counterparty';
  }
  return 'system';
}
