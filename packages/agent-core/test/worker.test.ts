import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {PactoraError, ErrorCode, type JobSpec} from '@pactora/shared';
import type {PactoraClient, JobSummary} from '@pactora/sdk';
import {
  BrainUnavailable,
  UNTRUSTED_OPEN,
  Worker,
  confidence,
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
        : (this.replies.result ?? {summary: 'ETH/USDC depth is healthy', confidence: 0.8});

    return {value: req.schema.parse(reply), provider: 'fake', model: 'fake', cached: false};
  }
  async available() {
    return true;
  }
}

interface Calls {
  accepted: string[];
  submitted: {jobId: string; output: Record<string, unknown>}[];
  submitAttempts: number;
  declined: {jobId: string; reason: string}[];
}

interface ClientFaults {
  acceptThrows?: unknown;
  acceptThrowsOnce?: unknown;
  submitThrowsOnce?: unknown;
  declineThrows?: unknown;
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
    submitResult: async (jobId: string, result: {output: Record<string, unknown>}) => {
      calls.submitAttempts++;
      if (over.submitThrowsOnce && !submitThrown) {
        submitThrown = true;
        throw over.submitThrowsOnce;
      }
      calls.submitted.push({jobId, output: result.output});
      return {jobId, chainId: 'near:testnet', state: 'submitted', txHash: '0x', explorerUrl: 'u'};
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
      input: {question: 'how deep is ETH/USDC?'},
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
  const calls: Calls = {accepted: [], submitted: [], submitAttempts: 0, declined: []};
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
 * caps. Live, a model declined "research ETH/USDC on Monad" three times over
 * because Monad postdates its training; no prompt wording stopped it.
 */
describe('the decline policy', () => {
  it('accepts anyway when the model declines over missing knowledge', async () => {
    const brain = new FakeBrain({
      triage: {accept: false, reason: 'Monad is newer than my knowledge', blocker: 'missing_knowledge'},
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
      [offer({input: {goal: 'research ETH/USDC, then prepare the execution plan', step: '1 of 3'}})],
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
