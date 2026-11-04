import {z} from 'zod';
import {BaseUnits, Capability, type JobSpec} from './job.js';

/**
 * x402 — HTTP 402 Payment Required, made to mean something.
 *
 * The message shapes follow x402 v1 (`PaymentRequirements`, the `X-PAYMENT`
 * and `X-PAYMENT-RESPONSE` headers, a facilitator's verify and settle), so a
 * client that speaks x402 recognises the conversation. The SCHEME is ours,
 * and it is named for what it is rather than borrowing `exact`:
 *
 * - `exact` has the client sign an EIP-3009 `transferWithAuthorization`,
 *   which the facilitator submits. The test token has no such function, and
 *   more to the point a Pactora agent's key lives in the signer, not in the
 *   agent — there is nothing for the agent to sign with.
 * - `agentx-directpay` has the client settle FIRST, through the facilitator,
 *   as a `directPay` on `TaskEscrow`: paid, settled and feedback recorded in
 *   one transaction, under the same caps as every other spend. The receipt of
 *   that payment is what goes in `X-PAYMENT`, and the worker redeems it once.
 *
 * So the payment is on chain before the worker does anything, and the
 * worker's only question — "was I paid, for this, and not already?" — is one
 * the facilitator answers from the chain and a one-row ledger.
 *
 * - `agentx-escrow` (v3) is the refundable one. The facilitator settles the
 *   payment as an escrow job, so the money waits in the escrow while the
 *   worker works. The worker does the work first; only then does it accept
 *   and submit on chain. A worker that cannot deliver declines, and the client
 *   cancels for a full refund; one that accepts and vanishes is refunded by
 *   the deadline exits, with its bond. Slower than `agentx-directpay` (more
 *   transactions) and not capped by the fast path, only by `maxJobAmount`.
 */

export const X402_VERSION = 1;
export const X402_SCHEME = 'agentx-directpay';
export const X402_ESCROW_SCHEME = 'agentx-escrow';
export const X402Scheme = z.enum([X402_SCHEME, X402_ESCROW_SCHEME]);
export type X402Scheme = z.infer<typeof X402Scheme>;

export const PaymentRequirements = z.object({
  scheme: X402Scheme,
  /** The network slug, e.g. `monad-testnet`. A payment on another chain is refused. */
  network: z.string().min(1),
  /** What this resource costs, in token base units. */
  maxAmountRequired: BaseUnits,
  /** The URL being paid for. The payment is bound to it. */
  resource: z.string().url(),
  description: z.string().max(500).default(''),
  mimeType: z.string().default('application/json'),
  /** The worker's payout wallet — where `directPay` sends the money. */
  payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  maxTimeoutSeconds: z.number().int().positive().max(3_600).default(300),
  /** The payment token. */
  asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  extra: z.object({
    /** The worker's Pactora agent id — who is being paid. */
    agentId: z.number().int().positive(),
    capability: Capability,
  }),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirements>;

/** The body of a 402 response. */
export interface PaymentRequired {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
}

/** What goes, base64-encoded JSON, in the `X-PAYMENT` header. */
export const PaymentPayload = z.object({
  x402Version: z.literal(X402_VERSION),
  scheme: X402Scheme,
  network: z.string().min(1),
  payload: z.object({
    /** The Pactora job the facilitator settled this payment as — its public id. */
    jobId: z.string().uuid(),
    txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
});
export type PaymentPayload = z.infer<typeof PaymentPayload>;

export interface VerifyResponse {
  isValid: boolean;
  /** Stable, machine-readable. Absent when valid. */
  invalidReason?: X402InvalidReason;
  /** Human-readable detail for the log. */
  detail?: string;
  /** The paying agent's id. */
  payer?: number;
}

export interface SettleResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer: number;
  jobId: string;
  /** The ready-made `X-PAYMENT` header value for the retry. */
  paymentHeader: string;
}

export type X402InvalidReason =
  | 'wrong_network'
  | 'unknown_payment'
  | 'wrong_payee'
  | 'wrong_resource'
  | 'insufficient_amount'
  | 'not_direct_payment'
  | 'transaction_mismatch'
  | 'payment_pending'
  | 'payment_reverted'
  | 'already_redeemed'
  /** v3: the payment's scheme is not the one the quote names. */
  | 'wrong_scheme'
  /** v3: an escrow payment the client has already cancelled or that has ended. */
  | 'payment_withdrawn';

/**
 * The job an x402 payment is recorded as.
 *
 * The resource and a nonce go into the spec, so the spec hash — which is what
 * the chain commits to — binds the payment to this URL, and two payments for
 * the same URL are two jobs rather than one replayed.
 */
export function x402JobSpec(requirements: PaymentRequirements, nonce: string): JobSpec {
  return {
    capability: requirements.extra.capability,
    input: {x402: {resource: requirements.resource, nonce}},
    deadlineSeconds: Math.max(10, requirements.maxTimeoutSeconds),
  };
}

/** Is this job an x402 payment, delivered over HTTP rather than through the job API? */
export function isX402Spec(spec: {input?: Record<string, unknown>}): boolean {
  const marker = spec.input?.['x402'];
  return typeof marker === 'object' && marker !== null && 'resource' in marker;
}

export function encodePaymentHeader(payment: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payment), 'utf8').toString('base64');
}

/** Parses an `X-PAYMENT` header. Throws on anything that is not a well-formed payload. */
export function decodePaymentHeader(header: string): PaymentPayload {
  return PaymentPayload.parse(JSON.parse(Buffer.from(header, 'base64').toString('utf8')));
}
