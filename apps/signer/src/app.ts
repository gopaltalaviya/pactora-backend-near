import Fastify, {type FastifyInstance} from 'fastify';
import {z, ZodError} from 'zod';
import {ACCOUNT_ID_RE, PactoraError, ErrorCode} from '@pactora/shared';
import {
  registerHealth,
  registerMetrics,
  serviceOptions,
  type BuildInfo,
  type Metrics,
} from '@pactora/service';
import {authorised} from './auth.js';
import type {KeyStore} from './keystore.js';
import type {SignerService, SignRequest} from './signer.js';

/**
 * The signer's HTTP surface, built from its dependencies so it can be tested
 * with `inject` — no port, no chain, no key.
 *
 * `/sign` used to cast its body with no validation: `Number(undefined)` became
 * a NaN agent id, `String(undefined)` became the idempotency key "undefined"
 * (so every malformed request shared one key), and a 500 answered with the raw
 * `err.message`. Now the body is a schema, every refusal is RFC 7807 with a
 * traceId, and an internal error says only that it was internal.
 */
export const SignBody = z.object({
  agentId: z.coerce.number().int().positive(),
  chainId: z.string().min(1).optional(),
  method: z.string().min(1).max(64),
  /** Checked per method by the service: the contract's argument names (NEAR-PORT §6). */
  args: z.record(z.string(), z.unknown()).default({}),
  spend: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).default('0'),
  idempotencyKey: z.string().min(8).max(200),
});

const Account = z.string().min(2).max(64).regex(ACCOUNT_ID_RE, 'must be a NEAR account id');

export const KeysBody = z.object({walletAddress: Account, chainId: z.string().min(1).optional()});

export const AcceptBody = z.object({
  chainId: z.string().min(1),
  walletAddress: Account,
  chainAgentId: z.string().regex(/^\d{1,16}$/, 'must be a decimal u64'),
});

export interface SignerAppDeps {
  service: Pick<SignerService, 'sign' | 'acceptWallet'>;
  /** `POST /keys` creates keys here. */
  keys: Pick<KeyStore, 'ensure'>;
  chainId: string;
  keysKind: string;
  /** What is running — reported on `/health`. */
  build?: BuildInfo;
  /** The latest NEAR balances (`balanceYocto`) of the accounts it sends from — reported on `/health`. */
  wallets?: () => unknown;
  token?: string;
  checks: Record<string, () => Promise<unknown>>;
  metrics?: Metrics;
  metricsToken?: string;
  trustProxy?: boolean | number;
  logger?: {warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void};
}

export function buildSignerApp(deps: SignerAppDeps): FastifyInstance {
  const app = Fastify({
    ...serviceOptions({trustProxy: deps.trustProxy ?? false, bodyLimit: 64 * 1024}),
    logger: false,
  });

  const refusals = deps.metrics?.counter('signer_refusals_total', 'Sign requests refused, by error code', [
    'code',
  ]);
  const signed = deps.metrics?.counter(
    'signer_signed_total',
    'Transactions signed and broadcast, by replay',
    ['replayed'],
  );

  registerHealth(app, {
    checks: deps.checks,
    info: () => ({
      chainId: deps.chainId,
      keys: deps.keysKind,
      build: deps.build ?? null,
      ...(deps.wallets ? {wallets: deps.wallets()} : {}),
    }),
  });
  if (deps.metrics) registerMetrics(app, deps.metrics, deps.metricsToken ? {token: deps.metricsToken} : {});

  app.setErrorHandler((error: unknown, request, reply) => {
    const traceId = request.id;
    if (error instanceof PactoraError) {
      refusals?.labels(error.code).inc();
      const problem = error.toProblem('Signing refused');
      if (problem.retryAfter) reply.header('retry-after', String(problem.retryAfter));
      return reply
        .status(problem.status)
        .type('application/problem+json')
        .send({...problem, traceId});
    }
    if (error instanceof ZodError) {
      refusals?.labels(ErrorCode.SCHEMA_MISMATCH).inc();
      return reply
        .status(422)
        .type('application/problem+json')
        .send({
          type: 'https://pactoragents.com/errors/schema-mismatch',
          title: 'Sign request failed validation',
          status: 422,
          code: ErrorCode.SCHEMA_MISMATCH,
          detail: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
          traceId,
        });
    }
    // The detail goes to the log, never to the caller: an RPC error can carry
    // a raw transaction, and an internal message is not the caller's business.
    deps.logger?.error({err: error, traceId}, 'sign failed');
    refusals?.labels('INTERNAL').inc();
    return reply.status(500).type('application/problem+json').send({
      type: 'https://pactoragents.com/errors/internal',
      title: 'Internal error',
      status: 500,
      code: 'INTERNAL',
      detail: 'the signer failed; the traceId identifies the log line',
      traceId,
    });
  });

  const guard = (header: string | undefined) => {
    if (!authorised(header, deps.token)) {
      throw new PactoraError(ErrorCode.UNAUTHORIZED, 'the signer requires its SIGNER_TOKEN');
    }
  };
  const sameChain = (chainId: string | undefined) => {
    if (chainId !== undefined && chainId !== deps.chainId) {
      throw new PactoraError(
        ErrorCode.CHAIN_MISMATCH,
        `signer serves chain ${deps.chainId}, request was for ${chainId}`,
      );
    }
  };

  app.post('/sign', async (request, reply) => {
    guard(request.headers.authorization);
    const body = SignBody.parse(request.body ?? {});
    const req: SignRequest = {
      agentId: body.agentId,
      chainId: body.chainId ?? deps.chainId,
      method: body.method,
      args: body.args,
      spend: BigInt(body.spend),
      idempotencyKey: body.idempotencyKey,
    };
    const result = await deps.service.sign(req);
    signed?.labels(String(result.replayed)).inc();
    return reply.send(result);
  });

  /** The wallet's function-call key, created if missing (NEAR-PORT §6). Never the secret half. */
  app.post('/keys', async (request, reply) => {
    guard(request.headers.authorization);
    const body = KeysBody.parse(request.body ?? {});
    sameChain(body.chainId);
    const {publicKey} = await deps.keys.ensure(body.walletAddress);
    return reply.send({publicKey});
  });

  /** `accept_wallet` for a wallet that has no agent row yet (registration, NEAR-PORT §5 (d)). */
  app.post('/keys/accept', async (request, reply) => {
    guard(request.headers.authorization);
    const body = AcceptBody.parse(request.body ?? {});
    const result = await deps.service.acceptWallet(body);
    return reply.send(result);
  });

  return app;
}
