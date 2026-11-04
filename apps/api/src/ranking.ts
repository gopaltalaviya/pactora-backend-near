import type {AgentRow} from './types.js';

/**
 * Discovery ranking.
 *
 * Exposed as named modes rather than raw weights so an orchestrator can say
 * what it values instead of always taking the cheapest bid — which is how a
 * marketplace races to the bottom and the demo hires the worst agent.
 */
export type RankMode = 'balanced' | 'quality' | 'cheapest' | 'fastest';

const WEIGHTS: Record<RankMode, {score: number; price: number; success: number; recency: number}> = {
  balanced: {score: 0.45, price: 0.25, success: 0.2, recency: 0.1},
  quality: {score: 0.7, price: 0.05, success: 0.25, recency: 0.0},
  cheapest: {score: 0.15, price: 0.75, success: 0.1, recency: 0.0},
  fastest: {score: 0.25, price: 0.15, success: 0.2, recency: 0.4},
};

export function rank(candidates: AgentRow[], mode: RankMode = 'balanced'): AgentRow[] {
  if (candidates.length === 0) return [];
  const w = WEIGHTS[mode];

  const prices = candidates.map((c) => Number(c.pricePerTask));
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const now = Date.now();

  const scored = candidates.map((c) => {
    const completed = Number(c.completed ?? 0);
    const failed = Number(c.failed ?? 0);
    const n = completed + failed;

    // Cheapest gets 1, dearest 0. Identical prices score equal rather than
    // dividing by zero.
    const price = Number(c.pricePerTask);
    const priceScore = maxPrice === minPrice ? 1 : 1 - (price - minPrice) / (maxPrice - minPrice);

    // An unproven agent is 0.5 here, matching the on-chain score of 50 —
    // unknown, not bad.
    const successRate = n === 0 ? 0.5 : completed / n;

    const lastActive = c.lastActiveAt ? new Date(c.lastActiveAt).getTime() : 0;
    const days = lastActive === 0 ? 365 : (now - lastActive) / 86_400_000;
    const recency = Math.max(0, 1 - days / 30);

    return {
      agent: c,
      rankScore:
        w.score * (Number(c.score ?? 50) / 100) +
        w.price * priceScore +
        w.success * successRate +
        w.recency * recency,
    };
  });

  return scored.sort((a, b) => b.rankScore - a.rankScore).map((s) => s.agent);
}

export const RANK_MODES = Object.keys(WEIGHTS) as RankMode[];
