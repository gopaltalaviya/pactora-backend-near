import {randomInt} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {and, count, desc, eq, gt} from 'drizzle-orm';
import {z} from 'zod';
import {agentEventSeq, channelLinks, channelOutbox, linkCodes, type Db} from '@pactora/db';
import {ErrorCode, PactoraError} from '@pactora/shared';
import {actorOf} from '../actor.js';

/**
 * Linking a person's Telegram chat or email address (docs/26 F11, F12).
 *
 * Telegram: the site shows an 8-character code and a 4-digit number; the
 * person sends `/link CODE` to the bot, then types the number. Both must
 * match, so a code read over someone's shoulder is not enough. Email: a
 * 6-digit code is sent to the address and typed back here. Codes last 10
 * minutes, 5 an hour per person; 3 wrong numbers cancel one. The bot side
 * (apps/channels) also locks a chat after 5 bad codes for 15 minutes.
 */

/** No 0 O 1 I: read aloud or typed, they are confused. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODES_PER_HOUR = 5;
export const MAX_TRIES = 3;

export function linkCode(): string {
  return Array.from({length: 8}, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}
const digits = (n: number) => String(randomInt(10 ** n)).padStart(n, '0');

export const EmailBody = z.object({address: z.string().trim().toLowerCase().email().max(320)});
export const VerifyBody = z.object({code: z.string().regex(/^\d{6}$/, 'the 6-digit code from the email')});

/** a***@example.com, or the last 4 of a chat id. */
export function maskAddress(channel: string, address: string): string {
  if (channel === 'email') {
    const [user = '', domain = ''] = address.split('@');
    return `${user.slice(0, 1)}***@${domain}`;
  }
  return `…${address.slice(-4)}`;
}

export interface ChannelRouteDeps {
  db: Db;
  /** The bot's @username, if Telegram is configured. */
  telegramBot?: string;
  /** Email can be linked (a provider is configured for apps/channels). */
  email?: boolean;
}

export async function registerChannelRoutes(app: FastifyInstance, deps: ChannelRouteDeps): Promise<void> {
  const {db} = deps;

  const person = async (request: Parameters<typeof actorOf>[1]) => {
    const actor = await actorOf(db, request);
    if (actor.via !== 'person') throw new PactoraError(ErrorCode.FORBIDDEN, 'channels are for people');
    return actor;
  };

  const underLimit = async (agentId: number) => {
    const [{n} = {n: 0}] = await db
      .select({n: count()})
      .from(linkCodes)
      .where(and(eq(linkCodes.agentId, agentId), gt(linkCodes.createdAt, new Date(Date.now() - 3600_000))));
    if (Number(n) >= CODES_PER_HOUR) {
      throw new PactoraError(ErrorCode.LIMIT_REACHED, `at most ${CODES_PER_HOUR} linking codes an hour`);
    }
  };

  app.get('/v1/me/channels', async (request) => {
    const actor = await person(request);
    const rows = await db.select().from(channelLinks).where(eq(channelLinks.agentId, actor.agent.id));
    return {
      telegram: deps.telegramBot ? {bot: deps.telegramBot} : null,
      email: Boolean(deps.email),
      links: rows.map((r) => ({
        channel: r.channel,
        address: maskAddress(r.channel, r.address),
        since: r.createdAt,
      })),
    };
  });

  app.post('/v1/me/channels/telegram/code', async (request, reply) => {
    const actor = await person(request);
    if (!deps.telegramBot)
      throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'Telegram is not configured here');
    await underLimit(actor.agent.id);
    const code = linkCode();
    const number = digits(4);
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await db
      .insert(linkCodes)
      .values({code, agentId: actor.agent.id, channel: 'telegram', secret: number, expiresAt});
    return reply.status(201).send({
      code,
      number,
      expiresAt,
      bot: deps.telegramBot,
      next: `Send "/link ${code}" to @${deps.telegramBot}, then type ${number} when the bot asks.`,
    });
  });

  app.post('/v1/me/channels/email', async (request, reply) => {
    const actor = await person(request);
    if (!deps.email) throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'email is not configured here');
    const {address} = EmailBody.parse(request.body ?? {});
    await underLimit(actor.agent.id);
    const secret = digits(6);
    await db.transaction(async (tx) => {
      await tx.insert(linkCodes).values({
        code: linkCode(),
        agentId: actor.agent.id,
        channel: 'email',
        secret,
        address,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      });
      await tx.insert(channelOutbox).values({
        channel: 'email',
        address,
        body: `Your Pactora code is ${secret}. It expires in 10 minutes. If you did not ask for it, ignore this email.`,
      });
    });
    return reply
      .status(202)
      .send({address: maskAddress('email', address), next: 'type the 6-digit code from the email'});
  });

  app.post('/v1/me/channels/email/verify', async (request) => {
    const actor = await person(request);
    const {code} = VerifyBody.parse(request.body ?? {});
    // A wrong code must be COUNTED, so the refusal is thrown after the
    // transaction commits: throwing inside it would roll the count back, and
    // a code could then be guessed without limit for its 10 minutes.
    const outcome = await db.transaction(async (tx) => {
      const [c] = await tx
        .select()
        .from(linkCodes)
        .where(
          and(
            eq(linkCodes.agentId, actor.agent.id),
            eq(linkCodes.channel, 'email'),
            gt(linkCodes.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(linkCodes.createdAt))
        .limit(1)
        .for('update');
      if (!c || !c.address)
        throw new PactoraError(ErrorCode.NOT_FOUND, 'no email code is waiting; ask for a new one');
      if (c.secret !== code) {
        const tries = c.tries + 1;
        if (tries >= MAX_TRIES) await tx.delete(linkCodes).where(eq(linkCodes.code, c.code));
        else await tx.update(linkCodes).set({tries}).where(eq(linkCodes.code, c.code));
        return {
          wrong:
            tries >= MAX_TRIES
              ? 'wrong code three times: it is cancelled, ask for a new one'
              : 'that is not the code',
        };
      }
      const [seq] = await tx.select().from(agentEventSeq).where(eq(agentEventSeq.agentId, actor.agent.id));
      await tx
        .delete(channelLinks)
        .where(and(eq(channelLinks.agentId, actor.agent.id), eq(channelLinks.channel, 'email')));
      await tx
        .insert(channelLinks)
        .values({agentId: actor.agent.id, channel: 'email', address: c.address, cursorSeq: seq?.last ?? 0});
      await tx.delete(linkCodes).where(eq(linkCodes.code, c.code));
      return {linked: {channel: 'email', address: maskAddress('email', c.address), linked: true}};
    });
    if ('wrong' in outcome) throw new PactoraError(ErrorCode.FORBIDDEN, outcome.wrong);
    return outcome.linked;
  });

  app.delete('/v1/me/channels/:channel', async (request) => {
    const actor = await person(request);
    const {channel} = request.params as {channel: string};
    if (channel !== 'telegram' && channel !== 'email')
      throw new PactoraError(ErrorCode.NOT_FOUND, `no channel ${channel}`);
    const gone = await db
      .delete(channelLinks)
      .where(and(eq(channelLinks.agentId, actor.agent.id), eq(channelLinks.channel, channel)))
      .returning({id: channelLinks.id});
    return {channel, unlinked: gone.length > 0};
  });
}
