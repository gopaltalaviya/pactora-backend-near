import {PactoraClient} from '@pactora/sdk';
import {Orchestrator, buildBrain, buildJudgeBrain, type Brain} from '@pactora/agent-core';
import type {RunExecutor} from './runs.js';

/**
 * The real executor: an `Orchestrator` per run, streaming its events out.
 *
 * Built once at startup and reused, because the brain holds provider clients
 * and a recorded cache — constructing one per run would re-read the cache
 * file on every request and throw away connection reuse.
 *
 * Returns `null` when no model is reachable, so the API can start and serve
 * everything else rather than refusing to boot. A deployment with no key
 * should still show the marketplace; it just cannot start a run, and says so
 * with a real error instead of hanging.
 */
export async function makeRunExecutor(opts: {
  baseUrl: string;
  chainId: string;
  brain?: Brain;
  /** The judge's brain; by default from JUDGE_PROVIDER (unset: the orchestrator's brain judges). */
  judgeBrain?: Brain;
}): Promise<RunExecutor | null> {
  const brain = opts.brain ?? buildBrain({role: 'orchestrator'});
  const judgeBrain = opts.judgeBrain ?? (opts.brain ? undefined : buildJudgeBrain());
  if (!(await brain.available())) return null;

  return async (ctx) => {
    // A client per run, carrying the caller's own key: the orchestrator acts
    // as that agent, and spends under that agent's on-chain caps.
    const client = new PactoraClient({
      baseUrl: opts.baseUrl,
      apiKey: ctx.apiKey,
      chainId: opts.chainId,
    });

    // The orchestrator's log callback is synchronous; recording an event is
    // not. Chaining them serialises the writes, which matters twice over: two
    // inserts racing would order the trace by whichever transaction committed
    // first, and the page renders that order as the story of what happened.
    let writes = Promise.resolve();
    const orchestrator = new Orchestrator({
      client,
      brain,
      ...(judgeBrain ? {judgeBrain} : {}),
      log: (event) => {
        writes = writes
          .then(() => ctx.emit(event as unknown as Record<string, unknown> & {kind: string}))
          // A failed write must not abandon the run — the trace is a view of
          // the work, not the work itself.
          .catch(() => undefined);
      },
    });

    const report = await orchestrator.run(ctx.goal);

    // Drain before returning, so the terminal `finished` event cannot be
    // written ahead of the last thing that happened.
    await writes;

    return {
      answer: report.answer,
      spent: report.spent,
      steps: report.steps,
      delivered: report.delivered,
      planError: report.planError ?? null,
    };
  };
}
