import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {MemoryObjectStore} from '@pactora/storage';
import {RETENTION_DEFAULTS, purgeRetention} from '../src/retention.js';

/**
 * Retention (docs/26 F27, 2026-11-09): photos, chat, drafts and old events
 * of finished jobs are purged after the documented periods; a dry run only
 * counts; a recent job and an unread notification are left alone.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
let db: Db;
const store = new MemoryObjectStore();
const DAY = 86_400_000;

beforeAll(() => {
  db = createDb(DB_URL, {max: 2});
});
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  store.objects.clear();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, job_files, job_messages, job_drafts, agent_events, agent_event_seq, agent_event_reads RESTART IDENTITY CASCADE`,
  );
});

/** A settled job `daysAgo` days ago between two agents, with a photo, a message, a draft and an event. */
async function finishedJob(daysAgo: number, label: string) {
  const at = new Date(Date.now() - daysAgo * DAY);
  const ids = (await db.execute(sql`
    INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task, chain_agent_id)
    VALUES ('near:sandbox', ${`${label}-c.test.near`}, ${`${label}-cw.test.near`}, 'C', '0', ${1000 + daysAgo}),
           ('near:sandbox', ${`${label}-w.test.near`}, ${`${label}-ww.test.near`}, 'W', '0', ${2000 + daysAgo})
    RETURNING id`)) as unknown as {id: number}[];
  const [c, w] = ids.map((r) => Number(r.id));
  const [j] = (await db.execute(sql`
    INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash, chain_job_id, state, settled_at, created_at)
    VALUES ('near:sandbox', ${c}, ${w}, 'escrow', '20000', '{}'::jsonb, ${'ab'.repeat(32)}, ${3000 + daysAgo}, 'settled', ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz)
    RETURNING id, public_id`)) as unknown as {id: number; public_id: string}[];
  const jobId = Number(j!.id);
  const key = `evidence/${j!.public_id}/one.png`;
  await store.put(key, new Uint8Array([1]), 'image/png');
  await db.execute(sql`
    INSERT INTO job_files (job_id, uploader_agent_id, object_key, sha256, mime, size)
    VALUES (${jobId}, ${w}, ${key}, ${'ee'.repeat(32)}, 'image/png', 1)`);
  await db.execute(
    sql`INSERT INTO job_messages (job_id, author_agent_id, body) VALUES (${jobId}, ${w}, 'hello there')`,
  );
  await db.execute(sql`
    INSERT INTO job_drafts (job_id, round, author_agent_id, snapshot, snapshot_hash)
    VALUES (${jobId}, 1, ${w}, '{"text":"round one"}'::jsonb, ${String(daysAgo).padStart(4, '0').repeat(16)})`);
  // The event (and its agent_events rows through the trigger), dated then.
  await db.execute(sql`
    INSERT INTO job_events (chain_id, job_id, kind, payload, occurred_at)
    VALUES ('near:sandbox', ${jobId}, 'settled', '{}'::jsonb, ${at.toISOString()}::timestamptz)`);
  await db.execute(
    sql`UPDATE agent_events SET created_at = ${at.toISOString()}::timestamptz WHERE job_id = ${jobId}`,
  );
  return {jobId, c, w, key};
}

const count = async (table: string, where = 'TRUE') =>
  Number(
    (
      (await db.execute(sql.raw(`SELECT count(*) AS n FROM ${table} WHERE ${where}`))) as unknown as {
        n: string;
      }[]
    )[0]!.n,
  );

describe('the retention sweep', () => {
  it('purges what is past its period, keeps what is not, and a dry run changes nothing', async () => {
    const old = await finishedJob(400, 'old');
    const fresh = await finishedJob(10, 'new');
    // The old client read its feed; the worker did not.
    await db.execute(sql`INSERT INTO agent_event_reads (agent_id, read_seq) VALUES (${old.c}, 1)`);

    const dry = await purgeRetention(db, store, {dryRun: true});
    expect(dry.dryRun).toBe(true);
    // jobEvents: both parties' copies of the old settled event; agentEvents: the one the client read.
    expect(dry.counts).toEqual({evidenceFiles: 1, messages: 1, drafts: 1, jobEvents: 2, agentEvents: 1});
    expect(store.objects.size).toBe(2);
    expect(await count('job_messages', "body = 'hello there'")).toBe(2);

    const real = await purgeRetention(db, store, {});
    // The read copy was counted under both kinds in the dry run; the real run removes it once.
    expect(real.counts).toEqual({...dry.counts, agentEvents: 0});
    // The old job: bytes gone, hash kept under a key nothing serves; words and snapshot scrubbed; events gone.
    expect(store.objects.has(old.key)).toBe(false);
    expect(store.objects.has(fresh.key)).toBe(true);
    const [f] = (await db.execute(
      sql`SELECT object_key, sha256 FROM job_files WHERE job_id = ${old.jobId}`,
    )) as unknown as [{object_key: string; sha256: string}];
    expect(f.object_key).toMatch(/^purged\//);
    expect(f.sha256).toBe('ee'.repeat(32));
    expect(await count('job_messages', `job_id = ${old.jobId} AND body = '[purged]'`)).toBe(1);
    expect(await count('job_drafts', `job_id = ${old.jobId} AND snapshot ? 'purged'`)).toBe(1);
    // The audit log is append-only (a trigger): it stays; the per-agent copies go.
    expect(await count('job_events', `job_id = ${old.jobId}`)).toBe(1);
    expect(await count('agent_events', `job_id = ${old.jobId}`)).toBe(0);
    // The recent job is untouched; the job rows themselves always stay.
    expect(await count('job_messages', `job_id = ${fresh.jobId} AND body = 'hello there'`)).toBe(1);
    expect(await count('job_events', `job_id = ${fresh.jobId}`)).toBe(1);
    expect(await count('jobs')).toBe(2);
    // A second sweep finds nothing more.
    expect((await purgeRetention(db, store, {})).counts).toEqual({
      evidenceFiles: 0,
      messages: 0,
      drafts: 0,
      jobEvents: 0,
      agentEvents: 0,
    });
  });

  it('respects configured periods: a shorter chat period purges only chat', async () => {
    const j = await finishedJob(30, 'mid');
    const r = await purgeRetention(db, store, {...RETENTION_DEFAULTS, chatDays: 7});
    expect(r.counts).toEqual({evidenceFiles: 0, messages: 1, drafts: 0, jobEvents: 0, agentEvents: 0});
    expect(store.objects.has(j.key)).toBe(true);
    expect(await count('job_messages', `job_id = ${j.jobId} AND body = '[purged]'`)).toBe(1);
  });
});
