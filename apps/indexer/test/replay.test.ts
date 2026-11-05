import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {sql} from 'drizzle-orm';
import {loadConfig, loadAbis} from '@pactora/config';
import {createDb, closeDb, type Db} from '@pactora/db';
import {Indexer} from '../src/indexer.js';
import {encodeAbiParameters, encodeEventTopics, stringToHex, type Abi, type AbiEvent} from 'viem';

/**
 * Replay safety — chaos checklist item 2, "kill the indexer, no duplicate rows".
 *
 * A replay is ORDINARY here, not exotic. The cursor is written after a batch
 * is processed, so any restart mid-batch re-reads it, and every reorg
 * deliberately rewinds twice the confirmation depth. So the question is not
 * whether logs get processed twice — they do — but whether processing one
 * twice changes anything.
 *
 * The events and payments tables were always protected by unique keys. The
 * reputation bump was not: it is `completed + 1`, and it ran whether or not
 * the event was new. Every replay credited the worker again, with no payment
 * behind it — inflating the one number this project claims can only be
 * written by a settled payment.
 *
 * These call `handleLog` through a narrow reach into the instance rather than
 * through `tick()`, because `tick()` needs an RPC and the behaviour under test
 * is entirely local.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';

let db: Db;
let indexer: Indexer;

const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});
const chain = config.chain(31337);

beforeAll(() => {
  db = createDb(DB_URL, {max: 3});
  indexer = new Indexer({db, chain, abis: loadAbis() as never});
});

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, runs, run_events RESTART IDENTITY CASCADE`,
  );
});

/** A settled job, already linked to its on-chain id. */
async function seedJob(): Promise<{jobId: number; workerId: number}> {
  const [client] = (await db.execute(
    sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task, chain_agent_id)
        VALUES (31337, '0xaa', '0xaa', 'Client', '20000', 1) RETURNING id`,
  )) as unknown as {id: number}[];
  const [worker] = (await db.execute(
    sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task, chain_agent_id)
        VALUES (31337, '0xbb', '0xbb', 'Worker', '20000', 2) RETURNING id`,
  )) as unknown as {id: number}[];

  const [job] = (await db.execute(
    sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash, chain_job_id)
        VALUES (31337, ${client!.id}, ${worker!.id}, 'escrow', '20000', '{}'::jsonb, '0xspec', 7)
        RETURNING id`,
  )) as unknown as {id: number}[];

  await db.execute(sql`INSERT INTO agent_stats (agent_id) VALUES (${worker!.id})`);
  return {jobId: job!.id, workerId: worker!.id};
}

/** The same settled log the chain would hand us, as many times as we like. */
function settledLog(overrides: Record<string, unknown> = {}) {
  return {
    address: chain.contracts['TaskEscrow'] as `0x${string}`,
    blockNumber: 1234n,
    logIndex: 3,
    transactionHash: `0x${'ab'.repeat(32)}`,
    ...overrides,
  };
}

/** Bypasses decoding: the decoder needs real ABI-encoded data, the projection does not. */
async function feed(log: ReturnType<typeof settledLog>, kind: string, payload: Record<string, unknown>) {
  const inner = indexer as unknown as {
    decode: (entry: unknown) => Promise<unknown>;
    handleLog: (entry: unknown) => Promise<void>;
  };
  const original = inner.decode;
  inner.decode = async () => ({kind, chainJobId: '7', payload});
  try {
    await inner.handleLog.call(indexer, log);
  } finally {
    inner.decode = original;
  }
}

async function statsOf(workerId: number) {
  const rows = (await db.execute(
    sql`SELECT completed, failed, score, volume FROM agent_stats WHERE agent_id = ${workerId}`,
  )) as unknown as {completed: number; failed: number; score: number; volume: string}[];
  return rows[0]!;
}

async function countRows(table: 'job_events' | 'payments') {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`,
  )) as unknown as {n: number}[];
  return rows[0]!.n;
}

describe('replaying a settled event', () => {
  it('credits the worker exactly once', async () => {
    const {workerId} = await seedJob();
    const log = settledLog();
    const payload = {fee: '200', txHash: `0x${'cd'.repeat(32)}`};

    await feed(log, 'settled', payload);
    const first = await statsOf(workerId);
    expect(Number(first.completed)).toBe(1);

    // The same log again — a restart mid-batch, or a reorg rewind.
    await feed(log, 'settled', payload);
    await feed(log, 'settled', payload);

    const after = await statsOf(workerId);
    expect(Number(after.completed), 'a replay must not credit the worker again').toBe(1);
    expect(Number(after.score)).toBe(Number(first.score));
  });

  it('writes one event row and one payment row however many times it is replayed', async () => {
    await seedJob();
    const log = settledLog();
    const payload = {fee: '200', txHash: `0x${'cd'.repeat(32)}`};

    for (let i = 0; i < 4; i++) await feed(log, 'settled', payload);

    expect(await countRows('job_events')).toBe(1);
    expect(await countRows('payments')).toBe(1);
  });

  it('does not inflate settled volume on replay', async () => {
    const {workerId} = await seedJob();
    const log = settledLog();

    await feed(log, 'settled', {fee: '200', txHash: '0x01'});
    await feed(log, 'settled', {fee: '200', txHash: '0x01'});

    expect(BigInt((await statsOf(workerId)).volume)).toBe(20_000n);
  });

  /**
   * Two genuinely different events must both count — the guard is the unique
   * (chain, tx, logIndex) key, not "have we seen this job before".
   */
  it('still counts a second, genuinely different settlement', async () => {
    const {workerId} = await seedJob();

    await feed(settledLog(), 'settled', {fee: '200', txHash: '0x01'});
    await feed(
      settledLog({transactionHash: `0x${'ef'.repeat(32)}`, logIndex: 9, blockNumber: 1300n}),
      'settled',
      {fee: '200', txHash: '0x02'},
    );

    expect(Number((await statsOf(workerId)).completed)).toBe(2);
  });

  it('records the block the payment actually landed in, not zero', async () => {
    await seedJob();
    await feed(settledLog({blockNumber: 987n}), 'settled', {fee: '200', txHash: '0x01'});

    const rows = (await db.execute(sql`SELECT block_number FROM payments`)) as unknown as {
      block_number: string;
    }[];
    expect(Number(rows[0]!.block_number)).toBe(987);
  });
});

describe('replaying a refund', () => {
  it('counts a failure exactly once', async () => {
    const {workerId} = await seedJob();
    const log = settledLog({logIndex: 5});

    await feed(log, 'refunded', {reason: 'undelivered'});
    await feed(log, 'refunded', {reason: 'undelivered'});

    const stats = await statsOf(workerId);
    expect(Number(stats.failed)).toBe(1);
    expect(Number(stats.completed)).toBe(0);
  });

  /** A job nobody ever accepted is not the worker's fault. */
  it('does not blame the worker for a job that was never accepted', async () => {
    const {workerId} = await seedJob();
    await feed(settledLog({logIndex: 6}), 'refunded', {reason: 'unaccepted'});

    expect(Number((await statsOf(workerId)).failed)).toBe(0);
  });
});

/**
 * Where a fresh indexer starts.
 *
 * With no cursor, `tick()` begins at the deployment's `startBlock` and
 * backfills — correct for production, and the reason the demo never once
 * completed. The demo truncates the cursor at startup, so the indexer
 * restarted at block 65,027,889 while its own transactions were landing at
 * 66,636,000: 1.6 MILLION blocks away, at Monad's 100-block `eth_getLogs`
 * cap. It would have needed about two hours to catch up to work that finished
 * in ninety seconds.
 *
 * So no `chain_job_id` was ever linked, every transition answered "not
 * confirmed on-chain yet", and no job ever settled. Five demo runs were read
 * as agent failures. `.catch(() => {})` around the tick hid the whole thing.
 *
 * Starting at the head is also what an operator wants when adding a chain
 * they do not need the history of.
 */
describe('starting from the head instead of from genesis', () => {
  /** A chain whose head is far from the deployment block. */
  const fakeChain = (head: bigint) => ({
    getBlockNumber: async () => head,
    getBlock: async ({blockNumber}: {blockNumber: bigint}) => ({
      number: blockNumber,
      hash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
    }),
  });

  const cursorRow = async () =>
    (await db.execute(
      sql`SELECT last_block, last_block_hash FROM indexer_cursor WHERE chain_id = 31337`,
    )) as unknown as {last_block: string; last_block_hash: string}[];

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM indexer_cursor WHERE chain_id = 31337`);
  });

  it('writes a cursor at the head so the next tick does not backfill', async () => {
    (indexer as unknown as {client: unknown}).client = fakeChain(66_636_596n);

    await indexer.seedCursorToHead();

    const [row] = await cursorRow();
    expect(row).toBeDefined();
    // Far past the deployment block — that is the whole point.
    expect(BigInt(row!.last_block)).toBeGreaterThan(BigInt(chain.startBlock));
    expect(BigInt(row!.last_block)).toBeLessThanOrEqual(66_636_596n);
  });

  it('stores the head block hash, so reorg detection still works', async () => {
    (indexer as unknown as {client: unknown}).client = fakeChain(66_636_596n);

    await indexer.seedCursorToHead();

    const [row] = await cursorRow();
    expect(row!.last_block_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('leaves an existing cursor alone — a restart must not skip a backlog', async () => {
    await db.execute(
      sql`INSERT INTO indexer_cursor (chain_id, contract, last_block, last_block_hash)
          VALUES (31337, 'TaskEscrow', 100, '0xdead')`,
    );
    (indexer as unknown as {client: unknown}).client = fakeChain(66_636_596n);

    await indexer.seedCursorToHead();

    const [row] = await cursorRow();
    expect(Number(row!.last_block)).toBe(100);
  });

  it('never seeds below genesis on a chain with barely any blocks', async () => {
    (indexer as unknown as {client: unknown}).client = fakeChain(3n);

    await indexer.seedCursorToHead();

    const [row] = await cursorRow();
    expect(BigInt(row!.last_block)).toBeGreaterThanOrEqual(0n);
  });
});

/**
 * Through the REAL decoder, with logs encoded from the ABI.
 *
 * `feed` above hands the projection a payload of our choosing, and the
 * payloads chosen were ones the chain never produces: a refund with no
 * `reason` (the event always carries one, as bytes32) and a settlement with a
 * `txHash` field (no event has one). Both fictions passed while the real
 * thing was wrong: every refund, including a client's own cancel, counted as
 * a failure against the worker, and every payment row had an empty tx hash.
 */
describe('real refund and settlement logs', () => {
  const escrowAbi = loadAbis()['TaskEscrow'] as Abi;
  const TX = `0x${'ef'.repeat(32)}` as const;

  function realLog(eventName: string, args: Record<string, unknown>, logIndex: number) {
    const event = (escrowAbi as AbiEvent[]).find((e) => e.type === 'event' && e.name === eventName)!;
    const topics = encodeEventTopics({abi: [event], eventName, args});
    const data = encodeAbiParameters(
      event.inputs.filter((i) => !i.indexed),
      event.inputs.filter((i) => !i.indexed).map((i) => args[i.name!]),
    );
    return {...settledLog({logIndex}), topics, data, transactionHash: TX};
  }

  async function refund(reason: string, logIndex: number) {
    const {workerId} = await seedJob();
    const log = realLog(
      'JobRefunded',
      {jobId: 7n, amount: 20_000n, reason: stringToHex(reason, {size: 32})},
      logIndex,
    );
    await (indexer as unknown as {handleLog: (e: unknown) => Promise<void>}).handleLog(log);
    return statsOf(workerId);
  }

  it('does not count a client cancelling as the worker failing', async () => {
    expect(Number((await refund('cancelled', 11)).failed)).toBe(0);
  });

  it('does not count an offer nobody accepted as the worker failing', async () => {
    expect(Number((await refund('unaccepted', 12)).failed)).toBe(0);
  });

  it('counts accepted work that was never delivered', async () => {
    expect(Number((await refund('undelivered', 13)).failed)).toBe(1);
  });

  it('counts a dispute the worker lost', async () => {
    expect(Number((await refund('dispute', 14)).failed)).toBe(1);
  });

  /**
   * v2: a dispute nobody ruled on expires, and the escrow pays the worker
   * with outcome UNRESOLVED (3) — and writes NO feedback, so disputed work
   * never earns reputation by default. The projection must agree: the money
   * moved, so there is a payment row; the reputation must not rise.
   */
  it('records the payment of an unresolved dispute but credits no reputation', async () => {
    const {workerId} = await seedJob();
    const before = await statsOf(workerId);
    const log = realLog('JobSettled', {jobId: 7n, paid: 19_800n, fee: 200n, outcome: 3}, 16);
    await (indexer as unknown as {handleLog: (e: unknown) => Promise<void>}).handleLog(log);

    const after = await statsOf(workerId);
    expect(Number(after.completed)).toBe(Number(before.completed));
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM payments`)) as unknown as {n: number}[];
    expect(rows[0]!.n).toBe(1);
  });

  it('keeps the v2 events in the job trail', async () => {
    await seedJob();
    const handle = (indexer as unknown as {handleLog: (e: unknown) => Promise<void>}).handleLog.bind(indexer);
    await handle(realLog('DisputeExpired', {jobId: 7n}, 17));
    await handle(realLog('PaymentDeferred', {jobId: 7n, agentId: 2n, amount: 19_800n}, 18));
    const kinds = (
      (await db.execute(sql`SELECT kind FROM job_events ORDER BY id`)) as unknown as {kind: string}[]
    ).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['dispute_expired', 'payment_deferred']));
  });

  /**
   * v3: an undelivered job's bond goes to the client, and a dispute bond goes
   * to whoever the ruling favoured. Both move money; a trail without them
   * would show a refund larger than the job with no reason why.
   */
  it('keeps the v3 bond events in the job trail', async () => {
    await seedJob();
    const handle = (indexer as unknown as {handleLog: (e: unknown) => Promise<void>}).handleLog.bind(indexer);
    await handle(realLog('BondSeized', {jobId: 7n, agentId: 2n, amount: 10_000n}, 19));
    await handle(realLog('DisputeBondSettled', {jobId: 7n, toAgentId: 2n, amount: 10_000n}, 20));
    const kinds = (
      (await db.execute(sql`SELECT kind FROM job_events ORDER BY id`)) as unknown as {kind: string}[]
    ).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['bond_seized', 'dispute_bond_settled']));
  });

  /**
   * Audit M-1: a review the registry refused is kept by the escrow and
   * written later. The keeper finds what is still unwritten from these two.
   */
  it('keeps refused reviews and their later writing in the job trail', async () => {
    await seedJob();
    const handle = (indexer as unknown as {handleLog: (e: unknown) => Promise<void>}).handleLog.bind(indexer);
    await handle(realLog('FeedbackFailed', {jobId: 7n, agentId: 2n}, 21));
    await handle(realLog('FeedbackRetried', {jobId: 7n, agentId: 2n}, 22));
    const kinds = (
      (await db.execute(sql`SELECT kind FROM job_events ORDER BY id`)) as unknown as {kind: string}[]
    ).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['feedback_failed', 'feedback_retried']));
  });

  it('records the transaction a payment landed in', async () => {
    await seedJob();
    const log = realLog('JobSettled', {jobId: 7n, paid: 19_800n, fee: 200n, outcome: 0}, 15);
    await (indexer as unknown as {handleLog: (e: unknown) => Promise<void>}).handleLog(log);

    const rows = (await db.execute(sql`SELECT tx_hash FROM payments`)) as unknown as {tx_hash: string}[];
    expect(rows[0]!.tx_hash).toBe(TX);
  });
});

/**
 * The confidence floor is per chain — 25 on testnet, 50 on mainnet, where a
 * reputation is worth more to fake — and the score hard-coded 25. The same
 * history must score LOWER where the chain demands more evidence.
 */
describe('the confidence floor', () => {
  async function scoreAfterTenSettlements(floor: number) {
    const {workerId} = await seedJob();
    const strict = new Indexer({
      db,
      chain: {...chain, params: {...chain.params, confidenceFloor: floor}},
      abis: loadAbis() as never,
    });
    const inner = strict as unknown as {decode: unknown; handleLog: (e: unknown) => Promise<void>};
    inner.decode = async () => ({kind: 'settled', chainJobId: '7', payload: {fee: '200'}});
    // Ten settlements are ten transactions. (This used one hash for all ten,
    // which the chain cannot produce and the re-mined-event guard now,
    // correctly, reads as one event.)
    for (let i = 0; i < 10; i++) {
      await inner.handleLog.call(
        strict,
        settledLog({logIndex: 100 + i, transactionHash: `0x${(0xf0 + i).toString(16).repeat(32)}`}),
      );
    }
    return Number((await statsOf(workerId)).score);
  }

  it('reads the floor from the chain configuration', async () => {
    const lenient = await scoreAfterTenSettlements(25);
    await db.execute(sql`TRUNCATE agents, jobs, job_events, agent_stats, payments RESTART IDENTITY CASCADE`);
    const strict = await scoreAfterTenSettlements(50);
    expect(strict).toBeLessThan(lenient);
  });
});

/**
 * Linking a job row to its on-chain id.
 *
 * The first event carries the specHash, and the row was found by that hash
 * alone. A spec hash is scoped to the database's job id — and ids repeat
 * whenever a database is rebuilt, or when two deployments share a chain. A
 * live end-to-end run showed the cost: an escrow job nobody had accepted, and
 * whose worker was paid nothing, was linked to an OLD run's fast-path
 * payment, projected as settled, and credited to the worker as a completion.
 * The event also names the client and the worker; both must match.
 */
describe('linking by spec hash', () => {
  const escrowAbi = loadAbis()['TaskEscrow'] as Abi;

  async function unlinkedJob() {
    const {jobId, workerId} = await seedJob();
    await db.execute(
      sql`UPDATE jobs SET chain_job_id = NULL, spec_hash = ${'0x' + 'aa'.repeat(32)} WHERE id = ${jobId}`,
    );
    return {jobId, workerId};
  }

  function directPaid(clientAgentId: bigint, workerAgentId: bigint, logIndex: number) {
    const event = (escrowAbi as AbiEvent[]).find((e) => e.type === 'event' && e.name === 'DirectPaid')!;
    const args = {
      jobId: 55n,
      clientAgentId,
      workerAgentId,
      amount: 20_000n,
      fee: 200n,
      specHash: `0x${'aa'.repeat(32)}`,
    };
    const topics = encodeEventTopics({abi: [event], eventName: 'DirectPaid', args});
    const data = encodeAbiParameters(
      event.inputs.filter((i) => !i.indexed),
      event.inputs.filter((i) => !i.indexed).map((i) => (args as Record<string, unknown>)[i.name!]),
    );
    return {...settledLog({logIndex}), topics, data};
  }

  const handle = (log: unknown) =>
    (indexer as unknown as {handleLog: (e: unknown) => Promise<void>}).handleLog(log);
  const chainJobIdOf = async (jobId: number) =>
    (
      (await db.execute(sql`SELECT chain_job_id FROM jobs WHERE id = ${jobId}`)) as unknown as {
        chain_job_id: string | null;
      }[]
    )[0]!.chain_job_id;

  it('links when the parties match', async () => {
    const {jobId} = await unlinkedJob();
    // seedJob's agents are chain ids 1 (client) and 2 (worker).
    await handle(directPaid(1n, 2n, 20));
    expect(await chainJobIdOf(jobId)).toBe('55');
  });

  it('refuses a payment between other agents that happens to share the hash', async () => {
    const {jobId, workerId} = await unlinkedJob();
    await handle(directPaid(901n, 902n, 21));
    expect(await chainJobIdOf(jobId)).toBeNull();
    expect(Number((await statsOf(workerId)).completed)).toBe(0);
  });
});

/**
 * Reorgs. The indexer rewound its cursor and replayed, trusting the
 * (chain, tx, logIndex) key to make that safe. Two cases it was not:
 *
 * - A transaction RE-MINED in a later block keeps its hash but can change
 *   its logIndex, which is block-level. The replayed log had a new key, was
 *   applied again, and credited the same settlement twice.
 * - A transaction DROPPED from the chain left its effects in the projection
 *   for good. job_events is append-only by design (it is the audit log), so
 *   they cannot be quietly rewritten — the indexer must stop and say so.
 */
describe('after a reorg', () => {
  it('does not credit a re-mined settlement twice', async () => {
    const {workerId} = await seedJob();
    await feed(settledLog({logIndex: 3, blockNumber: 1000n}), 'settled', {fee: '200'});
    // Same transaction, mined again in a later block at a different position.
    await feed(settledLog({logIndex: 9, blockNumber: 1003n}), 'settled', {fee: '200'});

    expect(Number((await statsOf(workerId)).completed)).toBe(1);
    expect(await countRows('payments')).toBe(1);
  });

  it('stops, naming the transaction, when a recorded event was dropped from the chain', async () => {
    await seedJob();
    await feed(settledLog({logIndex: 3, blockNumber: 1000n}), 'settled', {fee: '200'});

    const inner = indexer as unknown as {
      client: unknown;
      checkRewindWindow: (from: bigint, to: bigint) => Promise<void>;
    };
    const real = inner.client;
    inner.client = {
      getTransactionReceipt: async () => Promise.reject(new Error('Transaction receipt not found')),
    };
    try {
      await expect(inner.checkRewindWindow.call(indexer, 990n, 1010n)).rejects.toThrow(/0xabab/);
    } finally {
      inner.client = real;
    }
  });

  /**
   * An RPC that cannot answer is not a chain that dropped the transaction.
   * Treating any receipt error as "orphaned" meant one RPC blip during the
   * rewind check HALTED the indexer, which is only meant to stop for a real
   * reorg. An outage now fails the tick, which the loop retries with backoff.
   */
  it('treats an RPC failure as a failed tick, not as a dropped transaction', async () => {
    await seedJob();
    await feed(settledLog({logIndex: 3, blockNumber: 1000n}), 'settled', {fee: '200'});

    const inner = indexer as unknown as {
      client: unknown;
      checkRewindWindow: (from: bigint, to: bigint) => Promise<void>;
    };
    const real = inner.client;
    inner.client = {
      getTransactionReceipt: async () => Promise.reject(new Error('HTTP request failed. Status: 503')),
    };
    try {
      const err = await inner.checkRewindWindow.call(indexer, 990n, 1010n).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(/503/);
      expect(err?.message).not.toMatch(/0xabab/);
    } finally {
      inner.client = real;
    }
  });

  it('carries on when every recorded event in the window is still on chain', async () => {
    await seedJob();
    await feed(settledLog({logIndex: 3, blockNumber: 1000n}), 'settled', {fee: '200'});

    const inner = indexer as unknown as {
      client: unknown;
      checkRewindWindow: (from: bigint, to: bigint) => Promise<void>;
    };
    const real = inner.client;
    inner.client = {getTransactionReceipt: async () => ({status: 'success', blockNumber: 1003n})};
    try {
      await expect(inner.checkRewindWindow.call(indexer, 990n, 1010n)).resolves.toBeUndefined();
    } finally {
      inner.client = real;
    }
  });
});

/**
 * The API advances a job optimistically when a transaction is broadcast; the
 * indexer trails the head by its confirmations. So the indexer routinely
 * reaches an event OLDER than the state the API already wrote. Projecting it
 * walked the job backwards: live, a result was stored and the job read
 * "accepted" again, and the orchestrator's approve was refused ("job is
 * accepted, this action needs submitted") — one of three timed demo runs.
 */
describe('a trailing indexer never walks a job backwards', () => {
  async function stateOf(jobId: number) {
    const [row] = (await db.execute(sql`SELECT state FROM jobs WHERE id = ${jobId}`)) as unknown as {
      state: string;
    }[];
    return row!.state;
  }

  it('keeps "submitted" when the older JobAccepted arrives', async () => {
    const {jobId} = await seedJob();
    await db.execute(sql`UPDATE jobs SET state = 'submitted' WHERE id = ${jobId}`);
    await feed(settledLog({logIndex: 21}), 'accepted', {jobId: '7'});
    expect(await stateOf(jobId)).toBe('submitted');
  });

  it('keeps "settled" when the older ResultSubmitted arrives', async () => {
    const {jobId} = await seedJob();
    await db.execute(sql`UPDATE jobs SET state = 'settled' WHERE id = ${jobId}`);
    await feed(settledLog({logIndex: 22}), 'submitted', {jobId: '7', resultHash: '0x01'});
    expect(await stateOf(jobId)).toBe('settled');
  });

  /** The API wrote "settled" first; the chain's fee must still land on the row. */
  it('still records the chain facts when the API already wrote the same state', async () => {
    const {jobId} = await seedJob();
    await db.execute(sql`UPDATE jobs SET state = 'settled' WHERE id = ${jobId}`);
    await feed(settledLog({logIndex: 26}), 'settled', {jobId: '7', paid: '19800', fee: '200', outcome: 0});
    const [row] = (await db.execute(sql`SELECT state, fee FROM jobs WHERE id = ${jobId}`)) as unknown as {
      state: string;
      fee: string;
    }[];
    expect(row).toMatchObject({state: 'settled', fee: '200'});
  });

  it('still moves forward, including out of a dispute', async () => {
    const {jobId} = await seedJob();
    await feed(settledLog({logIndex: 23}), 'accepted', {jobId: '7'});
    expect(await stateOf(jobId)).toBe('accepted');
    await feed(settledLog({logIndex: 24}), 'disputed', {jobId: '7'});
    expect(await stateOf(jobId)).toBe('disputed');
    await feed(settledLog({logIndex: 25}), 'refunded', {jobId: '7', reason: 'dispute'});
    expect(await stateOf(jobId)).toBe('refunded');
  });
});
