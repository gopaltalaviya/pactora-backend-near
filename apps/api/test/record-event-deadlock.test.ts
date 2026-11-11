import {describe, expect, it} from 'vitest';
import {EventBus} from '../src/app.js';
import {recordEvent} from '../src/routes/jobs.js';

/**
 * A job event's insert can lose a deadlock: its fan-out trigger locks both
 * parties' agent_event_seq rows, and another transaction may hold one of them
 * while it waits for the other. The live browser suite hit this on 2026-11-11
 * (POST /v1/listings/:id/decide answered 500, "deadlock detected" on the
 * job.created insert). Postgres aborts one side with 40P01 and expects it to
 * retry; the insert is idempotent (ON CONFLICT DO NOTHING), so a retry can
 * never write twice.
 */

type Insertish = {
  insert: () => {values: () => {onConflictDoNothing: () => {returning: () => Promise<{id: number}[]>}}};
};

function fakeDb(failures: Array<'deadlock' | 'other'>): {db: Insertish; calls: () => number} {
  let calls = 0;
  const db: Insertish = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            const f = failures[calls++];
            if (f === 'deadlock') {
              // drizzle wraps the driver error; the SQLSTATE is on `cause`.
              throw Object.assign(new Error('Failed query: insert into "job_events" … deadlock detected'), {
                cause: Object.assign(new Error('deadlock detected'), {code: '40P01'}),
              });
            }
            if (f === 'other') throw Object.assign(new Error('unique violation'), {code: '23505'});
            return [{id: 42}];
          },
        }),
      }),
    }),
  };
  return {db, calls: () => calls};
}

describe('recordEvent under a deadlock', () => {
  it('retries an insert Postgres aborted as a deadlock victim, and records it once', async () => {
    const {db, calls} = fakeDb(['deadlock', 'deadlock']);
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.subscribe(7, (e) => seen.push(e));
    await recordEvent(db as never, bus, 7, 'near:sandbox', 'job.created', {jobId: 'j'});
    expect(calls()).toBe(3);
    expect(seen).toEqual([{event: 'job.created', data: {jobId: 'j'}, id: 42}]);
  });

  it('does not retry any other error', async () => {
    const {db, calls} = fakeDb(['other']);
    await expect(
      recordEvent(db as never, new EventBus(), 7, 'near:sandbox', 'job.created', {}),
    ).rejects.toThrow(/unique violation/);
    expect(calls()).toBe(1);
  });

  it('gives up after a bounded number of deadlocks, with the error', async () => {
    const {db, calls} = fakeDb(['deadlock', 'deadlock', 'deadlock', 'deadlock', 'deadlock', 'deadlock']);
    await expect(
      recordEvent(db as never, new EventBus(), 7, 'near:sandbox', 'job.created', {}),
    ).rejects.toThrow(/deadlock/);
    expect(calls()).toBe(4);
  });
});
