import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {Indexer} from '../src/indexer.js';
import {FakeChain, log, receipt, sandboxChain} from './near-fixtures.js';
import {CHAIN, DB_URL, reset} from './db.js';

/**
 * The deadlock `pnpm swarm:local` found (2026-11-09, round 3).
 *
 * Every agent event takes its agent's `agent_event_seq` row lock until
 * commit (migrations 0018, 0024). The indexer's batch writes many jobs'
 * events in one transaction, and took those locks in EVENT order. An API
 * transaction taking two agents' locks (in agent order) could then hold one
 * the indexer wanted while waiting for one the indexer held: Postgres
 * "deadlock detected", and the API's request answered 500.
 *
 * Deterministic: a second connection plays the API — it locks agent 1,
 * waits until the indexer is blocked, then asks for agent 3. With event
 * order the indexer already holds agent 3 (job A: agents 2 and 3 comes
 * first in the block) and waits for agent 1: a cycle. With the batch's
 * parties locked in agent-id order up front, the indexer waits on agent 1
 * holding nothing, and both finish.
 */
const chain = sandboxChain();
const PACTORA = chain.contracts.Pactora;
const H = 'cd'.repeat(32);

let db: Db;
let api: postgres.Sql;
beforeAll(() => {
  db = createDb(DB_URL, {max: 3});
  api = postgres(DB_URL, {max: 2, onnotice: () => {}});
});
afterAll(async () => {
  await api.end();
  await closeDb(db);
});
beforeEach(async () => {
  await reset(db);
});

async function agentRow(chainAgentId: number): Promise<number> {
  const [row] = (await db.execute(
    sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task, chain_agent_id)
        VALUES (${CHAIN}, ${`o${chainAgentId}.test.near`}, ${`w${chainAgentId}.test.near`}, ${`A${chainAgentId}`}, '20000', ${chainAgentId})
        RETURNING id`,
  )) as unknown as {id: number}[];
  return Number(row!.id);
}
async function jobRow(chainJobId: number, client: number, worker: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash, chain_job_id, state)
        VALUES (${CHAIN}, ${client}, ${worker}, 'escrow', '20000', '{}'::jsonb, ${H}, ${chainJobId}, 'created')`,
  );
}

/** Wait until some backend of this database is waiting on a lock. */
async function untilSomeoneWaits(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [w] = await api`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (Number(w?.['n'] ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('nobody ever waited on a lock');
}

describe("the indexer's batch takes agent_event_seq locks in agent-id order", () => {
  it('does not deadlock with an API transaction that locks agents 1 then 3', async () => {
    const [a1, a2, a3] = [await agentRow(11), await agentRow(12), await agentRow(13)];
    expect(a1 < a2 && a2 < a3).toBe(true);
    await jobRow(101, a2, a3); // job A, first in the block: agents 2 and 3
    await jobRow(102, a1, a2); // job B: agents 1 and 2

    const src = new FakeChain(chain.startBlock);
    src.block(
      receipt({
        executor: PACTORA,
        logs: [log.jobAccepted({jobId: 101, worker: 13, bond: 10000, workDeadline: 1700003600})],
      }),
      receipt({
        executor: PACTORA,
        logs: [log.jobAccepted({jobId: 102, worker: 12, bond: 10000, workDeadline: 1700003600})],
      }),
    );
    const indexer = new Indexer({db, chain, source: src});

    const conn = await api.reserve();
    const apiErrors: string[] = [];
    let indexerError: string | null = null;
    try {
      await conn`BEGIN`;
      // The API's event for agent 1, through pactora_agent_event (as listing.closed and account.warned are).
      await conn`SELECT pactora_agent_event(${a1}, 'account', 'account.warned', '{}'::jsonb, NULL, 'lo-1')`;
      const tick = indexer.tick().catch((e: unknown) => {
        // drizzle wraps the driver's error: the reason is its cause.
        indexerError = String((e as {cause?: Error}).cause?.message ?? (e as Error).message);
      });
      await untilSomeoneWaits();
      // Then for agent 3, in the same transaction.
      await conn`SELECT pactora_agent_event(${a3}, 'account', 'account.warned', '{}'::jsonb, NULL, 'lo-3')`.catch(
        (e: unknown) => apiErrors.push(String((e as Error).message)),
      );
      await conn`COMMIT`.catch(() => {});
      await tick;
    } finally {
      await conn`ROLLBACK`.catch(() => {});
      conn.release();
    }
    expect({apiErrors, indexerError}).toEqual({apiErrors: [], indexerError: null});
    // Both jobs' events landed, numbered without gaps per agent.
    const seqs = (await db.execute(
      sql`SELECT agent_id::int, array_agg(seq::int ORDER BY seq) AS seqs FROM agent_events GROUP BY agent_id ORDER BY agent_id`,
    )) as unknown as {agent_id: number; seqs: number[]}[];
    expect(seqs).toEqual([
      {agent_id: a1, seqs: [1, 2]},
      {agent_id: a2, seqs: [1, 2]},
      {agent_id: a3, seqs: [1, 2]},
    ]);
  }, 20_000);
});
