import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {PactoraError, ErrorCode, type JobSpec} from '@pactora/shared';
import {NotAccepted, type AgentSummary, type PactoraClient} from '@pactora/sdk';
import {explainModelFailure, type Brain} from './brain.js';
import {Judge, validateShape, type Verdict} from './judge.js';
import {PLANNER_SYSTEM, SELECTOR_SYSTEM, SYNTHESIS_SYSTEM, wrapUntrusted} from './prompts.js';

/**
 * The client side: turn one sentence into work other agents get paid for.
 *
 * plan → discover → select → hire → await → validate → judge → settle.
 *
 * ## Every branch is a real branch
 *
 * A demo fails on the paths nobody implemented: no candidate offers the
 * capability, the budget runs out mid-run, a worker accepts and goes quiet,
 * the result comes back the wrong shape. Each of those is handled here and
 * reported as an outcome, because an orchestrator that visibly recovers is
 * more convincing than one that never stumbles — and on stage it is the only
 * kind that finishes.
 *
 * ## Planning never sees a result
 *
 * The planner is called once, before any work comes back. Selection sees only
 * protocol facts — id, price, score — never an agent's own prose. Only the
 * judge and the synthesiser read worker output, and both run with no tools.
 * So an injection in a result cannot reach the call that decides what to
 * commission or what to spend. See docs/10 §1.
 */

export const Plan = z.object({
  subtasks: z
    .array(
      z.object({
        capability: z
          .string()
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
          .describe('lowercase kebab-case'),
        input: z.record(z.string(), z.unknown()).describe('everything the worker needs to start'),
        dependsOn: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('index of an earlier subtask whose result this one needs'),
      }),
    )
    .max(4),
  reasoning: z.string().min(1).max(600),
});
export type Plan = z.infer<typeof Plan>;

/**
 * A value the planner wrote to stand for an earlier step's result —
 * `"<output of subtask 0>"`, `"{{result of step 1}}"` — rather than data.
 * The whole string must be one bracketed reference to a result.
 */
const PLACEHOLDER = /^\s*(?:<[^<>]*>|\{\{[^{}]*\}\}|\[[^[\]]*\])\s*$/;
const REFERS_TO_RESULT = /\b(?:output|result|subtask|step|previous)\b/i;
/** `"{{0}}"`: template syntax for a step index (live, Groq). A bare `[3]` may be data, so it stays. */
const STEP_INDEX = /^\s*\{\{\s*\d+\s*\}\}\s*$/;

/**
 * The input without placeholders, for a step that receives the real result
 * as `previousResult`. Live (Groq, 2026-10-08): the planner wrote
 * `liquidityData: "<output of subtask 0>"` beside the real result, and the
 * worker declined for lack of data it had been given.
 */
function withoutPlaceholders(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([, v]) =>
        !(typeof v === 'string' && ((PLACEHOLDER.test(v) && REFERS_TO_RESULT.test(v)) || STEP_INDEX.test(v))),
    ),
  );
}

export const Selection = z.object({
  agentId: z.number().int().nullable().describe('null if no candidate is worth hiring'),
  reason: z.string().min(1).max(300),
});

export const Synthesis = z.object({
  answer: z.string().min(1).max(2_000),
  confidence: z.number().min(0).max(1),
});

export type StepStatus =
  | 'settled'
  | 'disputed'
  /**
   * Judged bad, and nothing can be done about it: a fast-path job whose
   * payment is already final. Distinct from `disputed`, where the money is
   * still recoverable, and from `failed`, which would blame the system for a
   * trade-off the client made deliberately.
   */
  | 'unrecoverable'
  | 'no-candidate'
  | 'budget-exceeded'
  /** The hired worker turned the job down, with a reason; it was cancelled and refunded. */
  | 'declined'
  | 'timeout'
  | 'failed';

/** How a step's ending reads in a sentence: "…step 1, which <phrase>". */
const ENDED_AS: Record<StepStatus, string> = {
  settled: 'settled',
  disputed: 'was disputed',
  unrecoverable: 'was judged bad',
  'no-candidate': 'found no agent',
  'budget-exceeded': 'ran out of budget',
  declined: 'was declined',
  timeout: 'timed out',
  failed: 'failed',
};

export interface StepOutcome {
  capability: string;
  status: StepStatus;
  detail: string;
  jobId?: string;
  agentId?: number;
  amount?: string;
  explorerUrl?: string;
  verdict?: Verdict;
  result?: Record<string, unknown>;
  /** Set when this outcome came from a second worker: why the first one did not deliver. */
  retriedAfter?: string;
}

export interface RunReport {
  goal: string;
  plan: Plan | null;
  steps: StepOutcome[];
  answer: string | null;
  spent: string;
  /** True when at least one subtask settled: partial success is still success. */
  delivered: boolean;
  /** Why no plan was produced, when none was. */
  planError?: string;
}

export type OrchestratorEvent =
  | {kind: 'planned'; subtasks: number; reasoning: string}
  | {kind: 'plan-failed'; reason: string}
  | {kind: 'discovered'; capability: string; candidates: number}
  | {kind: 'selected'; capability: string; agentId: number; price: string; reason: string}
  /** v3: left out of the pool by the trust check, before the model chose. */
  | {kind: 'excluded'; capability: string; agentId: number; verdict: string; reason: string}
  | {kind: 'hired'; capability: string; jobId: string; amount: string; explorerUrl: string}
  | {kind: 'judged'; jobId: string; accept: boolean; quality: number; injectionAttempted: boolean}
  | {kind: 'settled'; jobId: string; explorerUrl: string}
  | {kind: 'disputed'; jobId: string; reason: string}
  | {kind: 'retrying'; capability: string; jobId: string; reason: string}
  | {kind: 'skipped'; capability: string; status: StepStatus; detail: string};

export interface OrchestratorOptions {
  client: PactoraClient;
  brain: Brain;
  /** Defaults to the same brain. Separated so judging can use a stronger model. */
  judgeBrain?: Brain;
  log?: (event: OrchestratorEvent) => void;
  /**
   * Trust verdicts that keep an agent out of the pool (v3). The default
   * refuses only misconduct: an agent that paid for its own reviews, or one
   * that fails too often. `new` and `concentrated` describe thin or narrow
   * history, not bad behaviour — every worker a single orchestrator ever
   * hired is concentrated by definition.
   */
  trustGate?: readonly string[];
}

/** See `OrchestratorOptions.trustGate`. */
export const DEFAULT_TRUST_GATE: readonly string[] = ['self-funded', 'failing'];

export class Orchestrator {
  private readonly judge: Judge;
  /** This orchestrator's own agent id, learned at the start of each run. Never a candidate. */
  private self: number | null = null;

  /**
   * Unique per `run()`. A hire's idempotency key is derived from it, the
   * worker and the spec: a retried request within a run is the same hire, but
   * a second run with the same goal is a NEW one. Keyed on worker and spec
   * alone (the SDK's default), the second run got the first run's job back —
   * already refunded — and could never hire.
   */
  private runNonce = '';

  constructor(private readonly opts: OrchestratorOptions) {
    this.judge = new Judge(opts.judgeBrain ?? opts.brain);
  }

  async run(goal: string, opts: {timeoutMs?: number} = {}): Promise<RunReport> {
    this.runNonce = randomUUID();
    const steps: StepOutcome[] = [];
    let spent = 0n;

    // What the marketplace actually sells, before planning what to buy.
    //
    // Without this the planner names capabilities from imagination: the first
    // live run produced data-analysis, position-valuation and trade-advisory,
    // none of which any agent offers, so three of four subtasks died at
    // discovery. Capability strings are protocol data — constrained to
    // kebab-case by a database CHECK — not agent prose, so this adds no
    // injection surface.
    //
    // Read the budget first: it also says who WE are. The orchestrator is a
    // registered agent too, and without knowing its own id it offered its own
    // capability to the planner — a live chaos run planned an `orchestration`
    // step, chose the orchestrator, and the API refused it as a self-hire.
    const budget = await this.opts.client.budget();
    this.self = Number(budget.agentId) || null;
    const offered = await this.availableCapabilities(this.self);
    // The reason is KEPT. This was `.catch(() => null)`, so a key the provider
    // rejected, an exhausted quota and a model that answered off-schema all
    // reported the same thing — "could not reach a model" — and the one run
    // that could have said which cost a second run to find out.
    let planError: string | undefined;
    const plan = await this.plan(goal, offered).catch((err: unknown) => {
      planError = explainModelFailure(err) ?? (err instanceof Error ? err.message : String(err));
      return null;
    });
    if (!plan || plan.subtasks.length === 0) {
      // An empty plan is the planner declining the goal; its reasoning says
      // why, and that is what a user needs — not "no subtasks".
      planError ??= plan ? `nothing to hire for: ${plan.reasoning}` : 'the plan had no subtasks';
      this.emit({kind: 'plan-failed', reason: planError});
      return {
        goal,
        plan,
        steps,
        answer: null,
        spent: '0',
        delivered: false,
        planError,
      };
    }
    this.emit({kind: 'planned', subtasks: plan.subtasks.length, reasoning: plan.reasoning});

    // Split what may be spent across the plan up front. Spending it all on
    // subtask one and discovering subtask three is unaffordable is worse than
    // being modest throughout.
    const perStep = divide(BigInt(budget.dailyRemaining), plan.subtasks.length);
    const ceiling = minOf(perStep, BigInt(budget.maxSingleSpend));

    for (const [index, subtask] of plan.subtasks.entries()) {
      // A dependency must point BACKWARDS, at a step that has already run.
      //
      // Nothing stopped a planner saying subtask 1 depends on subtask 1. The
      // first live run did exactly that, and since `steps[0]` does not exist
      // while step 0 is being planned, every subtask waited on something that
      // could never have run and the whole plan died without hiring anyone.
      //
      // A self-reference or a forward reference is not a dependency anybody
      // can satisfy, so it is dropped rather than treated as unmet — the
      // subtask simply runs on its own input, which is what the planner
      // evidently meant for the first one.
      const declared = subtask.dependsOn;
      const dependsOn = declared !== undefined && declared < index ? declared : undefined;

      const upstream = dependsOn !== undefined ? steps[dependsOn] : undefined;
      if (dependsOn !== undefined && upstream?.status !== 'settled') {
        steps.push({
          capability: subtask.capability,
          status: 'failed',
          detail: `not run: it needed the result of step ${dependsOn + 1}, which ${
            upstream ? ENDED_AS[upstream.status] : 'did not run'
          }`,
        });
        this.emit({
          kind: 'skipped',
          capability: subtask.capability,
          status: 'failed',
          detail: 'upstream step did not deliver',
        });
        continue;
      }

      const outcome = await this.runStep(
        {
          capability: subtask.capability,
          input: {
            // The goal, verbatim, on every job.
            //
            // A planner reasonably emits an empty `input` for the first
            // subtask, because the goal IS the input — and the first live
            // runs did exactly that. The orchestrator then hired a worker,
            // paid it, and asked it to do a job without saying what the job
            // was. The worker declined, correctly, and nothing ever
            // completed. Reading the recording is what showed this: three of
            // four triage decisions were accept, and the one refusal was the
            // job whose input was `{}`.
            //
            // This comes from the user rather than from an agent, so it adds
            // no injection surface — and the worker wraps the whole spec as
            // untrusted regardless.
            goal,
            step: `${index + 1} of ${plan.subtasks.length}`,
            ...(upstream?.result ? withoutPlaceholders(subtask.input) : subtask.input),
            // The upstream result travels as input. It is another agent's
            // output, so the worker will wrap it as untrusted in turn.
            ...(upstream?.result ? {previousResult: upstream.result} : {}),
          },
          // No outputSchema from the planner.
          //
          // It used to ask the planner for the field names a subtask must
          // produce, which is a guess about a worker it has not chosen yet
          // and whose schema it cannot see. The first live run had a planner
          // answer ["eth","usdc","monad"] — topic words — so every worker
          // correctly refused work it could not satisfy and nothing was ever
          // hired. The coupling was brittle by construction, not badly
          // prompted: no planner can know what fields an unknown worker
          // emits.
          //
          // The worker's own schema governs delivery, the API enforces any
          // schema a client does state, and the judge assesses whether the
          // result actually answers the task. A client that knows exactly
          // what shape it needs can still say so.
          deadlineSeconds: 120,
        },
        ceiling,
        opts.timeoutMs ?? 120_000,
      );

      steps.push(outcome);
      if (outcome.status === 'settled' && outcome.amount) spent += BigInt(outcome.amount);

      // A cap is not a hiccup: every later step would hit the same wall.
      if (outcome.status === 'budget-exceeded') break;
    }

    const settled = steps.filter((s) => s.status === 'settled');
    const answer = settled.length > 0 ? await this.synthesise(goal, settled) : null;

    return {
      goal,
      plan,
      steps,
      answer,
      spent: spent.toString(),
      delivered: settled.length > 0,
    };
  }

  /**
   * Cancel, waiting out "not confirmed on-chain yet". A worker can now decline
   * within seconds — before the indexer has linked the job to its on-chain id —
   * and the API then answers INVALID_STATE with a retry-after. That is "try
   * again in a moment", not a failed cancel; anything else still is.
   */
  private async cancelSoon(jobId: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.opts.client.cancel(jobId);
        return;
      } catch (err) {
        if (err instanceof PactoraError && err.retryAfter !== undefined && attempt < CANCEL_RETRIES) {
          const waitS = Math.min(err.retryAfter, 5);
          await new Promise((r) => setTimeout(r, waitS * 1_000));
          continue;
        }
        throw err;
      }
    }
  }

  // ── one subtask ────────────────────────────────────────────────────────

  private async runStep(spec: JobSpec, ceiling: bigint, timeoutMs: number): Promise<StepOutcome> {
    const base = {capability: spec.capability};

    if (ceiling <= 0n) {
      return this.skip({...base, status: 'budget-exceeded', detail: 'no budget remaining'});
    }

    const candidates = (
      await this.opts.client.discover({
        capability: spec.capability,
        maxPrice: ceiling.toString(),
        rank: 'balanced',
        limit: 10,
      })
    ).filter((c) => c.agentId !== this.self);
    this.emit({kind: 'discovered', capability: spec.capability, candidates: candidates.length});

    if (candidates.length === 0) {
      return this.skip({
        ...base,
        status: 'no-candidate',
        detail: `no agent offers ${spec.capability} at or below ${ceiling} base units`,
      });
    }

    // v3: who paid for each candidate's record decides whether it is in the
    // pool at all. The verdicts never enter a prompt — the model chooses among
    // the agents that passed, so recorded replays still match.
    const excluded = await this.trustExclusions(spec.capability, candidates);
    if (excluded.size > 0) {
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (excluded.has(candidates[i]!.agentId)) candidates.splice(i, 1);
      }
      if (candidates.length === 0) {
        return this.skip({
          ...base,
          status: 'no-candidate',
          detail: `every agent offering ${spec.capability} failed the trust check (${[...excluded.values()].join('; ')})`,
        });
      }
    }

    // A worker that goes silent is a fact about that worker, not about the
    // subtask. Giving up on the step lost the work whenever a second agent
    // offered the same capability; retrying the same one would repeat the
    // silence. So: once more, with someone else, never with the same agent.
    const tried = new Set<number>();
    let remaining = ceiling;
    let previous: StepOutcome | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const pool = candidates.filter((c) => !tried.has(c.agentId) && BigInt(c.pricePerTask) <= remaining);
      if (pool.length === 0) break;

      // A model outage while CHOOSING is a failed step, not a failed run.
      // This used to escape `run()` entirely: one 503 from the provider after
      // a good plan ended the demo with nothing hired and no report, where
      // every other model call in the loop already degraded to a decision.
      let chosen: AgentSummary | null;
      try {
        chosen = await this.select(spec, pool);
      } catch (err) {
        return this.skip({
          ...base,
          status: 'failed',
          detail: `could not choose an agent: ${explainModelFailure(err) ?? (err instanceof Error ? err.message : String(err))}`,
        });
      }
      if (!chosen) break;
      tried.add(chosen.agentId);

      const outcome = await this.attempt(spec, chosen, remaining, timeoutMs);
      if (!('retry' in outcome)) {
        return previous ? {...outcome, retriedAfter: previous.detail} : outcome;
      }

      previous = outcome.retry;
      // Money a silent worker still holds in escrow is not available to the
      // next one until the keeper's refund lands.
      if (outcome.locked) remaining -= outcome.locked;
      this.emit({
        kind: 'retrying',
        capability: spec.capability,
        jobId: outcome.retry.jobId!,
        reason: outcome.retry.detail,
      });
    }

    if (previous) return this.skip(previous);
    return this.skip({
      ...base,
      status: 'no-candidate',
      detail: 'no candidate was worth hiring at this price',
    });
  }

  /**
   * Hire one worker and see the job through to settlement or dispute.
   *
   * Returns `{retry}` rather than a final outcome when the worker never
   * delivered and someone else might: the caller decides whether anyone is
   * left to ask.
   */
  private async attempt(
    spec: JobSpec,
    chosen: AgentSummary,
    ceiling: bigint,
    timeoutMs: number,
  ): Promise<StepOutcome | {retry: StepOutcome; locked: bigint}> {
    const base = {capability: spec.capability};

    let receipt;
    try {
      receipt = await this.opts.client.hire({
        workerAgentId: chosen.agentId,
        spec,
        maxPrice: ceiling.toString(),
        idempotencyKey: createHash('sha256')
          .update(`${this.runNonce}:${chosen.agentId}:${JSON.stringify(spec)}`)
          .digest('hex')
          .slice(0, 32),
      });
    } catch (err) {
      // The cap is enforced outside this process and will not move. Reporting it is the
      // job; retrying it is not.
      if (err instanceof PactoraError && err.code === ErrorCode.BUDGET_EXCEEDED) {
        return this.skip({...base, status: 'budget-exceeded', detail: err.message});
      }
      return this.skip({...base, status: 'failed', detail: message(err)});
    }

    this.emit({
      kind: 'hired',
      capability: spec.capability,
      jobId: receipt.jobId,
      amount: receipt.amountDisplay,
      explorerUrl: receipt.explorerUrl,
    });

    const common = {
      ...base,
      jobId: receipt.jobId,
      agentId: chosen.agentId,
      amount: receipt.amount,
      explorerUrl: receipt.explorerUrl,
    };

    const waitingSince = Date.now();
    let job;
    try {
      job = await this.opts.client.awaitResult(receipt.jobId, {
        timeoutMs,
        acceptWithinMs: Math.min(ACCEPT_WITHIN_MS, timeoutMs),
      });
    } catch (err) {
      if (!(err instanceof NotAccepted)) {
        if (err instanceof PactoraError && err.code === ErrorCode.DEADLINE_PASSED) {
          // Not a lost payment: the keeper sends the permissionless refund once
          // the on-chain work deadline passes. Say so, rather than implying the
          // money is gone.
          return {
            retry: {
              ...common,
              status: 'timeout',
              detail: `agent ${chosen.agentId} did not deliver in time — the escrow refunds it at the work deadline`,
            },
            locked: BigInt(receipt.amount),
          };
        }
        return this.skip({...common, status: 'failed', detail: message(err)});
      }
      // The worker said no, with a reason — or never answered at all.
      const declinedReason = err.declinedReason;
      // Nobody started, so the client may cancel: an immediate on-chain
      // refund rather than one that waits out the accept window.
      try {
        await this.cancelSoon(receipt.jobId);
      } catch (cancelErr) {
        // Most likely the worker accepted in the gap. The job is theirs now:
        // hiring a second agent would pay twice, and walking away left their
        // delivery in an escrow nobody judged — seen live on a lossy RPC. So
        // wait for it like any other, for what is left of the step's time.
        try {
          job = await this.opts.client.awaitResult(receipt.jobId, {
            timeoutMs: Math.max(timeoutMs - (Date.now() - waitingSince), 0),
          });
        } catch (lateErr) {
          // Never a retry: if the cancel failed for some other reason the job
          // may still be accepted and delivered, and a second hire would pay
          // twice. It stays recoverable on chain through its own deadlines.
          return this.skip({
            ...common,
            status: 'failed',
            detail: `worker was slow to accept and the cancel failed (${message(cancelErr)}): ${message(lateErr)}`,
          });
        }
      }
      if (!job) {
        return {
          retry:
            declinedReason !== undefined
              ? {
                  ...common,
                  status: 'declined',
                  detail: `agent ${chosen.agentId} declined: ${declinedReason} — cancelled and refunded`,
                }
              : {
                  ...common,
                  status: 'timeout',
                  detail: `agent ${chosen.agentId} never accepted — cancelled and refunded`,
                },
          locked: 0n,
        };
      }
    }

    if (!job.result) {
      if (job.state === 'refunded') {
        return {
          retry: {...common, status: 'timeout', detail: `job ${receipt.jobId} was refunded without a result`},
          locked: 0n,
        };
      }
      return this.skip({...common, status: 'failed', detail: `job ended as ${job.state} with no result`});
    }

    // Structural first, deterministic, and it keeps a malformed result out of
    // a model context entirely.
    const shape = validateShape(job.result, spec.outputSchema);
    if (!shape.ok) {
      return this.dispute(common, `result is the wrong shape: ${shape.reason}`);
    }

    const verdict = await this.judge
      .evaluate({capability: spec.capability, task: spec.input, result: job.result})
      .catch(() => null);

    if (!verdict) {
      // Judging failed, not the work. Paying on an unread result would reward
      // a worker for our outage; disputing punishes them for it. The escrow's
      // review window expires in the worker's favour, so doing nothing is the
      // one option that does not make our failure their problem.
      return this.skip({
        ...common,
        status: 'failed',
        detail: 'could not evaluate the result; left for the review window to settle',
        result: job.result,
      });
    }

    this.emit({
      kind: 'judged',
      jobId: receipt.jobId,
      accept: verdict.accept,
      quality: verdict.quality,
      injectionAttempted: verdict.injectionAttempted,
    });

    if (!verdict.accept) {
      // The fast path has no recourse, and saying so is the honest report.
      //
      // A direct-pay job transferred the money when it was created; the
      // contract is finished with it and refuses a dispute. Calling one
      // anyway produced `INVALID_STATE: job is "settled", this action needs
      // "submitted"` and a step reported as `failed`, which reads as a broken
      // system rather than as the limit of a path the client chose in
      // exchange for skipping escrow.
      //
      // The result is kept. The money is spent either way, and a downstream
      // step is better served by disappointing work plus a warning than by
      // nothing at all.
      if (job.path === 'direct') {
        return this.skip({
          ...common,
          verdict,
          status: 'unrecoverable',
          detail:
            `${verdict.reason} — paid up front on the fast path, so there is no dispute to raise; ` +
            'the cost of skipping escrow is that a bad result cannot be reversed',
          result: job.result,
        });
      }
      return this.dispute({...common, verdict}, verdict.reason);
    }

    // The fast path already settled on hire; approving it would revert.
    if (job.state !== 'settled') {
      try {
        const settled = await this.opts.client.approve(receipt.jobId);
        this.emit({kind: 'settled', jobId: receipt.jobId, explorerUrl: settled.explorerUrl});
      } catch (err) {
        return this.skip({...common, status: 'failed', detail: `approve failed: ${message(err)}`});
      }
    } else {
      this.emit({kind: 'settled', jobId: receipt.jobId, explorerUrl: receipt.explorerUrl});
    }

    return {...common, status: 'settled', detail: verdict.reason, verdict, result: job.result};
  }

  // ── model calls ────────────────────────────────────────────────────────

  /** The distinct capabilities on offer right now, from discovery. */
  private async availableCapabilities(self: number | null): Promise<string[]> {
    const agents = await this.opts.client.discover({limit: 50}).catch(() => []);
    return [...new Set(agents.filter((a) => a.agentId !== self).flatMap((a) => a.capabilities))].sort();
  }

  private async plan(goal: string, offered: string[]): Promise<Plan> {
    const menu =
      offered.length === 0
        ? ''
        : [
            '',
            '',
            'The ONLY capabilities any agent offers are:',
            ...offered.map((c) => `  - ${c}`),
            '',
            'Use these exact strings. A capability outside this list matches no',
            'agent, so that subtask buys nothing and wastes the budget. If the',
            'goal cannot be served by these, return an empty list and say why.',
          ].join('\n');

    const {value} = await this.opts.brain.complete({
      schema: Plan,
      schemaName: 'Plan',
      system: PLANNER_SYSTEM,
      // The goal comes from the user, not from another agent, so it is not
      // wrapped. Everything an agent produced is.
      prompt: `The goal:\n${goal}${menu}\n\nPlan the work.`,
      maxTokens: 1_500,
      effort: 'medium',
    });
    return value;
  }

  /**
   * Choose between candidates.
   *
   * Candidates are protocol facts — id, price, score, completions — and never
   * an agent's own prose, so there is no injection surface in this call.
   */
  /**
   * The candidates the trust gate keeps out, with why. A trust read that
   * fails leaves the candidate in: the escrow's own guarantees (stake, caps,
   * settlement-backed reviews) do not depend on this read, and an API hiccup
   * must not halt a run.
   */
  private async trustExclusions(
    capability: string,
    candidates: AgentSummary[],
  ): Promise<Map<number, string>> {
    const gate = this.opts.trustGate ?? DEFAULT_TRUST_GATE;
    const out = new Map<number, string>();
    if (gate.length === 0) return out;
    const readings = await Promise.all(
      candidates.map((c) =>
        typeof this.opts.client.trust === 'function'
          ? this.opts.client.trust(c.agentId).catch(() => null)
          : Promise.resolve(null),
      ),
    );
    readings.forEach((r, i) => {
      if (r && gate.includes(r.verdict)) {
        const agentId = candidates[i]!.agentId;
        const reason = r.reasons[0] ?? r.verdict;
        out.set(agentId, `agent ${agentId}: ${r.verdict}`);
        this.emit({kind: 'excluded', capability, agentId, verdict: r.verdict, reason});
      }
    });
    return out;
  }

  private async select(spec: JobSpec, candidates: AgentSummary[]): Promise<AgentSummary | null> {
    // The record that matters is the one in THIS skill: a strong analyst with
    // no research history is unknown at research. Discovery filtered by
    // capability returns it as `skill`; the overall figures are the fallback.
    const facts = candidates.map((c) => {
      const record = c.skill?.capability === spec.capability ? c.skill : c;
      return {
        agentId: c.agentId,
        price: c.pricePerTask,
        priceDisplay: c.priceDisplay,
        score: record.score,
        completed: record.completed,
        failed: record.failed,
        capabilities: c.capabilities,
      };
    });

    const {value} = await this.opts.brain.complete({
      schema: Selection,
      schemaName: 'Selection',
      system: SELECTOR_SYSTEM,
      prompt: [
        `Subtask capability: ${spec.capability}`,
        '',
        'Candidates:',
        JSON.stringify(facts, null, 2),
        '',
        'Which one, if any?',
      ].join('\n'),
      maxTokens: 500,
      effort: 'low',
    });

    // A hallucinated id must not become a hire. Only an id that was actually
    // offered counts.
    const chosen = candidates.find((c) => c.agentId === value.agentId) ?? null;
    if (chosen) {
      // The reason is emitted, not just the id: "why this agent" is the
      // question an audience asks, and a marketplace that cannot answer it
      // looks like a lottery.
      this.emit({
        kind: 'selected',
        capability: spec.capability,
        agentId: chosen.agentId,
        price: chosen.priceDisplay,
        reason: value.reason,
      });
    }
    return chosen;
  }

  private async synthesise(goal: string, settled: StepOutcome[]): Promise<string | null> {
    const {value} = await this.opts.brain
      .complete({
        schema: Synthesis,
        schemaName: 'Synthesis',
        system: SYNTHESIS_SYSTEM,
        prompt: [
          `The goal:\n${goal}`,
          '',
          'What the agents you hired returned:',
          // Every one of these is third-party output.
          ...settled.map((s) => `\n${s.capability}:\n${wrapUntrusted(s.result)}`),
          '',
          'Answer the goal.',
        ].join('\n'),
        maxTokens: 2_000,
        effort: 'medium',
      })
      .catch(() => ({value: null}));

    return value?.answer ?? null;
  }

  // ── outcomes ───────────────────────────────────────────────────────────

  private async dispute(
    common: Omit<StepOutcome, 'status' | 'detail'>,
    reason: string,
  ): Promise<StepOutcome> {
    try {
      await this.opts.client.dispute(common.jobId!, reason);
      this.emit({kind: 'disputed', jobId: common.jobId!, reason});
    } catch (err) {
      return {...common, status: 'failed', detail: `dispute failed: ${message(err)}`};
    }
    return {...common, status: 'disputed', detail: reason};
  }

  private skip(outcome: StepOutcome): StepOutcome {
    this.emit({
      kind: 'skipped',
      capability: outcome.capability,
      status: outcome.status,
      detail: outcome.detail,
    });
    return outcome;
  }

  private emit(event: OrchestratorEvent): void {
    this.opts.log?.(event);
  }
}

/** Integer division that never returns a negative share. */
function divide(total: bigint, parts: number): bigint {
  if (parts <= 0 || total <= 0n) return 0n;
  return total / BigInt(parts);
}

const minOf = (a: bigint, b: bigint) => (a < b ? a : b);

/** One worker, then one other. A third silent worker says more about the network than the workers. */
const MAX_ATTEMPTS = 2;

/** How long an escrow offer may sit unaccepted before the client cancels and asks someone else. */
const ACCEPT_WITHIN_MS = 45_000;
/** Cancels refused as "not confirmed on-chain yet" are retried this many times (≈ seconds each). */
const CANCEL_RETRIES = 8;

function message(err: unknown): string {
  if (err instanceof PactoraError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
