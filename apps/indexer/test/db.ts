/** Database helpers shared by the indexer tests. They TRUNCATE: never point DATABASE_URL at real data. */
import {sql} from 'drizzle-orm';
import type {Db} from '@pactora/db';

export const DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near_indexer';

export const CHAIN = 'near:sandbox';

export const CLIENT = {chainAgentId: 1, owner: 'client-owner.test.near', wallet: 'client.test.near'};
export const WORKER = {chainAgentId: 2, owner: 'worker-owner.test.near', wallet: 'worker.test.near'};
export const SPEC = 'aa'.repeat(32);

export async function reset(db: Db): Promise<void> {
  await db.execute(
    sql`TRUNCATE indexer_cursor, agents, jobs, job_events, agent_stats, agent_capabilities, api_keys,
        payments, token_transfers, runs, run_events, disputes, signer_txs, spend_policies, key_challenges, x402_redemptions RESTART IDENTITY CASCADE`,
  );
}

async function agent(db: Db, a: typeof CLIENT, name: string): Promise<number> {
  const [row] = (await db.execute(
    sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task, chain_agent_id)
        VALUES (${CHAIN}, ${a.owner}, ${a.wallet}, ${name}, '20000', ${a.chainAgentId}) RETURNING id`,
  )) as unknown as {id: number}[];
  return Number(row!.id);
}

/** The client and worker agents, as the API registered them. */
export async function seedAgents(db: Db): Promise<{clientId: number; workerId: number}> {
  const clientId = await agent(db, CLIENT, 'Client');
  const workerId = await agent(db, WORKER, 'Worker');
  await db.execute(sql`INSERT INTO agent_stats (agent_id) VALUES (${workerId})`);
  return {clientId, workerId};
}

/**
 * A job between them. `chainJobId` null is a job the API wrote before the
 * chain assigned its id — linked later by spec hash.
 */
export async function seedJob(
  db: Db,
  o: {chainJobId?: number | null; path?: 'escrow' | 'direct'; specHash?: string; state?: string} = {},
): Promise<{jobId: number; clientId: number; workerId: number}> {
  const {clientId, workerId} = await seedAgents(db);
  const chainJobId = o.chainJobId === undefined ? 7 : o.chainJobId;
  const [job] = (await db.execute(
    sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash, chain_job_id, state)
        VALUES (${CHAIN}, ${clientId}, ${workerId}, ${o.path ?? 'escrow'}, '20000', '{}'::jsonb,
                ${o.specHash ?? SPEC}, ${chainJobId}, ${o.state ?? 'created'})
        RETURNING id`,
  )) as unknown as {id: number}[];
  return {jobId: Number(job!.id), clientId, workerId};
}

export async function statsOf(db: Db, agentId: number) {
  const rows = (await db.execute(
    sql`SELECT completed::int, failed::int, score::int, volume::text FROM agent_stats WHERE agent_id = ${agentId}`,
  )) as unknown as {completed: number; failed: number; score: number; volume: string}[];
  return rows[0]!;
}

export async function jobRow(db: Db, jobId: number) {
  const rows = (await db.execute(
    sql`SELECT state, chain_job_id::text, fee::text, result_hash,
        (extract(epoch FROM settled_at) * 1000)::bigint::text AS settled_ms FROM jobs WHERE id = ${jobId}`,
  )) as unknown as {
    state: string;
    chain_job_id: string | null;
    fee: string | null;
    result_hash: string | null;
    settled_ms: string | null;
  }[];
  return rows[0]!;
}

export async function eventRows(db: Db) {
  return (await db.execute(
    sql`SELECT kind, payload, tx_hash, receipt_id, block_number::int, log_index FROM job_events ORDER BY id`,
  )) as unknown as {
    kind: string;
    payload: Record<string, unknown>;
    tx_hash: string;
    receipt_id: string;
    block_number: number;
    log_index: number;
  }[];
}

export async function paymentRows(db: Db) {
  return (await db.execute(
    sql`SELECT amount::text, fee::text, tx_hash, block_number::int FROM payments ORDER BY id`,
  )) as unknown as {amount: string; fee: string; tx_hash: string; block_number: number}[];
}

export async function cursorRow(db: Db) {
  const rows = (await db.execute(
    sql`SELECT contract, last_block::int, last_block_hash FROM indexer_cursor`,
  )) as unknown as {contract: string; last_block: number; last_block_hash: string}[];
  return rows;
}
