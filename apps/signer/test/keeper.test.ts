import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '@pactora/config';
import {KeyPair, TGAS, keyPairKey, nearClient} from '@pactora/near';
import {
  Keeper,
  JobState,
  chainKeeper,
  deadlineOf,
  dueExit,
  type Exit,
  type OnChainJob,
} from '../src/keeper.js';
import {createMetrics} from '@pactora/service';
import {FakeNear} from './helpers/fake-near.js';

/**
 * The keeper exists because the contract's permissionless exits need a
 * caller. The contract promises that no job holds funds forever; something
 * has to send the transaction that keeps the promise.
 *
 * The timing rule under test is the contract's: an exit is valid strictly
 * AFTER its deadline (`now_s() > deadline`, else `DeadlineNotPassed`).
 * Getting the boundary wrong in the safe direction wastes a sweep; in the
 * other it buys a certain failure and pays gas for it.
 */

const job = (over: Partial<OnChainJob>): OnChainJob => ({
  state: JobState.CREATED,
  acceptDeadline: 1_000n,
  workDeadline: 2_000n,
  reviewDeadline: 0n,
  disputeDeadline: 0n,
  ...over,
});

describe('which exit is due', () => {
  it('refunds an offer nobody accepted, once the accept deadline has passed', () => {
    expect(dueExit(job({}), 1_001n, 0n)).toBe('expire_unaccepted');
  });

  it('sends nothing on the deadline second itself — the contract would refuse', () => {
    expect(dueExit(job({}), 1_000n, 0n)).toBeNull();
    expect(dueExit(job({state: JobState.ACCEPTED}), 2_000n, 0n)).toBeNull();
    expect(dueExit(job({state: JobState.SUBMITTED, reviewDeadline: 3_000n}), 3_000n, 0n)).toBeNull();
  });

  it('refunds accepted work that was never delivered', () => {
    expect(dueExit(job({state: JobState.ACCEPTED}), 2_001n, 0n)).toBe('expire_undelivered');
  });

  it('does not expire accepted work on the ACCEPT deadline', () => {
    expect(dueExit(job({state: JobState.ACCEPTED}), 1_500n, 0n)).toBeNull();
  });

  /** The client going quiet must not let it keep a result without paying. */
  it('pays for a result nobody reviewed, once the review window closes', () => {
    expect(dueExit(job({state: JobState.SUBMITTED, reviewDeadline: 3_000n}), 3_001n, 0n)).toBe(
      'auto_approve',
    );
  });

  it('leaves every terminal state alone, and any state it does not know', () => {
    for (const state of [JobState.SETTLED, JobState.REFUNDED, 'SomethingNew']) {
      expect(dueExit(job({state, reviewDeadline: 1n, disputeDeadline: 1n}), 10_000_000n, 0n)).toBeNull();
    }
  });

  /** An arbiter who never rules must not hold the funds forever. */
  it('settles a dispute nobody ruled on, once its timeout passes', () => {
    const disputed = job({state: JobState.DISPUTED, reviewDeadline: 3_000n, disputeDeadline: 5_000n});
    expect(dueExit(disputed, 5_000n, 0n)).toBeNull();
    expect(dueExit(disputed, 5_001n, 0n)).toBe('expire_dispute');
  });

  /**
   * Contract 1.1.0: the arbiter may still rule for `dispute_grace` after the
   * deadline, and `expire_dispute` before that is DeadlineNotPassed. A keeper
   * that ignored the grace failed every sweep for the whole grace.
   */
  it('waits out the dispute grace: due only after deadline + grace', () => {
    const disputed = job({state: JobState.DISPUTED, reviewDeadline: 3_000n, disputeDeadline: 5_000n});
    expect(dueExit(disputed, 5_001n, 100n)).toBeNull();
    expect(dueExit(disputed, 5_100n, 100n)).toBeNull();
    expect(dueExit(disputed, 5_101n, 100n)).toBe('expire_dispute');
    expect(deadlineOf(disputed, 'expire_dispute', 100n)).toBe(5_100n);
    // The grace is a dispute matter: the other exits are unchanged.
    expect(dueExit(job({}), 1_001n, 100n)).toBe('expire_unaccepted');
  });

  it('never expires a dispute whose deadline the chain has not set', () => {
    expect(dueExit(job({state: JobState.DISPUTED, disputeDeadline: 0n}), 10_000_000n, 0n)).toBeNull();
  });
});

describe('a sweep', () => {
  const build = (jobs: Record<string, OnChainJob | null>, now: bigint, failOn: string[] = []) => {
    const sent: {exit: Exit; id: string}[] = [];
    const keeper = new Keeper({
      openJobs: async () => Object.keys(jobs).map(BigInt),
      readJob: async (id) => jobs[id.toString()] ?? null,
      now: async () => now,
      disputeGrace: async () => 0n,
      send: async (exit, id) => {
        if (failOn.includes(id.toString()))
          throw new Error('the contract refused: InvalidState\nmore detail');
        sent.push({exit, id: id.toString()});
        return `tx-${id.toString()}`;
      },
    });
    return {keeper, sent};
  };

  it('sends only what is due, and the right exit for each', async () => {
    const {keeper, sent} = build(
      {
        '1': job({}), //                                         unaccepted, overdue
        '2': job({acceptDeadline: 9_000n, workDeadline: 9_500n}), // still open
        '3': job({state: JobState.ACCEPTED}), //                   undelivered, overdue
        '4': job({state: JobState.SUBMITTED, reviewDeadline: 2_500n}), // unreviewed
        '5': null, //                                             not on chain
      },
      5_000n,
    );

    const result = await keeper.sweep();

    expect(result.checked).toBe(5);
    expect(sent).toEqual([
      {exit: 'expire_unaccepted', id: '1'},
      {exit: 'expire_undelivered', id: '3'},
      {exit: 'auto_approve', id: '4'},
    ]);
  });

  /**
   * The likeliest failure is someone else calling the same exit first. That
   * is the system working; it must not strand every job after it.
   */
  it('carries on past a job whose exit fails, and says which and why', async () => {
    const {keeper, sent} = build({'1': job({}), '2': job({}), '3': job({})}, 5_000n, ['2']);

    const result = await keeper.sweep();

    expect(sent.map((s) => s.id)).toEqual(['1', '3']);
    expect(result.failed).toEqual([
      {chainJobId: '2', exit: 'expire_unaccepted', reason: 'the contract refused: InvalidState'},
    ]);
  });

  /**
   * docs/26 F29: an exit that keeps failing is money held past its deadline.
   * The gauge is how long the OLDEST due exit has been waiting, so an alert
   * can fire on it; 0 once nothing due is left unsent.
   */
  it('reports how long the oldest due exit it could not send has been waiting', async () => {
    const ages: number[] = [];
    const jobs = {
      '1': job({}), //                                          due since 1000, fails
      '2': job({state: JobState.ACCEPTED}), //                   due since 2000, fails
      '3': job({state: JobState.SUBMITTED, reviewDeadline: 500n}), // due since 500, sent
    };
    const failing = new Set(['1', '2']);
    const keeper = new Keeper({
      openJobs: async () => Object.keys(jobs).map(BigInt),
      readJob: async (id) => jobs[id.toString() as keyof typeof jobs],
      now: async () => 5_000n,
      disputeGrace: async () => 0n,
      send: async (_exit, id) => {
        if (failing.has(id.toString())) throw new Error('rpc down');
        return 'tx';
      },
      onBacklog: (s) => ages.push(s),
    });

    await keeper.sweep();
    expect(ages).toEqual([4_000]);

    failing.clear();
    await keeper.sweep();
    expect(ages).toEqual([4_000, 0]);
  });

  it('reads no clock and sends nothing when there is nothing open', async () => {
    let clockRead = false;
    const keeper = new Keeper({
      openJobs: async () => [],
      readJob: async () => {
        throw new Error('should not read');
      },
      now: async () => {
        clockRead = true;
        return 0n;
      },
      disputeGrace: async () => {
        throw new Error('should not read params');
      },
      send: async () => {
        throw new Error('should not send');
      },
    });

    expect(await keeper.sweep()).toEqual({checked: 0, sent: [], failed: []});
    expect(clockRead).toBe(false);
  });
});

describe('on a NEAR chain', () => {
  const config = loadConfig({
    contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
    env: {ENABLED_CHAINS: 'near:sandbox'},
  });
  const chain = config.chain('near:sandbox');
  const PACTORA = chain.contracts.Pactora;
  const KEEPER = 'keeper.test.near';
  const fake = new FakeNear();
  const key = keyPairKey(KeyPair.fromRandom('ed25519'));
  let onChain: Record<number, unknown>;

  beforeAll(() => fake.start());
  afterAll(() => fake.stop());
  beforeEach(() => {
    fake.reset();
    fake.addAccount(KEEPER, 10n ** 24n);
    fake.addKey(KEEPER, key.publicKey, 'FullAccess', 70n);
    onChain = {};
    fake.view(PACTORA, 'get_job', (a) => onChain[a['job_id'] as number] ?? null);
    fake.view(PACTORA, 'get_params', () => ({dispute_timeout: 10, dispute_grace: GRACE}));
  });
  /** The contract's dispute_grace, as get_params answers it (1.1.0). */
  const GRACE = 5;

  const nowS = () => Number(fake.state.block.timestampNs / 1_000_000_000n);
  const jobView = (state: string, over: Record<string, number> = {}) => ({
    state,
    accept_deadline: 0,
    work_deadline: 0,
    review_deadline: 0,
    dispute_deadline: 0,
    ...over,
  });

  const keeper = (ids: bigint[]) =>
    chainKeeper({
      db: undefined as never,
      chain,
      near: nearClient(fake.url, {retries: 1}),
      account: {accountId: KEEPER, key},
      openJobs: async () => ids,
    });

  it('reads get_job, judges by the final block clock, and sends each exit from its own account', async () => {
    const t = nowS();
    onChain[1] = jobView('Created', {accept_deadline: t - 1});
    onChain[2] = jobView('Created', {accept_deadline: t}); // the boundary second: not yet
    onChain[3] = jobView('Submitted', {review_deadline: t - 10});
    onChain[4] = jobView('Disputed', {dispute_deadline: t - GRACE - 1});
    onChain[5] = jobView('Settled');
    onChain[7] = jobView('Disputed', {dispute_deadline: t - 1}); // past the deadline, inside the grace

    const result = await keeper([1n, 2n, 3n, 4n, 5n, 6n, 7n]).sweep();

    expect(result.failed).toEqual([]);
    expect(fake.state.sent.map((s) => [s.method, s.args])).toEqual([
      ['expire_unaccepted', {job_id: 1}],
      ['auto_approve', {job_id: 3}],
      ['expire_dispute', {job_id: 4}],
    ]);
    for (const tx of fake.state.sent) {
      expect(tx).toMatchObject({signerId: KEEPER, receiverId: PACTORA, deposit: 0n, gas: 100n * TGAS});
    }
    expect(fake.state.sent.map((s) => s.nonce)).toEqual([71n, 72n, 73n]);
    expect(result.sent.map((s) => s.txHash)).toEqual(fake.state.sent.map((s) => s.hash));
  });

  it('exports the backlog age as keeper_backlog_age_seconds', async () => {
    const t = nowS();
    onChain[1] = jobView('Created', {accept_deadline: t - 30});
    fake.state.onSend = () => ({kind: 'panic', name: 'InvalidState'});
    const metrics = createMetrics('keeper-backlog-test');
    await chainKeeper({
      db: undefined as never,
      chain,
      near: nearClient(fake.url, {retries: 1}),
      account: {accountId: KEEPER, key},
      openJobs: async () => [1n],
      metrics,
    }).sweep();
    const text = await metrics.registry.metrics();
    const line = text.split('\n').find((l) => l.startsWith('keeper_backlog_age_seconds'));
    expect(line).toBeDefined();
    expect(Number(line!.split(' ').pop())).toBeGreaterThanOrEqual(30);
  });

  it('a send that expires leaves the backlog aged, and the next sweep clears it to 0 (F29)', async () => {
    const t = nowS();
    onChain[1] = jobView('Created', {accept_deadline: t - 45});
    let attempt = 0;
    fake.state.onSend = () =>
      ++attempt === 1 ? {kind: 'rejected', invalidTx: 'Expired'} : {kind: 'success', value: null};
    const metrics = createMetrics('keeper-backlog-recovery-test');
    const k = chainKeeper({
      db: undefined as never,
      chain,
      near: nearClient(fake.url, {retries: 1}),
      account: {accountId: KEEPER, key},
      openJobs: async () => [1n],
      metrics,
    });
    const age = async () => {
      const line = (await metrics.registry.metrics())
        .split('\n')
        .find((l) => l.startsWith('keeper_backlog_age_seconds'));
      return Number(line!.split(' ').pop());
    };
    const first = await k.sweep();
    expect(first.sent).toEqual([]);
    expect(first.failed.map((f) => f.exit)).toEqual(['expire_unaccepted']);
    expect(await age()).toBeGreaterThanOrEqual(45);
    const second = await k.sweep();
    expect(second.failed).toEqual([]);
    expect(second.sent.map((s) => s.exit)).toEqual(['expire_unaccepted']);
    expect(await age()).toBe(0);
  });

  it('never reuses a nonce when the node has not caught up', async () => {
    fake.state.advanceNonce = false;
    const t = nowS();
    onChain[1] = jobView('Created', {accept_deadline: t - 1});
    onChain[2] = jobView('Accepted', {work_deadline: t - 1});
    await keeper([1n, 2n]).sweep();
    expect(fake.state.sent.map((s) => s.nonce)).toEqual([71n, 72n]);
  });

  it('reports an exit someone else sent first by the contract’s name, and carries on', async () => {
    const t = nowS();
    onChain[1] = jobView('Created', {accept_deadline: t - 1});
    onChain[2] = jobView('Created', {accept_deadline: t - 1});
    fake.state.onSend = (tx) =>
      tx.args['job_id'] === 1 ? {kind: 'panic', name: 'InvalidState'} : {kind: 'success', value: null};
    const result = await keeper([1n, 2n]).sweep();
    expect(result.failed).toEqual([
      {chainJobId: '1', exit: 'expire_unaccepted', reason: expect.stringContaining('InvalidState')},
    ]);
    expect(result.sent.map((s) => s.chainJobId)).toEqual(['2']);
  });
});
