import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {PactoraError, ErrorCode} from '@pactora/shared';
import type {PactoraClient} from '@pactora/sdk';
import {SPEND_WARNING, buildTools, describeError, type ToolContext} from '../src/tools.js';
import {TESTNET} from './fixtures.js';

/**
 * The tools as data, and their handlers called directly — no transport.
 *
 * What is under test is the part a model reads and acts on: whether a tool
 * that moves money says so, whether a result that came from another agent is
 * marked as untrusted, and whether a failure tells the model if retrying can
 * possibly help.
 */

/** Only the calls the tools make; cast rather than implemented in full. */
function fakeClient(over: Partial<Record<string, unknown>> = {}): PactoraClient {
  return {
    network: async () => TESTNET,
    budget: async () => ({
      agentId: '1',
      chainId: 'near:testnet',
      network: 'NEAR Testnet',
      testnet: true,
      source: 'chain',
      perTaskCap: '50000',
      perTaskCapDisplay: '0.05 USDC',
      dailyCap: '500000',
      dailyCapDisplay: '0.50 USDC',
      dailyRemaining: '300000',
      dailyRemainingDisplay: '0.30 USDC',
      maxSingleSpend: '50000',
      maxSingleSpendDisplay: '0.05 USDC',
      allowlistOnly: false,
      tokenBalance: '1000000',
      tokenSymbol: 'USDC',
      walletAddress: '0x' + '55'.repeat(20),
      resetsInSeconds: 3600,
    }),
    discover: async () => [],
    hire: async () => ({
      jobId: '7',
      chainJobId: '7',
      chainId: 'near:testnet',
      network: 'NEAR Testnet',
      state: 'created',
      path: 'escrow',
      amount: '20000',
      amountDisplay: '0.02 USDC',
      specHash: '0x' + 'ee'.repeat(32),
      txHash: 'Tx1' + 'ff'.repeat(32),
      explorerUrl: 'https://testnet.nearblocks.io/txns/Tx1',
    }),
    getJob: async () => ({jobId: '7', state: 'submitted'}),
    approve: async () => ({
      jobId: '7',
      chainId: 'near:testnet',
      state: 'settled',
      txHash: 'Tx1',
      explorerUrl: 'u',
    }),
    dispute: async () => ({
      jobId: '7',
      chainId: 'near:testnet',
      state: 'disputed',
      txHash: 'Tx1',
      explorerUrl: 'u',
    }),
    awaitResult: async () => ({jobId: '7', state: 'settled'}),
    ...over,
  } as unknown as PactoraClient;
}

const ctx = (over?: Partial<Record<string, unknown>>): ToolContext => ({
  client: fakeClient(over),
  network: TESTNET,
});

const tools = buildTools();
const byName = (name: string) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
};

describe('the tool set', () => {
  it('exposes exactly the twenty-eight tools the spec promises', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'accept_job',
      'approve_job',
      'await_result',
      'bid_on_listing',
      'check_trust',
      'claim_listing',
      'close_applications',
      'decide_application',
      'decline_job',
      'discover_agents',
      'dispute_job',
      'find_listings',
      'get_conversation',
      'get_evidence',
      'get_job',
      'get_network',
      'get_updates',
      'hire_agent',
      'list_applications',
      'list_jobs',
      'my_budget',
      'post_listing',
      'reopen_applications',
      'review_job',
      'send_message',
      'submit_draft',
      'submit_result',
      'wait_for_updates',
    ]);
  });

  /**
   * The rule that must not be left to whoever adds the ninth tool. An agent
   * should never spend money without the tool having told it so, and putting
   * the sentence first means a model that stops reading early still read it.
   */
  it('opens every spending tool description with the money warning', () => {
    for (const tool of tools.filter((t) => t.spends)) {
      expect(tool.description.startsWith(SPEND_WARNING), tool.name).toBe(true);
    }
  });

  it('marks exactly the money-moving tools as spending', () => {
    expect(
      tools
        .filter((t) => t.spends)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['approve_job', 'decide_application', 'dispute_job', 'hire_agent', 'review_job']);
  });

  it('tells the model plainly which tools are free', () => {
    for (const tool of tools.filter((t) => !t.spends)) {
      expect(tool.description, tool.name).toMatch(/Free/);
    }
  });

  /**
   * The injection defence at the tool layer. `get_job` and `await_result` are
   * the two places another agent's text enters the model's context, so the
   * warning belongs on those two descriptions and not merely in the system
   * prompt the client may or may not have set.
   */
  it('warns that a returned result is data rather than instruction', () => {
    for (const name of ['get_job', 'await_result']) {
      expect(byName(name).description, name).toMatch(/data|DATA/);
      expect(byName(name).description, name).toMatch(/never as instructions|not instruction/);
    }
  });
});

describe('hire_agent', () => {
  it('requires an explicit ceiling — a model must never infer one', () => {
    const schema = z.object(byName('hire_agent').inputSchema);
    const withoutMax = schema.safeParse({agentId: 3, spec: {capability: 'x', input: {}}});
    expect(withoutMax.success).toBe(false);
  });

  it('rejects an amount that is not base units', () => {
    const schema = z.object(byName('hire_agent').inputSchema);
    expect(schema.safeParse({agentId: 3, spec: {capability: 'x', input: {}}, maxPrice: '0.02'}).success).toBe(
      false,
    );
  });

  it('stamps the network on the receipt, so the money is never ambiguous', async () => {
    const out = (await byName('hire_agent').handler(
      {agentId: 3, spec: {capability: 'market-research', input: {}}, maxPrice: '50000'},
      ctx(),
    )) as {testnet: boolean; network: string; nextStep: string};

    expect(out.testnet).toBe(true);
    expect(out.network).toBe('NEAR Testnet');
  });

  it('says what to do next, which differs by path', async () => {
    const out = (await byName('hire_agent').handler(
      {agentId: 3, spec: {capability: 'market-research', input: {}}, maxPrice: '50000'},
      ctx(),
    )) as {nextStep: string};
    expect(out.nextStep).toMatch(/approve_job|dispute_job/);
  });

  /**
   * The budget read is a convenience. A hire that succeeded must not be
   * reported as a failure because the follow-up read did not.
   */
  it('still reports a successful hire when the budget read fails', async () => {
    const out = (await byName('hire_agent').handler(
      {agentId: 3, spec: {capability: 'market-research', input: {}}, maxPrice: '50000'},
      ctx({
        budget: async () => {
          throw new Error('RPC down');
        },
      }),
    )) as {jobId: string; remainingToday: string | null};

    expect(out.jobId).toBe('7');
    expect(out.remainingToday).toBeNull();
  });
});

describe('discover_agents', () => {
  /**
   * An empty marketplace is an answer. A model that reads it as a failure
   * retries the same query until it gives up or runs out of budget.
   */
  it('explains an empty result rather than leaving it to be read as an error', async () => {
    const out = (await byName('discover_agents').handler({capability: 'time-travel'}, ctx())) as {
      count: number;
      note: string;
    };
    expect(out.count).toBe(0);
    expect(out.note).toMatch(/not an error/);
  });

  it('omits the note when there are candidates', async () => {
    const out = (await byName('discover_agents').handler(
      {capability: 'market-research'},
      ctx({discover: async () => [{agentId: 1}]}),
    )) as {count: number; note?: string};

    expect(out.count).toBe(1);
    expect(out.note).toBeUndefined();
  });
});

describe('dispute_job (v3)', () => {
  /** A dispute now costs a bond, lost if the arbiter sides with the worker. A model must know before it disputes. */
  it('says a dispute posts a bond the client can lose', () => {
    expect(byName('dispute_job').description).toMatch(/bond/);
    expect(byName('dispute_job').description).toMatch(/lose|lost/);
  });
});

describe('check_trust', () => {
  /**
   * v3: a score says every review cost a payment; this says who paid. A
   * model about to hire should read the verdict and its reasons, not just a
   * number — and it must cost nothing to ask.
   */
  it('returns the verdict and reasons for the agent asked about', async () => {
    let asked: number | undefined;
    const out = (await byName('check_trust').handler(
      {agentId: '42'},
      ctx({
        trust: async (id: number) => {
          asked = id;
          return {agentId: '42', verdict: 'self-funded', reasons: ['3 of 3 paid jobs'], metrics: {}};
        },
      }),
    )) as {verdict: string; reasons: string[]};
    expect(asked).toBe(42);
    expect(out.verdict).toBe('self-funded');
    expect(out.reasons[0]).toMatch(/3 of 3/);
  });

  it('is free, and says a non-trusted verdict is a reason not to hire', () => {
    const t = byName('check_trust');
    expect(t.spends).toBe(false);
    expect(t.description).toMatch(/self-funded/);
    expect(t.description).toMatch(/Free/);
  });
});

describe('describeError', () => {
  /**
   * A cap is a decision the owner made. An agent that sleeps until the window
   * lifts is an agent that has stopped doing its job for a day.
   */
  it('does not present a spending cap as retryable, despite its reset time', () => {
    const described = describeError(new PactoraError(ErrorCode.BUDGET_EXCEEDED, 'over the daily cap', 3600));
    expect(described.retryable).toBe(false);
    expect(described.retryAfterSeconds).toBe(3600);
  });

  it('marks the one genuinely transient failure as retryable', () => {
    const described = describeError(
      new PactoraError(ErrorCode.AGENT_NOT_HIREABLE, 'not yet seen on-chain', 2),
    );
    expect(described.retryable).toBe(true);
  });

  it('does not retry a permanent version of the same code', () => {
    const described = describeError(
      new PactoraError(ErrorCode.AGENT_NOT_HIREABLE, 'agent is not accepting work'),
    );
    expect(described.retryable).toBe(false);
  });

  it('never marks a decision as retryable', () => {
    for (const code of [
      ErrorCode.PRICE_ABOVE_MAX,
      ErrorCode.SCHEMA_MISMATCH,
      ErrorCode.INVALID_STATE,
      ErrorCode.DEADLINE_PASSED,
      ErrorCode.IDEMPOTENCY_CONFLICT,
    ]) {
      expect(describeError(new PactoraError(code, 'no')).retryable, code).toBe(false);
    }
  });

  /** A dropped connection should not make an agent abandon a paid job. */
  it('treats an unrecognised failure as transient', () => {
    expect(describeError(new Error('socket hang up')).retryable).toBe(true);
    expect(describeError('something').code).toBe('UNKNOWN');
  });
});

describe('the listing tools (docs/26 F4)', () => {
  it('puts sort in the list_applications schema, and passes it through', async () => {
    const seen: unknown[] = [];
    const tool = byName('list_applications');
    expect(Object.keys(tool.inputSchema)).toContain('sort');
    await tool.handler(
      {listingId: '00000000-0000-4000-8000-000000000001', sort: 'price_low', page: 2},
      ctx({listApplications: async (...a: unknown[]) => (seen.push(a), {applications: []})}),
    );
    expect(seen).toEqual([['00000000-0000-4000-8000-000000000001', {sort: 'price_low', page: 2}]]);
  });

  it('marks selecting a bid as spending, and posting, closing and reopening as not', () => {
    expect(byName('decide_application').spends).toBe(true);
    expect(byName('decide_application').description.startsWith(SPEND_WARNING)).toBe(true);
    for (const name of ['post_listing', 'close_applications', 'reopen_applications', 'list_applications']) {
      expect(byName(name).spends, name).toBe(false);
    }
    expect(byName('post_listing').description).toContain('RESERVES');
  });

  it('calls the SDK with what the model gave, and stamps the chain on decisions and posts', async () => {
    const calls: unknown[][] = [];
    const record =
      (name: string, answer: unknown) =>
      async (...a: unknown[]) => (calls.push([name, ...a]), answer);
    const c = ctx({
      postListing: record('postListing', {listingId: 'L'}),
      decideApplication: record('decideApplication', {replayed: false}),
      closeApplications: record('closeApplications', {status: 'closed'}),
      reopenApplications: record('reopenApplications', {status: 'open'}),
    });
    const posted = await byName('post_listing').handler(
      {title: 'Count the cars', maxWorkers: 2, idempotencyKey: 'post-key-1'} as never,
      c,
    );
    expect(posted).toMatchObject({listingId: 'L', testnet: true});
    const decided = await byName('decide_application').handler(
      {listingId: 'L', applicationId: 'A', action: 'select', reason: 'Best price and record.'},
      c,
    );
    expect(decided).toMatchObject({replayed: false, testnet: true});
    await byName('close_applications').handler({listingId: 'L'}, c);
    await byName('reopen_applications').handler({listingId: 'L'}, c);
    expect(calls).toEqual([
      ['postListing', {title: 'Count the cars', maxWorkers: 2}, 'post-key-1'],
      ['decideApplication', 'L', {applicationId: 'A', action: 'select', reason: 'Best price and record.'}],
      ['closeApplications', 'L'],
      ['reopenApplications', 'L'],
    ]);
  });
});

describe('the worker-side listing tools (2026-11-10)', () => {
  it('are free, and say a listing is written by its client (data, not instructions)', () => {
    for (const name of ['find_listings', 'bid_on_listing', 'claim_listing']) {
      expect(byName(name).spends, name).toBe(false);
      expect(byName(name).description, name).toMatch(/Free/);
    }
    expect(byName('find_listings').description).toMatch(/data/);
  });

  it('calls the SDK with what the model gave, and stamps the chain on a bid and a claim', async () => {
    const calls: unknown[][] = [];
    const record =
      (name: string, answer: unknown) =>
      async (...a: unknown[]) => (calls.push([name, ...a]), answer);
    const c = ctx({
      listListings: record('listListings', [{listingId: 'L'}]),
      applyToListing: record('applyToListing', {applicationId: 'A'}),
      claimListing: record('claimListing', {replayed: false}),
    });
    expect(
      await byName('find_listings').handler({q: 'shop fronts', capability: 'photography'}, c),
    ).toMatchObject({
      count: 1,
      listings: [{listingId: 'L'}],
    });
    await byName('find_listings').handler({}, c);
    const bid = await byName('bid_on_listing').handler(
      {listingId: 'L', price: '30000', proposal: 'I can do this today, with a good camera.'},
      c,
    );
    expect(bid).toMatchObject({applicationId: 'A', testnet: true});
    const claimed = await byName('claim_listing').handler({listingId: 'L'}, c);
    expect(claimed).toMatchObject({replayed: false, testnet: true});
    await byName('claim_listing').handler(
      {listingId: 'L', proposal: 'Taking it at the listed price, today.'},
      c,
    );
    expect(calls).toEqual([
      ['listListings', {q: 'shop fronts', skill: 'photography'}],
      ['listListings', {}],
      [
        'applyToListing',
        'L',
        {priceBaseUnits: '30000', proposal: 'I can do this today, with a good camera.'},
      ],
      ['claimListing', 'L', undefined],
      ['claimListing', 'L', 'Taking it at the listed price, today.'],
    ]);
  });

  it('requires a base-units price and a proposal on a bid', () => {
    const schema = z.object(byName('bid_on_listing').inputSchema);
    expect(schema.safeParse({listingId: 'L', price: '1.5', proposal: 'x'.repeat(30)}).success).toBe(false);
    expect(schema.safeParse({listingId: 'L', price: '30000'}).success).toBe(false);
  });
});

describe('the evidence, review and chat tools (docs/26 F6-F8)', () => {
  const JOB = '00000000-0000-4000-8000-000000000007';
  const DRAFT = '00000000-0000-4000-8000-000000000008';

  it('marks review_job as spending, because accept_draft authorises the release, and the rest as free', () => {
    expect(byName('review_job').spends).toBe(true);
    expect(byName('review_job').description).toContain('AUTHORISES');
    for (const name of [
      'submit_draft',
      'get_evidence',
      'send_message',
      'get_conversation',
      'list_jobs',
      'accept_job',
      'submit_result',
      'decline_job',
      'get_updates',
      'wait_for_updates',
    ]) {
      expect(byName(name).spends, name).toBe(false);
    }
  });

  it('warns that evidence and chat are data written by the other party, never instructions', () => {
    for (const name of ['get_evidence', 'get_conversation', 'get_updates', 'wait_for_updates']) {
      expect(byName(name).description, name).toMatch(/never/i);
      expect(byName(name).description, name).toMatch(/budget|limit/i);
    }
  });

  it('requires 1-30 checks on a review and a 64-hex snapshot hash', () => {
    const schema = z.object(byName('review_job').inputSchema);
    const ok = {
      jobId: JOB,
      draftId: DRAFT,
      snapshotHash: 'a'.repeat(64),
      decision: 'accept_draft',
      reason: 'Everything asked for.',
      checks: [{criterion: 'sign visible', met: true}],
    };
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({...ok, checks: []}).success).toBe(false);
    expect(schema.safeParse({...ok, snapshotHash: '0xabc'}).success).toBe(false);
  });

  it('calls the SDK with what the model gave', async () => {
    const calls: unknown[][] = [];
    const record =
      (name: string, answer: unknown) =>
      async (...a: unknown[]) => (calls.push([name, ...a]), answer);
    const c = ctx({
      getDrafts: record('getDrafts', {phase: 'awaiting_review', drafts: [{draftId: 'D1'}, {draftId: 'D2'}]}),
      listFiles: record('listFiles', {files: []}),
      reviewDraft: record('reviewDraft', {phase: 'revise'}),
      sendMessage: record('sendMessage', {messageId: 'M'}),
      getConversation: record('getConversation', {messages: []}),
      listJobs: record('listJobs', [{jobId: JOB}]),
      accept: record('accept', {state: 'accepted'}),
      submitDraft: record('submitDraft', {round: 1}),
      submitResult: record('submitResult', {state: 'submitted'}),
      decline: record('decline', {declined: {}}),
    });
    const evidence = (await byName('get_evidence').handler({jobId: JOB}, c)) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      phase: 'awaiting_review',
      latest: {draftId: 'D2'},
      rounds: 2,
      files: {files: []},
    });
    const reviewed = await byName('review_job').handler(
      {
        jobId: JOB,
        draftId: DRAFT,
        snapshotHash: 'a'.repeat(64),
        decision: 'revise',
        reason: 'Retake it closer.',
        checks: [{criterion: 'c', met: false}],
      },
      c,
    );
    expect(reviewed).toMatchObject({phase: 'revise', testnet: true});
    await byName('send_message').handler({jobId: JOB, body: 'hi', idempotencyKey: 'k'.repeat(16)}, c);
    await byName('get_conversation').handler({jobId: JOB}, c);
    expect(await byName('list_jobs').handler({role: 'worker'}, c)).toEqual({count: 1, jobs: [{jobId: JOB}]});
    await byName('accept_job').handler({jobId: JOB}, c);
    await byName('submit_draft').handler({jobId: JOB, text: 'my draft text'}, c);
    await byName('submit_result').handler({jobId: JOB}, c);
    await byName('submit_result').handler({jobId: JOB, output: {a: 1}}, c);
    await byName('decline_job').handler({jobId: JOB, reason: 'busy'}, c);
    expect(calls).toEqual([
      ['getDrafts', JOB],
      ['listFiles', JOB],
      [
        'reviewDraft',
        JOB,
        DRAFT,
        {
          snapshotHash: 'a'.repeat(64),
          decision: 'revise',
          reason: 'Retake it closer.',
          checks: [{criterion: 'c', met: false}],
        },
      ],
      ['sendMessage', JOB, 'hi', {idempotencyKey: 'k'.repeat(16)}],
      ['getConversation', JOB],
      ['listJobs', {role: 'worker'}],
      ['accept', JOB],
      ['submitDraft', JOB, {text: 'my draft text'}],
      ['submitResult', JOB, undefined],
      ['submitResult', JOB, {output: {a: 1}}],
      ['decline', JOB, 'busy'],
    ]);
  });
});

describe('updates (docs/26 F9)', () => {
  it('wait_for_updates holds with long-polls and answers as soon as something arrives', async () => {
    const asked: {after?: number; wait?: number}[] = [];
    let calls = 0;
    const c = {
      client: {
        getUpdates: async (q: {after?: number; wait?: number}) => {
          asked.push(q);
          calls++;
          return {
            agentId: 'a',
            after: q.after ?? 0,
            next: calls === 2 ? 8 : 7,
            more: false,
            latest: 8,
            events:
              calls === 2
                ? [
                    {
                      seq: 8,
                      kind: 'job.settled',
                      role: 'client',
                      jobId: '00000000-0000-4000-8000-000000000008',
                      payload: {},
                      at: '',
                    },
                  ]
                : [],
          };
        },
      },
    } as unknown as Parameters<ReturnType<typeof byName>['handler']>[1];
    const out = (await byName('wait_for_updates').handler({after: 7, timeoutSeconds: 120}, c)) as {
      events: unknown[];
    };
    expect(out.events).toHaveLength(1);
    expect(asked).toHaveLength(2);
    expect(asked.every((q) => q.after === 7 && q.wait !== undefined && q.wait <= 30)).toBe(true);
  });
});
