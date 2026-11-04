import {encodeFunctionData, type Abi, type Hex} from 'viem';
import type {PactoraConfig} from '@pactora/config';
import {loadAbis} from '@pactora/config';
import {PactoraError, ErrorCode} from '@pactora/shared';
import type {JobRouteDeps} from './routes/jobs.js';

/**
 * Turn an API action into a policy-checked, signed transaction.
 *
 * The API never holds a key. It encodes the call, hands it to the signer over
 * private networking, and reports what came back. That separation is what
 * makes "the API is compromised" survivable: an attacker gets to *propose*
 * transactions, and the signer's policy plus the on-chain AgentAccount caps
 * decide whether any of them happen.
 */

export interface SignerSubmitDeps {
  signerUrl: string;
  /** Presented to the signer, which refuses requests without it when it has one. */
  signerToken?: string;
  config: PactoraConfig;
  abis?: Record<string, Abi>;
  fetchImpl?: typeof fetch;
  /** How long to wait for the signer. A sign includes a broadcast, so not short. */
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
]);

export function makeSignerSubmit(deps: SignerSubmitDeps): JobRouteDeps['submit'] {
  const abis = deps.abis ?? (loadAbis() as unknown as Record<string, Abi>);
  const escrowAbi = abis['TaskEscrow'];
  if (!escrowAbi) throw new Error('TaskEscrow ABI missing — run `make export` in agentx-contracts');
  const doFetch = deps.fetchImpl ?? fetch;

  return async ({agentId, chainId, kind, job, spend, idempotencyKey, payload, traceId}) => {
    const chain = deps.config.chain(chainId);
    const escrow = chain.contracts['TaskEscrow'];
    if (!escrow) {
      throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${chainId} has no deployed TaskEscrow`);
    }

    const data = encodeCall(escrowAbi, kind, {agentId, job, spend, payload, chain});

    let res: Response;
    try {
      res = await doFetch(`${deps.signerUrl}/sign`, {
        method: 'POST',
        // No timeout used to mean a hung signer hung every hire with it.
        signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
        headers: {
          'content-type': 'application/json',
          ...(deps.signerToken ? {authorization: `Bearer ${deps.signerToken}`} : {}),
          // One id from the caller's request to the signer's log line.
          ...(traceId ? {'x-request-id': traceId} : {}),
        },
        body: JSON.stringify({
          agentId,
          chainId,
          target: escrow,
          data,
          spend: spend.toString(),
          idempotencyKey,
        }),
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
      // outage, not the caller's empty wallet (which is what v1 called it).
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

    const {txHash} = (await res.json()) as {txHash: string};
    return {txHash};
  };
}

function encodeCall(
  abi: Abi,
  kind: Parameters<JobRouteDeps['submit']>[0]['kind'],
  ctx: {
    agentId: number;
    job: {id: number; chainJobId: string | null} | undefined;
    spend: bigint;
    payload: Record<string, unknown> | undefined;
    chain: ReturnType<PactoraConfig['chain']>;
  },
): Hex {
  const chainJobId = ctx.job?.chainJobId ? BigInt(ctx.job.chainJobId) : 0n;
  const specHash = (ctx.payload?.['specHash'] as Hex) ?? (('0x' + '0'.repeat(64)) as Hex);

  // ERC-8004 ids supplied by the caller. NEVER ctx.agentId — that is the
  // database's serial, and the contract would resolve it to a different
  // agent's wallet without erroring.
  const workerAgentId = agentIdOf(ctx.payload?.['workerChainAgentId']);
  const clientAgentId = agentIdOf(ctx.payload?.['clientChainAgentId']);

  switch (kind) {
    case 'directPay':
      return encodeFunctionData({
        abi,
        functionName: 'directPay',
        args: [clientAgentId, workerAgentId, ctx.spend, specHash],
      });

    case 'createJob':
      return encodeFunctionData({
        abi,
        functionName: 'createJob',
        args: [
          clientAgentId,
          workerAgentId,
          ctx.spend,
          specHash,
          BigInt(ctx.chain.params.acceptWindowSeconds as number),
          BigInt(ctx.chain.params.workWindowSeconds as number),
        ],
      });

    case 'accept':
      return encodeFunctionData({abi, functionName: 'acceptJob', args: [chainJobId]});

    case 'submitResult':
      return encodeFunctionData({
        abi,
        functionName: 'submitResult',
        args: [chainJobId, (ctx.payload?.['resultHash'] as Hex) ?? specHash, ''],
      });

    case 'approve':
      return encodeFunctionData({abi, functionName: 'approve', args: [chainJobId]});

    case 'dispute':
      return encodeFunctionData({
        abi,
        functionName: 'dispute',
        args: [chainJobId, (ctx.payload?.['reasonHash'] as Hex) ?? specHash],
      });

    case 'cancel':
      return encodeFunctionData({abi, functionName: 'cancel', args: [chainJobId]});

    default: {
      // Exhaustiveness: adding a new action without an encoding is a compile
      // error, not a transaction that quietly does nothing.
      const never: never = kind;
      throw new Error(`unhandled action ${String(never)}`);
    }
  }
}

/** An ERC-8004 id from the hire payload: a decimal string, number or bigint — nothing else. */
function agentIdOf(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) return BigInt(v);
  return 0n;
}
