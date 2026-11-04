import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {
  PactoraError,
  ErrorCode,
  X402_ESCROW_SCHEME,
  X402_SCHEME,
  X402_VERSION,
  decodePaymentHeader,
  type BaseUnits,
  type PaymentRequired,
  type PaymentRequirements,
  type VerifyResponse,
  type X402Scheme,
} from '@pactora/shared';
import type {PactoraClient} from '@pactora/sdk';
import type {Worker} from './worker.js';

/**
 * A worker's paid HTTP endpoint: `POST /<capability>`, answering x402.
 *
 * Without `X-PAYMENT` it answers `402` with a quote. With one, it asks the
 * facilitator to REDEEM the payment — verify it against the chain and mark it
 * used, in one step — and only then does the work. The job the payment
 * created gets the result as well, so a paid answer is on the record exactly
 * like a hired one.
 *
 * The worker never sees money or keys here. What it holds is its own API key,
 * and the one question it asks the facilitator is "was I paid for this?".
 *
 * v3: with `schemes` including `agentx-escrow`, the quote also offers the
 * refundable scheme. Paid that way, the money is in escrow and the job is
 * still open: the worker does the work FIRST, and only on success accepts and
 * submits on chain. On failure it declines, so the client can cancel for a
 * full refund — an honest worker that could not deliver never has its bond
 * seized, because it never accepted.
 */

export interface X402ServerOptions<T> {
  worker: Worker<T>;
  /** The worker's own API client — redemption is asked AS the payee. */
  client: PactoraClient;
  port: number;
  host?: string;
  /**
   * The base URL clients reach this server at. The resource URL is bound into
   * every payment. Omitted, the address the server actually bound to.
   */
  publicUrl?: string;
  agentId: number;
  price: BaseUnits;
  payTo: string;
  asset: string;
  network: string;
  description?: string;
  /** The schemes the quote offers, in order of preference. Default: direct pay only. */
  schemes?: X402Scheme[];
  /** How long to wait for a payment the chain has not confirmed yet. */
  confirmWaitMs?: number;
  log?: (event: X402Event) => void;
}

export type X402Event =
  | {kind: 'quoted'; resource: string}
  | {kind: 'refused'; reason: string}
  | {kind: 'served'; jobId: string; payer: number | undefined}
  | {kind: 'failed'; jobId: string; reason: string};

export interface X402Server {
  url: string;
  /** The first scheme's requirements. */
  requirements: PaymentRequirements;
  /** One entry per offered scheme, as the quote lists them. */
  accepts: PaymentRequirements[];
  close(): Promise<void>;
}

export async function serveX402<T>(opts: X402ServerOptions<T>): Promise<X402Server> {
  const capability = opts.worker.capability;
  // Set once the server is listening, before it can receive a request: the
  // resource URL depends on the port actually bound when none was named.
  let accepts!: PaymentRequirements[]; // eslint-disable-line prefer-const -- assigned after listen()
  const confirmWaitMs = opts.confirmWaitMs ?? 15_000;
  const schemes = opts.schemes ?? [X402_SCHEME];
  if (schemes.length === 0) throw new Error('serveX402: at least one scheme is required');

  const quote = (error: string): PaymentRequired => ({
    x402Version: X402_VERSION,
    error,
    accepts,
  });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://x').pathname !== `/${capability}`) {
      return send(res, 404, {error: `POST /${capability} is the only resource here`});
    }

    const header = req.headers['x-payment'];
    if (typeof header !== 'string' || header.length === 0) {
      opts.log?.({kind: 'quoted', resource: accepts[0]!.resource});
      return send(res, 402, quote('X-PAYMENT header is required'));
    }

    // The payment names its scheme; redeem it against that scheme's terms,
    // and refuse one this server does not offer before asking anyone.
    let requirements: PaymentRequirements | undefined;
    try {
      const scheme = decodePaymentHeader(header).scheme;
      requirements = accepts.find((a) => a.scheme === scheme);
    } catch {
      requirements = undefined;
    }
    if (!requirements) {
      opts.log?.({kind: 'refused', reason: 'wrong_scheme'});
      return send(res, 402, quote('X-PAYMENT is not a payment in a scheme this resource accepts'));
    }

    let body: {input?: unknown};
    try {
      body = JSON.parse((await readBody(req)) || '{}') as {input?: unknown};
    } catch {
      return send(res, 400, {error: 'body must be JSON: {"input": {...}}'});
    }
    const input = body.input;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return send(res, 400, {error: 'body must be JSON: {"input": {...}}'});
    }

    // Redeem BEFORE working. A payment still confirming is waited for
    // briefly — Monad finalises in about a second — rather than bounced: a
    // client that paid and got a 402 back would reasonably pay again.
    let verdict: VerifyResponse;
    const deadline = Date.now() + confirmWaitMs;
    for (;;) {
      try {
        verdict = await opts.client.x402Redeem(requirements, header);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        opts.log?.({kind: 'refused', reason});
        return send(res, 402, quote(`payment could not be checked: ${reason}`));
      }
      if (verdict.invalidReason !== 'payment_pending' || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!verdict.isValid) {
      opts.log?.({kind: 'refused', reason: verdict.invalidReason ?? 'invalid'});
      return send(res, 402, quote(verdict.invalidReason ?? 'invalid payment'));
    }

    // Well-formed: the facilitator just redeemed it.
    const {jobId, txHash} = decodePaymentHeader(header).payload;
    const escrowed = requirements.scheme === X402_ESCROW_SCHEME;

    let output: T;
    try {
      ({output} = await opts.worker.answer(input as Record<string, unknown>));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      opts.log?.({kind: 'failed', jobId, reason});
      if (escrowed) {
        // Nothing committed on chain yet: say no, so the client's cancel is
        // a full refund and the decline is on the record. Best effort — an
        // undeclined job can be cancelled all the same.
        await opts.client
          .decline(jobId, `the work failed: ${reason}`.slice(0, 500))
          .catch((e: unknown) => opts.log?.({kind: 'failed', jobId, reason: `declining: ${String(e)}`}));
        return send(res, 502, {
          error: `the work failed: ${reason}`,
          jobId,
          refund: 'cancel this job for a full refund',
        });
      }
      // Paid and could not deliver. The fast path has no refund — that is
      // what it trades for speed, and why it is capped — so the failure is
      // said plainly and the job stays without a result, which is what the
      // worker's reputation is read from.
      return send(res, 502, {error: `paid, but the work failed: ${reason}`, jobId});
    }

    if (escrowed) {
      // Commit only now that there is a result: accept (locks the bond), then
      // submit — the money is released when the client approves or the
      // review window passes, like any escrow job. Unlike direct pay this is
      // not best effort: the worker is paid only if it lands.
      try {
        await acceptWhenOpen(opts.client, jobId, confirmWaitMs);
        await opts.client.submitResult(jobId, {output: output as Record<string, unknown>});
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        opts.log?.({kind: 'failed', jobId, reason: `committing: ${reason}`});
        return send(res, 502, {error: `the work was done but could not be committed: ${reason}`, jobId});
      }
    } else {
      // On the record, like any delivered job. Best effort: the client has its
      // answer either way, and a failure here is the worker's to see, not the
      // client's to be refused over.
      await opts.client
        .submitResult(jobId, {output: output as Record<string, unknown>})
        .catch((err: unknown) => opts.log?.({kind: 'failed', jobId, reason: `recording: ${String(err)}`}));
    }

    opts.log?.({kind: 'served', jobId, payer: verdict.payer});
    const paymentResponse = Buffer.from(
      JSON.stringify({success: true, transaction: txHash, network: opts.network, payer: verdict.payer}),
      'utf8',
    ).toString('base64');
    return send(res, 200, {output, jobId}, {'x-payment-response': paymentResponse});
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => send(res, 500, {error: String(err)}));
  });
  await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  const resource = `${(opts.publicUrl ?? `http://${opts.host ?? '127.0.0.1'}:${port}`).replace(/\/$/, '')}/${capability}`;
  accepts = schemes.map((scheme) => ({
    scheme,
    network: opts.network,
    maxAmountRequired: opts.price,
    resource,
    description: opts.description ?? `${capability}, answered by Pactora agent ${opts.agentId}`,
    mimeType: 'application/json',
    payTo: opts.payTo,
    maxTimeoutSeconds: 300,
    asset: opts.asset,
    extra: {agentId: opts.agentId, capability},
  }));

  return {
    url: `http://${opts.host ?? '127.0.0.1'}:${port}/${capability}`,
    requirements: accepts[0]!,
    accepts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Accept an escrow job, waiting briefly if the API has not seen it as open
 * yet (its creation still being indexed). Any other refusal is final.
 */
async function acceptWhenOpen(client: PactoraClient, jobId: string, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await client.accept(jobId);
      return;
    } catch (err) {
      const retry =
        err instanceof PactoraError && err.code === ErrorCode.INVALID_STATE && Date.now() < deadline;
      if (!retry) throw err;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, {'content-type': 'application/json', ...headers});
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      // An unpaid-for request has no business being large.
      if (data.length > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
