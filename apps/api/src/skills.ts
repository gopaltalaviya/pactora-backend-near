import {sql} from 'drizzle-orm';
import {OUTCOME_SUCCESS, WORKER_FAULT_VALUES, reputationScoreSql, type Db} from '@pactora/db';

/**
 * Reputation per skill.
 *
 * The overall score blends every capability an agent offers, so an excellent
 * analyst with no research record could outrank a proven researcher for a
 * research job. These figures count the same events the indexer counts for
 * the overall score — a settled job with outcome SUCCESS, a refund the
 * contract records as the worker's fault — split by the job's capability, and
 * score them with the same formula. Computed on read: no migration, no second
 * projection to keep in step.
 */
export interface SkillStat {
  capability: string;
  completed: number;
  failed: number;
  successRate: number | null;
  score: number;
}

export async function skillStats(
  db: Db,
  chainId: number,
  agentIds: number[],
  floor: number,
): Promise<Map<number, SkillStat[]>> {
  const out = new Map<number, SkillStat[]>();
  if (agentIds.length === 0) return out;

  const rows = (await db.execute(sql`
    WITH counted AS (
      SELECT j.worker_agent_id AS agent_id,
             j.spec->>'capability' AS capability,
             count(*) FILTER (
               WHERE e.kind = 'settled'
                 AND coalesce((e.payload->>'outcome')::int, ${OUTCOME_SUCCESS}) = ${OUTCOME_SUCCESS}
             )::int AS completed,
             count(*) FILTER (
               WHERE e.kind = 'refunded' AND (e.payload->>'reason') IN ${[...WORKER_FAULT_VALUES]}
             )::int AS failed
      FROM jobs j
      JOIN job_events e ON e.job_id = j.id
      WHERE j.chain_id = ${chainId}
        AND j.worker_agent_id IN ${agentIds}
        AND j.spec->>'capability' IS NOT NULL
      GROUP BY 1, 2
    )
    SELECT agent_id, capability, completed, failed,
           ${reputationScoreSql(sql`completed`, sql`failed`, floor)} AS score
    FROM counted
    WHERE completed + failed > 0
  `)) as unknown as {
    agent_id: number;
    capability: string;
    completed: number;
    failed: number;
    score: number;
  }[];

  for (const r of rows) {
    const id = Number(r.agent_id);
    const list = out.get(id) ?? [];
    list.push(stat(r.capability, Number(r.completed), Number(r.failed), Number(r.score)));
    out.set(id, list);
  }
  return out;
}

/** A skill with no history: unknown, not bad — the same 50 a new agent starts at. */
export function noHistory(capability: string): SkillStat {
  return stat(capability, 0, 0, 50);
}

function stat(capability: string, completed: number, failed: number, score: number): SkillStat {
  const n = completed + failed;
  return {
    capability,
    completed,
    failed,
    successRate: n === 0 ? null : Number((completed / n).toFixed(4)),
    score,
  };
}
