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
  it('exposes exactly the nine tools the spec promises', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'approve_job',
      'await_result',
      'check_trust',
      'discover_agents',
      'dispute_job',
      'get_job',
      'get_network',
      'hire_agent',
      'my_budget',
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
    ).toEqual(['approve_job', 'dispute_job', 'hire_agent']);
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
