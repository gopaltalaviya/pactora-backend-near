import {describe, expect, it} from 'vitest';
import {PactoraClient, PactoraError, ErrorCode, NotAccepted} from '../src/index.js';

/**
 * `@pactora/sdk` — the client every agent imports. It had no tests.
 *
 * Two of the things it decides are about money, not convenience:
 *
 *   - **What is worth retrying.** Retrying a spending cap wastes the agent's
 *     time and the operator's rate limit, and it will never succeed. Retrying
 *     a dropped connection is how a paid job survives a blip.
 *   - **The idempotency key.** It is what stops a retried hire becoming a
 *     second payment, and it is derived here when the caller omits one.
 *
 * Nothing exercised either.
 */

/** A fetch that answers from a script and records what it was asked. */
function fakeFetch(
  script: (call: number, url: string, init?: RequestInit) => {status: number; body: unknown},
) {
  const calls: {url: string; init?: RequestInit}[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({url: String(url), ...(init ? {init} : {})});
    const {status, body} = script(calls.length, String(url), init);
    return new Response(JSON.stringify(body), {
      status,
      headers: {'content-type': 'application/json'},
    });
  };
  return {calls, impl: impl};
}

const problem = (code: ErrorCode, detail: string, retryAfter?: number) => ({
  type: `https://pactoragents.com/errors/x`,
  title: 'x',
  status: 402,
  code,
  detail,
  ...(retryAfter !== undefined ? {retryAfter} : {}),
});

function client(impl: typeof fetch, over: {maxRetries?: number} = {}) {
  return new PactoraClient({
    baseUrl: 'http://api.test',
    apiKey: 'ax_test',
    chainId: 'near:testnet',
    fetchImpl: impl,
    ...(over.maxRetries !== undefined ? {maxRetries: over.maxRetries} : {}),
  });
}

const SPEC = {
  capability: 'market-research',
  input: {question: 'depth?'},
  deadlineSeconds: 120,
} as never;

describe('what the client retries', () => {
  /**
   * A cap is a decision the owner made on-chain. Retrying it cannot succeed,
   * and doing so is how an agent turns one refusal into a rate-limit ban.
   */
  it('never retries a spending cap', async () => {
    const f = fakeFetch(() => ({
      status: 402,
      body: problem(ErrorCode.BUDGET_EXCEEDED, 'over the daily cap'),
    }));
    let error: unknown;
    try {
      await client(f.impl).hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});
    } catch (err) {
      error = err;
    }
    expect((error as PactoraError).code).toBe(ErrorCode.BUDGET_EXCEEDED);
    expect(f.calls.length, 'a cap must be attempted exactly once').toBe(1);
  });

  it('never retries a price above the ceiling, or a schema mismatch', async () => {
    for (const code of [ErrorCode.PRICE_ABOVE_MAX, ErrorCode.SCHEMA_MISMATCH, ErrorCode.INVALID_STATE]) {
      const f = fakeFetch(() => ({status: 409, body: problem(code, 'no')}));
      await client(f.impl)
        .hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'})
        .catch(() => undefined);
      expect(f.calls.length, `${code} must not be retried`).toBe(1);
    }
  });

  /** A 500 is the server's problem and may well be gone next time. */
  it('retries a server error and succeeds when it clears', async () => {
    const f = fakeFetch((call) =>
      call < 3
        ? {status: 500, body: {code: 'INVALID_STATE', detail: 'boom'}}
        : {status: 201, body: {jobId: '7', amount: '20000'}},
    );
    const receipt = await client(f.impl).hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});
    expect(receipt.jobId).toBe('7');
    expect(f.calls.length).toBe(3);
  });

  it('gives up after maxRetries and surfaces the last error', async () => {
    const f = fakeFetch(() => ({status: 503, body: {code: 'INVALID_STATE', detail: 'still down'}}));
    let error: unknown;
    try {
      await client(f.impl, {maxRetries: 2}).hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PactoraError);
    expect(f.calls.length).toBe(2);
  });

  it('retries a rate limit rather than treating it as fatal', async () => {
    const f = fakeFetch((call) =>
      call === 1
        ? {status: 429, body: {code: 'RATE_LIMITED', detail: 'slow down', retryAfter: 0}}
        : {status: 200, body: {agents: []}},
    );
    await client(f.impl).discover({capability: 'market-research'});
    expect(f.calls.length).toBe(2);
  });

  /**
   * A network-level failure is exactly what the idempotency key makes safe to
   * retry — the request may or may not have arrived.
   */
  it('retries a dropped connection', async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      if (calls < 2) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({agents: []}), {status: 200});
    }) as unknown as typeof fetch;

    await client(impl).discover({});
    expect(calls).toBe(2);
  });
});

describe('the error contract agents branch on', () => {
  it('turns an RFC 7807 problem into a typed code, not a status number', async () => {
    const f = fakeFetch(() => ({
      status: 409,
      body: problem(ErrorCode.AGENT_NOT_HIREABLE, 'not on chain yet', 2),
    }));
    let error: unknown;
    try {
      await client(f.impl).getJob('1');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PactoraError);
    expect((error as PactoraError).code).toBe(ErrorCode.AGENT_NOT_HIREABLE);
    expect((error as PactoraError).retryAfter).toBe(2);
  });

  it('still produces an PactoraError when the body is not a problem document', async () => {
    const f = fakeFetch(() => ({status: 502, body: 'gateway'}));
    let error: unknown;
    try {
      await client(f.impl, {maxRetries: 1}).getJob('1');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PactoraError);
  });
});

describe('the idempotency key', () => {
  /** Without it, a retried hire is a second payment. */
  it('is sent on every hire', async () => {
    const f = fakeFetch(() => ({status: 201, body: {jobId: '1'}}));
    await client(f.impl).hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});

    const headers = f.calls[0]!.init!.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBeTruthy();
    expect(headers['idempotency-key']!.length).toBeGreaterThanOrEqual(8);
  });

  /**
   * Derived from the request itself, so two identical hires a second apart —
   * almost certainly a retry — collapse into one payment.
   */
  it('is identical for the same worker and spec', async () => {
    const keys: string[] = [];
    const f = fakeFetch((_c, _u, init) => {
      keys.push((init!.headers as Record<string, string>)['idempotency-key']!);
      return {status: 201, body: {jobId: '1'}};
    });
    const c = client(f.impl);
    await c.hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});
    await c.hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});

    expect(keys[0]).toBe(keys[1]);
  });

  it('differs when the work differs', async () => {
    const keys: string[] = [];
    const f = fakeFetch((_c, _u, init) => {
      keys.push((init!.headers as Record<string, string>)['idempotency-key']!);
      return {status: 201, body: {jobId: '1'}};
    });
    const c = client(f.impl);
    await c.hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});
    await c.hire({
      workerAgentId: 2,
      spec: {...(SPEC as object), input: {question: 'something else'}} as never,
      maxPrice: '50000',
    });

    expect(keys[0]).not.toBe(keys[1]);
  });

  it('differs when the worker differs, for identical work', async () => {
    const keys: string[] = [];
    const f = fakeFetch((_c, _u, init) => {
      keys.push((init!.headers as Record<string, string>)['idempotency-key']!);
      return {status: 201, body: {jobId: '1'}};
    });
    const c = client(f.impl);
    await c.hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});
    await c.hire({workerAgentId: 3, spec: SPEC, maxPrice: '50000'});

    expect(keys[0]).not.toBe(keys[1]);
  });

  /**
   * Audit H1: the derived key was the worker and the spec alone, so two
   * clients asking the same question derived the same key — a key any other
   * client could compute, and claim, in advance.
   */
  it('differs between clients for identical work', async () => {
    const keys: string[] = [];
    const f = fakeFetch((_c, _u, init) => {
      keys.push((init!.headers as Record<string, string>)['idempotency-key']!);
      return {status: 201, body: {jobId: '1'}};
    });
    const as = (agentId: number, apiKey: string) =>
      new PactoraClient({baseUrl: 'http://api.test', apiKey, agentId, fetchImpl: f.impl});
    await as(7, 'ax_aaaa_secret1').hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});
    await as(8, 'ax_bbbb_secret2').hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});
    // Without an agent id, the key's public id stands in for it.
    await new PactoraClient({baseUrl: 'http://api.test', apiKey: 'ax_cccc_secret3', fetchImpl: f.impl}).hire({
      workerAgentId: 2,
      spec: SPEC,
      maxPrice: '50000',
    });

    expect(new Set(keys).size).toBe(3);
    for (const k of keys) expect(k).not.toContain('secret');
  });

  it('uses a caller-supplied key verbatim, so a restart can be made safe', async () => {
    const f = fakeFetch(() => ({status: 201, body: {jobId: '1'}}));
    await client(f.impl).hire({
      workerAgentId: 2,
      spec: SPEC,
      maxPrice: '50000',
      idempotencyKey: 'my-own-durable-key',
    });
    const headers = f.calls[0]!.init!.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('my-own-durable-key');
  });
});

describe('credentials', () => {
  it('browses the marketplace without sending a key', async () => {
    const f = fakeFetch(() => ({status: 200, body: {agents: []}}));
    await client(f.impl).discover({capability: 'market-research'});
    expect((f.calls[0]!.init!.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('sends the key for a budget lookup, which is not public', async () => {
    const f = fakeFetch(() => ({status: 200, body: {dailyRemaining: '0'}}));
    await client(f.impl).budget();
    expect((f.calls[0]!.init!.headers as Record<string, string>)['authorization']).toBe('Bearer ax_test');
  });
});

describe('awaitResult', () => {
  /**
   * The settled job carries a result, because on the escrow path it cannot
   * not: settled means the client approved, and approving something that was
   * never delivered is not a state the contract can reach. The old fixture
   * settled with `result` absent, which described a job that cannot exist —
   * and that fiction is what let `awaitResult` return on the state alone.
   */
  it('polls until the job reaches a terminal state', async () => {
    const f = fakeFetch((call) => ({
      status: 200,
      body:
        call < 3
          ? {jobId: '1', state: 'accepted'}
          : {jobId: '1', state: 'settled', result: {summary: 'delivered'}},
    }));
    const job = await client(f.impl).awaitResult('1', {timeoutMs: 5_000, pollMs: 1});
    expect(job.state).toBe('settled');
    expect(f.calls.length).toBe(3);
  });

  it('treats a refund as terminal too', async () => {
    const f = fakeFetch(() => ({status: 200, body: {jobId: '1', state: 'refunded'}}));
    const job = await client(f.impl).awaitResult('1', {timeoutMs: 1_000, pollMs: 1});
    expect(job.state).toBe('refunded');
  });

  /**
   * A timeout is not a lost payment — the job still has an on-chain deadline
   * and a permissionless exit. The error has to say which, or a caller will
   * assume the money is gone.
   */
  it('times out with DEADLINE_PASSED and says the job is still recoverable', async () => {
    const f = fakeFetch(() => ({status: 200, body: {jobId: '1', state: 'accepted'}}));
    let error: unknown;
    try {
      await client(f.impl).awaitResult('1', {timeoutMs: 5, pollMs: 1});
    } catch (err) {
      error = err;
    }
    expect((error as PactoraError).code).toBe(ErrorCode.DEADLINE_PASSED);
    expect((error as PactoraError).message).toMatch(/recoverable|expiry/i);
  });

  /**
   * A worker that is offline never accepts, and waiting out the whole
   * timeout for it wastes the run. Nobody has started, so the caller can
   * cancel for an immediate refund — but only if it is told which case this is.
   */
  it('gives up early on an offer nobody accepts, and says so distinctly', async () => {
    const f = fakeFetch(() => ({status: 200, body: {jobId: '1', state: 'created'}}));
    let error: unknown;
    try {
      await client(f.impl).awaitResult('1', {timeoutMs: 60_000, acceptWithinMs: 5, pollMs: 1});
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(NotAccepted);
    // Still a deadline, so a caller that only knows timeouts handles it.
    expect((error as PactoraError).code).toBe(ErrorCode.DEADLINE_PASSED);
  });

  it('does not give up on an accepted job just because it was slow to be accepted', async () => {
    const f = fakeFetch((call) => ({
      status: 200,
      body: call < 3 ? {jobId: '1', state: 'accepted'} : {jobId: '1', state: 'submitted', result: {ok: true}},
    }));
    const job = await client(f.impl).awaitResult('1', {timeoutMs: 5_000, acceptWithinMs: 0, pollMs: 2});
    expect(job.result).toEqual({ok: true});
  });

  /**
   * A worker that said no has answered. Waiting out the accept window for it
   * cost every run 45 s and hid the reason behind "never accepted".
   */
  it('stops at once when the worker declined, and carries its reason', async () => {
    const f = fakeFetch(() => ({
      status: 200,
      body: {jobId: '1', state: 'created', declined: {reason: 'needs a private API key', at: 'now'}},
    }));
    let error: unknown;
    try {
      await client(f.impl).awaitResult('1', {timeoutMs: 60_000, acceptWithinMs: 45_000, pollMs: 1});
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(NotAccepted);
    expect((error as NotAccepted).declinedReason).toBe('needs a private API key');
    expect((error as PactoraError).message).toMatch(/declined: needs a private API key/);
    expect(f.calls.length).toBe(1);
  });
});

describe('decline', () => {
  it('posts the reason to the decline route', async () => {
    const f = fakeFetch(() => ({status: 200, body: {jobId: '7', declined: {reason: 'no', at: 'now'}}}));
    await client(f.impl).decline('7', 'outside my capability');
    expect(f.calls[0]!.url).toMatch(/\/v1\/jobs\/7\/decline$/);
    expect(f.calls[0]!.init!.method).toBe('POST');
    expect(JSON.parse(String(f.calls[0]!.init!.body))).toEqual({reason: 'outside my capability'});
  });
});

describe('query building', () => {
  it('passes discovery filters through and pins the chain', async () => {
    const f = fakeFetch(() => ({status: 200, body: {agents: []}}));
    await client(f.impl).discover({
      capability: 'market-research',
      maxPrice: '50000',
      minScore: 70,
      rank: 'cheapest',
      limit: 5,
    });

    const url = f.calls[0]!.url;
    for (const part of [
      'capability=market-research',
      'maxPrice=50000',
      'minScore=70',
      'rank=cheapest',
      'limit=5',
      'chainId=near%3Atestnet',
    ]) {
      expect(url).toContain(part);
    }
  });

  it('omits filters that were not given, rather than sending empty ones', async () => {
    const f = fakeFetch(() => ({status: 200, body: {agents: []}}));
    await client(f.impl).discover({});
    expect(f.calls[0]!.url).not.toContain('capability=');
    expect(f.calls[0]!.url).not.toContain('minScore=');
  });
});

describe('a POST with nothing to say', () => {
  /**
   * `accept` has no body. It was still sent with
   * `content-type: application/json`, and Fastify rejects exactly that
   * combination — `FST_ERR_CTP_EMPTY_JSON_BODY`, "Body cannot be empty when
   * content-type is set to 'application/json'".
   *
   * So no worker could ever accept an escrow job. Every escrow hire in the
   * demo timed out, was refunded, and no reputation was ever written — the
   * one claim the project exists to make, defeated by a header on an empty
   * request.
   */
  it('does not declare a JSON body it is not sending', async () => {
    const f = fakeFetch(() => ({status: 200, body: {jobId: '1', state: 'accepted'}}));
    await client(f.impl).accept('1');

    const {init} = f.calls[0]!;
    expect(init!.body).toBeUndefined();
    const headers = init!.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
  });

  it('still authenticates and carries the idempotency key', async () => {
    const f = fakeFetch(() => ({status: 200, body: {jobId: '1', state: 'accepted'}}));
    await client(f.impl).accept('1');

    const headers = f.calls[0]!.init!.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer ax_test');
  });

  it('keeps the content type on a POST that does have a body', async () => {
    const f = fakeFetch(() => ({status: 200, body: {jobId: '1', state: 'submitted'}}));
    await client(f.impl).submitResult('1', {output: {summary: 'x'}});

    const headers = f.calls[0]!.init!.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(f.calls[0]!.init!.body).toContain('summary');
  });
});

describe('waiting for work, not for a state', () => {
  /**
   * `awaitResult` returned as soon as the job reached `settled`.
   *
   * On the escrow path that is right — settled means the client approved,
   * which means a result exists. On the fast path it is exactly backwards: a
   * direct-pay job is settled the instant it is created, because the client
   * has already paid. So the orchestrator hired a worker, polled once,
   * found a settled job with no result, and reported "job ended as settled
   * with no result" about work that had not been started yet.
   *
   * What is being waited for is the RESULT. The state is how you know it is
   * never coming.
   */
  const job = (over: Record<string, unknown>) => ({
    jobId: '1',
    chainId: 'near:testnet',
    state: 'settled',
    path: 'direct',
    result: null,
    ...over,
  });

  it('keeps waiting on a job that is paid but not yet delivered', async () => {
    const f = fakeFetch((call) => ({
      status: 200,
      body: call < 3 ? job({}) : job({result: {summary: 'done'}}),
    }));

    const settled = await client(f.impl).awaitResult('1', {timeoutMs: 5_000, pollMs: 1});

    expect(settled.result).toEqual({summary: 'done'});
    expect(f.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('returns at once when the result is already there', async () => {
    const f = fakeFetch(() => ({status: 200, body: job({result: {summary: 'done'}})}));

    await client(f.impl).awaitResult('1', {timeoutMs: 5_000, pollMs: 1});

    expect(f.calls.length).toBe(1);
  });

  it('returns a refund immediately — there is no result coming', async () => {
    const f = fakeFetch(() => ({status: 200, body: job({state: 'refunded'})}));

    const out = await client(f.impl).awaitResult('1', {timeoutMs: 5_000, pollMs: 1});

    expect(out.state).toBe('refunded');
    expect(f.calls.length).toBe(1);
  });

  it('times out rather than waiting forever on a job nobody is working', async () => {
    const f = fakeFetch(() => ({status: 200, body: job({})}));

    await expect(client(f.impl).awaitResult('1', {timeoutMs: 30, pollMs: 1})).rejects.toThrow(
      /still "settled"|remains recoverable/,
    );
  });
});

/**
 * v3: paying for an HTTP resource with the refundable scheme. The money
 * waits in escrow, so a worker that answers 502 — paid, could not deliver —
 * costs the client nothing: the SDK cancels the job and the escrow refunds.
 */
describe('payX402 with the escrow-backed scheme', () => {
  const RESOURCE = 'http://worker.test/market-research';
  const accepts = [
    {scheme: 'pactora-directpay', maxAmountRequired: '20000', resource: RESOURCE, extra: {agentId: 2}},
    {scheme: 'pactora-escrow', maxAmountRequired: '20000', resource: RESOURCE, extra: {agentId: 2}},
  ];
  const settled = (scheme: string) => ({
    success: true,
    transaction: '0x' + 'ab'.repeat(32),
    network: 'near:testnet',
    payer: 7,
    jobId: '5f0c1a9e-2b7d-4c3e-9a61-0d8e4f7b2c11',
    paymentHeader: Buffer.from(JSON.stringify({scheme})).toString('base64'),
  });

  it('pays with the scheme it was asked for, when the quote offers it', async () => {
    const f = fakeFetch((n, url, init) => {
      if (url === RESOURCE && n === 1) return {status: 402, body: {x402Version: 1, error: 'pay', accepts}};
      if (url.endsWith('/v1/x402/settle')) {
        const body = JSON.parse(String(init?.body)) as {paymentRequirements: {scheme: string}};
        return {status: 200, body: settled(body.paymentRequirements.scheme)};
      }
      return {status: 200, body: {output: {summary: 'deep'}}};
    });
    const {settlement} = await client(f.impl).payX402(RESOURCE, {
      maxAmount: '20000',
      body: {input: {}},
      scheme: 'pactora-escrow',
    });
    expect(settlement?.paymentHeader).toBe(
      Buffer.from(JSON.stringify({scheme: 'pactora-escrow'})).toString('base64'),
    );
  });

  it('cancels the job for its refund when the paid worker could not deliver', async () => {
    const f = fakeFetch((n, url) => {
      if (url === RESOURCE && n === 1) return {status: 402, body: {x402Version: 1, error: 'pay', accepts}};
      if (url.endsWith('/v1/x402/settle')) return {status: 200, body: settled('pactora-escrow')};
      if (url === RESOURCE)
        return {status: 502, body: {error: 'paid, but the work failed', refund: 'cancel'}};
      if (url.endsWith('/cancel'))
        return {status: 200, body: {jobId: 'x', state: 'refunded', txHash: '0x' + 'ef'.repeat(32)}};
      return {status: 404, body: {}};
    });
    const out = await client(f.impl).payX402(RESOURCE, {
      maxAmount: '20000',
      body: {input: {}},
      scheme: 'pactora-escrow',
    });
    expect(out.response.status).toBe(502);
    expect(out.refunded).toBe(true);
    // Broadcast, not yet confirmed: the hash is how the caller waits for it.
    expect(out.refundTx).toBe('0x' + 'ef'.repeat(32));
    expect(f.calls.some((c) => c.url.endsWith('/v1/jobs/5f0c1a9e-2b7d-4c3e-9a61-0d8e4f7b2c11/cancel'))).toBe(
      true,
    );
  });

  // Found live on testnet: the worker answered 502 before the indexer had
  // seen the job, and the API refused the cancel as not yet confirmed.
  it('waits for the job to be confirmed before cancelling it', async () => {
    let cancels = 0;
    const f = fakeFetch((n, url) => {
      if (url === RESOURCE && n === 1) return {status: 402, body: {x402Version: 1, error: 'pay', accepts}};
      if (url.endsWith('/v1/x402/settle')) return {status: 200, body: settled('pactora-escrow')};
      if (url === RESOURCE)
        return {status: 502, body: {error: 'paid, but the work failed', refund: 'cancel'}};
      if (url.endsWith('/cancel')) {
        cancels++;
        return cancels < 3
          ? {
              status: 409,
              body: {code: 'INVALID_STATE', detail: 'not confirmed on-chain yet', retryAfter: 0.01},
            }
          : {status: 200, body: {jobId: 'x', state: 'refunded'}};
      }
      return {status: 404, body: {}};
    });
    const out = await client(f.impl).payX402(RESOURCE, {
      maxAmount: '20000',
      body: {input: {}},
      scheme: 'pactora-escrow',
    });
    expect(out.refunded).toBe(true);
    expect(cancels).toBe(3);
  });

  it('keeps the response and says the refund is pending when the cancel cannot land', async () => {
    const f = fakeFetch((n, url) => {
      if (url === RESOURCE && n === 1) return {status: 402, body: {x402Version: 1, error: 'pay', accepts}};
      if (url.endsWith('/v1/x402/settle')) return {status: 200, body: settled('pactora-escrow')};
      if (url === RESOURCE)
        return {status: 502, body: {error: 'paid, but the work failed', refund: 'cancel'}};
      if (url.endsWith('/cancel')) return {status: 403, body: {code: 'FORBIDDEN', detail: 'no'}};
      return {status: 404, body: {}};
    });
    const out = await client(f.impl).payX402(RESOURCE, {
      maxAmount: '20000',
      body: {input: {}},
      scheme: 'pactora-escrow',
    });
    expect(out.response.status).toBe(502);
    expect(out.refunded).toBe(false);
    expect(out.refundError).toMatch(/no/);
  });
});
