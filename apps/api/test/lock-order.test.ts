import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {notifyApplicants} from '../src/listing-slots.js';

/**
 * The API half of the deadlock `pnpm swarm:local` found (2026-11-09).
 *
 * `notifyApplicants` writes one feed event per applicant in one
 * transaction, each taking that agent's `agent_event_seq` lock until
 * commit. It took them in the order the rows came back. Against another
 * transaction taking the same agents' locks in agent-id order, that is a
 * cycle: Postgres "deadlock detected", and the request (a fill, a close, a
 * cancel) answered 500.
 *
 * Deterministic: a second connection locks agent 1, `notifyApplicants` runs
 * for applicants [3, 1] and blocks, then the second connection asks for
 * agent 3. In row order the API already holds agent 3: a cycle. In agent-id
 * order it waits on agent 1 holding nothing, and both finish.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';

let db: Db;
let other: postgres.Sql;
beforeAll(() => {
  db = createDb(DB_URL, {max: 3});
  other = postgres(DB_URL, {max: 2, onnotice: () => {}});
});
afterAll(async () => {
  await other.end();
  await closeDb(db);
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE agents, listings, agent_events, agent_event_seq RESTART IDENTITY CASCADE`);
});

async function agentRow(n: number): Promise<number> {
  const [row] = (await db.execute(
    sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task, chain_agent_id)
        VALUES ('near:sandbox', ${`o${n}.test.near`}, ${`w${n}.test.near`}, ${`A${n}`}, '20000', ${n})
        RETURNING id`,
  )) as unknown as {id: number}[];
  return Number(row!.id);
}

async function untilSomeoneWaits(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [w] = await other`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (Number(w?.['n'] ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('nobody ever waited on a lock');
}

describe('notifyApplicants takes agent_event_seq locks in agent-id order', () => {
  it('does not deadlock with a transaction that locks agents 1 then 3', async () => {
    const [a1, , a3] = [await agentRow(21), await agentRow(22), await agentRow(23)];
    const [listing] = (await db.execute(sql`
      INSERT INTO listings (chain_id, client_agent_id, title, description, category, interaction_mode, max_price,
                            max_workers, hiring_mode, estimated_minutes, deadline, criteria, accept_window_seconds,
                            work_window_seconds, reserved, idempotency_key, request_hash)
      VALUES ('near:sandbox', ${a1}, 'Label photos', 'Label two hundred photos.', 'expertise', 'task', 40000,
              1, 'applications', 30, now() + interval '1 day', 'Every photo labelled.', 300, 900, 0, 'lo-k', 'lo-h')
      RETURNING id, public_id`)) as unknown as {id: number; public_id: string}[];

    const conn = await other.reserve();
    const otherErrors: string[] = [];
    let apiError: string | null = null;
    try {
      await conn`BEGIN`;
      await conn`SELECT pactora_agent_event(${a1}, 'account', 'account.warned', '{}'::jsonb, NULL, 'lo-1')`;
      // Applicants as the UPDATE … RETURNING handed them back: agent 3 first.
      const fill = db
        .transaction((tx) =>
          notifyApplicants(
            tx,
            {id: Number(listing!.id), publicId: listing!.public_id},
            [
              {publicId: '33333333-3333-4333-8333-333333333333', applicantAgentId: a3},
              {publicId: '11111111-1111-4111-8111-111111111111', applicantAgentId: a1},
            ],
            'listing.closed',
            ':lo',
          ),
        )
        .catch((e: unknown) => {
          apiError = String((e as {cause?: Error}).cause?.message ?? (e as Error).message);
        });
      await untilSomeoneWaits();
      await conn`SELECT pactora_agent_event(${a3}, 'account', 'account.warned', '{}'::jsonb, NULL, 'lo-3')`.catch(
        (e: unknown) => otherErrors.push(String((e as Error).message)),
      );
      await conn`COMMIT`.catch(() => {});
      await fill;
    } finally {
      await conn`ROLLBACK`.catch(() => {});
      conn.release();
    }
    expect({otherErrors, apiError}).toEqual({otherErrors: [], apiError: null});
    const [c] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM agent_events WHERE kind = 'listing.closed'`,
    )) as unknown as {n: number}[];
    expect(c?.n).toBe(2);
  }, 20_000);
});
