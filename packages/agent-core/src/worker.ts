import {z} from 'zod';
import {PactoraError, ErrorCode, isX402Spec, type JobSpec} from '@pactora/shared';
import type {PactoraClient, JobSummary} from '@pactora/sdk';
import type {Brain} from './brain.js';
import {BrainInvalidOutput, MODEL_UNAVAILABLE, explainModelFailure} from './brain.js';
import {TRIAGE_SYSTEM, WORKER_SYSTEM, wrapUntrusted} from './prompts.js';
import {validateShape} from './judge.js';

/**
 * The worker side of the marketplace.
 *
 * One base class; a worker is then a capability, an output schema and a
 * sentence describing what it does. Everything below — polling for offers,
 * deciding whether to take one, producing a result, checking it before
 * delivering — is the same for every worker, and getting it right once is the
 * point.
 *
 * ## Declining is the strategy
 *
 * Reputation here is settlement-backed: a score only moves when a payment
 * settles on-chain, and a job accepted and failed is recorded as failed
 * forever. So a worker that accepts everything and fails one in five ranks
 * below one that accepts selectively and completes ~all of them.
 *
 * That is the incentive the protocol was built to create, and a worker that
 * did not actually exhibit it would make the whole claim decorative. So this
 * declines for two independent reasons:
 *
 *   1. **Structurally** — the client asked for output fields this worker
 *      cannot produce. Checked against the schema, no model involved, and it
 *      is not overridable.
 *   2. **By judgement** — the input is missing something the task needs.
 *
 * A declined job is not accepted, and the worker says so — off-chain, with its
 * reason, through the API. There is no "decline" transaction to pay for. The
 * client learns at once instead of after its accept window, cancels for a
 * refund and hires someone else; until 2026-10-07 a decline was silent, so a
 * run waited 45 s and then reported only "never accepted".
 */

/**
 * A confidence between 0 and 1, accepting the percentage models keep emitting.
 *
 * Asking for 0..1 and rejecting anything else is correct but loses real work:
 * the first live run had a worker produce a perfectly good report with
 * `confidence: 95`, fail its own schema, and deliver nothing — so the client
 * had paid and got a refund instead of a result. A value above 1 and at most
 * 100 is unambiguously a percentage, so it is read as one. Anything else still
 * fails, because it is not a confidence.
 */
export const confidence = () =>
  z.preprocess((v) => (typeof v === 'number' && v > 1 && v <= 100 ? v / 100 : v), z.number().min(0).max(1));

/** The worker could not think about the offer at all. Not a judgement on it. */
export class TriageUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TriageUnavailable';
  }
}

/**
 * What stands in the way of a job, if anything. Only the first three are
 * grounds to decline — enforced in code, like the spending caps, because live
 * a model refused research on a chain newer than its training three runs in
 * a row however the prompt was worded.
 */
export const BLOCKERS = [
  'none',
  'client_only_data',
  'impossible_action',
  'outside_capability',
  'missing_knowledge',
  'other',
] as const;
// Not `outside_capability`: offers are filtered to this worker's own
// capability before any model is asked, so a job it sees never is — a model
// saying so has read the client's wider goal (live, on Groq).
const DECLINABLE = new Set<string>(['client_only_data', 'impossible_action']);

export const TriageDecision = z.object({
  accept: z.boolean(),
  reason: z.string().min(1).max(300).describe('which condition failed, or why you can do this'),
  // Optional, so decisions recorded before it existed still replay.
  blocker: z
    .enum(BLOCKERS)
    .optional()
    .describe(
      'none; client_only_data (a private document, wallet or account only the client has and did not include — never public market data); impossible_action; outside_capability; missing_knowledge (the subject is newer than or beyond what you know); other',
    ),
});
export type TriageDecision = z.infer<typeof TriageDecision>;

export interface WorkerOptions<T> {
  client: PactoraClient;
  brain: Brain;
  /** The one capability this worker offers, lowercase kebab-case. */
  capability: string;
  /** How the worker describes itself to the model. One or two sentences. */
  role: string;
  /** The shape of a result. Producing to schema is what makes it valid by construction. */
  output: z.ZodType<T>;
  log?: (event: WorkerEvent) => void;
  /**
   * At most this many jobs taken per UTC day (2026-11-12). A hosted worker on
   * a paid model declines the rest before any model runs, with a reason, so
   * the client is refunded and the owner's credit is not spent. Unset: no cap.
   */
  maxJobsPerDay?: number;
  /** The clock, for tests. */
  now?: () => Date;
}

export type WorkerEvent =
  | {kind: 'offer'; jobId: string; capability: string}
  | {kind: 'declined'; jobId: string; reason: string; structural: boolean}
  | {kind: 'accepted'; jobId: string}
  | {kind: 'delivered'; jobId: string; provider: string; latencyMs: number}
  /** A listing job's draft round, posted for the client to review. */
  | {kind: 'drafted'; jobId: string; round: number; provider: string; latencyMs: number}
  /** A transient failure: the job is kept, and the stage is tried again next poll. */
  | {kind: 'retrying'; jobId: string; stage: string; reason: string}
  | {kind: 'failed'; jobId: string; stage: string; reason: string};

export type Outcome =
  | {status: 'declined'; reason: string}
  /** Wants the job, or holds it; the API asked it to retry. Tried again next poll. */
  | {status: 'waiting'; jobId: string; reason: string}
  | {status: 'delivered'; jobId: string}
  /** A listing job's draft round is posted; the client reviews it before anything is submitted. */
  | {status: 'drafted'; jobId: string; round: number}
  | {status: 'failed'; stage: string; reason: string};

export class Worker<T> {
  private readonly requiredKeys: Set<string>;

  /**
   * Jobs this worker has already refused.
   *
   * A decline leaves the job in `created`, so without this the very next poll
   * offers it again — and again. The first live run produced eighteen
   * identical refusals of one job in a few seconds, each costing a model call
   * on the judgement path. A decision already taken is not re-taken.
   */
  private readonly declined = new Set<string>();
  /** Jobs taken today (UTC), for `maxJobsPerDay`. */
  private takenToday = {day: '', count: 0};

  /**
   * Jobs this worker decided to take and has not yet been allowed to accept.
   * Kept so a retry goes straight to accept rather than asking the model the
   * same question again.
   */
  private readonly willing = new Set<string>();

  /**
   * Work produced and not yet delivered, because the submit failed in a way
   * the API said to retry. Kept so the retry is ONLY the submit: the job was
   * already accepted and the work already paid for in model time.
   */
  private readonly undelivered = new Map<string, {output: T; provider: string; latencyMs: number}>();

  /**
   * Listing jobs this worker has accepted. Such a job stays `accepted` across
   * many polls — draft, review, perhaps revise — and the API may still list
   * it as `created` until the indexer catches up; this keeps the worker from
   * trying to accept it again. A restart loses it, which is fine: by then the
   * listing says `accepted`, and the draft state is read from the API.
   */
  private readonly holding = new Set<string>();

  /** A listing job's produced draft whose post the API said to retry, keyed by the round it fills. */
  private readonly undrafted = new Map<
    string,
    {round: number; output: T; provider: string; latencyMs: number}
  >();

  constructor(private readonly opts: WorkerOptions<T>) {
    this.requiredKeys = keysOf(opts.output);
  }

  get capability(): string {
    return this.opts.capability;
  }

  /**
   * One pass: take every offered job and resolve it.
   *
   * Sequential on purpose. A worker with one wallet has one nonce, and two
   * accepts racing for it is a stuck transaction at exactly the wrong moment.
   */
  async tick(): Promise<Outcome[]> {
    // Not filtered by state.
    //
    // A fast-path job is `settled` from the instant it is created, because
    // the client has already paid — but the work still has to be done. A
    // worker polling only for `created` never saw those at all, so the client
    // paid and then waited for a result nobody was producing. What decides
    // whether there is work here is `hasResult`, not the payment state.
    const offers = await this.opts.client.listJobs({role: 'worker', limit: 25});
    const outcomes: Outcome[] = [];

    for (const offer of offers) {
      if (offer.spec.capability !== this.opts.capability) continue;
      // An x402 payment is delivered over HTTP, to the request that paid for
      // it, by `serveX402`. Producing it here as well would do the work twice
      // and race the HTTP handler to submit.
      if (isX402Spec(offer.spec)) continue;
      if (offer.hasResult) continue;
      if (offer.state === 'refunded' || offer.state === 'disputed') continue;
      if (this.declined.has(offer.jobId)) continue;
      outcomes.push(await this.handle(offer));
    }
    return outcomes;
  }

  /** Poll until stopped. `signal` is how a demo shuts a worker down cleanly. */
  async run(opts: {intervalMs?: number; signal?: AbortSignal} = {}): Promise<void> {
    const interval = opts.intervalMs ?? 1_000;

    while (!opts.signal?.aborted) {
      try {
        await this.tick();
      } catch (err) {
        // A worker that dies on a transient API error is a worker that misses
        // every offer after the first blip.
        this.emit({
          kind: 'failed',
          jobId: '-',
          stage: 'poll',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      await sleep(interval);
    }
  }

  async handle(offer: JobSummary): Promise<Outcome> {
    const pending = this.undelivered.get(offer.jobId);
    if (pending) return this.deliver(offer, pending);
    // Only this worker's jobs are listed (role: worker), so an ACCEPTED one is
    // a job it already holds — accepted by an earlier poll whose response was
    // lost, or by this worker before a restart. Triage is moot (it is
    // committed), and accepting again is refused as INVALID_STATE, which used
    // to make the worker abandon the job. Do the work.
    if (offer.state === 'accepted' || this.willing.has(offer.jobId) || this.holding.has(offer.jobId))
      return this.take(offer);
    return this.consider(offer);
  }

  private async consider(offer: JobSummary): Promise<Outcome> {
    this.emit({kind: 'offer', jobId: offer.jobId, capability: offer.spec.capability});

    const structural = this.canSatisfy(offer.spec);
    if (!structural.ok) {
      this.declined.add(offer.jobId);
      this.emit({kind: 'declined', jobId: offer.jobId, reason: structural.reason, structural: true});
      await this.tellClient(offer.jobId, structural.reason);
      return {status: 'declined', reason: structural.reason};
    }

    const cap = this.opts.maxJobsPerDay;
    if (cap !== undefined) {
      const day = (this.opts.now?.() ?? new Date()).toISOString().slice(0, 10);
      if (this.takenToday.day !== day) this.takenToday = {day, count: 0};
      if (this.takenToday.count >= cap) {
        const reason = `this agent takes at most ${cap} jobs a day and has reached that today; please try again tomorrow`;
        this.declined.add(offer.jobId);
        this.emit({kind: 'declined', jobId: offer.jobId, reason, structural: true});
        await this.tellClient(offer.jobId, reason);
        return {status: 'declined', reason};
      }
    }

    let decision: TriageDecision;
    try {
      decision = await this.triage(offer.spec);
    } catch (err) {
      this.declined.add(offer.jobId);
      this.emit({kind: 'failed', jobId: offer.jobId, stage: 'triage', reason: message(err)});
      // Still a "no" to the client — it must not wait on a worker that cannot
      // think — but worded as what it is: a fact about this worker.
      await this.tellClient(offer.jobId, explainModelFailure(err) ?? `${MODEL_UNAVAILABLE}: ${message(err)}`);
      return {status: 'failed', stage: 'triage', reason: message(err)};
    }
    // A refusal the policy does not allow is overruled: the worker takes the
    // job and delivers what it honestly can, caveated.
    if (!decision.accept && decision.blocker !== undefined && !DECLINABLE.has(decision.blocker)) {
      decision = {accept: true, reason: `taken despite: ${decision.reason}`, blocker: decision.blocker};
    }
    if (!decision.accept) {
      this.declined.add(offer.jobId);
      this.emit({kind: 'declined', jobId: offer.jobId, reason: decision.reason, structural: false});
      await this.tellClient(offer.jobId, decision.reason);
      return {status: 'declined', reason: decision.reason};
    }

    this.willing.add(offer.jobId);
    if (cap !== undefined) this.takenToday.count++;
    return this.take(offer);
  }

  private async take(offer: JobSummary): Promise<Outcome> {
    try {
      // Decided by PATH, not by state.
      //
      // A fast-path job is paid and terminal on chain the moment it is
      // created, but the API writes `state: created` optimistically until the
      // indexer catches up. Reading state therefore meant calling accept() on
      // an already-settled job: the contract reverted, this method returned
      // without emitting anything, and the job came back on the very next
      // poll — an invisible failure retried forever. `path` is fixed when the
      // job is created and does not lie.
      if (offer.path === 'escrow' && offer.state !== 'accepted' && !this.holding.has(offer.jobId))
        await this.opts.client.accept(offer.jobId);
    } catch (err) {
      // "Not confirmed on-chain yet — retry in a moment" is the API's answer
      // until the indexer links a fresh escrow job, and it says so with a
      // retry-after. This used to be treated like losing the race: marked
      // declined, never looked at again, while the client waited and then
      // cancelled. Keep the job; the next poll tries the accept again.
      if (err instanceof PactoraError && err.retryAfter !== undefined) {
        return {status: 'waiting', jobId: offer.jobId, reason: message(err)};
      }

      // Losing the race to accept is ordinary — the job may have expired or
      // been cancelled between the listing and now. It is not this worker's
      // fault, but it must be VISIBLE, and it must not be retried on every
      // poll for the rest of the run.
      this.willing.delete(offer.jobId);
      this.declined.add(offer.jobId);
      this.emit({kind: 'failed', jobId: offer.jobId, stage: 'accept', reason: message(err)});
      return {status: 'failed', stage: 'accept', reason: message(err)};
    }
    this.willing.delete(offer.jobId);
    if (offer.path === 'escrow' && offer.state !== 'accepted' && !this.holding.has(offer.jobId))
      this.emit({kind: 'accepted', jobId: offer.jobId});

    // A job hired from a listing is not delivered with a result: the work
    // goes up as a draft round the client reviews, and only the accepted
    // snapshot is submitted. A plain submit is refused (live, 2026-11-12:
    // the hosted bot accepted one, failed at submit, and the job stalled).
    if (isListingJob(offer)) {
      this.holding.add(offer.jobId);
      return this.draftRound(offer);
    }

    const startedAt = Date.now();
    let output: T;
    let provider: string;

    try {
      const produced = await this.produce(offer.spec);
      output = produced.output;
      provider = produced.provider;
    } catch (err) {
      // Accepted and could not deliver. The job expires at its work deadline,
      // the client is refunded, and this worker's score takes the hit — which
      // is the correct accounting. Nothing is submitted: a result that failed
      // its own schema is worse than no result, because the client would have
      // to read it to find out.
      this.emit({kind: 'failed', jobId: offer.jobId, stage: 'produce', reason: message(err)});
      return {status: 'failed', stage: 'produce', reason: message(err)};
    }

    // Check against what the CLIENT asked for, not only our own schema. The
    // two can differ, and the client's is the one the payment depends on.
    const shape = validateShape(output, offer.spec.outputSchema);
    if (!shape.ok) {
      this.emit({kind: 'failed', jobId: offer.jobId, stage: 'self-check', reason: shape.reason});
      return {status: 'failed', stage: 'self-check', reason: shape.reason};
    }

    return this.deliver(offer, {output, provider, latencyMs: Date.now() - startedAt});
  }

  /**
   * One poll of a listing job this worker holds. What to do is read from the
   * API's draft state every time — never from memory — so a restart, a lost
   * response or a second poll during review cannot post a duplicate draft.
   */
  private async draftRound(offer: JobSummary): Promise<Outcome> {
    const {jobId} = offer;
    let state: Awaited<ReturnType<PactoraClient['getDrafts']>>;
    try {
      state = await this.opts.client.getDrafts(jobId);
    } catch (err) {
      // Kept: the next poll reads the state again.
      this.emit({kind: 'retrying', jobId, stage: 'drafts', reason: message(err)});
      return {status: 'waiting', jobId, reason: message(err)};
    }

    switch (state.phase) {
      case 'awaiting_review':
        return {status: 'waiting', jobId, reason: 'the draft is awaiting the client’s review'};
      case 'dispute_intent':
        return {status: 'waiting', jobId, reason: 'the client intends to dispute the draft'};
      case 'accepted':
        return this.submitAccepted(offer);
      case 'none':
      case 'revise':
        break;
    }

    const round = state.drafts.length + 1;
    let work = this.undrafted.get(jobId);
    if (!work || work.round !== round) {
      const latest = state.drafts.at(-1);
      const revision = state.phase === 'revise' ? (latest?.review?.reason ?? '') : undefined;
      const startedAt = Date.now();
      let produced: {output: T; provider: string};
      try {
        produced = await this.produce(offer.spec, revision);
      } catch (err) {
        this.emit({kind: 'failed', jobId, stage: 'produce', reason: message(err)});
        return {status: 'failed', stage: 'produce', reason: message(err)};
      }
      const shape = validateShape(produced.output, offer.spec.outputSchema);
      if (!shape.ok) {
        this.emit({kind: 'failed', jobId, stage: 'self-check', reason: shape.reason});
        return {status: 'failed', stage: 'self-check', reason: shape.reason};
      }
      work = {round, ...produced, latencyMs: Date.now() - startedAt};
    }

    const output = work.output as Record<string, unknown>;
    try {
      await this.opts.client.submitDraft(jobId, {text: draftText(output), output});
    } catch (err) {
      if (err instanceof PactoraError && err.retryAfter !== undefined) {
        this.undrafted.set(jobId, work);
        this.emit({kind: 'retrying', jobId, stage: 'draft', reason: message(err)});
        return {status: 'waiting', jobId, reason: message(err)};
      }
      this.undrafted.delete(jobId);
      this.holding.delete(jobId);
      this.declined.add(jobId);
      this.emit({kind: 'failed', jobId, stage: 'draft', reason: message(err)});
      return {status: 'failed', stage: 'draft', reason: message(err)};
    }
    this.undrafted.delete(jobId);
    this.emit({kind: 'drafted', jobId, round, provider: work.provider, latencyMs: work.latencyMs});
    return {status: 'drafted', jobId, round};
  }

  /** Deliver a listing job: its accepted draft snapshot is the result, so no output is sent. */
  private async submitAccepted(offer: JobSummary): Promise<Outcome> {
    const {jobId} = offer;
    const startedAt = Date.now();
    try {
      await this.opts.client.submitResult(jobId);
    } catch (err) {
      if (err instanceof PactoraError && err.retryAfter !== undefined) {
        this.emit({kind: 'retrying', jobId, stage: 'submit', reason: message(err)});
        return {status: 'waiting', jobId, reason: message(err)};
      }
      this.holding.delete(jobId);
      this.declined.add(jobId);
      this.emit({kind: 'failed', jobId, stage: 'submit', reason: message(err)});
      return {status: 'failed', stage: 'submit', reason: message(err)};
    }
    this.holding.delete(jobId);
    this.emit({kind: 'delivered', jobId, provider: 'accepted-draft', latencyMs: Date.now() - startedAt});
    return {status: 'delivered', jobId};
  }

  /**
   * Submit produced work.
   *
   * A failure here used to return silently, and the job came back on the next
   * poll looking like a fresh offer — so the worker tried to accept a job it
   * already held, was refused, and abandoned finished work. Now a transient
   * failure keeps the work and retries only this step; any other failure is
   * reported and the job is let go.
   */
  private async deliver(
    offer: JobSummary,
    work: {output: T; provider: string; latencyMs: number},
  ): Promise<Outcome> {
    try {
      await this.opts.client.submitResult(offer.jobId, {
        output: work.output as Record<string, unknown>,
      });
    } catch (err) {
      if (err instanceof PactoraError && err.retryAfter !== undefined) {
        this.undelivered.set(offer.jobId, work);
        this.emit({kind: 'retrying', jobId: offer.jobId, stage: 'submit', reason: message(err)});
        return {status: 'waiting', jobId: offer.jobId, reason: message(err)};
      }
      this.undelivered.delete(offer.jobId);
      this.declined.add(offer.jobId);
      this.emit({kind: 'failed', jobId: offer.jobId, stage: 'submit', reason: message(err)});
      return {status: 'failed', stage: 'submit', reason: message(err)};
    }

    this.undelivered.delete(offer.jobId);
    this.emit({
      kind: 'delivered',
      jobId: offer.jobId,
      provider: work.provider,
      latencyMs: work.latencyMs,
    });
    return {status: 'delivered', jobId: offer.jobId};
  }

  /**
   * Tell the client this worker will not take the job, and why. Best effort:
   * if the API is unreachable the client still has its accept window, so a
   * failure here is reported and the worker moves on.
   */
  private async tellClient(jobId: string, reason: string): Promise<void> {
    try {
      await this.opts.client.decline(jobId, reason.slice(0, 500));
    } catch (err) {
      this.emit({kind: 'failed', jobId, stage: 'decline', reason: message(err)});
    }
  }

  /**
   * Can this worker produce every field the client requires?
   *
   * Structural, deterministic, and checked before any model is asked — a
   * worker that cannot produce `sources` should decline a job that requires
   * `sources`, not accept it and hope. No prompt can talk it out of this.
   */
  canSatisfy(spec: JobSpec): {ok: true} | {ok: false; reason: string} {
    const required = Array.isArray(spec.outputSchema?.['required'])
      ? (spec.outputSchema['required'] as string[])
      : [];

    const missing = required.filter((key) => !this.requiredKeys.has(key));
    return missing.length === 0
      ? {ok: true}
      : {
          ok: false,
          reason: `this agent does not produce ${missing.join(', ')} — declining rather than delivering a result that cannot be accepted`,
        };
  }

  /** Should this job be taken at all? */
  private async triage(spec: JobSpec): Promise<TriageDecision> {
    const required = Array.isArray(spec.outputSchema?.['required'])
      ? (spec.outputSchema['required'] as string[])
      : [];

    const prompt = [
      `You are: ${this.opts.role}`,
      `You offer exactly one capability: ${this.opts.capability}`,
      `You always produce these fields: ${[...this.requiredKeys].join(', ')}`,
      required.length > 0
        ? `This job additionally requires: ${required.join(', ')}`
        : 'This job states no required output shape, so your own schema governs.',
      '',
      'The job offer:',
      // The spec was written by another agent. Wrapped for the same reason a
      // result is: a "task" that tells the worker to ignore its own rules is
      // an injection with a different label.
      wrapUntrusted(spec),
      '',
      'Accept this job?',
    ].join('\n');

    try {
      const {value} = await this.opts.brain.complete({
        schema: TriageDecision,
        schemaName: 'TriageDecision',
        system: TRIAGE_SYSTEM,
        prompt,
        maxTokens: 400,
        effort: 'low',
        // The client waits 45 s for an accept. A model that hangs must give
        // way to the next one in the chain well inside that.
        timeoutMs: TRIAGE_TIMEOUT_MS,
      });
      return value;
    } catch (err) {
      // Not a decline.
      //
      // This used to return `{accept: false}`, so a worker whose model was
      // unreachable reported, job after job, that it had considered the work
      // and chosen not to take it. A decline is a claim about the JOB; this
      // is a fact about the WORKER, and only one of them is the operator's to
      // fix. Reading an outage as caution cost an hour on a cached run where
      // every recording was simply missing.
      //
      // It still does not accept — taking work it cannot think about is how a
      // reputation is lost — but it says which of the two happened.
      throw new TriageUnavailable(message(err));
    }
  }

  /**
   * Do the work for an input that did not arrive as a job offer — an x402
   * request, paid for before it reached here. No triage: the payment is the
   * decision. The result is still produced to this worker's schema.
   */
  async answer(input: Record<string, unknown>): Promise<{output: T; provider: string}> {
    return this.produce({capability: this.opts.capability, input, deadlineSeconds: 120});
  }

  /** Do the work, to schema. */
  private async produce(spec: JobSpec, revision?: string): Promise<{output: T; provider: string}> {
    const prompt = [
      `You are: ${this.opts.role}`,
      '',
      'The task:',
      wrapUntrusted(spec.input),
      '',
      // The client's review of the previous draft. Written by the other
      // party, so wrapped like the task: what it asks for, not orders.
      ...(revision !== undefined
        ? [
            'The client reviewed your previous draft and asked for a revision, saying:',
            wrapUntrusted(revision || '(no reason given)'),
            '',
            'Produce the revised result.',
          ]
        : ['Produce the result.']),
    ].join('\n');

    const {value, provider} = await this.opts.brain.complete({
      schema: this.opts.output,
      schemaName: 'Result',
      system: WORKER_SYSTEM,
      prompt,
      maxTokens: 2_000,
      effort: 'low',
    });

    return {output: value, provider};
  }

  private emit(event: WorkerEvent): void {
    this.opts.log?.(event);
  }
}

/**
 * Whether a job was hired from a listing (docs/26 F4). The API lists it with
 * `listingId`; the spec carries `input.listing.listingId`, which is what the
 * API itself reads (read-model `listingOfSpec`).
 */
export function isListingJob(offer: JobSummary): boolean {
  const fromApi = (offer as {listingId?: unknown}).listingId;
  if (typeof fromApi === 'string' && fromApi.length > 0) return true;
  const l = (offer.spec?.input as {listing?: {listingId?: unknown}} | undefined)?.listing;
  return typeof l?.listingId === 'string' && l.listingId.length > 0;
}

/**
 * A draft's readable text: the output's summary if it has one, else its
 * pretty JSON — 10..10000 characters, as the API requires.
 */
export function draftText(output: Record<string, unknown>): string {
  const summary = typeof output['summary'] === 'string' ? output['summary'].trim() : '';
  let text = summary.length >= 10 ? summary : JSON.stringify(output, null, 2);
  if (text.length > 10_000) text = `${text.slice(0, 9_999)}…`;
  return text.length >= 10 ? text : `Result: ${text}`.padEnd(10, '.');
}

/** The top-level field names a schema produces. */
function keysOf(schema: z.ZodType): Set<string> {
  // A refine keeps the object's own type in zod 4; a transform wraps it in a pipe.
  const unwrapped: z.ZodType = schema instanceof z.ZodPipe ? (schema.in as z.ZodType) : schema;
  return unwrapped instanceof z.ZodObject
    ? new Set(Object.keys((unwrapped as z.ZodObject<z.ZodRawShape>).shape))
    : new Set<string>();
}

function message(err: unknown): string {
  if (err instanceof PactoraError) return `${err.code}: ${err.detail ?? ''}`.trim();
  if (err instanceof BrainInvalidOutput) return `invalid model output: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per model call while deciding on an offer; the client's accept window is 45 s. */
const TRIAGE_TIMEOUT_MS = 15_000;

export {ErrorCode};
