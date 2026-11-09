import type {FastifyInstance} from 'fastify';
import {and, eq} from 'drizzle-orm';
import {z} from 'zod';
import {agents, jobEvents, jobs, x402Redemptions, type Db} from '@pactora/db';
import {
  ChainId,
  PactoraError,
  ErrorCode,
  PaymentPayload,
  PaymentRequirements,
  X402_ESCROW_SCHEME,
  X402_VERSION,
  decodePaymentHeader,
  encodePaymentHeader,
  x402JobSpec,
  type SettleResponse,
  type VerifyResponse,
} from '@pactora/shared';
import type {ChainConfig} from '@pactora/config';
import {authenticate, resolveChainId, type Caller} from '../auth.js';
import type {EventBus} from '../events.js';
import type {PaymentReader} from '../chain-reads.js';
import {hire, requiredIdempotencyKey, type JobRouteDeps} from './jobs.js';

/**
 * The x402 facilitator.
 *
 * Three endpoints, two parties:
 *
 * - `settle` — the CLIENT pays for a resource it was quoted in a 402. The
 *   payment is a fast-path hire of the worker named in the quote, so it runs
 *   through every rule a hire does: the signer's caps (or the AgentAccount's,
 *   on chain), idempotency, on-chain agent ids. The answer carries the ready-made
 *   `X-PAYMENT` header for the retry.
 * - `verify` — the WORKER asks whether a presented payment is good. No side
 *   effects; safe to call twice.
 * - `redeem` — `verify`, and then mark the payment used, atomically. What a
 *   worker calls before serving. Without it one payment buys unlimited
 *   responses: the chain records that money moved, not how often it was
 *   shown.
 *
 * Every check is answered from the chain as well as the database. The row
 * says what the API asked for; only the receipt says what the escrow did.
 */

/** The x402 `network` is the CAIP-2 chain id itself (docs/NEAR-PORT.md §1). */
export const x402Network = (chainId: string): ChainId => ChainId.parse(chainId);

export const SettleBody = z.object({paymentRequirements: PaymentRequirements});

export const VerifyBody = z
  .object({
    paymentRequirements: PaymentRequirements,
    /** The `X-PAYMENT` header exactly as the client sent it… */
    paymentHeader: z.string().optional(),
    /** …or already decoded. */
    paymentPayload: PaymentPayload.optional(),
  })
  .refine((b) => b.paymentHeader !== undefined || b.paymentPayload !== undefined, {
    message: 'one of paymentHeader or paymentPayload is required',
  });

export interface X402RouteDeps extends Pick<JobRouteDeps, 'db' | 'submit'> {
  chains: Record<string, ChainConfig>;
  bus: EventBus;
  /** Omitted, nothing can be verified — and nothing is ever reported valid. */
  readPayment?: PaymentReader;
}

export async function registerX402Routes(app: FastifyInstance, deps: X402RouteDeps): Promise<void> {
  const {db, chains, bus, submit} = deps;
  const enabled = Object.keys(chains);

  app.post('/v1/x402/settle', async (request, reply) => {
    const caller = await authenticate(db, request);
    const chainId = resolveChainId(request, caller, enabled);
    const chain = chains[chainId]!;

    const idempotencyKey = requiredIdempotencyKey(request);

    const {paymentRequirements: req} = SettleBody.parse(request.body);
    await checkQuote(db, chain, req);
    const escrowed = req.scheme === X402_ESCROW_SCHEME;
    const asked = BigInt(req.maxAmountRequired);

    if (escrowed) {
      // v3: the money waits in the escrow, so there is no fast-path cap —
      // only the escrow's own ceiling on one job.
      const maxJobAmount = chain.params.maxJobAmount;
      if (asked > maxJobAmount) {
        throw new PactoraError(
          ErrorCode.PRICE_ABOVE_MAX,
          `an escrow job may carry at most ${chain.formatToken(maxJobAmount)}; this resource asks ${chain.formatToken(asked)}`,
        );
      }
    } else {
      // Pay-first by definition: there is no escrow to hold the money while the
      // worker works, so a quote above the fast-path cap cannot be paid this
      // way at all. Said here, before the signer, rather than as a revert.
      const fastPathMax = chain.params.fastPathMax;
      if (asked > fastPathMax) {
        throw new PactoraError(
          ErrorCode.PRICE_ABOVE_MAX,
          `x402 pays up front, on the fast path, which is capped at ${chain.formatToken(fastPathMax)} — ` +
            `this resource asks ${chain.formatToken(asked)}; pay with the ${X402_ESCROW_SCHEME} scheme instead`,
        );
      }
    }

    // The nonce is the Idempotency-Key: a retried settle is the same
    // payment, and a new key is a new payment for the same URL.
    const receipt = await hire(
      {db, bus, submit},
      {caller, chainId, chain, idempotencyKey, traceId: request.id},
      {
        workerAgentId: String(req.extra.agentId),
        spec: x402JobSpec(req, idempotencyKey),
        maxPrice: req.maxAmountRequired,
        path: escrowed ? 'escrow' : 'direct',
      },
    );

    const network = x402Network(chainId);
    const body: SettleResponse = {
      success: true,
      transaction: receipt.txHash,
      network,
      payer: caller.agentId,
      jobId: receipt.jobId,
      paymentHeader: encodePaymentHeader({
        x402Version: X402_VERSION,
        scheme: req.scheme,
        network,
        payload: {jobId: receipt.jobId, txHash: receipt.txHash},
      }),
    };
    return reply.status(200).send(body);
  });

  app.post('/v1/x402/verify', async (request) => {
    const caller = await authenticate(db, request);
    const chainId = resolveChainId(request, caller, enabled);
    const {req, payment} = parseVerify(request.body);
    const {verdict, jobRowId} = await check(deps, caller, chainId, req, payment);
    if (!verdict.isValid) return verdict;

    const used = await db.query.x402Redemptions.findFirst({
      where: eq(x402Redemptions.jobId, jobRowId!),
    });
    return used
      ? invalid('already_redeemed', 'this payment has already been redeemed', verdict.payer)
      : verdict;
  });

  app.post('/v1/x402/redeem', async (request) => {
    const caller = await authenticate(db, request);
    const chainId = resolveChainId(request, caller, enabled);
    const {req, payment} = parseVerify(request.body);
    const {verdict: checked, jobRowId} = await check(deps, caller, chainId, req, payment);
    if (!checked.isValid) return checked;

    // One insert decides it. Two concurrent redemptions of one payment both
    // pass every check above; only one of them gets the row.
    const won = await db
      .insert(x402Redemptions)
      .values({jobId: jobRowId!, resource: req.resource})
      .onConflictDoNothing()
      .returning();
    return won.length === 1
      ? checked
      : invalid('already_redeemed', 'this payment has already been redeemed', checked.payer);
  });
}

function parseVerify(raw: unknown): {req: PaymentRequirements; payment: PaymentPayload} {
  const body = VerifyBody.parse(raw);
  let payment: PaymentPayload;
  try {
    payment = body.paymentPayload ?? decodePaymentHeader(body.paymentHeader!);
  } catch {
    throw new PactoraError(
      ErrorCode.SCHEMA_MISMATCH,
      'X-PAYMENT is not a base64-encoded x402 payment payload',
    );
  }
  return {req: body.paymentRequirements, payment};
}

/**
 * Does this quote describe a real, payable agent — before anyone pays it?
 *
 * The quote comes from whoever answered the 402, which is not necessarily
 * the agent it names. A `payTo` that is not that agent's registered wallet,
 * or an `asset` that is not this chain's payment token, is a quote steering
 * money somewhere the client did not choose.
 */
async function checkQuote(db: Db, chain: ChainConfig, req: PaymentRequirements): Promise<void> {
  if (req.network !== x402Network(chain.chainId)) {
    throw new PactoraError(
      ErrorCode.CHAIN_MISMATCH,
      `quote is for ${req.network}; this facilitator settles on ${x402Network(chain.chainId)}`,
    );
  }
  const worker = await db.query.agents.findFirst({
    where: and(eq(agents.id, req.extra.agentId), eq(agents.chainId, chain.chainId)),
  });
  if (!worker) {
    throw new PactoraError(
      ErrorCode.AGENT_NOT_HIREABLE,
      `no agent ${req.extra.agentId} on chain ${chain.chainId}`,
    );
  }
  if (worker.walletAddress.toLowerCase() !== req.payTo.toLowerCase()) {
    throw new PactoraError(
      ErrorCode.INVALID_STATE,
      `payTo ${req.payTo} is not agent ${worker.id}'s registered wallet — refusing to pay a quote that redirects the money`,
    );
  }
  const token = chain.contracts['PaymentToken']?.toLowerCase();
  if (req.asset.toLowerCase() !== token) {
    throw new PactoraError(ErrorCode.INVALID_STATE, `asset ${req.asset} is not this chain's payment token`);
  }
}

/** Every check a worker needs before serving, in the order cheapest-first. */
async function check(
  deps: X402RouteDeps,
  caller: Caller,
  chainId: string,
  req: PaymentRequirements,
  payment: PaymentPayload,
): Promise<{verdict: VerifyResponse; jobRowId?: number}> {
  const {db} = deps;
  const network = x402Network(chainId);
  if (payment.network !== network || req.network !== network) {
    return {verdict: invalid('wrong_network', `this facilitator verifies ${network}`)};
  }
  if (payment.scheme !== req.scheme) {
    return {verdict: invalid('wrong_scheme', `paid with ${payment.scheme}; the quote is for ${req.scheme}`)};
  }
  const escrowed = req.scheme === X402_ESCROW_SCHEME;

  const job = await db.query.jobs.findFirst({
    where: and(eq(jobs.publicId, payment.payload.jobId), eq(jobs.chainId, chainId)),
  });
  if (!job) return {verdict: invalid('unknown_payment', `no payment ${payment.payload.jobId} on ${network}`)};
  const payer = job.clientAgentId;

  // Only the payee may verify or redeem. Anyone else asking is either
  // probing other agents' receipts or trying to burn one before it is used.
  if (job.workerAgentId !== caller.agentId || req.extra.agentId !== caller.agentId) {
    return {verdict: invalid('wrong_payee', 'this payment was not made to the calling agent', payer)};
  }
  if (!escrowed && job.path !== 'direct')
    return {verdict: invalid('not_direct_payment', 'an escrow job is not a direct payment', payer)};
  if (escrowed && job.path !== 'escrow')
    return {verdict: invalid('wrong_scheme', 'a direct payment is not an escrow-backed one', payer)};
  // v3: an escrow payment is good only while its money is still in escrow
  // for this work — not once the client cancelled it or the job has ended.
  if (escrowed && job.state !== 'created') {
    return {
      verdict: invalid(
        'payment_withdrawn',
        `this escrow payment is no longer open (job is ${job.state})`,
        payer,
      ),
    };
  }

  const bound = (job.spec as {input?: {x402?: {resource?: string}}}).input?.x402?.resource;
  if (bound !== req.resource) {
    return {verdict: invalid('wrong_resource', `this payment was for ${bound ?? 'no x402 resource'}`, payer)};
  }
  const required = BigInt(req.maxAmountRequired);
  if (BigInt(job.amount) < required) {
    return {
      verdict: invalid('insufficient_amount', `paid ${job.amount}, the resource costs ${required}`, payer),
    };
  }

  const created = await db.query.jobEvents.findFirst({
    where: and(eq(jobEvents.jobId, job.id), eq(jobEvents.kind, 'job.created')),
  });
  const recordedTx = (created?.payload as {txHash?: string} | undefined)?.txHash;
  // Exact: a NEAR transaction hash is base58, where case is part of the value.
  if (!recordedTx || recordedTx !== payment.payload.txHash) {
    return {
      verdict: invalid(
        'transaction_mismatch',
        'the transaction named is not the one that paid for this job',
        payer,
      ),
    };
  }

  // The chain, last and decisively.
  if (!deps.readPayment) {
    return {
      verdict: invalid(
        'payment_pending',
        'this facilitator cannot read the chain, so it cannot confirm anything',
        payer,
      ),
    };
  }
  const worker = await db.query.agents.findFirst({where: eq(agents.id, job.workerAgentId)});
  // NEAR finds a transaction by hash AND signer: the paying agent's wallet signed it.
  const client = await db.query.agents.findFirst({where: eq(agents.id, job.clientAgentId)});
  if (!client) return {verdict: invalid('unknown_payment', 'the paying agent no longer exists', payer)};
  const reading = await deps.readPayment({
    chainId,
    txHash: payment.payload.txHash,
    signerId: client.walletAddress,
  });
  if (reading.status === 'pending')
    return {verdict: invalid('payment_pending', 'not yet confirmed on chain — retry shortly', payer)};
  if (reading.status === 'reverted')
    return {verdict: invalid('payment_reverted', 'the payment transaction reverted', payer)};

  // The contract's own event for this worker and this job: direct_paid for a
  // direct payment, job_created (money locked) for an escrow-backed one.
  const events = escrowed ? (reading.jobCreated ?? []) : reading.directPaid;
  const paid = events.some(
    (e) =>
      worker?.chainAgentId !== null &&
      worker?.chainAgentId !== undefined &&
      e.workerAgentId === BigInt(worker.chainAgentId) &&
      e.specHash === job.specHash &&
      e.amount >= required,
  );
  if (!paid) {
    return {
      verdict: invalid(
        'transaction_mismatch',
        `the contract emitted no ${escrowed ? 'job_created' : 'direct_paid'} for this worker and job`,
        payer,
      ),
    };
  }
  return {verdict: {isValid: true, payer}, jobRowId: job.id};
}

function invalid(
  reason: NonNullable<VerifyResponse['invalidReason']>,
  detail: string,
  payer?: number,
): VerifyResponse {
  return {isValid: false, invalidReason: reason, detail, ...(payer !== undefined ? {payer} : {})};
}
