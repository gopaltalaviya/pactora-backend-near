import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import type {ChainConfig} from '@pactora/config';
import type {Db} from '@pactora/db';
import {ErrorCode, PactoraError} from '@pactora/shared';
import {isPublicId} from './jobs.js';
import {personPublicView} from './agents.js';
import {VISIBLE_REVIEW} from './profiles.js';

/**
 * A participant's public history, for a score-over-time chart (2026-11-09,
 * round 3): settled and refunded jobs per week for the last 52 weeks, and
 * the rating of the reviews about them that are shown right now.
 *
 * What it does not say: who the other party was, which jobs, or what each
 * paid. Amounts are counted into four buckets (in payment-token units), so
 * the chart can shade size without the response carrying a figure the
 * chain does not already make public per job. A person is reachable only
 * through a published profile — the same rule as GET /v1/agents/:id since
 * 917b232 — so an unpublished person is 404 on both routes.
 */

export const HISTORY_WEEKS = 52;
export const AMOUNT_BUCKETS = ['lt1', '1to10', '10to100', 'gte100'] as const;
type Bucket = (typeof AMOUNT_BUCKETS)[number];

const WEEK_MS = 7 * 86_400_000;

/** Monday 00:00 UTC of the week holding `d`. */
export function weekStart(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

interface Subject {
  agentId: number;
  chainId: string;
  kind: 'agent' | 'person';
  /** Shown in the response: the agent id for an agent (and a person reached by it), else null. */
  shownAgentId: string | null;
  profileId: string | null;
}

export interface HistoryRouteDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  now?: () => Date;
}

export async function registerHistoryRoutes(app: FastifyInstance, deps: HistoryRouteDeps): Promise<void> {
  const {db} = deps;
  const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];

  const history = async (s: Subject) => {
    const now = deps.now?.() ?? new Date();
    const last = weekStart(now);
    const from = new Date(last.getTime() - (HISTORY_WEEKS - 1) * WEEK_MS);
    const to = new Date(last.getTime() + WEEK_MS);
    const decimals = deps.chains[s.chainId]?.network.paymentToken.decimals ?? 6;
    const one = 10n ** BigInt(decimals);
    const [t1, t10, t100] = [one, one * 10n, one * 100n].map(String);

    const jobsByWeek = await rows<{
      wk: string;
      state: 'settled' | 'refunded';
      as_worker: boolean;
      as_client: boolean;
      bucket: Bucket;
      n: string | number;
    }>(sql`
      SELECT to_char(date_trunc('week', closed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS wk, state,
             worker_agent_id = ${s.agentId} AS as_worker, client_agent_id = ${s.agentId} AS as_client,
             CASE WHEN amount < ${t1}::numeric THEN 'lt1'
                  WHEN amount < ${t10}::numeric THEN '1to10'
                  WHEN amount < ${t100}::numeric THEN '10to100'
                  ELSE 'gte100' END AS bucket,
             count(*) AS n
        FROM (SELECT j.state::text AS state, j.amount, j.worker_agent_id, j.client_agent_id,
                     COALESCE(j.settled_at,
                              (SELECT max(e.occurred_at) FROM job_events e
                                WHERE e.job_id = j.id AND e.kind = 'refunded'),
                              j.created_at) AS closed_at
                FROM jobs j
               WHERE (j.client_agent_id = ${s.agentId} OR j.worker_agent_id = ${s.agentId})
                 AND j.state IN ('settled', 'refunded')) x
       WHERE closed_at >= ${from.toISOString()}::timestamptz AND closed_at < ${to.toISOString()}::timestamptz
       GROUP BY 1, 2, 3, 4, 5`);

    const ratingsByWeek = await rows<{wk: string; total: string | number; n: string | number}>(sql`
      SELECT to_char(date_trunc('week', r.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS wk, sum(r.rating) AS total, count(*) AS n
        FROM party_reviews r JOIN jobs j ON j.id = r.job_id
       WHERE r.subject_agent_id = ${s.agentId} AND ${VISIBLE_REVIEW}
         AND r.created_at >= ${from.toISOString()}::timestamptz AND r.created_at < ${to.toISOString()}::timestamptz
       GROUP BY 1`);

    const series = Array.from({length: HISTORY_WEEKS}, (_, i) => {
      const week = new Date(from.getTime() + i * WEEK_MS).toISOString().slice(0, 10);
      return {
        week,
        settled: 0,
        refunded: 0,
        asWorker: 0,
        asClient: 0,
        amounts: {lt1: 0, '1to10': 0, '10to100': 0, gte100: 0},
        rating: null as {average: number; count: number} | null,
      };
    });
    const byWeek = new Map(series.map((w) => [w.week, w]));
    for (const r of jobsByWeek) {
      const w = byWeek.get(r.wk);
      if (!w) continue;
      const n = Number(r.n);
      if (r.state === 'settled') w.settled += n;
      else w.refunded += n;
      if (r.as_worker) w.asWorker += n;
      if (r.as_client) w.asClient += n;
      w.amounts[r.bucket] += n;
    }
    let ratingSum = 0;
    let ratingCount = 0;
    for (const r of ratingsByWeek) {
      const w = byWeek.get(r.wk);
      if (!w) continue;
      const n = Number(r.n);
      const total = Number(r.total);
      w.rating = {average: Number((total / n).toFixed(2)), count: n};
      ratingSum += total;
      ratingCount += n;
    }
    return {
      subject: {kind: s.kind, agentId: s.shownAgentId, profileId: s.profileId},
      weeks: HISTORY_WEEKS,
      from: from.toISOString(),
      to: to.toISOString(),
      amountBuckets: [...AMOUNT_BUCKETS],
      series,
      totals: {
        settled: series.reduce((a, w) => a + w.settled, 0),
        refunded: series.reduce((a, w) => a + w.refunded, 0),
        rating:
          ratingCount > 0
            ? {average: Number((ratingSum / ratingCount).toFixed(2)), count: ratingCount}
            : null,
      },
    };
  };

  interface Row {
    id: string | number;
    chain_id: string;
    kind: 'agent' | 'person';
    public_id: string;
    published: boolean | null;
  }
  const select = sql`SELECT a.id, a.chain_id, a.kind, a.public_id, p.published
    FROM agents a LEFT JOIN public_profiles p ON p.agent_id = a.id`;

  app.get('/v1/agents/:id/history', async (request) => {
    const {id} = request.params as {id: string};
    if (!/^[1-9]\d{0,15}$/.test(id)) throw new PactoraError(ErrorCode.NOT_FOUND, `no agent ${id}`);
    const [a] = await rows<Row>(sql`${select} WHERE a.id = ${Number(id)}`);
    if (!a) throw new PactoraError(ErrorCode.NOT_FOUND, `no agent ${id}`);
    // A person's record is public only through a published profile.
    if ((await personPublicView(db, Number(a.id))) === 'hidden') {
      throw new PactoraError(ErrorCode.NOT_FOUND, `no agent ${id}`);
    }
    return history({
      agentId: Number(a.id),
      chainId: a.chain_id,
      kind: a.kind,
      shownAgentId: String(a.id),
      profileId: a.published ? a.public_id : null,
    });
  });

  app.get('/v1/profiles/:id/history', async (request) => {
    const {id} = request.params as {id: string};
    if (!isPublicId(id)) throw new PactoraError(ErrorCode.NOT_FOUND, `no profile ${id}`);
    const [a] = await rows<Row>(sql`${select} WHERE a.public_id = ${id} AND p.published`);
    if (!a) throw new PactoraError(ErrorCode.NOT_FOUND, `no published profile ${id}`);
    return history({
      agentId: Number(a.id),
      chainId: a.chain_id,
      kind: a.kind,
      shownAgentId: a.kind === 'agent' ? String(a.id) : null,
      profileId: a.public_id,
    });
  });
}
