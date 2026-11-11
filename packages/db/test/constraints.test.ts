import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '../src/index.js';

/**
 * The constraints, tried against a real Postgres.
 *
 * `0001_constraints.sql` says these "make bad states impossible rather than
 * merely discouraged" and that append-only is "enforced, not just documented".
 * Nothing had ever checked that. In this project, a guarantee asserted in a
 * comment has turned out to be absent five times — a balance-delta guard that
 * did not exist, an SSRF guard for a fetch nobody wrote, a session-key expiry
 * nothing bounded, a result check the route did not perform, and an on-chain
 * commitment to the wrong hash.
 *
 * So each test here writes the bad row and requires the database to refuse
 * it. A constraint that exists only in a migration file nobody ran is
 * indistinguishable from one that was never written.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';

let db: Db;

beforeAll(() => {
  db = createDb(DB_URL, {max: 3});
});

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, runs, run_events, signer_txs RESTART IDENTITY CASCADE`,
  );
});

/** Asserts the statement is refused, and that it is refused for the right reason. */
async function refuses(statement: ReturnType<typeof sql>, because: RegExp): Promise<void> {
  let error: unknown;
  try {
    await db.execute(statement);
  } catch (err) {
    error = err;
  }
  expect(error, 'the database accepted a row it should have refused').toBeDefined();
  // drizzle wraps the driver's error (DrizzleQueryError, since 0.45); the
  // constraint that fired is named on the Postgres error it carries.
  const pg = ((error as {cause?: unknown}).cause ?? error) as Error;
  expect(`${(error as Error).message} ${pg.message}`).toMatch(because);
}

async function agent(chainId: string, wallet: string, over: {price?: string} = {}): Promise<number> {
  const rows = (await db.execute(
    sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
        VALUES (${chainId}, 'owner.testnet', ${wallet}, 'A', ${over.price ?? '20000'}) RETURNING id`,
  )) as unknown as {id: number}[];
  return rows[0]!.id;
}

describe('a job can never span two chains', () => {
  /**
   * The composite foreign key is what makes this structural. Without it, a
   * job whose client is on testnet and whose worker is on mainnet is one
   * application bug away — and testnet NEAR is free, so that bug is a way to
   * buy mainnet reputation.
   */
  it('refuses a job whose worker is on another network', async () => {
    const client = await agent('near:testnet', 'w11.testnet');
    const worker = await agent('near:sandbox', 'w22.testnet');

    await refuses(
      sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash)
          VALUES ('near:testnet', ${client}, ${worker}, 'escrow', 20000, '{}'::jsonb, '0xa')`,
      /jobs_worker_same_chain|foreign key/i,
    );
  });

  it('refuses a job whose client is on another network', async () => {
    const client = await agent('near:sandbox', 'w33.testnet');
    const worker = await agent('near:testnet', 'w44.testnet');

    await refuses(
      sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash)
          VALUES ('near:testnet', ${client}, ${worker}, 'escrow', 20000, '{}'::jsonb, '0xb')`,
      /jobs_client_same_chain|foreign key/i,
    );
  });

  it('accepts a job when both sides are on the same chain', async () => {
    const client = await agent('near:testnet', 'w55.testnet');
    const worker = await agent('near:testnet', 'w66.testnet');

    await db.execute(
      sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash)
          VALUES ('near:testnet', ${client}, ${worker}, 'escrow', 20000, '{}'::jsonb, '0xc')`,
    );
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM jobs`)) as unknown as {n: number}[];
    expect(rows[0]!.n).toBe(1);
  });
});

describe('money cannot be created or faked', () => {
  async function pair(): Promise<[number, number]> {
    return [await agent('near:testnet', 'w77.testnet'), await agent('near:testnet', 'w88.testnet')];
  }

  it('refuses a self-dealt job', async () => {
    const [a] = await pair();
    await refuses(
      sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash)
          VALUES ('near:testnet', ${a}, ${a}, 'escrow', 20000, '{}'::jsonb, '0xd')`,
      /no_self_dealing/i,
    );
  });

  it('refuses a zero-amount job', async () => {
    const [c, w] = await pair();
    await refuses(
      sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash)
          VALUES ('near:testnet', ${c}, ${w}, 'escrow', 0, '{}'::jsonb, '0xe')`,
      /amount_positive/i,
    );
  });

  /** Invariant I4 in the database: settlement never creates value. */
  it('refuses a fee larger than the amount it came out of', async () => {
    const [c, w] = await pair();
    await refuses(
      sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, fee, spec, spec_hash)
          VALUES ('near:testnet', ${c}, ${w}, 'escrow', 20000, 20001, '{}'::jsonb, '0xf')`,
      /fee_within_amount/i,
    );
  });

  it('refuses a negative fee', async () => {
    const [c, w] = await pair();
    await refuses(
      sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, fee, spec, spec_hash)
          VALUES ('near:testnet', ${c}, ${w}, 'escrow', 20000, -1, '{}'::jsonb, '0x10')`,
      /fee_not_negative/i,
    );
  });

  it('refuses a zero-amount payment row', async () => {
    await refuses(
      sql`INSERT INTO payments (chain_id, amount, fee, tx_hash, block_number)
          VALUES ('near:testnet', 0, 0, '0xaa', 1)`,
      /payment_amount_positive/i,
    );
  });

  it('refuses a negative price', async () => {
    await refuses(
      sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
          VALUES ('near:testnet', 'o.testnet', 'w99.testnet', 'Cheap', -1)`,
      /price_non_negative/i,
    );
  });
});

describe('a score cannot leave its range', () => {
  it('refuses a score above 100', async () => {
    const a = await agent('near:testnet', 'waa.testnet');
    await refuses(sql`INSERT INTO agent_stats (agent_id, score) VALUES (${a}, 101)`, /score_in_range/i);
  });

  it('refuses a negative score', async () => {
    const a = await agent('near:testnet', 'wbb.testnet');
    await refuses(sql`INSERT INTO agent_stats (agent_id, score) VALUES (${a}, -1)`, /score_in_range/i);
  });
});

describe('capabilities stay matchable', () => {
  /**
   * "Market Research" and "market-research" would be different capabilities,
   * and discovery would silently find nobody.
   */
  it('refuses a capability that is not kebab-case', async () => {
    const a = await agent('near:testnet', 'wcc.testnet');
    for (const bad of [
      'Market Research',
      'market_research',
      'Market-Research',
      'market--research',
      '-market',
    ]) {
      await refuses(
        sql`INSERT INTO agent_capabilities (agent_id, capability) VALUES (${a}, ${bad})`,
        /capability_is_kebab_case/i,
      );
    }
  });

  it('accepts ordinary kebab-case', async () => {
    const a = await agent('near:testnet', 'wdd.testnet');
    await db.execute(
      sql`INSERT INTO agent_capabilities (agent_id, capability) VALUES (${a}, 'market-research'), (${a}, 'trade-analysis'), (${a}, 'x2')`,
    );
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM agent_capabilities`)) as unknown as {
      n: number;
    }[];
    expect(rows[0]!.n).toBe(3);
  });
});

describe('job_events is append-only, enforced rather than documented', () => {
  async function anEvent(): Promise<number> {
    const client = await agent('near:testnet', 'wee.testnet');
    const worker = await agent('near:testnet', 'wff.testnet');
    const jobs = (await db.execute(
      sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash)
          VALUES ('near:testnet', ${client}, ${worker}, 'escrow', 20000, '{}'::jsonb, '0x11') RETURNING id`,
    )) as unknown as {id: number}[];
    await db.execute(
      sql`INSERT INTO job_events (chain_id, job_id, kind, payload, tx_hash, log_index)
          VALUES ('near:testnet', ${jobs[0]!.id}, 'settled', '{}'::jsonb, '0xtx', 0)`,
    );
    return jobs[0]!.id;
  }

  /**
   * The audit trail behind every payment. If it can be edited after the fact,
   * "the chain said so" stops being checkable against our own record.
   */
  it('refuses an UPDATE', async () => {
    await anEvent();
    await refuses(sql`UPDATE job_events SET kind = 'refunded'`, /append-only/i);
  });

  it('refuses a DELETE', async () => {
    await anEvent();
    await refuses(sql`DELETE FROM job_events`, /append-only/i);
  });

  it('still allows an INSERT, which is the whole point', async () => {
    const jobId = await anEvent();
    await db.execute(
      sql`INSERT INTO job_events (chain_id, job_id, kind, payload, tx_hash, log_index)
          VALUES ('near:testnet', ${jobId}, 'accepted', '{}'::jsonb, '0xtx2', 1)`,
    );
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM job_events`)) as unknown as {
      n: number;
    }[];
    expect(rows[0]!.n).toBe(2);
  });
});

describe('uniqueness that makes replay safe', () => {
  it('refuses the same chain event twice', async () => {
    const client = await agent('near:testnet', 'w12.testnet');
    const worker = await agent('near:testnet', 'w13.testnet');
    const jobs = (await db.execute(
      sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash)
          VALUES ('near:testnet', ${client}, ${worker}, 'escrow', 20000, '{}'::jsonb, '0x14') RETURNING id`,
    )) as unknown as {id: number}[];

    // Keyed by receipt, not transaction: on NEAR one transaction's receipts each log their own events.
    const insert = sql`INSERT INTO job_events (chain_id, job_id, kind, payload, tx_hash, receipt_id, log_index)
        VALUES ('near:testnet', ${jobs[0]!.id}, 'settled', '{}'::jsonb, 'txdup', 'receiptdup', 3)`;
    await db.execute(insert);
    await refuses(insert, /job_events_idempotency_uk|duplicate key/i);
  });

  it('refuses two agents sharing a wallet on one chain', async () => {
    await agent('near:testnet', 'w15.testnet');
    await refuses(
      sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
          VALUES ('near:testnet', 'o.testnet', 'w15.testnet', 'Twin', 100)`,
      /agents_chain_wallet_uk|duplicate key/i,
    );
  });

  /**
   * The same wallet on a DIFFERENT chain is a different agent with its own
   * reputation — a global unique here would make the second network fail to
   * index at agent one.
   */
  it('allows the same wallet on a different chain', async () => {
    await agent('near:testnet', 'w16.testnet');
    await agent('near:sandbox', 'w16.testnet');
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM agents`)) as unknown as {n: number}[];
    expect(rows[0]!.n).toBe(2);
  });

  it('refuses reusing an idempotency key in the signer ledger', async () => {
    const a = await agent('near:testnet', 'w17.testnet');
    await db.execute(
      sql`INSERT INTO signer_txs (chain_id, agent_id, idempotency_key, nonce, status)
          VALUES ('near:testnet', ${a}, 'key-1', 0, 'pending')`,
    );
    await refuses(
      sql`INSERT INTO signer_txs (chain_id, agent_id, idempotency_key, nonce, status)
          VALUES ('near:testnet', ${a}, 'key-1', 1, 'pending')`,
      /signer_idempotency_uk|duplicate key/i,
    );
  });

  /**
   * Two transactions sharing a nonce means one of them never lands. The
   * database refuses the second rather than leaving it to be discovered in
   * the mempool.
   */
  it('refuses reusing a nonce for the same agent on the same chain', async () => {
    const a = await agent('near:testnet', 'w18.testnet');
    await db.execute(
      sql`INSERT INTO signer_txs (chain_id, agent_id, idempotency_key, nonce, status)
          VALUES ('near:testnet', ${a}, 'key-a', 7, 'pending')`,
    );
    await refuses(
      sql`INSERT INTO signer_txs (chain_id, agent_id, idempotency_key, nonce, status)
          VALUES ('near:testnet', ${a}, 'key-b', 7, 'pending')`,
      /signer_nonce_uk|duplicate key/i,
    );
  });
});

describe('NEAR identifiers (docs/NEAR-WIRE.md §1–2)', () => {
  it('refuses a network key that is not a NEAR CAIP-2 id', async () => {
    await refuses(
      sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
          VALUES ('unknown:1', 'o.testnet', 'w1.testnet', 'A', 100)`,
      /agents_chain_caip2/,
    );
  });

  it('refuses an owner or wallet that is not a NEAR account id', async () => {
    await refuses(
      sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
          VALUES ('near:testnet', '0xAbC0000000000000000000000000000000000001', 'w2.testnet', 'A', 100)`,
      /agents_owner_account/,
    );
    await refuses(
      sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
          VALUES ('near:testnet', 'o.testnet', 'bad..name', 'A', 100)`,
      /agents_wallet_account/,
    );
  });

  it('refuses a token transfer between non-accounts', async () => {
    await refuses(
      sql`INSERT INTO token_transfers (chain_id, block_number, tx_hash, receipt_id, log_index, from_address, to_address, amount)
          VALUES ('near:testnet', 1, 't', 'r', 0, 'Alice.testnet', 'bob.testnet', 1)`,
      /token_transfers_from_account/,
    );
  });
});
