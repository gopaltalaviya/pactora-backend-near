import Fastify, {type FastifyInstance} from 'fastify';
import {z, ZodError} from 'zod';
import {PactoraError, ErrorCode} from '@pactora/shared';
import {
  registerHealth,
  registerMetrics,
  serviceOptions,
  type BuildInfo,
  type Metrics,
} from '@pactora/service';
import {authorised} from './auth.js';
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
const Hex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, 'must be 0x-prefixed hex');

export const SignBody = z.object({
  agentId: z.coerce.number().int().positive(),
  chainId: z.coerce.number().int().positive().optional(),
  target: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte address'),
  data: Hex,
  spend: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).default('0'),
  idempotencyKey: z.string().min(8).max(200),
});

export interface SignerAppDeps {
  service: Pick<SignerService, 'sign'>;
  chainId: number;
  keysKind: string;
  /** What is running — reported on `/health`. */
  build?: BuildInfo;
  /** The latest gas reading of the wallets it sends from (v3) — reported on `/health`. */
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

  app.post('/sign', async (request, reply) => {
    if (!authorised(request.headers.authorization, deps.token)) {
      throw new PactoraError(ErrorCode.UNAUTHORIZED, 'the signer requires its SIGNER_TOKEN');
    }
    const body = SignBody.parse(request.body ?? {});
    const req: SignRequest = {
      agentId: body.agentId,
      chainId: body.chainId ?? deps.chainId,
      target: body.target as `0x${string}`,
      data: body.data as `0x${string}`,
      spend: BigInt(body.spend),
      idempotencyKey: body.idempotencyKey,
    };
    const result = await deps.service.sign(req);
    signed?.labels(String(result.replayed)).inc();
    return reply.send(result);
  });

  return app;
}
