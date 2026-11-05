import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import type {ChainConfig} from '@pactora/config';
import type {ReceiptExecution} from '@pactora/near';
import {Indexer} from '../src/indexer.js';
import {FakeChain, log, receipt, sandboxChain} from './near-fixtures.js';
import {DB_URL, SPEC, cursorRow, eventRows, jobRow, paymentRows, reset, seedJob, statsOf} from './db.js';

/**
 * The projection, end to end: fabricated final blocks holding the contract's
 * real log lines → tick() → job_events, jobs, payments, agent_stats.
 *
 * Replays are ordinary — a crash before the batch commits re-reads it, and an
 * operator may reset the cursor — so every case that moves money or
 * reputation is also run twice.
 */
const chain = sandboxChain();
const PACTORA = chain.contracts.Pactora;
const R = 'cd'.repeat(32);

let db: Db;
beforeAll(() => {
  db = createDb(DB_URL, {max: 3});
});
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  await reset(db);
});

/** A chain and an indexer on it; `block(...)` appends, `sync()` indexes to the final head. */
function harness(c: ChainConfig = chain) {
  const src = new FakeChain(c.startBlock);
  const indexer = new Indexer({db, chain: c, source: src});
  return {
    src,
    indexer,
    block: (...receipts: ReceiptExecution[]) => src.block(...receipts),
    pactora: (...logs: string[]) => src.block(receipt({executor: PACTORA, logs})),
    async sync() {
      const final = await src.finalHeight();
      while ((await indexer.tick()) < final);
    },
  };
}

const created = (jobId = 7) =>
  log.jobCreated({jobId, client: 1, worker: 2, amount: 20000, fee: 200, specHash: SPEC});
const settled = (outcome = 'Success', jobId = 7) =>
  log.jobSettled({jobId, worker: 2, paid: 19800, fee: 200, outcome});

describe('every lifecycle event lands in the job trail', () => {
  it('with its kind, payload, receipt, transaction, block and log position', async () => {
    const {jobId} = await seedJob(db);
    const h = harness();
    const r = receipt({
      executor: PACTORA,
      receiptId: 'RCPT-created',
      txHash: 'TX-created',
      logs: [created(), log.review({jobId: 7, agentId: 2, side: 'worker', value: 1})],
    });
    const at = h.block(r);
    h.pactora(log.jobAccepted({jobId: 7, worker: 2, bond: 1000}));
    h.pactora(log.resultSubmitted({jobId: 7, resultHash: R}));
    h.pactora(log.jobDisputed({jobId: 7, disputeBond: 500, reasonHash: null}));
    h.pactora(
      log.disputeResolved({jobId: 7, forWorker: false, arbiter: 'arbiter.test.near'}),
      log.disputeBondSettled({jobId: 7, to: 1, amount: 500}),
      log.jobRefunded({jobId: 7, client: 1, amount: 20000, reason: 'dispute', outcome: 'DisputeLost'}),
    );
    await h.sync();

    const events = await eventRows(db);
    expect(events.map((e) => e.kind)).toEqual([
      'created',
      'accepted',
      'submitted',
      'disputed',
      'dispute_resolved',
      'dispute_bond_settled',
      'refunded',
    ]);
    expect(events[0]).toEqual({
      kind: 'created',
      payload: {
        jobId: '7',
        clientAgentId: '1',
        workerAgentId: '2',
        amount: '20000',
        fee: '200',
        specHash: SPEC,
        acceptDeadline: '1700000000',
        workDeadline: '1700003600',
      },
      tx_hash: 'TX-created',
      receipt_id: 'RCPT-created',
      block_number: at,
      log_index: 0,
    });
    // Three events in one receipt keep their log positions.
    expect(events.slice(4).map((e) => e.log_index)).toEqual([0, 1, 2]);
    expect(events[6]!.payload).toMatchObject({reason: 'dispute', outcome: 'DisputeLost'});

    const job = await jobRow(db, jobId);
    expect(job.state).toBe('refunded');
    expect(job.result_hash).toBe(R);
  });

  it('records bond_seized and dispute_expired', async () => {
    await seedJob(db);
    const h = harness();
    h.pactora(
      log.jobRefunded({jobId: 7, client: 1, amount: 20000, reason: 'undelivered', outcome: 'Failed'}),
      log.bondSeized({jobId: 7, worker: 2, client: 1, amount: 1000}),
    );
    h.pactora(log.disputeExpired({jobId: 7}));
    await h.sync();
    const events = await eventRows(db);
    expect(events.map((e) => e.kind)).toEqual(['refunded', 'bond_seized', 'dispute_expired']);
    expect(events[1]!.payload).toEqual({jobId: '7', workerAgentId: '2', clientAgentId: '1', amount: '1000'});
  });

  it('ignores an event for a job this API did not create', async () => {
    await seedJob(db);
    const h = harness();
    h.pactora(log.jobAccepted({jobId: 999, worker: 2, bond: 0}));
    await h.sync();
    expect(await eventRows(db)).toEqual([]);
  });
});

describe('what the chain did not do', () => {
  it('ignores the logs of a failed receipt — NEAR rolled its state back', async () => {
    const {jobId, workerId} = await seedJob(db, {state: 'submitted'});
    const h = harness();
    h.block(receipt({executor: PACTORA, ok: false, logs: [settled()]}));
    await h.sync();
    expect(await eventRows(db)).toEqual([]);
    expect(await paymentRows(db)).toEqual([]);
    expect((await jobRow(db, jobId)).state).toBe('submitted');
    expect((await statsOf(db, workerId)).completed).toBe(0);
  });

  it('ignores pactora-standard events logged by any other contract', async () => {
    const {workerId} = await seedJob(db, {state: 'submitted'});
    const h = harness();
    h.block(receipt({executor: 'impostor.test.near', logs: [settled()]}));
    h.block(receipt({executor: chain.contracts.PaymentToken, logs: [settled()]}));
    await h.sync();
    expect(await eventRows(db)).toEqual([]);
    expect((await statsOf(db, workerId)).completed).toBe(0);
  });
});

describe('a settlement', () => {
  it('settles the job, writes the payment and credits the worker', async () => {
    const {jobId, workerId} = await seedJob(db, {state: 'submitted'});
    const h = harness();
    const at = h.block(receipt({executor: PACTORA, txHash: 'TX-settle', logs: [settled()]}));
    await h.sync();

    const job = await jobRow(db, jobId);
    expect(job.state).toBe('settled');
    expect(job.fee).toBe('200');
    // The block's time, not the time the indexer got round to it.
    expect(Number(job.settled_ms)).toBe(Number(h.src.blocks.get(at)!.timestampNs / 1_000_000n));
    // Gross amount: what the worker was paid plus the fee.
    expect(await paymentRows(db)).toEqual([
      {amount: '20000', fee: '200', tx_hash: 'TX-settle', block_number: at},
    ]);
    expect(await statsOf(db, workerId)).toMatchObject({completed: 1, failed: 0, volume: '20000'});
  });

  it('is applied exactly once however often its block is replayed', async () => {
    const {workerId} = await seedJob(db, {state: 'submitted'});
    const h = harness();
    h.pactora(settled());
    await h.sync();
    const first = await statsOf(db, workerId);

    for (let i = 0; i < 3; i++) {
      // An operator resets the cursor, or a crash lost it: the same blocks again.
      await db.execute(sql`TRUNCATE indexer_cursor`);
      await new Indexer({db, chain, source: h.src}).tick();
    }

    expect(await statsOf(db, workerId)).toEqual(first);
    expect(first.completed).toBe(1);
    expect(await paymentRows(db)).toHaveLength(1);
    expect(await eventRows(db)).toHaveLength(1);
    expect(await cursorRow(db)).toHaveLength(1);
  });

  it('pays but credits nothing for an unresolved dispute', async () => {
    const {workerId} = await seedJob(db, {state: 'disputed'});
    const h = harness();
    h.pactora(log.disputeExpired({jobId: 7}), settled('Unresolved'));
    await h.sync();
    expect(await paymentRows(db)).toHaveLength(1);
    expect((await statsOf(db, workerId)).completed).toBe(0);
  });
});

describe('a refund', () => {
  async function refund(reason: string, outcome: string | null) {
    const {workerId} = await seedJob(db);
    const h = harness();
    h.pactora(log.jobRefunded({jobId: 7, client: 1, amount: 20000, reason, outcome}));
    await h.sync();
    // And replayed.
    await db.execute(sql`TRUNCATE indexer_cursor`);
    await new Indexer({db, chain, source: h.src}).tick();
    return statsOf(db, workerId);
  }

  it('does not count a client cancelling as the worker failing', async () => {
    expect((await refund('cancelled', null)).failed).toBe(0);
  });
  it('does not count an offer nobody accepted as the worker failing', async () => {
    expect((await refund('unaccepted', null)).failed).toBe(0);
  });
  it('counts accepted work that was never delivered, once', async () => {
    expect((await refund('undelivered', 'Failed')).failed).toBe(1);
  });
  it('counts a dispute the worker lost, once', async () => {
    expect((await refund('dispute', 'DisputeLost')).failed).toBe(1);
  });
});

/**
 * The API writes a job before the chain assigns its id; the first event names
 * the spec hash and both parties, and that is what links them.
 */
describe('linking a job to its on-chain id', () => {
  it('links job_created by spec hash and parties, then follows the job by id', async () => {
    const {jobId, workerId} = await seedJob(db, {chainJobId: null});
    const h = harness();
    h.pactora(created(41));
    h.pactora(log.jobAccepted({jobId: 41, worker: 2, bond: 0}));
    h.pactora(log.resultSubmitted({jobId: 41, resultHash: R}));
    h.pactora(settled('Success', 41));
    await h.sync();

    expect((await jobRow(db, jobId)).chain_job_id).toBe('41');
    expect((await eventRows(db)).map((e) => e.kind)).toEqual(['created', 'accepted', 'submitted', 'settled']);
    expect((await jobRow(db, jobId)).state).toBe('settled');
    expect((await statsOf(db, workerId)).completed).toBe(1);
  });

  it('links the fast path: direct_paid and job_settled in one receipt credit once', async () => {
    const {jobId, workerId} = await seedJob(db, {chainJobId: null, path: 'direct'});
    const h = harness();
    // In the order direct_pay emits them (lib.rs): direct_paid, job_settled, two reviews.
    h.pactora(
      log.directPaid({jobId: 8, client: 1, worker: 2, amount: 20000, fee: 200, specHash: SPEC}),
      settled('Success', 8),
      log.review({jobId: 8, agentId: 2, side: 'worker', value: 100}),
      log.review({jobId: 8, agentId: 1, side: 'client', value: 100}),
    );
    await h.sync();

    expect((await jobRow(db, jobId)).chain_job_id).toBe('8');
    expect((await eventRows(db)).map((e) => e.kind)).toEqual(['direct_paid', 'settled']);
    expect((await statsOf(db, workerId)).completed).toBe(1);
    expect(await paymentRows(db)).toHaveLength(1);
  });

  it('refuses a job between other agents that happens to share the hash', async () => {
    const {jobId, workerId} = await seedJob(db, {chainJobId: null});
    const h = harness();
    h.pactora(log.jobCreated({jobId: 41, client: 901, worker: 902, amount: 20000, fee: 200, specHash: SPEC}));
    h.pactora(settled('Success', 41));
    await h.sync();
    expect((await jobRow(db, jobId)).chain_job_id).toBeNull();
    expect(await eventRows(db)).toEqual([]);
    expect((await statsOf(db, workerId)).completed).toBe(0);
  });

  it('does not link an event that carries no spec hash', async () => {
    const {jobId} = await seedJob(db, {chainJobId: null});
    const h = harness();
    h.pactora(log.jobAccepted({jobId: 41, worker: 2, bond: 0}));
    await h.sync();
    expect((await jobRow(db, jobId)).chain_job_id).toBeNull();
  });
});

describe('a trailing indexer never walks a job backwards', () => {
  it('keeps "submitted" when the older job_accepted arrives', async () => {
    const {jobId} = await seedJob(db, {state: 'submitted'});
    const h = harness();
    h.pactora(log.jobAccepted({jobId: 7, worker: 2, bond: 0}));
    await h.sync();
    expect((await jobRow(db, jobId)).state).toBe('submitted');
  });

  it('keeps "settled" when the older result_submitted arrives', async () => {
    const {jobId} = await seedJob(db, {state: 'settled'});
    const h = harness();
    h.pactora(log.resultSubmitted({jobId: 7, resultHash: R}));
    await h.sync();
    expect((await jobRow(db, jobId)).state).toBe('settled');
  });

  it('still records the chain facts when the API already wrote the same state', async () => {
    const {jobId} = await seedJob(db, {state: 'settled'});
    const h = harness();
    h.pactora(settled());
    await h.sync();
    expect(await jobRow(db, jobId)).toMatchObject({state: 'settled', fee: '200'});
  });
});

/** The confidence floor is per chain; the same history scores lower where more evidence is demanded. */
describe('the confidence floor', () => {
  async function scoreAfterTenSettlements(floor: number) {
    await reset(db);
    const strict: ChainConfig = {...chain, params: {...chain.params, confidenceFloor: floor}};
    const h = harness(strict);
    // Ten jobs, ten settlements.
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      const {workerId} = i === 0 ? await seedJob(db, {chainJobId: 100}) : {workerId: ids[0]!};
      if (i === 0) ids.push(workerId);
      else
        await db.execute(
          sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash, chain_job_id)
              SELECT chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash, ${100 + i}
              FROM jobs WHERE chain_job_id = 100`,
        );
      h.pactora(settled('Success', 100 + i));
    }
    await h.sync();
    const stats = await statsOf(db, ids[0]!);
    expect(stats.completed).toBe(10);
    return stats.score;
  }

  it('reads the floor from the chain configuration', async () => {
    const lenient = await scoreAfterTenSettlements(25);
    const strict = await scoreAfterTenSettlements(50);
    expect(strict).toBeLessThan(lenient);
  });
});
