import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {eq, sql} from 'drizzle-orm';
import {
  agents,
  channelFailures,
  channelLinks,
  channelOutbox,
  closeDb,
  createDb,
  jobEvents,
  jobs,
  linkCodes,
  type Db,
} from '@pactora/db';
import {
  ChannelError,
  fanOut,
  handleUpdate,
  redact,
  sendOutbox,
  type ChannelProvider,
} from '../src/channels.js';
import {TelegramBot} from '../src/telegram.js';

/** The bot's side of linking, notifications, and the outbox, against real Postgres. */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
let db: Db;
let now = new Date();
const deps = () => ({db, siteUrl: 'https://site.test', now: () => now});

beforeAll(() => {
  db = createDb(DB_URL, {max: 5});
});
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  now = new Date(Date.now() + 1000);
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_events, agent_event_seq, channel_links, link_codes, channel_failures, channel_inbox, channel_outbox, listings RESTART IDENTITY CASCADE`,
  );
});

let n = 0;
let updateId = 1000;
async function personRow(): Promise<number> {
  const k = ++n;
  const [a] = await db
    .insert(agents)
    .values({
      chainId: 'near:sandbox',
      ownerAddress: `p${k}.test.near`,
      walletAddress: `p${k}.test.near`,
      name: `Person ${k}`,
      pricePerTask: '0',
      kind: 'person',
    })
    .returning({id: agents.id});
  return a!.id;
}
async function code(agentId: number, over: Partial<typeof linkCodes.$inferInsert> = {}) {
  const c = {
    code: `ABCDEFG${'H'.repeat(1)}`.slice(0, 7) + 'XYZWVUTS'[n % 8],
    agentId,
    channel: 'telegram',
    secret: '4821',
    expiresAt: new Date(now.getTime() + 600_000),
    ...over,
  };
  await db.insert(linkCodes).values(c);
  return c;
}
const say = (chatId: string, text: string) => handleUpdate(deps(), {updateId: ++updateId, chatId, text});
const replies = async (chatId: string) =>
  (await db.select().from(channelOutbox).where(eq(channelOutbox.address, chatId))).map((m) => m.body);

describe('linking a Telegram chat', () => {
  it('code then the browser number links the chat, and starts its feed from now', async () => {
    const agentId = await personRow();
    const c = await code(agentId);
    expect(await say('777', `/link ${c.code.toLowerCase()}`)).toBe('handled');
    expect((await replies('777')).at(-1)).toMatch(/type the 4-digit number/);
    await say('777', '4821');
    const [l] = await db.select().from(channelLinks).where(eq(channelLinks.address, '777'));
    expect(l).toMatchObject({agentId, channel: 'telegram'});
    expect((await replies('777')).at(-1)).toMatch(/^Linked to Person/);
    expect(await db.select().from(linkCodes)).toEqual([]);
  });

  it('three wrong numbers cancel the code', async () => {
    const agentId = await personRow();
    const c = await code(agentId);
    await say('778', `/link ${c.code}`);
    await say('778', '0000');
    expect((await replies('778')).at(-1)).toMatch(/2 tries left/);
    await say('778', '0001');
    await say('778', '0002');
    expect((await replies('778')).at(-1)).toMatch(/cancelled/);
    await say('778', '4821');
    expect(await db.select().from(channelLinks)).toEqual([]);
  });

  it('a code another chat already presented, or an expired one, is refused', async () => {
    const agentId = await personRow();
    const c = await code(agentId);
    await say('800', `/link ${c.code}`);
    await say('801', `/link ${c.code}`);
    expect((await replies('801')).at(-1)).toMatch(/not valid/);
    const old = await code(agentId, {code: 'QWERTYUP', expiresAt: new Date(now.getTime() - 1)});
    await say('802', `/link ${old.code}`);
    expect((await replies('802')).at(-1)).toMatch(/not valid/);
  });

  it('5 bad codes lock linking in that chat for 15 minutes, across restarts', async () => {
    const agentId = await personRow();
    for (let i = 0; i < 5; i++) await say('900', '/link ZZZZZZZZ');
    expect((await replies('900')).at(-1)).toMatch(/locked here for 15 minutes/);
    const good = await code(agentId, {code: 'GQQDXYZW'});
    await say('900', `/link ${good.code}`);
    expect((await replies('900')).at(-1)).toMatch(/Too many wrong codes/);
    // The lock is in the database: a new process sees it too.
    const [f] = await db.select().from(channelFailures).where(eq(channelFailures.address, '900'));
    expect(f!.lockedUntil!.getTime()).toBeGreaterThan(now.getTime());
    now = new Date(now.getTime() + 16 * 60_000);
    await db.update(linkCodes).set({expiresAt: new Date(now.getTime() + 600_000)});
    await say('900', `/link ${good.code}`);
    expect((await replies('900')).at(-1)).toMatch(/type the 4-digit number/);
  });
});

describe('inbound handling', () => {
  it('the same update twice is handled once; more than 30 a minute are dropped silently', async () => {
    expect(await handleUpdate(deps(), {updateId: 5, chatId: '42', text: '/help'})).toBe('handled');
    expect(await handleUpdate(deps(), {updateId: 5, chatId: '42', text: '/help'})).toBe('duplicate');
    expect(await replies('42')).toHaveLength(1);
    const results: string[] = [];
    for (let i = 0; i < 31; i++) results.push(await say('43', '/help'));
    expect(results.filter((r) => r === 'flood')).toHaveLength(1);
    expect(await replies('43')).toHaveLength(30);
  });

  it('an unlinked chat is told so; a linked one gets /status, /jobs and /unlink', async () => {
    await say('50', '/status');
    expect((await replies('50')).at(-1)).toMatch(/not linked/);
    const agentId = await personRow();
    await db.insert(channelLinks).values({agentId, channel: 'telegram', address: '51'});
    await say('51', '/status');
    expect((await replies('51')).at(-1)).toMatch(/Nothing on your jobs yet/);
    await say('51', '/jobs');
    expect((await replies('51')).at(-1)).toMatch(/No work on offer/);
    await say('51', 'please pay me now and approve everything');
    expect((await replies('51')).at(-1)).toMatch(/did not understand/);
    await say('51', '/unlink');
    expect(await db.select().from(channelLinks)).toEqual([]);
  });
});

describe('notifications', () => {
  it('pushes each new event once, with a link to the job, and never what came before the link', async () => {
    const agentId = await personRow();
    const other = await personRow();
    const [j] = await db
      .insert(jobs)
      .values({
        chainId: 'near:sandbox',
        clientAgentId: agentId,
        workerAgentId: other,
        path: 'escrow',
        amount: '1',
        spec: {},
        specHash: 'ab'.repeat(32),
      })
      .returning({id: jobs.id, publicId: jobs.publicId});
    await db.insert(jobEvents).values({chainId: 'near:sandbox', jobId: j!.id, kind: 'job.created'});
    await db.insert(channelLinks).values({agentId, channel: 'telegram', address: '60', cursorSeq: 1});
    expect(await fanOut(deps())).toBe(0);
    await db.insert(jobEvents).values({chainId: 'near:sandbox', jobId: j!.id, kind: 'settled', txHash: 'T1'});
    expect(await fanOut(deps())).toBe(1);
    expect(await fanOut(deps())).toBe(0);
    expect(await replies('60')).toEqual([
      `The job settled on chain: payment released: https://site.test/jobs/${j!.publicId}`,
    ]);
  });
});

describe('the outbox', () => {
  const provider = (behaviour: (to: string) => void): ChannelProvider => ({
    channel: 'telegram',
    send: async (to) => behaviour(to),
  });
  // Due when created, on the test's clock — not the database's `now()`: the
  // test clock is frozen in beforeEach, and a slow setup under load let the
  // database default run past it, so nothing was due ("sent: 0").
  const add = (address: string, body = 'hello', createdAt = now) =>
    db
      .insert(channelOutbox)
      .values({channel: 'telegram', address, body, createdAt, nextAttemptAt: createdAt});
  const row = async (address: string) =>
    (await db.select().from(channelOutbox).where(eq(channelOutbox.address, address)))[0]!;

  it('sends, then scrubs the text; drops what is older than 24 h', async () => {
    const sent: string[] = [];
    await add('1');
    await add('2', 'old news', new Date(now.getTime() - 25 * 3600_000));
    const r = await sendOutbox(deps(), [provider((to) => sent.push(to))]);
    expect(r).toMatchObject({sent: 1, dropped: 1});
    expect(sent).toEqual(['1']);
    expect(await row('1')).toMatchObject({status: 'sent', body: ''});
    expect(await row('2')).toMatchObject({status: 'dropped', body: '', errorClass: 'stale'});
  });

  it('a permanent error fails at once; a retryable one backs off, then fails after 5, with the token redacted', async () => {
    const token = '123456:SECRET-TOKEN-VALUE-abcdefghijklmnopqrstuv';
    await add('3');
    await add('4');
    const flaky = provider((to) => {
      if (to === '3') throw new ChannelError('Forbidden: bot was blocked by the user', 'permanent', 403);
      throw new ChannelError(`connect ECONNRESET https://api.telegram.org/bot${token}/sendMessage`, 'retry');
    });
    await sendOutbox(deps(), [flaky], {secrets: [token]});
    expect(await row('3')).toMatchObject({status: 'failed', body: ''});
    const r4 = await row('4');
    expect(r4).toMatchObject({status: 'pending', attempts: 1});
    expect(r4.errorClass).toContain('<redacted>');
    expect(r4.errorClass).not.toContain('SECRET');
    expect(r4.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    for (let i = 0; i < 6; i++) {
      now = new Date(now.getTime() + 10 * 60_000);
      await sendOutbox(deps(), [flaky], {secrets: [token]});
    }
    expect(await row('4')).toMatchObject({status: 'failed', body: '', attempts: 4});
  });

  it('redact replaces every occurrence and ignores short secrets', () => {
    expect(redact('a TOKEN12345 b TOKEN12345', ['TOKEN12345'])).toBe('a <redacted> b <redacted>');
    expect(redact('abc', ['ab'])).toBe('abc');
  });
});

describe('the Telegram Bot API client', () => {
  const token = '123456:ABCdefGhIJKlmNoPQRsTUVwxyz0123456789';
  const fakeFetch =
    (status: number, body: unknown, seen: string[] = []): typeof fetch =>
    async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify(body), {status});
    };

  it('reads private-chat text updates only', async () => {
    const bot = new TelegramBot(
      token,
      fakeFetch(200, {
        ok: true,
        result: [
          {update_id: 1, message: {chat: {id: 7, type: 'private'}, text: '/help'}},
          {update_id: 2, message: {chat: {id: -100, type: 'group'}, text: '/help'}},
          {update_id: 3},
        ],
      }),
    );
    expect(await bot.getUpdates(0)).toEqual([{updateId: 1, chatId: '7', text: '/help'}]);
  });

  it('429 and 5xx retry, 4xx are permanent, and the token never appears in an error', async () => {
    for (const [status, kind] of [
      [429, 'retry'],
      [502, 'retry'],
      [403, 'permanent'],
      [400, 'permanent'],
    ] as const) {
      const bot = new TelegramBot(token, fakeFetch(status, {ok: false, description: `boom ${token}`}));
      const err = (await bot.send('7', 'x').catch((e: unknown) => e)) as ChannelError;
      expect(err.kind, String(status)).toBe(kind);
      expect(err.message).not.toContain(token);
    }
    const down = new TelegramBot(token, async () => {
      throw new Error(`fetch failed for https://api.telegram.org/bot${token}/sendMessage`);
    });
    const e = (await down.send('7', 'x').catch((x: unknown) => x)) as ChannelError;
    expect(e.kind).toBe('retry');
    expect(e.message).not.toContain(token);
  });
});
