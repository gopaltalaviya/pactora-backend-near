import {describe, expect, it} from 'vitest';
import {Keeper, JobState, dueExit, type Exit, type OnChainJob} from '../src/keeper.js';

/**
 * The keeper exists because `TaskEscrow`'s permissionless exits had no caller.
 * The contract promised that no job holds funds forever; nothing in this
 * system ever sent the transaction that keeps the promise.
 *
 * The timing rule under test is the contract's: an exit is valid strictly
 * AFTER its deadline (`block.timestamp <= deadline` reverts). Getting the
 * boundary wrong in the safe direction wastes a sweep; in the other it buys
 * a certain revert and pays gas for it.
 */

const job = (over: Partial<OnChainJob>): OnChainJob => ({
  state: JobState.CREATED,
  acceptDeadline: 1_000n,
  workDeadline: 2_000n,
  reviewDeadline: 0n,
  ...over,
});

describe('which exit is due', () => {
  it('refunds an offer nobody accepted, once the accept deadline has passed', () => {
    expect(dueExit(job({}), 1_001n)).toBe('expireUnaccepted');
  });

  it('sends nothing on the deadline second itself — the contract would revert', () => {
    expect(dueExit(job({}), 1_000n)).toBeNull();
    expect(dueExit(job({state: JobState.ACCEPTED}), 2_000n)).toBeNull();
    expect(dueExit(job({state: JobState.SUBMITTED, reviewDeadline: 3_000n}), 3_000n)).toBeNull();
  });

  it('refunds accepted work that was never delivered', () => {
    expect(dueExit(job({state: JobState.ACCEPTED}), 2_001n)).toBe('expireUndelivered');
  });

  it('does not expire accepted work on the ACCEPT deadline', () => {
    expect(dueExit(job({state: JobState.ACCEPTED}), 1_500n)).toBeNull();
  });

  /** The client going quiet must not let it keep a result without paying. */
  it('pays for a result nobody reviewed, once the review window closes', () => {
    expect(dueExit(job({state: JobState.SUBMITTED, reviewDeadline: 3_000n}), 3_001n)).toBe('autoApprove');
  });

  it('leaves every terminal state alone', () => {
    for (const state of [0, 5, 6, 7]) {
      expect(dueExit(job({state, reviewDeadline: 1n, disputeDeadline: 1n}), 10_000_000n)).toBeNull();
    }
  });

  /**
   * v1 listed DISPUTED (4) among the states to leave alone, because it HAD no
   * exit: an arbiter who never ruled held the funds forever. v2's escrow gives
   * it one, and the keeper sends it.
   */
  it('settles a dispute nobody ruled on, once its timeout passes', () => {
    const disputed = job({state: 4, reviewDeadline: 3_000n, disputeDeadline: 5_000n});
    expect(dueExit(disputed, 5_000n)).toBeNull();
    expect(dueExit(disputed, 5_001n)).toBe('expireDispute');
  });

  it('never expires a dispute whose deadline the chain has not set', () => {
    expect(dueExit(job({state: 4, disputeDeadline: 0n}), 10_000_000n)).toBeNull();
  });
});

describe('a sweep', () => {
  const build = (jobs: Record<string, OnChainJob>, now: bigint, failOn: string[] = []) => {
    const sent: {exit: Exit; id: string}[] = [];
    const keeper = new Keeper({
      openJobs: async () => Object.keys(jobs).map(BigInt),
      readJob: async (id) => jobs[id.toString()]!,
      now: async () => now,
      send: async (exit, id) => {
        if (failOn.includes(id.toString()))
          throw new Error('execution reverted: InvalidState()\nmore detail');
        sent.push({exit, id: id.toString()});
        return `0x${id.toString().padStart(64, '0')}`;
      },
    });
    return {keeper, sent};
  };

  it('sends only what is due, and the right exit for each', async () => {
    const {keeper, sent} = build(
      {
        '1': job({}), //                                      unaccepted, overdue
        '2': job({acceptDeadline: 9_000n, workDeadline: 9_500n}), // still open
        '3': job({state: JobState.ACCEPTED}), //                undelivered, overdue
        '4': job({state: JobState.SUBMITTED, reviewDeadline: 2_500n}), // unreviewed
      },
      5_000n,
    );

    const result = await keeper.sweep();

    expect(result.checked).toBe(4);
    expect(sent).toEqual([
      {exit: 'expireUnaccepted', id: '1'},
      {exit: 'expireUndelivered', id: '3'},
      {exit: 'autoApprove', id: '4'},
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
      {chainJobId: '2', exit: 'expireUnaccepted', reason: 'execution reverted: InvalidState()'},
    ]);
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
      send: async () => {
        throw new Error('should not send');
      },
    });

    expect(await keeper.sweep()).toEqual({checked: 0, sent: [], failed: []});
    expect(clockRead).toBe(false);
  });
});

/**
 * Audit M-1 (2026-10-26): a review the registry refused at settlement is now
 * kept by the escrow, the agent cannot hire or be hired until it is written,
 * and anyone may write it with `retryFeedback`. The keeper is that anyone —
 * otherwise a registry outage would leave honest agents unhireable.
 */
describe('refused reviews', () => {
  it('writes every refused review the registry now takes, and leaves the rest for later', async () => {
    const sent: string[] = [];
    const keeper = new Keeper({
      openJobs: async () => [],
      readJob: async () => {
        throw new Error('should not read');
      },
      now: async () => 0n,
      send: async () => {
        throw new Error('no exits here');
      },
      unwrittenReviews: async () => [
        {chainJobId: 7n, client: false},
        {chainJobId: 7n, client: true},
        {chainJobId: 9n, client: false},
      ],
      retryReview: async (id, client) => {
        if (id === 9n) throw new Error('execution reverted: Self-feedback not allowed');
        sent.push(`${id}:${client}`);
        return '0xabc';
      },
    });
    const result = await keeper.retryReviews();
    expect(sent).toEqual(['7:false', '7:true']);
    expect(result.written).toHaveLength(2);
    expect(result.stillRefused).toEqual([
      {chainJobId: '9', client: false, reason: 'execution reverted: Self-feedback not allowed'},
    ]);
  });

  it('does nothing when it was not given a way to find them', async () => {
    const keeper = new Keeper({
      openJobs: async () => [],
      readJob: async () => {
        throw new Error('should not read');
      },
      now: async () => 0n,
      send: async () => {
        throw new Error('should not send');
      },
    });
    expect(await keeper.retryReviews()).toEqual({written: [], stillRefused: []});
  });
});
