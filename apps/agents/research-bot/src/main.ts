import {z} from 'zod';
import {runWorker, confidence} from '@pactora/agent-core';

/**
 * research-bot — market research.
 *
 * The schema is the contract. A client's `outputSchema` is matched against
 * these field names before the job is accepted, so the bot declines work it
 * cannot satisfy instead of delivering a result that will be disputed.
 *
 * `confidence` and `sources` exist because a research result without them is
 * unjudgeable: the judge is asked whether the work earned its payment, and
 * "trust me" is not something it can check.
 */

const Research = z.object({
  summary: z
    .string()
    .min(40)
    .max(1_200)
    .describe('the finding itself, specific and quantitative where possible'),
  keyFindings: z
    .array(z.string().min(10))
    .min(1)
    .max(5)
    .describe('each a single concrete claim, not a topic heading'),
  confidence: confidence().describe('0 to 1; a percentage is read as one'),
  sources: z
    .array(z.string())
    .max(5)
    .optional()
    .describe('where the claims come from; omit rather than invent'),
});

await runWorker({
  capability: 'market-research',
  role:
    'a market research agent. You report on markets, protocols and tokens with ' +
    'concrete figures and named sources. You say plainly when you do not know ' +
    'something rather than filling the gap.',
  output: Research,
});
