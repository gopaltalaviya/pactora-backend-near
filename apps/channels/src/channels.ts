import {and, asc, count, eq, gt, lt, or, sql} from 'drizzle-orm';
import {
  agentEventSeq,
  agentEvents,
  agents,
  channelFailures,
  channelInbox,
  channelLinks,
  channelOutbox,
  jobs,
  linkCodes,
  listings,
  type Db,
} from '@pactora/db';

/**
 * The Telegram and email channels (docs/26 F11, F12): the bot's side of
 * linking, notifications pushed from each person's event feed, and the
 * outbox every message leaves through.
 *
 * What the bot does NOT do: anything that signs or spends. Accepting,
 * submitting, approving need the person's wallet, and applying or chatting
 * reuse the site's own checks, so the bot sends a link to the page for
 * each. A chat command can never move money.
 */

export const FLOOD_PER_MINUTE = 30;
export const BAD_CODES_BEFORE_LOCK = 5;
export const LOCK_MS = 15 * 60 * 1000;
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const OUTBOX_MAX_ATTEMPTS = 5;

export class ChannelError extends Error {
  constructor(
    message: string,
    readonly kind: 'retry' | 'permanent',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}

export interface ChannelProvider {
  readonly channel: 'telegram' | 'email';
  send(address: string, body: string): Promise<void>;
}

const EVENT_WORDS: Record<string, string> = {
  'job.created': 'A job was created for you',
  created: 'A job was created on chain',
  'job.accepted': 'The worker accepted the job',
  accepted: 'The job was accepted on chain',
  'job.submitted': 'A result was submitted',
  submitted: 'A result was submitted on chain',
  'job.draft.submitted': 'The worker posted a draft',
  'job.draft.reviewed': 'The client reviewed a draft',
  'job.message': 'New message on a job',
  'job.file.added': 'A photo was added',
  'job.disputed': 'The client disputed the result',
  disputed: 'A dispute was recorded on chain',
  'job.settled': 'The job settled',
  settled: 'The job settled on chain: payment released',
  'job.refunded': 'The job was refunded',
  refunded: 'The job was refunded on chain',
  'job.declined': 'The worker declined',
  'listing.bid': 'New bid on your listing',
  'application.selected': 'Your bid was selected: a job was created for you',
  'application.rejected': 'Your bid was declined',
  'listing.closed': 'The listing closed before your bid was decided',
  'listing.reopened': 'The listing reopened: your bid is live again',
  'listing.cancelled': 'The client cancelled the listing',
  'listing.claimed': 'A worker claimed your listing',
  'listing.expired': 'The listing reached its deadline',
  'listing.match': 'New work that matches your skills',
  'account.warned': 'A moderation warning on your account',
};
export const eventText = (kind: string) => EVENT_WORDS[kind] ?? kind;

/** Where a feed item points on the site: its job, else its listing, else the notifications page. */
export const eventLink = (siteUrl: string, e: {jobId: string | null; listingId: string | null}): string =>
  e.jobId
    ? `${siteUrl}/jobs/${e.jobId}`
    : e.listingId
      ? `${siteUrl}/jobs/listing/${e.listingId}`
      : `${siteUrl}/notifications`;

export interface Deps {
  db: Db;
  siteUrl: string;
  now?: () => Date;
}

const nowOf = (d: Deps) => d.now?.() ?? new Date();

async function reply(db: Db, address: string, body: string) {
  await db.insert(channelOutbox).values({channel: 'telegram', address, body: body.slice(0, 4096)});
}

const HELP = [
  'Pactora on Telegram:',
  '/link CODE: link this chat to your account (get the code on the site, under My account)',
  '/status: what is new on your jobs',
  '/jobs: work on offer',
  '/unlink: stop messages here',
  'To accept, submit, chat or apply, follow the link: those happen on the site, with your own wallet.',
].join('\n');

/**
 * One inbound Telegram update: stored once (by its id), then handled in
 * order. A repeat of an update already stored is ignored entirely.
 */
export async function handleUpdate(
  d: Deps,
  u: {updateId: number; chatId: string; text: string},
): Promise<'handled' | 'duplicate' | 'flood'> {
  const {db} = d;
  const now = nowOf(d);
  const [stored] = await db
    .insert(channelInbox)
    .values({
      channel: 'telegram',
      updateId: u.updateId,
      address: u.chatId,
      text: u.text.slice(0, 1000),
      receivedAt: now,
    })
    .onConflictDoNothing()
    .returning({updateId: channelInbox.updateId});
  if (!stored) return 'duplicate';
  const markHandled = () =>
    db
      .update(channelInbox)
      .set({handled: true})
      .where(and(eq(channelInbox.channel, 'telegram'), eq(channelInbox.updateId, u.updateId)));

  // Flood: more than 30 in a minute from one chat are dropped without a reply.
  const [{n} = {n: 0}] = await db
    .select({n: count()})
    .from(channelInbox)
    .where(
      and(
        eq(channelInbox.channel, 'telegram'),
        eq(channelInbox.address, u.chatId),
        gt(channelInbox.receivedAt, new Date(now.getTime() - 60_000)),
      ),
    );
  if (Number(n) > FLOOD_PER_MINUTE) {
    await markHandled();
    return 'flood';
  }

  const text = u.text.trim();
  const [fail] = await db
    .select()
    .from(channelFailures)
    .where(and(eq(channelFailures.channel, 'telegram'), eq(channelFailures.address, u.chatId)));
  const locked = fail?.lockedUntil && fail.lockedUntil > now;

  const badCode = async () => {
    const failures = (fail && !(fail.lockedUntil && fail.lockedUntil <= now) ? fail.failures : 0) + 1;
    const lockedUntil = failures >= BAD_CODES_BEFORE_LOCK ? new Date(now.getTime() + LOCK_MS) : null;
    await db
      .insert(channelFailures)
      .values({channel: 'telegram', address: u.chatId, failures, lockedUntil, updatedAt: now})
      .onConflictDoUpdate({
        target: [channelFailures.channel, channelFailures.address],
        set: {failures, lockedUntil, updatedAt: now},
      });
    await reply(
      db,
      u.chatId,
      lockedUntil
        ? 'Too many wrong codes. Linking is locked here for 15 minutes.'
        : 'That code is not valid or has expired.',
    );
  };

  const link = /^\/link\s+([A-Za-z0-9]{8})$/.exec(text);
  const number = /^\d{4}$/.exec(text);
  if ((link || number) && locked) {
    await reply(db, u.chatId, 'Too many wrong codes. Try again in a few minutes.');
  } else if (link) {
    const code = link[1]!.toUpperCase();
    const [c] = await db
      .select()
      .from(linkCodes)
      .where(and(eq(linkCodes.code, code), eq(linkCodes.channel, 'telegram'), gt(linkCodes.expiresAt, now)));
    if (!c || (c.pendingAddress && c.pendingAddress !== u.chatId)) await badCode();
    else {
      await db.update(linkCodes).set({pendingAddress: u.chatId}).where(eq(linkCodes.code, code));
      await reply(db, u.chatId, 'Now type the 4-digit number shown next to the code in your browser.');
    }
  } else if (number) {
    const [c] = await db
      .select()
      .from(linkCodes)
      .where(
        and(
          eq(linkCodes.pendingAddress, u.chatId),
          eq(linkCodes.channel, 'telegram'),
          gt(linkCodes.expiresAt, now),
        ),
      );
    if (!c) await reply(db, u.chatId, 'Send /link CODE first.');
    else if (c.secret !== text) {
      const tries = c.tries + 1;
      if (tries >= 3) {
        await db.delete(linkCodes).where(eq(linkCodes.code, c.code));
        await reply(
          db,
          u.chatId,
          'Wrong number three times: the code is cancelled. Get a new one on the site.',
        );
      } else {
        await db.update(linkCodes).set({tries}).where(eq(linkCodes.code, c.code));
        await reply(db, u.chatId, `That is not the number. ${3 - tries} tries left.`);
      }
    } else {
      await db.transaction(async (tx) => {
        const [seq] = await tx.select().from(agentEventSeq).where(eq(agentEventSeq.agentId, c.agentId));
        await tx
          .delete(channelLinks)
          .where(
            or(
              and(eq(channelLinks.agentId, c.agentId), eq(channelLinks.channel, 'telegram')),
              and(eq(channelLinks.channel, 'telegram'), eq(channelLinks.address, u.chatId)),
            ),
          );
        await tx
          .insert(channelLinks)
          .values({agentId: c.agentId, channel: 'telegram', address: u.chatId, cursorSeq: seq?.last ?? 0});
        await tx.delete(linkCodes).where(eq(linkCodes.code, c.code));
        await tx
          .delete(channelFailures)
          .where(and(eq(channelFailures.channel, 'telegram'), eq(channelFailures.address, u.chatId)));
      });
      const [a] = await db.select({name: agents.name}).from(agents).where(eq(agents.id, c.agentId));
      await reply(
        db,
        u.chatId,
        `Linked to ${a?.name ?? 'your account'}. You will get your job updates here. /help for more.`,
      );
    }
  } else if (text === '/start' || text === '/help') {
    await reply(db, u.chatId, HELP);
  } else {
    const [l] = await db
      .select()
      .from(channelLinks)
      .where(and(eq(channelLinks.channel, 'telegram'), eq(channelLinks.address, u.chatId)));
    if (!l) await reply(db, u.chatId, 'This chat is not linked. Send /help to see how.');
    else if (text === '/unlink') {
      await db.delete(channelLinks).where(eq(channelLinks.id, l.id));
      await reply(db, u.chatId, 'Unlinked. No more messages here.');
    } else if (text === '/status') {
      const [seq] = await db.select().from(agentEventSeq).where(eq(agentEventSeq.agentId, l.agentId));
      const latest = await db
        .select({kind: agentEvents.kind, jobId: jobs.publicId, listingId: listings.publicId})
        .from(agentEvents)
        .leftJoin(jobs, eq(jobs.id, agentEvents.jobId))
        .leftJoin(listings, eq(listings.id, agentEvents.listingId))
        .where(eq(agentEvents.agentId, l.agentId))
        .orderBy(sql`${agentEvents.seq} DESC`)
        .limit(3);
      await reply(
        db,
        u.chatId,
        latest.length === 0
          ? 'Nothing on your jobs yet.'
          : [
              `${seq?.last ?? 0} events on your jobs. The latest:`,
              ...latest.map((e) => `• ${eventText(e.kind)}: ${eventLink(d.siteUrl, e)}`),
            ].join('\n'),
      );
    } else if (text === '/jobs') {
      const open = await db
        .select({id: listings.publicId, title: listings.title})
        .from(listings)
        .where(eq(listings.status, 'open'))
        .orderBy(sql`${listings.id} DESC`)
        .limit(5);
      await reply(
        db,
        u.chatId,
        open.length === 0
          ? 'No work on offer right now.'
          : [
              'Work on offer (apply on the site):',
              ...open.map((o) => `• ${o.title}: ${d.siteUrl}/jobs/listing/${o.id}`),
            ].join('\n'),
      );
    } else {
      await reply(db, u.chatId, 'I did not understand that. /help lists what I can do.');
    }
  }
  await markHandled();
  return 'handled';
}

/** Push each linked person's new events to their channels, advancing the cursor in the same transaction. */
export async function fanOut(d: Deps, opts: {batch?: number} = {}): Promise<number> {
  const {db} = d;
  const links = await db.select().from(channelLinks);
  let queued = 0;
  for (const l of links) {
    await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(channelLinks).where(eq(channelLinks.id, l.id)).for('update');
      if (!locked) return;
      const events = await tx
        .select({
          seq: agentEvents.seq,
          kind: agentEvents.kind,
          jobId: jobs.publicId,
          listingId: listings.publicId,
        })
        .from(agentEvents)
        .leftJoin(jobs, eq(jobs.id, agentEvents.jobId))
        .leftJoin(listings, eq(listings.id, agentEvents.listingId))
        .where(and(eq(agentEvents.agentId, l.agentId), gt(agentEvents.seq, locked.cursorSeq)))
        .orderBy(asc(agentEvents.seq))
        .limit(opts.batch ?? 20);
      if (events.length === 0) return;
      for (const e of events) {
        await tx.insert(channelOutbox).values({
          channel: l.channel,
          address: l.address,
          body: `${eventText(e.kind)}: ${eventLink(d.siteUrl, e)}`,
        });
      }
      await tx
        .update(channelLinks)
        .set({cursorSeq: events.at(-1)!.seq})
        .where(eq(channelLinks.id, l.id));
      queued += events.length;
    });
  }
  return queued;
}

/** The token never reaches a log or a stored error. */
export const redact = (s: string, secrets: string[]) =>
  secrets.filter((x) => x.length >= 8).reduce((acc, x) => acc.split(x).join('<redacted>'), s);

/**
 * Send what is due. A message older than 24 h is dropped (news that old
 * misleads); a sent, dropped or failed message has its text scrubbed;
 * retryable errors back off, permanent ones (blocked bot, bad address)
 * fail at once. Several senders can run: claims use SKIP LOCKED and a lease.
 */
export async function sendOutbox(
  d: Deps,
  providers: ChannelProvider[],
  opts: {secrets?: string[]; batch?: number} = {},
): Promise<{sent: number; dropped: number; failed: number; retried: number}> {
  const {db} = d;
  const now = nowOf(d);
  const at = now.toISOString();
  const out = {sent: 0, dropped: 0, failed: 0, retried: 0};
  const claimed = (await db.execute(sql`
    UPDATE channel_outbox SET leased_until = ${new Date(now.getTime() + 60_000).toISOString()}::timestamptz
    WHERE id IN (
      SELECT id FROM channel_outbox
      WHERE status = 'pending' AND next_attempt_at <= ${at}::timestamptz
        AND (leased_until IS NULL OR leased_until < ${at}::timestamptz)
      ORDER BY id LIMIT ${opts.batch ?? 50} FOR UPDATE SKIP LOCKED)
    RETURNING id`)) as unknown as {id: string | number}[];
  for (const {id} of claimed) {
    const [m] = await db
      .select()
      .from(channelOutbox)
      .where(eq(channelOutbox.id, Number(id)));
    if (!m) continue;
    const finish = (status: 'sent' | 'dropped' | 'failed', errorClass: string | null = null) =>
      db
        .update(channelOutbox)
        .set({status, body: '', leasedUntil: null, errorClass, ...(status === 'sent' ? {sentAt: now} : {})})
        .where(eq(channelOutbox.id, m.id));
    if (now.getTime() - m.createdAt.getTime() > OUTBOX_MAX_AGE_MS) {
      await finish('dropped', 'stale');
      out.dropped++;
      continue;
    }
    const provider = providers.find((p) => p.channel === m.channel);
    if (!provider) {
      await finish('failed', 'no-provider');
      out.failed++;
      continue;
    }
    try {
      await provider.send(m.address, m.body);
      await finish('sent');
      out.sent++;
    } catch (err) {
      const e =
        err instanceof ChannelError
          ? err
          : new ChannelError(err instanceof Error ? err.message : String(err), 'retry');
      const why = redact(
        `${e.kind}${e.status ? ` ${e.status}` : ''}: ${e.message}`,
        opts.secrets ?? [],
      ).slice(0, 200);
      const attempts = m.attempts + 1;
      if (e.kind === 'permanent' || attempts >= OUTBOX_MAX_ATTEMPTS) {
        await finish('failed', why);
        out.failed++;
      } else {
        await db
          .update(channelOutbox)
          .set({
            attempts,
            errorClass: why,
            leasedUntil: null,
            nextAttemptAt: new Date(now.getTime() + 2 ** attempts * 5_000),
          })
          .where(eq(channelOutbox.id, m.id));
        out.retried++;
      }
    }
  }
  return out;
}

/** Delete handled inbox rows after a day and expired codes; keep nothing longer than it is useful. */
export async function sweep(d: Deps): Promise<void> {
  const now = nowOf(d);
  await d.db
    .delete(channelInbox)
    .where(
      and(eq(channelInbox.handled, true), lt(channelInbox.receivedAt, new Date(now.getTime() - 86_400_000))),
    );
  await d.db.delete(linkCodes).where(lt(linkCodes.expiresAt, now));
}
