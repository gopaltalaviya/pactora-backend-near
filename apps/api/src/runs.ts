import {and, asc, eq, gt} from 'drizzle-orm';
import {PactoraError, ErrorCode} from '@pactora/shared';
import {runEvents, runs, type Db} from '@pactora/db';
import type {EventBus} from './events.js';

/**
 * Executing an orchestrator run, and recording it as it happens.
 *
 * ## Why this lives in the API process
 *
 * A run is a long-lived agent loop, and long-lived work inside an HTTP
 * service is normally the wrong shape. It is here because the live demo page
 * needs one stream of one run, and a separate runner service would add a
 * queue, a second deployment and a failure mode between the page and the
 * thing it is showing — three ways for the demo to break, to avoid a scaling
 * problem a hackathon demo does not have.
 *
 * The seam is kept explicit so that stays a choice: `RunExecutor` is injected,
 * and moving runs to their own service means supplying a different one.
 *
 * ## Why every event is written before it is published
 *
 * The page may connect late, refresh, or be opened again after the run is
 * over — and the finished run is the artefact worth keeping. So the row is
 * the record and the stream is a convenience, never the other way round.
 */

export interface RunEvent {
  kind: string;
  [key: string]: unknown;
}

export interface RunContext {
  runId: number;
  agentId: number;
  apiKey: string;
  goal: string;
  emit: (event: RunEvent) => Promise<void>;
}

export interface RunResult {
  answer: string | null;
  spent: string;
  steps: unknown[];
  delivered: boolean;
  /** Set when no plan could be made; the run then hired nobody. */
  planError?: string | null;
}

/**
 * Why a run that delivered nothing failed, in one paragraph built from its own
 * steps. Null when something was delivered: a partial answer is still a run
 * that did its job, and its step list says what was missing.
 */
export function failureOf(result: RunResult): string | null {
  if (result.delivered) return null;
  if (result.planError) return `No plan: ${result.planError}`;
  const steps = result.steps as {capability?: string; detail?: string; status?: string}[];
  if (steps.length === 0) return 'No agent delivered: the plan had no steps.';
  const why = steps.map(
    (s) => `${s.capability ?? 'a step'}: ${(s.detail ?? s.status ?? 'did not deliver').replace(/\.$/, '')}.`,
  );
  return `No agent delivered. ${why.join(' ')}`;
}

/** What actually performs a run. Injected so the API can be tested without a model. */
export type RunExecutor = (ctx: RunContext) => Promise<RunResult>;

export class RunService {
  constructor(
    private readonly deps: {
      db: Db;
      bus: EventBus;
      execute: RunExecutor;
      log?: (err: unknown, msg: string) => void;
      /**
       * Runs one orchestrator may start in a rolling 24 h; 0 or unset = no cap.
       * A hosted orchestrator's key is handed to judges and every run spends
       * the owner's model quota — a leaked key must not be able to drain it.
       */
      runsPerDay?: number;
    },
  ) {}

  /**
   * Start a run and return immediately with its id.
   *
   * The caller gets an id it can subscribe to before any work happens, which
   * is what makes the page able to show the first event rather than joining
   * halfway through.
   */
  async start(args: {
    chainId: number;
    agentId: number;
    apiKey: string;
    goal: string;
  }): Promise<{runId: number; publicId: string}> {
    const cap = this.deps.runsPerDay ?? 0;
    if (cap > 0) {
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const recent = await this.deps.db
        .select({startedAt: runs.startedAt})
        .from(runs)
        .where(and(eq(runs.agentId, args.agentId), gt(runs.startedAt, since)))
        .orderBy(asc(runs.startedAt))
        .limit(cap);
      if (recent.length >= cap) {
        // The oldest run in the window is the next to fall out of it.
        const freeAt = recent[0]!.startedAt.getTime() + 24 * 3600 * 1000;
        throw new PactoraError(
          ErrorCode.RATE_LIMITED,
          `this orchestrator has started ${cap} run${cap === 1 ? '' : 's'} in the last 24 hours, its limit — try again later`,
          Math.max(1, Math.ceil((freeAt - Date.now()) / 1000)),
        );
      }
    }

    const [run] = await this.deps.db
      .insert(runs)
      .values({
        chainId: args.chainId,
        agentId: args.agentId,
        goal: args.goal,
      })
      .returning();

    const runId = run!.id;
    void this.execute({...args, runId});
    return {runId, publicId: run!.publicId};
  }

  private async execute(args: {runId: number; agentId: number; apiKey: string; goal: string}) {
    const emit = (event: RunEvent) => this.record(args.runId, event);

    try {
      const result = await this.deps.execute({...args, emit});

      // The terminal event is recorded BEFORE the row leaves `running`.
      //
      // The state is what every reader treats as "this run is complete" — the
      // demo page, the SDK, a test polling for it. Setting it first opened a
      // window where a run reported itself done while its last event was
      // still being written, so anything that read the trace at that instant
      // got a story missing its ending. Rare, which is what makes it nasty:
      // it surfaced as one flaky test in four full runs.
      //
      // And the RESULT is written before either. A page reads the record the
      // moment `finished` arrives; with the answer and steps written after the
      // event, a page that won that race showed a finished run with no answer
      // and no step outcomes (seen live; runs.test.ts reproduces it). So:
      // result, then the terminal event, then the state.
      await this.deps.db
        .update(runs)
        .set({answer: result.answer, steps: result.steps, spent: result.spent})
        .where(eq(runs.id, args.runId));

      // Nothing delivered is a failed run, whatever else happened along the
      // way — it used to end `done` with no error and read as a success.
      const failure = failureOf(result);
      if (failure) {
        await emit({kind: 'failed', detail: failure, spent: result.spent});
        await this.deps.db
          .update(runs)
          .set({state: 'failed', error: failure, finishedAt: new Date()})
          .where(eq(runs.id, args.runId));
        return;
      }

      await emit({kind: 'finished', delivered: result.delivered, spent: result.spent});

      await this.deps.db
        .update(runs)
        .set({state: 'done', finishedAt: new Date()})
        .where(eq(runs.id, args.runId));
    } catch (err) {
      // A run that throws must still end in a state the page can render.
      // "Running forever" is the one outcome a viewer cannot interpret.
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.log?.(err, `run ${args.runId} failed`);

      // Same ordering as the success path, for the same reason: the terminal
      // event must be durable before the state says the run has ended.
      await emit({kind: 'failed', detail}).catch((e: unknown) =>
        this.deps.log?.(e, `run ${args.runId}: could not record its failure event`),
      );

      await this.deps.db
        .update(runs)
        .set({state: 'failed', error: detail, finishedAt: new Date()})
        .where(eq(runs.id, args.runId))
        .catch((e: unknown) =>
          this.deps.log?.(e, `run ${args.runId}: could not mark it failed — it will read as running`),
        );
    }
  }

  /** Persist first, then publish. The row is the record; the stream is a view of it. */
  private async record(runId: number, event: RunEvent): Promise<void> {
    const {kind, ...payload} = event;
    const [row] = await this.deps.db
      .insert(runEvents)
      .values({runId, kind, payload})
      .returning({id: runEvents.id});
    this.deps.bus.publish(runId, {event: kind, data: payload, ...(row ? {id: row.id} : {})});
  }
}
