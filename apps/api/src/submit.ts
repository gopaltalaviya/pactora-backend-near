import type {PactoraConfig} from '@pactora/config';
import {PactoraError, ErrorCode} from '@pactora/shared';
import type {JobRouteDeps} from './routes/jobs.js';
import type {WalletKeys} from './routes/agents.js';

/**
 * Turn an API action into a policy-checked, signed transaction.
 *
 * The API never holds a key. It names the contract call — a method and its
 * JSON arguments (docs/NEAR-WIRE.md §6) — hands it to the signer over private
 * networking, and reports what came back. That separation is what makes "the
 * API is compromised" survivable: an attacker gets to *propose* calls, and the
 * signer's policy plus the contract's caps on the agent's purse decide
 * whether any of them happen.
 */

export interface SignerSubmitDeps {
  signerUrl: string;
  /** Presented to the signer, which refuses requests without it when it has one. */
  signerToken?: string;
  config: PactoraConfig;
  fetchImpl?: typeof fetch;
  /** How long to wait for the signer. A sign includes a broadcast and finality, so not short. */
  timeoutMs?: number;
}

/** The codes a signer refusal may carry through to the caller as they are. */
const PASS_THROUGH = new Set<string>([
  ErrorCode.BUDGET_EXCEEDED,
  ErrorCode.INSUFFICIENT_FUNDS,
  ErrorCode.AGENT_NOT_HIREABLE,
  ErrorCode.CHAIN_MISMATCH,
  ErrorCode.IDEMPOTENCY_CONFLICT,
  ErrorCode.SCHEMA_MISMATCH,
  ErrorCode.INVALID_STATE,
  ErrorCode.DEADLINE_PASSED,
  ErrorCode.NOT_FOUND,
  ErrorCode.FORBIDDEN,
  // The signer says when retrying the same request is safe, and how soon.
  ErrorCode.UPSTREAM_UNAVAILABLE,
]);

type Kind = Parameters<JobRouteDeps['submit']>[0]['kind'];

/** A contract call: the method and its arguments, with the contract's own argument names. */
export interface ContractCall {
  method: string;
  args: Record<string, unknown>;
}

/** POST to the signer; its RFC 7807 refusals pass through when the caller can act on them. */
async function callSigner<T>(
  deps: SignerSubmitDeps,
  path: string,
  body: unknown,
  traceId?: string,
): Promise<T> {
  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${deps.signerUrl}${path}`, {
      method: 'POST',
      // No timeout used to mean a hung signer hung every hire with it.
      signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000),
      headers: {
        'content-type': 'application/json',
        ...(deps.signerToken ? {authorization: `Bearer ${deps.signerToken}`} : {}),
        // One id from the caller's request to the signer's log line.
        ...(traceId ? {'x-request-id': traceId} : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Nothing was signed, or the idempotency key makes a retry safe if it was.
    throw new PactoraError(
      ErrorCode.UPSTREAM_UNAVAILABLE,
      `the signer did not answer: ${err instanceof Error ? err.message : String(err)}`,
      2,
    );
  }

  if (!res.ok) {
    // The signer already speaks RFC 7807, so its refusal is passed through
    // intact rather than flattened into a generic 500. An agent that hit a
    // budget cap must see BUDGET_EXCEEDED, not "signer error".
    const problem = (await res.json().catch(() => ({}))) as {
      code?: string;
      detail?: string;
      retryAfter?: number;
    };
    // A refusal the CALLER can act on passes through with its code. Anything
    // else — the signer down, a 5xx, the API's own token rejected — is an
    // outage, not the caller's empty wallet.
    if (problem.code && PASS_THROUGH.has(problem.code)) {
      throw new PactoraError(
        problem.code as ErrorCode,
        problem.detail ?? `signer refused with ${res.status}`,
        problem.retryAfter,
      );
    }
    throw new PactoraError(
      ErrorCode.UPSTREAM_UNAVAILABLE,
      `the signer answered ${res.status}${problem.code ? ` ${problem.code}` : ''}`,
      2,
    );
  }
  return (await res.json()) as T;
}

export function makeSignerSubmit(deps: SignerSubmitDeps): JobRouteDeps['submit'] {
  return async ({agentId, chainId, kind, job, spend, idempotencyKey, payload, traceId}) => {
    const chain = deps.config.chain(chainId);
    const call = contractCall(kind, {job, payload, chain, spend});
    const out = await callSigner<{txHash: string; result?: unknown}>(
      deps,
      '/sign',
      {agentId, chainId, method: call.method, args: call.args, spend: spend.toString(), idempotencyKey},
      traceId,
    );
    // create_job and direct_pay return the new job's id; the indexer links it too.
    const created = kind === 'createJob' || kind === 'directPay';
    const chainJobId =
      created &&
      (typeof out.result === 'number' || typeof out.result === 'string') &&
      /^\d+$/.test(String(out.result))
        ? String(out.result)
        : undefined;
    return {txHash: out.txHash, ...(chainJobId !== undefined ? {chainJobId} : {})};
  };
}

/** The signer's agent keys, for registration (docs/NEAR-WIRE.md §5–6). */
export function makeSignerWalletKeys(deps: SignerSubmitDeps): WalletKeys {
  return {
    async publicKeyFor({walletAddress}) {
      const out = await callSigner<{publicKey: string}>(deps, '/keys', {walletAddress});
      return out.publicKey;
    },
    async accept({chainId, walletAddress, chainAgentId}) {
      return callSigner<{txHash: string; alreadyAccepted: boolean}>(deps, '/keys/accept', {
        chainId,
        walletAddress,
        chainAgentId,
      });
    },
  };
}

/**
 * The contract call for an API action, with the contract's argument names
 * (`contracts/pactora/src/lib.rs`). Exported for tests.
 */
export function contractCall(
  kind: Kind,
  ctx: {
    job: {id: number; chainJobId: string | null} | undefined;
    payload: Record<string, unknown> | undefined;
    chain: ReturnType<PactoraConfig['chain']>;
    spend?: bigint;
  },
): ContractCall {
  const jobId = (): number => {
    const id = ctx.job?.chainJobId;
    if (!id || !/^\d+$/.test(id)) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        'this job has no on-chain id yet — retry once it is indexed',
        2,
      );
    }
    return Number(id);
  };
  const hash = (key: string): string | undefined => {
    const v = ctx.payload?.[key];
    return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : undefined;
  };
  // Contract agent ids supplied by the caller. NEVER the DB's agentId — that
  // is the database's serial, and the contract would resolve it to a
  // different agent without erroring.
  const agent = (key: string): number => {
    const v = ctx.payload?.[key];
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return v;
    if (typeof v === 'string' && /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v))) return Number(v);
    throw new PactoraError(ErrorCode.INVALID_STATE, `the hire names no on-chain ${key}`);
  };
  // A hire's amount is what it spends — the same figure the signer checks against the caps.
  const amount = (): string => {
    if (ctx.spend === undefined || ctx.spend <= 0n) {
      throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, 'a hire must spend a positive amount');
    }
    return ctx.spend.toString();
  };
  const windowOf = (key: string): number | undefined => {
    const v = ctx.payload?.[key];
    return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;
  };
  const specHash = (): string => {
    const h = hash('specHash');
    if (!h) throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, 'the hire carries no sha256 spec hash');
    return h;
  };

  switch (kind) {
    case 'directPay':
      return {
        method: 'direct_pay',
        args: {
          client_id: agent('clientChainAgentId'),
          worker_id: agent('workerChainAgentId'),
          amount: amount(),
          spec_hash: specHash(),
        },
      };
    case 'createJob':
      return {
        method: 'create_job',
        args: {
          client_id: agent('clientChainAgentId'),
          worker_id: agent('workerChainAgentId'),
          amount: amount(),
          spec_hash: specHash(),
          // A listing's own windows (docs/26 F4), else the chain's defaults.
          accept_window: windowOf('acceptWindowSeconds') ?? ctx.chain.params.acceptWindowSeconds,
          work_window: windowOf('workWindowSeconds') ?? ctx.chain.params.workWindowSeconds,
        },
      };
    case 'accept':
      return {method: 'accept_job', args: {job_id: jobId()}};
    case 'submitResult': {
      const resultHash = hash('resultHash');
      if (!resultHash) throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, 'a result needs its sha256 hash');
      return {method: 'submit_result', args: {job_id: jobId(), result_hash: resultHash}};
    }
    case 'approve':
      return {method: 'approve', args: {job_id: jobId(), review_hash: hash('reviewHash') ?? null}};
    case 'dispute':
      return {method: 'dispute', args: {job_id: jobId(), reason_hash: hash('reasonHash') ?? null}};
    case 'cancel':
      return {method: 'cancel', args: {job_id: jobId()}};
    default: {
      // Exhaustiveness: adding a new action without a call is a compile
      // error, not a transaction that quietly does nothing.
      const never: never = kind;
      throw new Error(`unhandled action ${String(never)}`);
    }
  }
}

/** The signer's test-token faucet (docs/26 F23). The API applies the claim limits first. */
export type FaucetSend = (
  receiverId: string,
  amount: bigint,
  traceId?: string,
) => Promise<{txHash: string; registered: boolean; from: string}>;

export function makeSignerFaucet(deps: SignerSubmitDeps): FaucetSend {
  return (receiverId, amount, traceId) =>
    callSigner(deps, '/faucet', {receiverId, amount: amount.toString()}, traceId);
}

/** NEP-177 metadata of a work credential, built by the API from the job (routes/credentials.ts). */
export interface CredentialMetadata {
  title: string;
  description: string;
  media: string;
  issued_at: string;
  extra: string;
}

/** The signer's work-credential minter (testnet and sandbox, with a Credentials contract). */
export type CredentialMint = (
  tokenId: string,
  receiverId: string,
  metadata: CredentialMetadata,
  traceId?: string,
) => Promise<{txHash: string; from: string; contract: string}>;

export function makeSignerMint(deps: SignerSubmitDeps): CredentialMint {
  return (tokenId, receiverId, metadata, traceId) =>
    callSigner(deps, '/credentials/mint', {tokenId, receiverId, metadata}, traceId);
}
