import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {sql} from 'drizzle-orm';
import {WORKER_FAULT_VALUES, closeDb, createDb, reputationScoreSql, type Db} from '../src/index.js';

/**
 * The reputation score is computed in SQL in two places: the indexer keeps
 * each agent's overall score, and discovery derives a score per skill. They
 * must be the same formula, or the same history would score two ways. This
 * pins the shared expression to the indexer's formula as it was written.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';
let db: Db;
beforeAll(() => {
  db = createDb(DB_URL, {max: 2});
});
afterAll(async () => {
  await closeDb(db);
});

/** The indexer's formula before it was shared, verbatim (apps/indexer, bumpReputation). */
// Counts are integer columns in the indexer; typed the same way here.
const original = (completed: number, failed: number, floor: number) => sql`GREATEST(0, LEAST(100, (
        50 + ((
          (100 * (${completed}::int + 1) / (${completed}::int + ${failed}::int + 2)) - 50
        ) * LEAST(100, (${completed}::int + ${failed}::int) * 100 / ${floor})) / 100
      )::int))`;

describe('reputationScoreSql', () => {
  it('gives exactly the indexer formula for every history', async () => {
    for (const floor of [25, 50]) {
      for (let completed = 0; completed <= 30; completed += 3) {
        for (let failed = 0; failed <= 12; failed += 2) {
          const [row] = (await db.execute(
            sql`SELECT ${original(completed, failed, floor)} AS a, ${reputationScoreSql(sql`${completed}::int`, sql`${failed}::int`, floor)} AS b`,
          )) as unknown as {a: number; b: number}[];
          expect([completed, failed, floor, Number(row!.b)]).toEqual([
            completed,
            failed,
            floor,
            Number(row!.a),
          ]);
        }
      }
    }
  });

  it('scores an agent with no history 50: unknown, not bad', async () => {
    const [row] = (await db.execute(
      sql`SELECT ${reputationScoreSql(sql`0::int`, sql`0::int`, 25)} AS s`,
    )) as unknown as {s: number}[];
    expect(Number(row!.s)).toBe(50);
  });
});

describe('WORKER_FAULT_VALUES', () => {
  /** JobRefunded.reason is a left-aligned bytes32 string; the indexer also accepts plain text. */
  it('holds each worker-fault reason as text and as its bytes32 form', () => {
    expect(WORKER_FAULT_VALUES).toContain('undelivered');
    expect(WORKER_FAULT_VALUES).toContain('dispute');
    expect(WORKER_FAULT_VALUES).toContain(`0x${Buffer.from('undelivered').toString('hex').padEnd(64, '0')}`);
    expect(WORKER_FAULT_VALUES).toContain(`0x${Buffer.from('dispute').toString('hex').padEnd(64, '0')}`);
    expect(WORKER_FAULT_VALUES).not.toContain('cancelled');
  });
});
