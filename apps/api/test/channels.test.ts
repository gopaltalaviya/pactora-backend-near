import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {eq, sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {channelLinks, channelOutbox, closeDb, createDb, linkCodes, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {CODE_ALPHABET, linkCode, maskAddress} from '../src/routes/channels.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, fakeReadTxEvents, person} from './helpers/people.js';

/** docs/26 F11, F12: the site's side of linking Telegram and email. */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let bare: FastifyInstance;
let db: Db;
const base = () => ({
  ...chainDeps(config),
  db,
  chains: config.chains,
  defaultChainId: 'near:sandbox',
  bus: new EventBus(),
  readBudget: fakeReadBudget,
  readTxEvents: fakeReadTxEvents,
  rateLimitPerMinute: 100_000,
  liveEvents: false,
  draftSettleSweepMs: 0,
  submit: async () => ({txHash: 'unused'}),
});

beforeAll(async () => {
  db = createDb(DB_URL, {max: 5});
  app = await buildApp({...base(), telegramBot: 'PactoraTestBot', emailChannel: true});
  bare = await buildApp(base());
});
afterAll(async () => {
  await app.close();
  await bare.close();
  await closeDb(db);
});
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE agents, sessions, login_challenges, registration_challenges, api_keys, channel_links, link_codes, channel_outbox RESTART IDENTITY CASCADE`,
  );
});

let n = 0;
const post = (token: string, url: string, payload: Record<string, unknown> = {}, on = app) =>
  app === on
    ? app.inject({method: 'POST', url, headers: bearer(token), payload})
    : on.inject({method: 'POST', url, headers: bearer(token), payload});

describe('codes', () => {
  it('are 8 characters from an alphabet without 0 O 1 I', () => {
    expect(CODE_ALPHABET).not.toMatch(/[0O1I]/);
    for (let i = 0; i < 200; i++) expect(linkCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
  it('addresses are masked', () => {
    expect(maskAddress('email', 'priya@example.com')).toBe('p***@example.com');
    expect(maskAddress('telegram', '123456789')).toBe('…6789');
  });
});

describe('Telegram', () => {
  it('gives a code and a 4-digit number for the bot, 5 an hour; none where Telegram is not configured', async () => {
    const p = await person(app, `ch${++n}`);
    const r = await post(p.token, '/v1/me/channels/telegram/code');
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({
      bot: 'PactoraTestBot',
      code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{8}$/),
      number: expect.stringMatching(/^\d{4}$/),
    });
    for (let i = 0; i < 4; i++)
      expect((await post(p.token, '/v1/me/channels/telegram/code')).statusCode).toBe(201);
    expect((await post(p.token, '/v1/me/channels/telegram/code')).json().code).toBe('LIMIT_REACHED');
    expect((await post(p.token, '/v1/me/channels/telegram/code', {}, bare)).statusCode).toBe(503);
    const a = await agent(app, `cha${++n}`);
    expect((await post(a.apiKey, '/v1/me/channels/telegram/code')).json()).toMatchObject({
      status: 401,
      code: 'WRONG_CREDENTIAL',
    });
  });
});

describe('email', () => {
  it('sends a 6-digit code through the outbox, links on the right one, cancels after 3 wrong', async () => {
    const p = await person(app, `ce${++n}`);
    const start = await post(p.token, '/v1/me/channels/email', {address: 'Priya@Example.com'});
    expect(start.statusCode, start.body).toBe(202);
    expect(start.json().address).toBe('p***@example.com');
    const [queued] = await db
      .select()
      .from(channelOutbox)
      .where(eq(channelOutbox.address, 'priya@example.com'));
    const sent = /code is (\d{6})/.exec(queued!.body)![1]!;

    const wrong = sent === '000000' ? '111111' : '000000';
    expect((await post(p.token, '/v1/me/channels/email/verify', {code: wrong})).json().detail).toMatch(
      /not the code/,
    );
    const ok = await post(p.token, '/v1/me/channels/email/verify', {code: sent});
    expect(ok.json()).toMatchObject({channel: 'email', linked: true});
    const [l] = await db.select().from(channelLinks).where(eq(channelLinks.channel, 'email'));
    expect(l!.address).toBe('priya@example.com');

    const list = (await app.inject({method: 'GET', url: '/v1/me/channels', headers: bearer(p.token)})).json();
    expect(list).toMatchObject({
      telegram: {bot: 'PactoraTestBot'},
      email: true,
      links: [{channel: 'email', address: 'p***@example.com'}],
    });
    expect(JSON.stringify(list)).not.toContain('priya@');

    const q = await person(app, `ce${++n}`);
    await post(q.token, '/v1/me/channels/email', {address: 'q@example.com'});
    for (let i = 0; i < 2; i++) await post(q.token, '/v1/me/channels/email/verify', {code: '999999'});
    const third = await post(q.token, '/v1/me/channels/email/verify', {code: '999999'});
    expect(third.json().detail).toMatch(/cancelled/);
    expect(await db.select().from(linkCodes).where(eq(linkCodes.channel, 'email'))).toHaveLength(0);
    expect((await post(q.token, '/v1/me/channels/email', {address: 'not-an-email'})).statusCode).toBe(422);
  });

  it('unlinks', async () => {
    const p = await person(app, `cu${++n}`);
    const del = (c: string) =>
      app.inject({method: 'DELETE', url: `/v1/me/channels/${c}`, headers: bearer(p.token)});
    expect((await del('email')).json()).toEqual({channel: 'email', unlinked: false});
    expect((await del('pigeon')).statusCode).toBe(404);
  });
});
