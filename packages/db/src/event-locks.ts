import {sql} from 'drizzle-orm';
import type {Db} from './client.js';

/**
 * Take the `agent_event_seq` row locks for these agents, in agent-id order,
 * at the start of a transaction that will write events for several of them.
 *
 * Every agent event (the job_events fan-out trigger of migration 0018,
 * `pactora_agent_event()` of 0024) locks its agent's counter row until
 * commit. Two transactions that take two of those locks in opposite orders
 * deadlock; `pnpm swarm:local` found the indexer's batch (event order)
 * against the API's writes (agent order), and Postgres answered "deadlock
 * detected" to one of them (2026-11-09). The rule for any transaction that
 * writes events for more than one agent: call this first, with all of them.
 * The writes afterwards find the locks already held, in any order.
 *
 * Missing counter rows are created (at 0, which the writers' upserts count
 * on from), in the same order.
 */
export async function lockAgentEventSeqs(tx: Pick<Db, 'execute'>, agentIds: Iterable<number>): Promise<void> {
  const ids = [...new Set([...agentIds].filter((n) => Number.isSafeInteger(n) && n > 0))].sort(
    (a, b) => a - b,
  );
  if (ids.length === 0) return;
  const list = sql`ARRAY[${sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  )}]::bigint[]`;
  await tx.execute(sql`INSERT INTO agent_event_seq (agent_id, last)
    SELECT x, 0 FROM unnest(${list}) AS x ORDER BY x ON CONFLICT (agent_id) DO NOTHING`);
  await tx.execute(
    sql`SELECT agent_id FROM agent_event_seq WHERE agent_id = ANY(${list}) ORDER BY agent_id FOR UPDATE`,
  );
}
