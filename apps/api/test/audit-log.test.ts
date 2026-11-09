import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {eq, sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {agents, complianceCases, createDb, closeDb, sessions, type Db} from '@pactora/db';
import {buildApp, EventBus} from '../src/app.js';
import {decide, openCases} from '../src/compliance.js';
import {chainDeps} from './helpers/register.js';
import {agent, bearer, fakeReadBudget, person, purses} from './helpers/people.js';

/**
 * Round 3 (2026-11-09): the compliance audit log as a CSV for reviewers.
 * Screening cases and decisions, identity checks, standing changes and
 * report resolutions, with timestamps and reviewer accounts; never a legal
 * or matched name, a list reference, document contents, a report's details
 * or a reviewer's free-text note. Reviewer session only; rate-limited.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});

let app: FastifyInstance;
let db: Db;
let reviewers: string[] = [];

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    readBudget: fakeReadBudget,
    rateLimitPerMinute: 100_000,
    liveEvents: false,
    draftSettleSweepMs: 0,
    listingExpirySweepMs: 0,
    sessionKeySweepMs: 0,
    submit: async () => ({txHash: 'unused'}),
    get complianceReviewers() {
      return reviewers;
    },
  });
});
afterAll(async () => {
  await app.close();
  await closeDb(db);
});
beforeEach(async () => {
  reviewers = [];
  purses.clear();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, registration_challenges, sessions, login_challenges, listings, applications, listing_slots, agent_events, agent_event_seq, public_profiles, account_standing, reports, job_messages, compliance_cases, compliance_decisions, identity_verifications RESTART IDENTITY CASCADE`,
  );
});

let n = 0;
const LEGAL = 'Ivana Petrovna Sidorova';
const MATCHED = 'SIDOROVA, Ivana P.';
const REF = 'OFAC-SDN-99117';
const SECRET_NOTE = 'Passport photo shows Ivana Sidorova, born 1980';

const exportCsv = (token: string | null, query = '') =>
  app.inject({
    method: 'GET',
    url: `/v1/admin/audit-log.csv${query}`,
    ...(token ? {headers: bearer(token)} : {}),
  });

async function reviewer(label: string) {
  const p = await person(app, `${label}${++n}`);
  reviewers.push(p.account);
  return p;
}

describe('GET /v1/admin/audit-log.csv', () => {
  it('covers cases, decisions, standing and reports with times and reviewer accounts; no names or notes', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const r1 = await reviewer('al-rev');
    const r2 = await reviewer('al-rev');
    const subject = await person(app, `al-subject${++n}`);
    const subjectId = (await db.query.agents.findFirst({where: eq(agents.publicId, subject.publicId)}))!.id;

    // A strong sanctions match: case opened, account held (as screening does it).
    await db.transaction((tx) =>
      openCases(tx as never, subjectId, subject.account, LEGAL, [
        {entry: {source: 'ofac-sdn', ref: REF} as never, matchedName: MATCHED, score: 0.97} as never,
      ]),
    );
    const c = (await db.query.complianceCases.findFirst({where: eq(complianceCases.agentId, subjectId)}))!;
    await decide(db, {
      casePublicId: c.publicId,
      reviewer: r1.account,
      decision: 'clear',
      reason: SECRET_NOTE,
      caseVersion: 1,
    });
    await decide(db, {
      casePublicId: c.publicId,
      reviewer: r2.account,
      decision: 'clear',
      reason: 'Different birth date.',
      caseVersion: 2,
    });

    // A report, resolved with a block through the real route.
    const reporter = await agent(app, `al-reporter${++n}`);
    const filed = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: bearer(reporter.apiKey),
      payload: {
        targetType: 'person',
        targetId: subject.publicId,
        reason: 'scam',
        details: `${LEGAL} asked for a bank transfer`,
      },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const blocked = await app.inject({
      method: 'POST',
      url: `/v1/admin/reports/${filed.json().reportId}/resolve`,
      headers: bearer(r1.token),
      payload: {action: 'block', note: `Confirmed: ${LEGAL} again`},
    });
    expect(blocked.statusCode, blocked.body).toBe(200);

    const res = await exportCsv(r2.token, `?from=${since}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="pactora-audit-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toBe('at,kind,action,case_id,reviewer,subject_account,outcome,note');
    const rows = lines.slice(1).map((l) => l.split(','));
    const mine = rows.filter((r) => r[5] === subject.account);
    const summary = mine.map((r) => [r[1], r[2], r[4], r[6]]);
    expect(summary).toEqual([
      ['screening', 'case.opened', 'system', 'opened'],
      ['standing', 'standing.hold', 'system', 'hold'],
      ['screening', 'case.clear', r1.account, 'clear (case open)'],
      ['screening', 'case.clear', r2.account, 'clear (case cleared)'],
      ['standing', 'standing.clear', r2.account, 'clear'],
      ['standing', 'standing.blocked', r1.account, 'blocked'],
      ['report', 'report.block', r1.account, 'block'],
    ]);
    // The case's public id names the case; the report's names the report.
    expect(mine[0]![3]).toBe(c.publicId);
    expect(mine[0]![7]).toBe('ofac-sdn');
    expect(mine.at(-1)![3]).toBe(filed.json().reportId);
    expect(mine.at(-1)![7]).toBe('scam');
    // Timestamps in order, ISO.
    for (const r of mine) expect(r[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Never a legal or matched name, a list reference or a reviewer's words.
    for (const leak of [LEGAL, MATCHED, REF, 'Sidorov', 'Passport', 'birth', 'bank transfer', 'Confirmed']) {
      expect(res.body).not.toContain(leak);
    }
  });

  it('reviewers only, with a fresh session; an API key or a stranger is refused', async () => {
    const stranger = await person(app, `al-stranger${++n}`);
    const bot = await agent(app, `al-bot${++n}`);
    const r = await reviewer('al-fresh');
    expect((await exportCsv(null)).statusCode).toBe(401);
    expect((await exportCsv(stranger.token)).statusCode).toBe(403);
    expect((await exportCsv(bot.apiKey)).statusCode).toBe(401);
    expect((await exportCsv(r.token)).statusCode).toBe(200);
    // A sign-in older than an hour is refused, as on every admin route.
    await db.update(sessions).set({createdAt: new Date(Date.now() - 2 * 3_600_000)});
    expect((await exportCsv(r.token)).statusCode).toBe(401);
  });

  it('validates the window and is rate-limited', async () => {
    const r = await reviewer('al-window');
    expect((await exportCsv(r.token, '?from=yesterday')).statusCode).toBe(422);
    expect((await exportCsv(r.token, '?from=2026-11-09&to=2026-11-01')).statusCode).toBe(422);
    expect((await exportCsv(r.token, '?from=2024-01-01&to=2026-01-01')).statusCode).toBe(422);
    const ok = await exportCsv(r.token, '?from=2026-11-01&to=2026-11-08');
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.headers['content-disposition']).toContain('pactora-audit-2026-11-01-2026-11-08.csv');
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await exportCsv(r.token)).statusCode);
    expect(codes).toContain(429);
  });

  it('a cell that a spreadsheet would run as a formula is defused', async () => {
    const {csvCell} = await import('../src/routes/audit-log.js');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@a')).toBe("'@a");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('plain.near')).toBe('plain.near');
  });
});
