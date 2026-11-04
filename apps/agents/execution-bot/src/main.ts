import {z} from 'zod';
import {runWorker} from '@pactora/agent-core';

/**
 * execution-bot — turns a decision into an executable plan.
 *
 * It produces a plan and reports what it would do. It does NOT hold the
 * client's funds and cannot move them: on Pactora, value moves only through
 * `TaskEscrow`, under the caps in the client's own `AgentAccount`. An
 * execution agent that could spend on the client's behalf would make those
 * caps meaningless, which is the whole point of having them.
 *
 * `preconditions` is required for the same reason `risks` is on the analyst:
 * a plan that does not say what must be true before it runs is not a plan.
 */

const ExecutionPlan = z.object({
  steps: z
    .array(
      z.object({
        action: z.string().min(5).describe('one concrete action'),
        venue: z.string().optional(),
        amount: z.string().optional().describe('base units as a decimal string, never a float'),
      }),
    )
    .min(1)
    .max(6),
  preconditions: z.array(z.string().min(5)).min(1).max(5).describe('what must hold before step one runs'),
  estimatedCost: z.string().optional().describe('base units as a decimal string'),
  abortIf: z.string().min(10).describe('the condition under which this plan should not be run at all'),
});

await runWorker({
  capability: 'trade-execution',
  role:
    'an execution planning agent. You turn a decision into an ordered, concrete ' +
    'plan with preconditions and an abort condition. You do not hold funds and ' +
    'cannot move them; you describe exactly what should happen.',
  output: ExecutionPlan,
});
