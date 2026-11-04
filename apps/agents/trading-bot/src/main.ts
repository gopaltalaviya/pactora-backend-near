import {z} from 'zod';
import {runWorker, confidence} from '@pactora/agent-core';

/**
 * trading-bot — trade analysis.
 *
 * It ANALYSES; it does not execute. The distinction is deliberate and is
 * enforced by the schema: this agent's output is a recommendation with a
 * rationale, and nothing it returns can move funds. Moving funds is
 * `execution-bot`'s capability, hired separately and paid separately, and the
 * split means a compromised analyst cannot trade.
 */

const TradeAnalysis = z.object({
  recommendation: z
    .enum(['buy', 'sell', 'hold'])
    .describe('hold is a real answer and is often the right one'),
  rationale: z.string().min(40).max(1_000).describe('why, in terms of the data you were given'),
  confidence: confidence().describe('0 to 1; a percentage is read as one'),
  risks: z
    .array(z.string().min(10))
    .min(1)
    .max(4)
    .describe(
      'what would make this wrong — required, because a recommendation without a downside is not analysis',
    ),
  suggestedSize: z
    .string()
    .optional()
    .describe('a proportion or amount, only if the input gave you enough to justify one'),
});

await runWorker({
  capability: 'trade-analysis',
  role:
    'a trading analysis agent. You evaluate a market situation and recommend a ' +
    'position with explicit risks. You never claim certainty, and you recommend ' +
    'hold when the case for acting is weak.',
  output: TradeAnalysis,
});
