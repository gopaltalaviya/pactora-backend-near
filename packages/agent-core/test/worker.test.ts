import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {PactoraError, ErrorCode, type JobSpec} from '@pactora/shared';
import type {PactoraClient, JobSummary} from '@pactora/sdk';
import {
  BrainUnavailable,
  UNTRUSTED_OPEN,
  Worker,
  confidence,
  draftText,
  type Brain,
  type CompletionRequest,
  type CompletionResult,
  type WorkerEvent,
} from '../src/index.js';

/**
 * The worker loop.
 *
 * The behaviour worth testing here is not "can it call an API" — it is the
 * economics. Reputation is settlement-backed, so an accepted-and-failed job is
 * recorded forever, and a worker that accepts everything ranks below one that
 * accepts selectively. These assert that the worker actually declines, that it
 * declines for a structural reason no prompt can argue with, and that it never
 * delivers a result it has already found wanting.
 */

/**
 * `sources` is OPTIONAL on purpose. The worker CAN produce it, so a client
 * requiring it passes triage — and if the model then omits it, only the
 * self-check stands between that and a delivered result the client must pay
 * to read. That gap is what the self-check test below exercises.
 */
const Output = z.object({
  summary: z.string(),
  confidence: z.number(),
  sources: z.array(z.string()).optional(),
});

class FakeBrain implements Brain {
  readonly name = 'fake';
  readonly prompts: string[] = [];
  readonly timeouts: (number | undefined)[] = [];

  constructor(
    private readonly replies: {triage?: unknown; result?: unknown} = {},
    private readonly failOn?: 'triage' | 'result',
  ) {}

  async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
    this.prompts.push(req.prompt);
    this.timeouts.push(req.timeoutMs);
    const which = req.schemaName === 'TriageDecision' ? 'triage' : 'result';
    if (this.failOn === which) throw new Error(`${which} unavailable`);

    const reply =
      which === 'triage'
        ? (this.replies.triage ?? {accept: true, reason: 'within my capability'})
        : (this.replies.result ?? {summary: 'NEAR/USDC depth is healthy', confidence: 0.8});

    return {value: req.schema.parse(reply), provider: 'fake', model: 'fake', cached: false};
  }
  async available() {
    return true;
  }
}

interface Calls {
  accepted: string[];
  submitted: {jobId: string; output: Record<string, unknown> | undefined}[];
  submitAttempts: number;
  declined: {jobId: string; reason: string}[];
  /** Draft rounds posted (listing jobs). Optional so older call sites still build. */
  drafts?: {jobId: string; text: string; output: Record<string, unknown> | undefined}[];
}

/** What the API's draft rounds look like for one job, as the fake serves them. */
interface DraftBook {
  phase: 'none' | 'awaiting_review' | 'revise' | 'accepted' | 'dispute_intent';
  rounds: {round: number; text: string; review: {decision: string; reason: string} | null}[];
}

interface ClientFaults {
  acceptThrows?: unknown;
  acceptThrowsOnce?: unknown;
  submitThrowsOnce?: unknown;
  declineThrows?: unknown;
  /** Per-job draft state; a listing job refuses submitResult until its draft is accepted. */
  draftBook?: Map<string, DraftBook>;
}

function fakeClient(offers: JobSummary[], calls: Calls, over: ClientFaults = {}): PactoraClient {
  let thrownOnce = false;
  let submitThrown = false;
  return {
    listJobs: async () => offers,
    decline: async (jobId: string, reason: string) => {
      if (over.declineThrows) throw over.declineThrows;
      calls.declined.push({jobId, reason});
      return {jobId, declined: {reason, at: new Date().toISOString()}};
    },
    accept: async (jobId: string) => {
      if (over.acceptThrows) throw over.acceptThrows;
      if (over.acceptThrowsOnce && !thrownOnce) {
        thrownOnce = true;
        throw over.acceptThrowsOnce;
      }
      calls.accepted.push(jobId);
      return {jobId, chainId: 'near:testnet', state: 'accepted', txHash: '0x', explorerUrl: 'u'};
    },
    submitResult: async (jobId: string, result?: {output: Record<string, unknown>}) => {
      calls.submitAttempts++;
      if (over.submitThrowsOnce && !submitThrown) {
        submitThrown = true;
        throw over.submitThrowsOnce;
      }
      // What the API does: a listing job delivers its accepted draft, nothing else.
      const book = over.draftBook?.get(jobId);
      if (book && (result !== undefined || book.phase !== 'accepted')) {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          'a listing job is submitted from an accepted draft: POST /v1/jobs/:id/drafts, then the client reviews it with accept_draft',
        );
      }
      calls.submitted.push({jobId, output: result?.output});
      return {jobId, chainId: 'near:testnet', state: 'submitted', txHash: '0x', explorerUrl: 'u'};
    },
    submitDraft: async (jobId: string, draft: {text: string; output?: Record<string, unknown>}) => {
      const book = over.draftBook?.get(jobId);
      if (!book) throw new PactoraError(ErrorCode.INVALID_STATE, 'drafts are for listing jobs');
      if (book.phase !== 'none' && book.phase !== 'revise') {
        throw new PactoraError(ErrorCode.INVALID_STATE, `a draft is not expected in phase ${book.phase}`);
      }
      if (draft.text.length < 10 || draft.text.length > 10_000) {
        throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, 'text must be 10..10000 characters');
      }
      (calls.drafts ??= []).push({jobId, text: draft.text, output: draft.output});
      const round = book.rounds.length + 1;
      book.rounds.push({round, text: draft.text, review: null});
      book.phase = 'awaiting_review';
      return {
        jobId,
        phase: book.phase,
        draftId: `d${round}`,
        round,
        snapshotHash: `h${round}`,
        replayed: false,
      };
    },
    getDrafts: async (jobId: string) => {
      const book = over.draftBook?.get(jobId) ?? {phase: 'none', rounds: []};
      return {
        jobId,
        role: 'worker',
        phase: book.phase,
        revisionsUsed: 0,
        revisionsLeft: 3,
        acceptedSnapshotHash: null,
        acceptedReviewHash: null,
        readyToApprove: false,
        resultMismatch: false,
        drafts: book.rounds.map((r) => ({
          draftId: `d${r.round}`,
          round: r.round,
          snapshotHash: `h${r.round}`,
          snapshot: {text: r.text},
          createdAt: new Date().toISOString(),
          review: r.review,
        })),
      };
    },
  } as unknown as PactoraClient;
}

function offer(over: Partial<JobSpec> = {}, jobId = '1'): JobSummary {
  return {
    jobId,
    chainJobId: jobId,
    chainId: 'near:testnet',
    state: 'created',
    path: 'escrow',
    amount: '20000',
    amountDisplay: '0.02 USDC',
    spec: {
      capability: 'market-research',
      input: {question: 'how deep is NEAR/USDC?'},
      deadlineSeconds: 120,
      ...over,
    },
    specHash: '',
    role: 'worker',
    hasResult: false,
    clientAgentId: '1',
    workerAgentId: '2',
    createdAt: new Date().toISOString(),
  };
}

function build(
  offers: JobSummary[],
  brain: Brain,
  over: ClientFaults = {},
): {worker: Worker<z.infer<typeof Output>>; calls: Calls; events: WorkerEvent[]} {
  const calls: Calls = {accepted: [], submitted: [], submitAttempts: 0, declined: [], drafts: []};
  const events: WorkerEvent[] = [];
  const worker = new Worker({
    client: fakeClient(offers, calls, over),
    brain,
    capability: 'market-research',
    role: 'a market research agent that reports order book depth',
    output: Output,
    log: (e) => events.push(e),
  });
  return {worker, calls, events};
}

describe('declining, which is the reputation strategy', () => {
  /**
   * Structural and non-negotiable: the client requires a field this worker
   * does not produce. Accepting would guarantee a dispute.
   */
  it('declines a job asking for output it cannot produce, before any model runs', async () => {
    const brain = new FakeBrain();
    const {worker, calls, events} = build(
      [offer({outputSchema: {type: 'object', required: ['summary', 'chart', 'appendix']}})],
      brain,
    );

    const [outcome] = await worker.tick();

    expect(outcome).toMatchObject({status: 'declined'});
    expect(calls.accepted).toEqual([]);
    // The decisive part: no tokens were spent deciding this.
    expect(brain.prompts).toEqual([]);
    expect(events.find((e) => e.kind === 'declined')).toMatchObject({structural: true});
  });

  it('names the fields it cannot produce, so the client can retarget', async () => {
    const {worker} = build(
      [offer({outputSchema: {type: 'object', required: ['summary', 'chart']}})],
      new FakeBrain(),
    );
    const [outcome] = await worker.tick();
    expect(outcome).toMatchObject({status: 'declined', reason: expect.stringContaining('chart')});
  });

  /**
   * An optional field the worker CAN produce is not grounds to decline — the
   * conservative reading would have it refusing work it is able to do.
   */
  it('does not decline over a field it can produce but does not always fill', async () => {
    const brain = new FakeBrain({
      result: {summary: 'depth is healthy', confidence: 0.8, sources: ['binance']},
    });
    const {worker, calls} = build([offer({outputSchema: {type: 'object', required: ['sources']}})], brain);

    expect(await worker.tick()).toEqual([{status: 'delivered', jobId: '1'}]);
    expect(calls.submitted).toHaveLength(1);
  });

  it('accepts when it can produce everything required', async () => {
    const {worker, calls} = build(
      [offer({outputSchema: {type: 'object', required: ['summary']}})],
      new FakeBrain(),
    );
    const [outcome] = await worker.tick();

    expect(outcome).toMatchObject({status: 'delivered'});
    expect(calls.accepted).toEqual(['1']);
  });

  it('declines on judgement when the input is not workable', async () => {
    const brain = new FakeBrain({triage: {accept: false, reason: 'no market named in the input'}});
    const {worker, calls} = build([offer()], brain);

    const [outcome] = await worker.tick();
    expect(outcome).toMatchObject({status: 'declined', reason: 'no market named in the input'});
    expect(calls.accepted).toEqual([]);
  });

  /**
   * Fail closed. A worker that accepts work it could not even evaluate has
   * bet its reputation on a coin flip.
   *
   * It used to report this as `declined`, which is what this test asserted —
   * so an unreachable model looked exactly like a cautious one. The
   * invariant that matters is that it does not ACCEPT; what it is called is
   * covered by "when the worker's own brain is the problem" below.
   */
  it('never accepts when triage itself fails', async () => {
    const {worker, calls} = build([offer()], new FakeBrain({}, 'triage'));

    const [outcome] = await worker.tick();
    expect(outcome!.status).not.toBe('delivered');
    expect(calls.accepted).toEqual([]);
  });
});

describe('delivering', () => {
  it('submits a result that satisfies the client schema', async () => {
    const {worker, calls} = build([offer()], new FakeBrain());
    await worker.tick();

    expect(calls.submitted).toHaveLength(1);
    expect(calls.submitted[0]!.output).toMatchObject({summary: expect.any(String)});
  });

  /**
   * The check that stops a worker being paid for something it already knows
   * is wrong — and stops the client having to read it to find out.
   */
  it('refuses to submit output that fails the client schema', async () => {
    // The worker can produce `sources`, so triage lets this through — and
    // then the model omits it.
    const brain = new FakeBrain({result: {summary: 'ok', confidence: 0.5}});
    const {worker, calls} = build(
      [offer({outputSchema: {type: 'object', required: ['summary', 'sources']}})],
      brain,
    );

    const [outcome] = await worker.tick();

    expect(outcome).toMatchObject({status: 'failed', stage: 'self-check'});
    expect(calls.submitted).toEqual([]);
  });

  it('submits nothing when the work itself fails', async () => {
    const {worker, calls, events} = build([offer()], new FakeBrain({}, 'result'));

    const [outcome] = await worker.tick();
    expect(outcome).toMatchObject({status: 'failed', stage: 'produce'});
    expect(calls.submitted).toEqual([]);
    // Accepted and then failed: the score takes the hit, which is correct.
    expect(calls.accepted).toEqual(['1']);
    expect(events.some((e) => e.kind === 'failed')).toBe(true);
  });

  /**
   * Losing the race to accept — the job expired, or the client cancelled — is
   * ordinary, not a fault of this worker, and it must not lead to work being
   * done for a job nobody is holding money for.
   */
  it('stops at the accept stage when the job is already gone', async () => {
    const brain = new FakeBrain();
    const {worker, calls} = build([offer()], brain, {
      acceptThrows: new PactoraError(ErrorCode.INVALID_STATE, 'job is no longer created'),
    });

    const [outcome] = await worker.tick();
    expect(outcome).toMatchObject({status: 'failed', stage: 'accept'});
    expect(calls.submitted).toEqual([]);
    // Triage ran; producing did not.
    expect(brain.prompts).toHaveLength(1);
  });
});

describe('confidence', () => {
  /**
   * The first live run had a worker produce a good report with
   * `confidence: 95`, fail its own schema, and deliver nothing — so the
   * client had paid and received a refund instead of a result.
   */
  it('reads a percentage as the fraction it obviously is', () => {
    expect(confidence().parse(95)).toBe(0.95);
    expect(confidence().parse(100)).toBe(1);
  });

  it('leaves a fraction alone', () => {
    expect(confidence().parse(0.8)).toBe(0.8);
    expect(confidence().parse(1)).toBe(1);
    expect(confidence().parse(0)).toBe(0);
  });

  it('still refuses something that is not a confidence at all', () => {
    expect(confidence().safeParse(-1).success).toBe(false);
    expect(confidence().safeParse(101).success).toBe(false);
    expect(confidence().safeParse('high').success).toBe(false);
  });
});

describe('the fast path', () => {
  /**
   * A direct-pay job is settled on chain the moment it is created, but the
   * API writes `state: created` optimistically until the indexer catches up.
   * Deciding from state therefore called accept() on an already-terminal job,
   * the contract reverted, and handle() returned WITHOUT emitting anything —
   * so the failure was invisible and the job was retried on every poll,
   * forever. `path` is set at creation and does not lie.
   */
  it('does not try to accept a job that was already paid', async () => {
    const {worker, calls} = build([{...offer(), path: 'direct'}], new FakeBrain());

    const [outcome] = await worker.tick();
    expect(calls.accepted, 'a fast-path job must not be accepted').toEqual([]);
    expect(outcome).toMatchObject({status: 'delivered'});
    expect(calls.submitted).toHaveLength(1);
  });

  it('still accepts an escrow job', async () => {
    const {worker, calls} = build([{...offer(), path: 'escrow'}], new FakeBrain());
    await worker.tick();
    expect(calls.accepted).toEqual(['1']);
  });

  /** A failure to accept must be visible, and must not be retried forever. */
  it('reports a failed accept and gives up on that job', async () => {
    const {worker, calls, events} = build([{...offer(), path: 'escrow'}], new FakeBrain(), {
      acceptThrows: new PactoraError(ErrorCode.INVALID_STATE, 'job is no longer created'),
    });

    await worker.tick();
    expect(
      events.some((e) => e.kind === 'failed'),
      'the failure must be logged',
    ).toBe(true);

    // A second poll must not re-offer it.
    const second = await worker.tick();
    expect(second).toEqual([]);
    expect(calls.submitted).toEqual([]);
  });
});

describe('what the worker shows a model', () => {
  /**
   * A job spec is written by another agent. A "task" instructing the worker to
   * ignore its own rules is an injection wearing a different label, so the
   * spec is wrapped exactly like a result is.
   */
  it('wraps the job spec as untrusted in both the triage and the work prompt', async () => {
    const brain = new FakeBrain();
    const {worker} = build([offer()], brain);
    await worker.tick();

    expect(brain.prompts).toHaveLength(2);
    for (const prompt of brain.prompts) expect(prompt).toContain(UNTRUSTED_OPEN);
  });
});

describe('the offer loop', () => {
  it('ignores offers for a capability it does not provide', async () => {
    const brain = new FakeBrain();
    const {worker, calls} = build([offer({capability: 'trade-execution'})], brain);

    expect(await worker.tick()).toEqual([]);
    expect(calls.accepted).toEqual([]);
    expect(brain.prompts).toEqual([]);
  });

  it('works through every matching offer in one pass', async () => {
    const {worker, calls} = build([offer({}, '1'), offer({}, '2')], new FakeBrain());

    expect(await worker.tick()).toHaveLength(2);
    expect(calls.submitted.map((s) => s.jobId)).toEqual(['1', '2']);
  });
});

describe('when the worker\u2019s own brain is the problem', () => {
  /**
   * Triage caught every error and returned `{accept: false, reason: 'could
   * not evaluate the offer'}` — a DECLINE. So a worker whose model was
   * unreachable reported, job after job, that it had considered the work and
   * chosen not to take it.
   *
   * Those two are not the same thing and must not look the same. A decline
   * is a claim about the JOB; this is a fact about the WORKER, and it is the
   * operator's problem to fix. A cached demo run spent an hour being read as
   * a cautious model when every recording was simply missing — the same
   * shape of mistake as the swallowed indexer error, an outage wearing
   * business logic as a costume.
   *
   * The worker still does not accept: taking work it cannot think about is
   * how a reputation is lost. But it says which of the two happened.
   */
  it('reports an unusable brain as a failure, not as a decision about the job', async () => {
    const {worker, calls, events} = build([offer({})], new FakeBrain({}, 'triage'));

    const [outcome] = await worker.tick();

    expect(outcome!.status).toBe('failed');
    expect(calls.accepted).toEqual([]);
    const failure = events.find((e) => e.kind === 'failed');
    expect(failure).toBeDefined();
    expect((failure as {stage: string}).stage).toBe('triage');
  });

  it('carries the underlying reason, so the operator can act on it', async () => {
    const {worker, events} = build([offer({})], new FakeBrain({}, 'triage'));

    await worker.tick();

    const failure = events.find((e) => e.kind === 'failed') as {reason: string};
    expect(failure.reason).toMatch(/unavailable/);
  });

  it('does not retry it on the next poll', async () => {
    const brain = new FakeBrain({}, 'triage');
    const {worker} = build([offer({})], brain);

    await worker.tick();
    await worker.tick();

    expect(brain.prompts).toHaveLength(1);
  });

  it('still reports a genuine decline as a decline', async () => {
    const {worker, events} = build(
      [offer({})],
      new FakeBrain({triage: {accept: false, reason: 'the input has no market data'}}),
    );

    const [outcome] = await worker.tick();

    expect(outcome!.status).toBe('declined');
    expect(events.some((e) => e.kind === 'declined')).toBe(true);
    expect(events.some((e) => e.kind === 'failed')).toBe(false);
  });
});

describe('an accept the API says to retry', () => {
  /**
   * "The job is not confirmed on-chain yet — retry in a moment" is the API's
   * answer until the indexer links an escrow job, a second or two after the
   * hire. The worker treated it like losing the race for the job: marked it
   * declined and never looked at it again. A live chaos run showed it — a
   * healthy worker abandoned a job it wanted, the client cancelled it 45s
   * later, and the step failed with nobody at fault but the worker's reading
   * of an error that said, in words, to retry.
   */
  const notYet = new PactoraError(
    ErrorCode.INVALID_STATE,
    'the job is not confirmed on-chain yet — retry in a moment',
    2,
  );

  it('tries again on the next poll, and delivers', async () => {
    const {worker, calls} = build([offer({})], new FakeBrain(), {acceptThrowsOnce: notYet});

    await worker.tick();
    expect(calls.accepted).toEqual([]);
    await worker.tick();

    expect(calls.accepted).toEqual(['1']);
    expect(calls.submitted.map((s) => s.jobId)).toEqual(['1']);
  });

  it('does not ask the model again about a job it already decided to take', async () => {
    const brain = new FakeBrain();
    const {worker} = build([offer({})], brain, {acceptThrowsOnce: notYet});

    await worker.tick();
    const afterFirst = brain.prompts.length;
    await worker.tick();

    // One more call — producing the work — not a second triage.
    expect(brain.prompts.length).toBe(afterFirst + 1);
  });

  it('still gives up on a refusal that is not transient', async () => {
    const lost = new PactoraError(ErrorCode.INVALID_STATE, 'job is "refunded", this action needs "created"');
    const {worker, calls} = build([offer({})], new FakeBrain(), {acceptThrowsOnce: lost});

    await worker.tick();
    await worker.tick();

    expect(calls.accepted).toEqual([]);
  });
});

describe('a delivery the chain did not take the first time', () => {
  /**
   * Found by the slow-RPC chaos run on v2. The signer's submit hit an RPC
   * 503; the API reported it as retryable; the worker returned "failed at
   * submit" WITHOUT emitting anything. The next poll listed the job again —
   * still undelivered — so the worker treated it as a fresh offer, tried to
   * accept a job it already held, got INVALID_STATE, and abandoned work it had
   * already produced. The client waited out the work window for a refund.
   */
  const upstream = new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'the signer answered 502', 2);

  it('reports a retryable submit failure and retries only the submit on the next poll', async () => {
    const brain = new FakeBrain();
    const job = offer({});
    const {worker, calls, events} = build([job], brain, {submitThrowsOnce: upstream});

    await worker.tick();
    expect(calls.accepted).toEqual(['1']);
    expect(calls.submitted).toEqual([]);
    expect(events.some((e) => e.kind === 'retrying' && e.stage === 'submit')).toBe(true);

    // What the API lists after the accept landed.
    job.state = 'accepted';
    const promptsBefore = brain.prompts.length;
    await worker.tick();

    expect(calls.accepted).toEqual(['1']); // not accepted twice
    expect(calls.submitted.map((c) => c.jobId)).toEqual(['1']);
    expect(brain.prompts.length).toBe(promptsBefore); // the work was not redone
    expect(events.at(-1)?.kind).toBe('delivered');
  });

  it('delivers a job it already accepted instead of trying to accept it again', async () => {
    const job = offer({});
    job.state = 'accepted';
    const {worker, calls, events} = build([job], new FakeBrain());

    await worker.tick();

    expect(calls.accepted).toEqual([]);
    expect(calls.submitted.map((c) => c.jobId)).toEqual(['1']);
    expect(events.some((e) => e.kind === 'failed')).toBe(false);
  });

  it('reports a submit refusal that is not transient, and does not retry it', async () => {
    const refused = new PactoraError(
      ErrorCode.INVALID_STATE,
      'job is "refunded", this action needs "accepted"',
    );
    const {worker, calls, events} = build([offer({})], new FakeBrain(), {submitThrowsOnce: refused});

    await worker.tick();
    await worker.tick();

    expect(events.some((e) => e.kind === 'failed' && e.stage === 'submit')).toBe(true);
    expect(calls.submitAttempts).toBe(1);
    expect(calls.accepted).toEqual(['1']);
  });
});

/**
 * A decline used to be silent: the job sat in `created`, the client waited out
 * its accept window (45 s) and the run said only "never accepted". The client
 * deserves the reason, at once, so it can hire someone else.
 */
describe('telling the client', () => {
  it('reports a judgement decline to the API, with its reason', async () => {
    const brain = new FakeBrain({triage: {accept: false, reason: 'asks for a private wallet export'}});
    const {worker, calls} = build([offer()], brain);

    await worker.tick();
    expect(calls.declined).toEqual([{jobId: '1', reason: 'asks for a private wallet export'}]);
    expect(calls.accepted).toEqual([]);
  });

  it('reports a structural decline too', async () => {
    const {worker, calls} = build(
      [offer({outputSchema: {type: 'object', required: ['summary', 'chart']}})],
      new FakeBrain(),
    );
    await worker.tick();
    expect(calls.declined).toHaveLength(1);
    expect(calls.declined[0]!.reason).toContain('chart');
  });

  it('declines with the cause when its own model cannot be reached', async () => {
    const {worker, calls} = build([offer()], new FakeBrain({}, 'triage'));

    const [outcome] = await worker.tick();
    expect(outcome).toMatchObject({status: 'failed', stage: 'triage'});
    expect(calls.declined).toEqual([{jobId: '1', reason: expect.stringMatching(/^AI model unavailable: /)}]);
  });

  it('keeps working when reporting the decline fails', async () => {
    const brain = new FakeBrain({triage: {accept: false, reason: 'not workable'}});
    const {worker, events} = build([offer()], brain, {declineThrows: new Error('api down')});

    const [outcome] = await worker.tick();
    expect(outcome).toMatchObject({status: 'declined', reason: 'not workable'});
    expect(events.some((e) => e.kind === 'failed' && e.stage === 'decline')).toBe(true);
  });

  it('reports a decline once, not on every poll', async () => {
    const brain = new FakeBrain({triage: {accept: false, reason: 'not workable'}});
    const {worker, calls} = build([offer()], brain);
    await worker.tick();
    await worker.tick();
    expect(calls.declined).toHaveLength(1);
  });

  /**
   * The client waits 45 s for an accept. A model that hangs for its full 60 s
   * outlasted that, so a worker with a working fallback model still timed out.
   */
  it('gives triage a short timeout, so a hanging model falls through in time', async () => {
    const brain = new FakeBrain();
    const {worker} = build([offer()], brain);
    await worker.tick();
    expect(brain.timeouts[0]).toBe(15_000);
  });
});

/**
 * Which refusals are allowed is policy, enforced in code — like the spending
 * caps. Live, a model declined "research NEAR Intents liquidity" three times
 * over because the product postdates its training; no prompt wording stopped it.
 */
describe('the decline policy', () => {
  it('accepts anyway when the model declines over missing knowledge', async () => {
    const brain = new FakeBrain({
      triage: {
        accept: false,
        reason: 'NEAR Intents is newer than my knowledge',
        blocker: 'missing_knowledge',
      },
    });
    const {worker, calls} = build([offer()], brain);
    const [outcome] = await worker.tick();
    expect(outcome).toMatchObject({status: 'delivered'});
    expect(calls.accepted).toEqual(['1']);
    expect(calls.declined).toEqual([]);
  });

  it('accepts anyway when the model cannot name a real blocker', async () => {
    const brain = new FakeBrain({triage: {accept: false, reason: 'needs live data', blocker: 'other'}});
    const {worker, calls} = build([offer()], brain);
    await worker.tick();
    expect(calls.accepted).toEqual(['1']);
  });

  /**
   * Offers are filtered to the worker's own capability before any model is
   * asked, so a job it sees is never outside its capability — a model saying
   * so has read the client's wider goal (live, Groq: "the request includes
   * preparing an execution plan, beyond market-research").
   */
  it('accepts anyway when the model calls its own capability "outside" it', async () => {
    const brain = new FakeBrain({
      triage: {
        accept: false,
        reason: 'the goal also asks for an execution plan',
        blocker: 'outside_capability',
      },
    });
    const {worker, calls} = build([offer()], brain);
    const [outcome] = await worker.tick();
    expect(outcome).toMatchObject({status: 'delivered'});
    expect(calls.declined).toEqual([]);
  });

  it.each(['client_only_data', 'impossible_action'])('declines for a real blocker: %s', async (blocker) => {
    const brain = new FakeBrain({triage: {accept: false, reason: `because ${blocker}`, blocker}});
    const {worker, calls} = build([offer()], brain);
    const [outcome] = await worker.tick();
    expect(outcome).toMatchObject({status: 'declined', reason: `because ${blocker}`});
    expect(calls.declined).toHaveLength(1);
  });

  it('still honours a decline recorded before blockers existed', async () => {
    const brain = new FakeBrain({triage: {accept: false, reason: 'no market named'}});
    const {worker, calls} = build([offer()], brain);
    const [outcome] = await worker.tick();
    expect(outcome).toMatchObject({status: 'declined'});
    expect(calls.accepted).toEqual([]);
  });
});

/**
 * Live, a research worker was handed the user's whole goal ("research, decide,
 * then prepare the execution plan") and declined because it cannot execute —
 * which was never its part. Triage must judge only the worker's own part.
 */
describe('judging only its own part of a goal', () => {
  it('tells the model that the rest of the goal belongs to other agents', async () => {
    const brain = new FakeBrain();
    const {worker} = build(
      [offer({input: {goal: 'research NEAR/USDC, then prepare the execution plan', step: '1 of 3'}})],
      brain,
    );
    let system = '';
    const complete = brain.complete.bind(brain);
    brain.complete = async (req) => {
      if (req.schemaName === 'TriageDecision') system = req.system;
      return complete(req);
    };
    await worker.tick();
    expect(system).toMatch(/whole\s+goal/i);
    expect(system).toMatch(/other\s+agents/i);
  });
});

describe('a model out of quota', () => {
  it('tells the client in one plain sentence, not the raw provider JSON', async () => {
    const brain = new FakeBrain();
    brain.complete = async () => {
      throw new BrainUnavailable(
        'fallback(gemini:a→gemini:b)',
        'outage',
        'every provider failed: gemini:a(rate_limit: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}})',
      );
    };
    const {worker, calls} = build([offer()], brain);
    await worker.tick();
    expect(calls.declined).toEqual([
      {jobId: '1', reason: 'AI model unavailable: its free request quota is used up for now'},
    ]);
  });
});

/**
 * 2026-11-12: a hosted worker on a paid model gets a daily cap. Over it, the
 * worker declines before any model runs, with a reason, so the client is
 * refunded and the owner's credit is not spent.
 */
describe('daily job cap', () => {
  function capped(offers: JobSummary[], brain: Brain, maxJobsPerDay: number, now: () => Date) {
    const calls: Calls = {accepted: [], submitted: [], submitAttempts: 0, declined: []};
    const worker = new Worker({
      client: fakeClient(offers, calls),
      brain,
      capability: 'market-research',
      role: 'a market research agent that reports order book depth',
      output: Output,
      maxJobsPerDay,
      now,
    });
    return {worker, calls};
  }

  it('takes jobs up to the cap, then declines the rest without asking the model', async () => {
    const brain = new FakeBrain();
    const day = () => new Date('2026-11-12T10:00:00Z');
    const {worker, calls} = capped([offer({}, '1'), offer({}, '2'), offer({}, '3')], brain, 2, day);
    await worker.tick();
    expect(calls.accepted).toEqual(['1', '2']);
    expect(calls.declined).toHaveLength(1);
    expect(calls.declined[0]).toMatchObject({jobId: '3'});
    expect(calls.declined[0]!.reason).toMatch(/2 jobs a day/);
    // Two triages and two results; nothing for the third.
    expect(brain.prompts).toHaveLength(4);
  });

  it('counts afresh on the next UTC day, in the same worker', async () => {
    let now = new Date('2026-11-12T23:59:00Z');
    const offers = [offer({}, '1')];
    const {worker, calls} = capped(offers, new FakeBrain(), 1, () => now);
    await worker.tick();
    offers.splice(0, offers.length, offer({}, '2'));
    await worker.tick();
    expect(calls.accepted).toEqual(['1']);
    expect(calls.declined.map((d) => d.jobId)).toEqual(['2']);
    now = new Date('2026-11-13T00:01:00Z');
    offers.splice(0, offers.length, offer({}, '3'));
    await worker.tick();
    expect(calls.accepted).toEqual(['1', '3']);
  });
});

/**
 * 2026-11-12, live on testnet: the hosted bot accepted a job hired from a
 * listing, produced the work, and FAILED at submit — the API refuses a plain
 * result for a listing job ("a listing job is submitted from an accepted
 * draft"). The job stalled until it expired. A listing job is delivered as a
 * draft round the client reviews; only an accepted draft is submitted, and
 * then with no output, because the accepted snapshot IS the result.
 */
describe('a job hired from a listing', () => {
  const listingOffer = (jobId = '1'): JobSummary =>
    offer(
      {input: {question: 'how deep is NEAR/USDC?', listing: {listingId: 'L1', title: 'Depth report'}}},
      jobId,
    );

  function listing(book: DraftBook = {phase: 'none', rounds: []}, job = listingOffer()) {
    const draftBook = new Map([[job.jobId, book]]);
    const brain = new FakeBrain();
    const built = build([job], brain, {draftBook});
    return {...built, brain, book, job};
  }

  it('accepts, then posts one draft and does not submit a result', async () => {
    const {worker, calls, events} = listing();
    const [outcome] = await worker.tick();

    expect(calls.accepted).toEqual(['1']);
    expect(calls.drafts).toHaveLength(1);
    expect(calls.drafts![0]!.text).toBe('NEAR/USDC depth is healthy\n\nConfidence: 0.8');
    expect(calls.drafts![0]!.output).toMatchObject({summary: 'NEAR/USDC depth is healthy'});
    expect(calls.submitAttempts).toBe(0);
    expect(outcome).toMatchObject({status: 'drafted', jobId: '1'});
    expect(events.some((e) => e.kind === 'failed')).toBe(false);
  });

  it('waits while the draft is under review: no model call, no second draft', async () => {
    const {worker, calls, brain, job} = listing();
    await worker.tick();
    job.state = 'accepted';
    const prompts = brain.prompts.length;

    await worker.tick();
    await worker.tick();

    expect(brain.prompts.length).toBe(prompts);
    expect(calls.drafts).toHaveLength(1);
    expect(calls.accepted).toEqual(['1']);
    expect(calls.submitAttempts).toBe(0);
  });

  it('keeps holding the job even when the listing still says created', async () => {
    // The indexer may lag the accept: the job comes back as `created`.
    const {worker, calls, events} = listing();
    await worker.tick();
    await worker.tick();
    expect(calls.accepted).toEqual(['1']);
    expect(calls.drafts).toHaveLength(1);
    expect(events.some((e) => e.kind === 'failed')).toBe(false);
  });

  it('produces a new round when the client asks for a revision, with the reason', async () => {
    const {worker, calls, brain, book, job} = listing();
    await worker.tick();
    job.state = 'accepted';
    book.phase = 'revise';
    book.rounds[0]!.review = {decision: 'revise', reason: 'add the bid/ask spread'};
    const prompts = brain.prompts.length;

    await worker.tick();

    expect(brain.prompts.length).toBe(prompts + 1);
    expect(brain.prompts.at(-1)).toContain('add the bid/ask spread');
    expect(calls.drafts).toHaveLength(2);
    expect(calls.submitAttempts).toBe(0);
  });

  it('submits the accepted draft with no output, and is done', async () => {
    const {worker, calls, brain, book, job, events} = listing();
    await worker.tick();
    job.state = 'accepted';
    book.phase = 'accepted';
    const prompts = brain.prompts.length;

    const [outcome] = await worker.tick();

    expect(outcome).toMatchObject({status: 'delivered', jobId: '1'});
    expect(calls.submitted).toEqual([{jobId: '1', output: undefined}]);
    expect(brain.prompts.length).toBe(prompts);
    expect(calls.drafts).toHaveLength(1);
    expect(events.at(-1)?.kind).toBe('delivered');

    // Delivered: the API now lists it with a result, and the worker leaves it.
    job.hasResult = true;
    expect(await worker.tick()).toEqual([]);
  });

  it('does nothing while the client intends to dispute', async () => {
    const {worker, calls, brain, book, job} = listing();
    await worker.tick();
    job.state = 'accepted';
    book.phase = 'dispute_intent';
    const prompts = brain.prompts.length;
    await worker.tick();
    expect(brain.prompts.length).toBe(prompts);
    expect(calls.drafts).toHaveLength(1);
    expect(calls.submitAttempts).toBe(0);
  });

  it('after a restart, resumes from the draft state instead of drafting again', async () => {
    const job: JobSummary = {...listingOffer(), state: 'accepted'};
    const {worker, calls, brain} = listing(
      {phase: 'awaiting_review', rounds: [{round: 1, text: 'an earlier draft', review: null}]},
      job,
    );
    await worker.tick();
    expect(calls.drafts).toEqual([]);
    expect(calls.accepted).toEqual([]);
    expect(brain.prompts).toEqual([]);
    expect(calls.submitAttempts).toBe(0);
  });

  it('after a restart with the draft already accepted, submits it', async () => {
    const job: JobSummary = {...listingOffer(), state: 'accepted'};
    const {worker, calls, brain} = listing(
      {phase: 'accepted', rounds: [{round: 1, text: 'an earlier draft', review: null}]},
      job,
    );
    await worker.tick();
    expect(calls.submitted).toEqual([{jobId: '1', output: undefined}]);
    expect(brain.prompts).toEqual([]);
  });

  it('renders output without a summary as readable JSON for the draft text', async () => {
    const job = listingOffer();
    const draftBook = new Map<string, DraftBook>([[job.jobId, {phase: 'none', rounds: []}]]);
    const calls: Calls = {accepted: [], submitted: [], submitAttempts: 0, declined: [], drafts: []};
    const worker = new Worker({
      client: fakeClient([job], calls, {draftBook}),
      brain: new FakeBrain({result: {ok: true}}),
      capability: 'market-research',
      role: 'r',
      output: z.object({ok: z.boolean()}),
    });
    await worker.tick();
    expect(calls.drafts).toHaveLength(1);
    expect(calls.drafts![0]!.text.length).toBeGreaterThanOrEqual(10);
    expect(JSON.parse(calls.drafts![0]!.text)).toEqual({ok: true});
  });
});

/**
 * 2026-11-13, live: the model put a one-line preface in `summary` ("The
 * following paragraph explains…") and the actual answer in another field. The
 * draft posted only the summary, so the client reviewed a draft with no
 * answer in it. The draft text is the whole output, summary first.
 */
describe('draftText', () => {
  it('keeps every field, not just a summary that is only a preface', () => {
    const text = draftText({
      summary: 'The following paragraph explains the depth situation.',
      paragraph: 'NEAR/USDC has 2.1M USDC within 2% of mid on Ref Finance, up 14% week on week.',
    });
    expect(text.startsWith('The following paragraph explains the depth situation.')).toBe(true);
    expect(text).toContain('NEAR/USDC has 2.1M USDC within 2% of mid on Ref Finance');
  });

  it('puts the summary first even when it is not the first field', () => {
    const text = draftText({
      detail: 'The detailed body of the answer goes here.',
      summary: 'A summary that is long enough.',
    });
    expect(text).toBe('A summary that is long enough.\n\nDetail: The detailed body of the answer goes here.');
  });

  it('renders a research-bot result readably', () => {
    const text = draftText({
      summary: 'NEAR/USDC liquidity is concentrated on Ref Finance, with 2.1M USDC within 2% of mid.',
      keyFindings: ['Ref holds 78% of on-chain depth', 'Depth rose 14% week on week'],
      confidence: 0.72,
      sources: ['Ref Finance analytics', 'DefiLlama'],
    });
    expect(text).toBe(
      [
        'NEAR/USDC liquidity is concentrated on Ref Finance, with 2.1M USDC within 2% of mid.',
        'Key findings:\n- Ref holds 78% of on-chain depth\n- Depth rose 14% week on week',
        'Confidence: 0.72',
        'Sources:\n- Ref Finance analytics\n- DefiLlama',
      ].join('\n\n'),
    );
  });

  it('renders a trading-bot result (no summary) without JSON punctuation', () => {
    const text = draftText({
      recommendation: 'hold',
      rationale: 'Funding is flat and depth is thinning; the case for adding exposure is weak right now.',
      confidence: 0.6,
      risks: ['A breakout above 7 USD would make holding wrong'],
    });
    expect(text).toBe(
      [
        'Recommendation: hold',
        'Rationale:\nFunding is flat and depth is thinning; the case for adding exposure is weak right now.',
        'Confidence: 0.6',
        'Risks:\n- A breakout above 7 USD would make holding wrong',
      ].join('\n\n'),
    );
  });

  it('renders an execution-bot plan with its steps numbered and compact', () => {
    const text = draftText({
      steps: [
        {action: 'Swap NEAR for USDC', venue: 'Ref Finance', amount: '1000000000000000000000000'},
        {action: 'Withdraw USDC to the treasury'},
      ],
      preconditions: ['Slippage under 0.5%'],
      abortIf: 'Depth within 2% of mid falls below 500k USDC',
    });
    expect(text).toBe(
      [
        'Steps:\n1. Action: Swap NEAR for USDC; Venue: Ref Finance; Amount: 1000000000000000000000000\n2. Action: Withdraw USDC to the treasury',
        'Preconditions:\n- Slippage under 0.5%',
        'Abort if: Depth within 2% of mid falls below 500k USDC',
      ].join('\n\n'),
    );
  });

  it('skips empty fields and is deterministic', () => {
    const out = {summary: 'A summary that is long enough.', notes: '', extra: null, list: []};
    expect(draftText(out)).toBe('A summary that is long enough.');
    expect(draftText(out)).toBe(draftText({...out}));
  });

  it('keeps the 10..10000 character bounds', () => {
    const long = draftText({summary: 'x'.repeat(20), body: 'y'.repeat(20_000)});
    expect(long.length).toBe(10_000);
    expect(long.endsWith('…')).toBe(true);
    expect(draftText({a: 'b'}).length).toBeGreaterThanOrEqual(10);
  });
});
