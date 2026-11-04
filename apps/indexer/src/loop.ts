/**
 * The retry loop around `tick()`.
 *
 * Extracted from `main.ts` so it can be tested without an RPC, a database or
 * a running process — the behaviour that matters here is what happens when
 * the chain endpoint misbehaves, and that is exactly what is hardest to
 * arrange by hand at the wrong moment.
 *
 * ## Why backoff, not a fixed interval
 *
 * A failing tick must never kill the worker: RPCs rate-limit, time out and
 * briefly 500. But retrying a rate-limited endpoint every two seconds is how
 * a brief limit becomes a permanent one — the limiter sees a steady stream
 * and never lets us back in. Backing off gives it room to forgive us, and
 * jitter keeps two chains (or two replicas) from synchronising into the same
 * pattern.
 *
 * Recovery is immediate: one success resets the delay to the poll interval.
 * A demo that took a minute to notice the network came back would be
 * indistinguishable from one that never recovered.
 */

export interface LoopOptions {
  /** Normal cadence when everything is fine. */
  pollMs: number;
  /** Never wait longer than this between attempts, however long it has failed. */
  maxBackoffMs?: number;
  signal?: AbortSignal;
  onError?: (err: unknown, consecutiveFailures: number, nextDelayMs: number) => void;
  onRecovered?: (afterFailures: number) => void;
  /** Injected so a test does not spend real seconds. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export async function runIndexerLoop(tick: () => Promise<unknown>, opts: LoopOptions): Promise<void> {
  const maxBackoff = opts.maxBackoffMs ?? 60_000;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  let failures = 0;

  while (!opts.signal?.aborted) {
    let delay = opts.pollMs;

    try {
      await tick();
      if (failures > 0) {
        opts.onRecovered?.(failures);
        failures = 0;
      }
    } catch (err) {
      failures++;
      delay = backoff(opts.pollMs, failures, maxBackoff, random);
      opts.onError?.(err, failures, delay);
    }

    await sleep(delay);
  }
}

/**
 * Exponential, capped, with jitter.
 *
 * The jitter is ±20% rather than full randomisation: enough to break
 * lockstep between workers, not so much that the delay stops being
 * predictable to whoever is reading the log during a demo.
 */
export function backoff(baseMs: number, failures: number, maxMs: number, random = Math.random): number {
  const exponential = Math.min(baseMs * 2 ** (failures - 1), maxMs);
  const jitter = 1 + (random() - 0.5) * 0.4;
  return Math.round(Math.min(exponential * jitter, maxMs));
}
