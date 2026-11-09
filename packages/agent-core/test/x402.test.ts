import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  X402_SCHEME,
  encodePaymentHeader,
  type PaymentRequirements,
  type VerifyResponse,
} from '@pactora/shared';
import type {PactoraClient, JobSummary} from '@pactora/sdk';
import {
  Worker,
  serveX402,
  type Brain,
  type CompletionRequest,
  type CompletionResult,
  type X402Server,
} from '../src/index.js';

/**
 * A worker's paid endpoint, and the one change x402 makes to its job loop.
 *
 * The facilitator is faked here — its own checks are tested against a real
 * database in apps/api/test/x402.test.ts. What is under test is the worker's
 * side of the bargain: no work without a redeemed payment, a still-confirming
 * payment waited for rather than bounced, and a paid answer that lands on the
 * record as well as in the response.
 */

const Output = z.object({summary: z.string(), confidence: z.number()});

class FakeBrain implements Brain {
  readonly name = 'fake';
  calls = 0;
  async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
    this.calls++;
    const reply =
      req.schemaName === 'TriageDecision' ? {accept: true, reason: 'ok'} : {summary: 'deep', confidence: 0.9};
    return {value: req.schema.parse(reply), provider: 'fake', model: 'fake', cached: false};
  }
  async available() {
    return true;
  }
}

/** A job's public id — what the facilitator puts in a payment. */
const JOB = '5f0c1a9e-2b7d-4c3e-9a61-0d8e4f7b2c11';

const HEADER = encodePaymentHeader({
  x402Version: 1,
  scheme: X402_SCHEME,
  network: 'near:testnet',
  payload: {jobId: JOB, txHash: 'TxAbzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'},
});

interface Seen {
  redeemed: {req: PaymentRequirements; header: string}[];
  submitted: {jobId: string; output: Record<string, unknown>}[];
}

function fakeClient(verdicts: VerifyResponse[], seen: Seen, offers: JobSummary[] = []): PactoraClient {
  return {
    listJobs: async () => offers,
    accept: async () => ({}),
    x402Redeem: async (req: PaymentRequirements, header: string) => {
      seen.redeemed.push({req, header});
      return verdicts.length > 1 ? verdicts.shift()! : verdicts[0]!;
    },
    submitResult: async (jobId: string, result: {output: Record<string, unknown>}) => {
      seen.submitted.push({jobId, output: result.output});
      return {};
    },
  } as unknown as PactoraClient;
}

let server: X402Server | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(verdicts: VerifyResponse[]) {
  const seen: Seen = {redeemed: [], submitted: []};
  const brain = new FakeBrain();
  const client = fakeClient(verdicts, seen);
  const worker = new Worker({client, brain, capability: 'market-research', role: 'research', output: Output});
  server = await serveX402({
    worker,
    client,
    port: 0,
    publicUrl: 'http://127.0.0.1:9402',
    agentId: 2,
    price: '20000',
    payTo: 'worker.pactora.testnet',
    asset: 'musdc.pactora.testnet',
    network: 'near:testnet',
    confirmWaitMs: 3_000,
  });
  return {seen, brain, url: server.url};
}

const post = (
  url: string,
  headers: Record<string, string> = {},
  body: unknown = {input: {question: 'depth?'}},
) =>
  fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json', ...headers},
    body: JSON.stringify(body),
  });

describe('the paid endpoint', () => {
  it('answers 402 with a quote, and does no work, when there is no payment', async () => {
    const {seen, brain, url} = await start([{isValid: true}]);
    const res = await post(url);

    expect(res.status).toBe(402);
    const body = (await res.json()) as {x402Version: number; accepts: unknown[]};
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toEqual([
      expect.objectContaining({
        scheme: X402_SCHEME,
        maxAmountRequired: '20000',
        resource: 'http://127.0.0.1:9402/market-research',
        extra: {agentId: 2, capability: 'market-research'},
      }),
    ]);
    expect(seen.redeemed).toHaveLength(0);
    expect(brain.calls).toBe(0);
  });

  it('redeems before working, serves the answer, and puts it on the record', async () => {
    const {seen, brain, url} = await start([{isValid: true, payer: 1}]);
    const res = await post(url, {'x-payment': HEADER});

    expect(res.status).toBe(200);
    expect(((await res.json()) as {output: unknown}).output).toEqual({summary: 'deep', confidence: 0.9});
    expect(seen.redeemed).toEqual([
      {req: expect.objectContaining({resource: 'http://127.0.0.1:9402/market-research'}), header: HEADER},
    ]);
    expect(brain.calls).toBe(1);
    expect(seen.submitted).toEqual([{jobId: JOB, output: {summary: 'deep', confidence: 0.9}}]);

    const receipt = JSON.parse(
      Buffer.from(res.headers.get('x-payment-response')!, 'base64').toString('utf8'),
    );
    expect(receipt).toEqual({
      success: true,
      transaction: 'TxAbzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      network: 'near:testnet',
      payer: 1,
    });
  });

  it('refuses with 402, and does no work, when the facilitator says the payment is no good', async () => {
    const {seen, brain, url} = await start([{isValid: false, invalidReason: 'already_redeemed'}]);
    const res = await post(url, {'x-payment': HEADER});

    expect(res.status).toBe(402);
    expect(((await res.json()) as {error: string}).error).toBe('already_redeemed');
    expect(brain.calls).toBe(0);
    expect(seen.submitted).toHaveLength(0);
  });

  it('waits for a payment that is still confirming rather than bouncing a client that has paid', async () => {
    const {seen, url} = await start([
      {isValid: false, invalidReason: 'payment_pending'},
      {isValid: true, payer: 1},
    ]);
    const res = await post(url, {'x-payment': HEADER});

    expect(res.status).toBe(200);
    expect(seen.redeemed).toHaveLength(2);
  });

  it('gives up on a payment that never confirms, with 402 and no work', async () => {
    const {brain, url} = await start([{isValid: false, invalidReason: 'payment_pending'}]);
    const res = await post(url, {'x-payment': HEADER});

    expect(res.status).toBe(402);
    expect(((await res.json()) as {error: string}).error).toBe('payment_pending');
    expect(brain.calls).toBe(0);
  }, 10_000);

  it('rejects a body without an input object', async () => {
    const {url} = await start([{isValid: true}]);
    expect((await post(url, {'x-payment': HEADER}, {question: 'no input wrapper'})).status).toBe(400);
  });
});

describe('the job loop, beside the paid endpoint', () => {
  it('leaves x402 payments to the endpoint instead of doing the work twice', async () => {
    const seen: Seen = {redeemed: [], submitted: []};
    const paidByX402: JobSummary = {
      jobId: '9',
      chainJobId: '9',
      chainId: 'near:testnet',
      state: 'settled',
      path: 'direct',
      amount: '20000',
      amountDisplay: '0.02 USDC',
      spec: {
        capability: 'market-research',
        input: {x402: {resource: 'http://127.0.0.1:9402/market-research', nonce: 'n'}},
        deadlineSeconds: 300,
      },
      specHash: '',
      role: 'worker',
      hasResult: false,
      clientAgentId: '1',
      workerAgentId: '2',
      createdAt: new Date().toISOString(),
    };
    const brain = new FakeBrain();
    const worker = new Worker({
      client: fakeClient([{isValid: true}], seen, [paidByX402]),
      brain,
      capability: 'market-research',
      role: 'research',
      output: Output,
    });

    expect(await worker.tick()).toEqual([]);
    expect(brain.calls).toBe(0);
    expect(seen.submitted).toHaveLength(0);
  });
});

/**
 * v3: the refundable scheme. An escrow-backed payment holds the money in the
 * escrow while the worker works, so a worker that cannot deliver costs the
 * client nothing: it declines, and the client cancels for a full refund. The
 * work is done BEFORE anything is committed on chain, so a failure never
 * becomes a seized bond for an honest worker.
 */
describe('the escrow-backed scheme (pactora-escrow)', () => {
  const ESCROW_HEADER = encodePaymentHeader({
    x402Version: 1,
    scheme: 'pactora-escrow',
    network: 'near:testnet',
    payload: {jobId: JOB, txHash: 'TxCdzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'},
  });

  async function startEscrow(brainFails = false) {
    const order: string[] = [];
    const seen: Seen = {redeemed: [], submitted: []};
    const client = {
      listJobs: async () => [],
      x402Redeem: async (req: PaymentRequirements, header: string) => {
        seen.redeemed.push({req, header});
        order.push('redeem');
        return {isValid: true, payer: 7};
      },
      accept: async (jobId: string) => {
        order.push(`accept:${jobId}`);
        return {};
      },
      submitResult: async (jobId: string, result: {output: Record<string, unknown>}) => {
        order.push(`submit:${jobId}`);
        seen.submitted.push({jobId, output: result.output});
        return {};
      },
      decline: async (jobId: string, reason: string) => {
        order.push(`decline:${jobId}:${reason.slice(0, 20)}`);
        return {jobId, declined: {reason, at: ''}};
      },
    } as unknown as PactoraClient;
    const brain = brainFails
      ? ({
          name: 'down',
          complete: async () => {
            throw new Error('model unavailable');
          },
          available: async () => true,
        } as unknown as Brain)
      : new FakeBrain();
    const worker = new Worker({
      client,
      brain,
      capability: 'market-research',
      role: 'research',
      output: Output,
    });
    const answer = worker.answer.bind(worker);
    worker.answer = async (input: Record<string, unknown>) => {
      order.push('work');
      return answer(input);
    };
    server = await serveX402({
      worker,
      client,
      port: 0,
      publicUrl: 'http://127.0.0.1:9402',
      agentId: 2,
      price: '20000',
      payTo: 'worker.pactora.testnet',
      asset: 'musdc.pactora.testnet',
      network: 'near:testnet',
      schemes: ['pactora-directpay', 'pactora-escrow'],
      confirmWaitMs: 3_000,
    });
    return {order, seen, url: server.url};
  }

  it('offers both schemes in the quote when asked to', async () => {
    const {url} = await startEscrow();
    const body = (await (await post(url)).json()) as {accepts: {scheme: string}[]};
    expect(body.accepts.map((a) => a.scheme)).toEqual(['pactora-directpay', 'pactora-escrow']);
  });

  it('works first, then accepts and submits on chain, then answers', async () => {
    const {order, seen, url} = await startEscrow();
    const res = await post(url, {'x-payment': ESCROW_HEADER});
    expect(res.status).toBe(200);
    expect(order).toEqual(['redeem', 'work', `accept:${JOB}`, `submit:${JOB}`]);
    expect(seen.redeemed[0]!.req.scheme).toBe('pactora-escrow');
  });

  it('declines without accepting when the work fails, and says how to get the refund', async () => {
    const {order, url} = await startEscrow(true);
    const res = await post(url, {'x-payment': ESCROW_HEADER});
    expect(res.status).toBe(502);
    const body = (await res.json()) as {jobId: string; refund: string};
    expect(body.jobId).toBe(JOB);
    expect(body.refund).toMatch(/cancel/);
    expect(order.some((o) => o.startsWith('accept'))).toBe(false);
    expect(order.some((o) => o.startsWith('decline'))).toBe(true);
  });
});
