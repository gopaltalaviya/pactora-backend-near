import {sql, type SQL} from 'drizzle-orm';

/**
 * How reputation is counted, in one place.
 *
 * The indexer keeps each agent's overall score as settlements arrive; discovery
 * derives a score per skill from the same events. Both use these, so one
 * history can never score two ways.
 */

/** `JobSettled.outcome` for a paid, reviewed job. UNRESOLVED (a dispute that timed out) pays but earns nothing. */
export const OUTCOME_SUCCESS = 0;

/** Refund reasons the contract records as the worker's failure. A client's own cancel is not one. */
export const WORKER_FAULT = new Set(['undelivered', 'dispute']);

/** `JobRefunded.reason` is a left-aligned bytes32 string; plain text is accepted too. */
const bytes32 = (s: string) =>
  `0x${Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .padEnd(64, '0')}`;
export const WORKER_FAULT_VALUES: readonly string[] = [...WORKER_FAULT].flatMap((r) => [r, bytes32(r)]);

/**
 * The score, as SQL: Laplace-smoothed and volume-damped (docs/04 §2.3), so a
 * fresh agent is 50 — unknown, not bad — and one lucky job cannot outrank a
 * proven record. `floor` is the chain's confidence floor.
 */
export function reputationScoreSql(completed: SQL, failed: SQL, floor: number): SQL {
  return sql`GREATEST(0, LEAST(100, (
        50 + ((
          (100 * (${completed} + 1) / (${completed} + ${failed} + 2)) - 50
        ) * LEAST(100, (${completed} + ${failed}) * 100 / ${floor})) / 100
      )::int))`;
}
