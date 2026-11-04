import {describe, expect, it} from 'vitest';
import {backoff, runIndexerLoop} from '../src/loop.js';

/**
 * Chaos checklist item 5 — "RPC returns 500 for 30s → retry with backoff, no
 * stuck job".
 *
 * Time is injected, so these assert the shape of the retry rather than
 * spending real seconds waiting for it.
 */

/** Records what the loop would have waited for, and returns instantly. */
function fakeClock() {
  const waits: number[] = [];
  return {waits, sleep: async (ms: number) => void waits.push(ms)};
}

/** Stops the loop after n iterations, so a test terminates. */
function stopAfter(n: number) {
  const controller = new AbortController();
  let calls = 0;
  return {
    signal: controller.signal,
    count: () => calls,
    tick: (behaviour: (call: number) => void) => async () => {
      calls++;
      // In a `finally`, because most of these ticks throw on purpose — an
      // abort placed after the call would never run, and the loop would
      // spin forever.
      try {
        return behaviour(calls);
      } finally {
        if (calls >= n) controller.abort();
      }
    },
  };
}

describe('the retry loop', () => {
  it('polls at the normal interval while everything works', async () => {
    const clock = fakeClock();
    const runner = stopAfter(3);

    await runIndexerLoop(
      runner.tick(() => undefined),
      {pollMs: 2_000, signal: runner.signal, sleep: clock.sleep, random: () => 0.5},
    );

    expect(clock.waits).toEqual([2_000, 2_000, 2_000]);
  });

  /**
   * The failure that matters. Retrying a rate-limited endpoint every two
   * seconds is how a brief limit becomes a permanent one: the limiter sees a
   * steady stream and never lets us back in.
   */
  it('backs off exponentially while the RPC keeps failing', async () => {
    const clock = fakeClock();
    const runner = stopAfter(4);

    await runIndexerLoop(
      runner.tick(() => {
        throw new Error('503 Service Unavailable');
      }),
      {pollMs: 1_000, signal: runner.signal, sleep: clock.sleep, random: () => 0.5},
    );

    expect(clock.waits).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('never waits longer than the ceiling, however long it has been down', async () => {
    const clock = fakeClock();
    const runner = stopAfter(12);

    await runIndexerLoop(
      runner.tick(() => {
        throw new Error('down');
      }),
      {
        pollMs: 1_000,
        maxBackoffMs: 10_000,
        signal: runner.signal,
        sleep: clock.sleep,
        random: () => 0.5,
      },
    );

    expect(Math.max(...clock.waits)).toBeLessThanOrEqual(10_000);
  });

  /**
   * Recovery has to be immediate. A demo that took a minute to notice the
   * network came back is indistinguishable from one that never recovered.
   */
  it('returns to the normal interval on the first success', async () => {
    const clock = fakeClock();
    const runner = stopAfter(5);

    await runIndexerLoop(
      runner.tick((call) => {
        if (call <= 3) throw new Error('down');
      }),
      {pollMs: 1_000, signal: runner.signal, sleep: clock.sleep, random: () => 0.5},
    );

    expect(clock.waits).toEqual([1_000, 2_000, 4_000, 1_000, 1_000]);
  });

  it('never stops on an error, because the cursor is durable and the next tick resumes', async () => {
    const runner = stopAfter(6);
    let observed = 0;

    await runIndexerLoop(
      runner.tick(() => {
        throw new Error('down');
      }),
      {
        pollMs: 1,
        signal: runner.signal,
        sleep: async () => undefined,
        onError: () => observed++,
      },
    );

    expect(runner.count()).toBe(6);
    expect(observed).toBe(6);
  });

  it('reports the failure streak so a persistent outage can be escalated', async () => {
    const streaks: number[] = [];
    const runner = stopAfter(3);

    await runIndexerLoop(
      runner.tick(() => {
        throw new Error('down');
      }),
      {
        pollMs: 1,
        signal: runner.signal,
        sleep: async () => undefined,
        onError: (_err, failures) => streaks.push(failures),
      },
    );

    expect(streaks).toEqual([1, 2, 3]);
  });

  it('announces recovery with how long it was down', async () => {
    const recovered: number[] = [];
    const runner = stopAfter(4);

    await runIndexerLoop(
      runner.tick((call) => {
        if (call <= 2) throw new Error('down');
      }),
      {
        pollMs: 1,
        signal: runner.signal,
        sleep: async () => undefined,
        onRecovered: (after) => recovered.push(after),
      },
    );

    expect(recovered).toEqual([2]);
  });

  it('stops promptly when asked, so a demo does not leave workers running', async () => {
    const controller = new AbortController();
    controller.abort();
    let ticks = 0;

    await runIndexerLoop(async () => void ticks++, {
      pollMs: 1_000,
      signal: controller.signal,
      sleep: async () => undefined,
    });

    expect(ticks).toBe(0);
  });
});

describe('backoff', () => {
  it('keeps jitter within ±20%, so a logged delay is still predictable', () => {
    for (const r of [0, 0.5, 1]) {
      const delay = backoff(1_000, 3, 60_000, () => r);
      expect(delay).toBeGreaterThanOrEqual(3_200);
      expect(delay).toBeLessThanOrEqual(4_800);
    }
  });

  it('respects the ceiling even at the top of the jitter range', () => {
    expect(backoff(1_000, 20, 10_000, () => 1)).toBeLessThanOrEqual(10_000);
  });
});
