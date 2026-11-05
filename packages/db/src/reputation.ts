import {sql, type SQL} from 'drizzle-orm';

/**
 * How reputation is counted, in one place.
 *
 * The indexer keeps each agent's overall score as settlements arrive; discovery
 * derives a score per skill from the same events. Both use these, so one
 * history can never score two ways.
 */

/**
 * `job_settled.outcome` for a paid, reviewed job — the contract's `Outcome`
 * enum as its JSON names it. `Unresolved` (a dispute that timed out) pays but
 * earns nothing.
 */
export const OUTCOME_SUCCESS = 'Success';

/** `job_refunded.reason`s the contract records as the worker's failure. A client's own cancel is not one. */
export const WORKER_FAULT = new Set(['undelivered', 'dispute']);

/** The same reasons, as the values an event payload carries (plain strings on NEAR). */
export const WORKER_FAULT_VALUES: readonly string[] = [...WORKER_FAULT];

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
