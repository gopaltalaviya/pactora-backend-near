import type {FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions} from 'fastify';
import {ZodError} from 'zod';
import {PactoraError, ErrorCode, ERROR_STATUS} from '@pactora/shared';

/**
 * RFC 7807 problem details for every failure.
 *
 * Agents branch on `code`, never on a message string. A human-readable message
 * is for the logs; a stable machine code is what lets an orchestrator decide
 * between "try another candidate" and "stop, the budget is gone".
 */
export interface ErrorHandlerOptions {
  /** Runs before the 404 answer — the rate limiter, so unmatched routes are limited like every other. */
  notFoundPreHandler?: RouteShorthandOptions['preHandler'];
}

export function registerErrorHandler(app: FastifyInstance, opts: ErrorHandlerOptions = {}): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const err = error as Error & {validation?: unknown; statusCode?: number};
    const traceId = request.id;

    if (err instanceof PactoraError) {
      const problem = err.toProblem(titleFor(err.code));
      if (problem.retryAfter) reply.header('retry-after', String(problem.retryAfter));
      // A route may attach structured detail a page can act on (`extra`,
      // e.g. the open job ids a deletion is refused over); never secrets.
      const extra = (err as {extra?: Record<string, unknown>}).extra ?? {};
      return reply
        .status(problem.status)
        .type('application/problem+json')
        .send({...extra, ...problem, traceId});
    }

    // A malformed request is the caller's fault, not ours. Zod throws a
    // ZodError from .parse(), which is NOT Fastify's `validation` field — so
    // without this branch every bad body returned an opaque 500 and an agent
    // could not tell "I sent nonsense" from "the server broke".
    if (err instanceof ZodError) {
      return reply
        .status(422)
        .type('application/problem+json')
        .send({
          type: 'https://pactoragents.com/errors/schema-mismatch',
          title: 'Request failed validation',
          status: 422,
          code: ErrorCode.SCHEMA_MISMATCH,
          detail: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
          traceId,
        });
    }

    // Fastify's own schema validation, surfaced in the same shape.
    if ((err as {validation?: unknown}).validation) {
      return reply.status(422).type('application/problem+json').send({
        type: 'https://pactoragents.com/errors/schema-mismatch',
        title: 'Request failed validation',
        status: 422,
        code: ErrorCode.SCHEMA_MISMATCH,
        detail: err.message,
        traceId,
      });
    }

    // Postgres 23505. A uniqueness conflict is something the caller can act
    // on, not an internal fault — returning 500 told them to retry something
    // that can never succeed.
    //
    // The message names the constraint that actually fired. It used to say
    // "an agent already exists for that wallet" for EVERY unique violation,
    // which during an incident points whoever is reading at the wrong table:
    // a duplicate on-chain job id reported as a duplicate wallet costs real
    // minutes.
    // drizzle (0.45+) wraps the driver's error in a DrizzleQueryError and
    // puts the Postgres error on `cause` — reading `code` off the wrapper
    // silently turned every uniqueness conflict into a 500.
    const pg = ((err as {cause?: unknown}).cause ?? err) as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
    };
    if (pg.code === '23505') {
      const constraint = pg.constraint_name ?? pg.constraint ?? '';

      const detail =
        CONFLICT_DETAIL[constraint] ??
        `a uniqueness constraint was violated${constraint ? ` (${constraint})` : ''}`;

      return reply.status(409).type('application/problem+json').send({
        type: 'https://pactoragents.com/errors/already-exists',
        title: 'Already exists',
        status: 409,
        code: 'ALREADY_EXISTS',
        detail,
        traceId,
      });
    }

    // Postgres 22021 (a NUL byte in text) and 22P05 (a \u0000 escape in
    // JSON): the caller sent bytes a text column cannot hold. A request
    // fault, said as one; the API's own NUL check (app.ts) catches it first.
    if (pg.code === '22021' || pg.code === '22P05') {
      return reply.status(422).type('application/problem+json').send({
        type: 'https://pactoragents.com/errors/schema-mismatch',
        title: 'Request failed validation',
        status: 422,
        code: ErrorCode.SCHEMA_MISMATCH,
        detail: 'text fields may not contain a NUL byte (\\u0000)',
        traceId,
      });
    }

    // The database (or another dependency) is unreachable. Not our bug and
    // not the caller's: 503 + retry-after, so clients back off and retry
    // instead of reading a 500 as "broken, give up". The driver's message
    // names the host it could not reach, so only the trace id goes out.
    if (isConnectionFailure(err)) {
      request.log.error({err, traceId}, 'dependency unavailable');
      return reply.status(503).header('retry-after', '5').type('application/problem+json').send({
        type: 'https://pactoragents.com/errors/upstream-unavailable',
        title: 'Temporarily unavailable',
        status: 503,
        code: ErrorCode.UPSTREAM_UNAVAILABLE,
        detail: 'a service this request needs is unavailable; retry shortly',
        traceId,
      });
    }

    if ((err as {statusCode?: number}).statusCode === 429) {
      return reply.status(429).type('application/problem+json').send({
        type: 'https://pactoragents.com/errors/rate-limited',
        title: 'Too many requests',
        status: 429,
        code: 'RATE_LIMITED',
        detail: err.message,
        traceId,
      });
    }

    // An error that already knows it is the caller's fault.
    //
    // Fastify's own errors carry a `statusCode` — a malformed body, an
    // unsupported media type, a payload over the limit. Collapsing those into
    // 500 breaks the one promise a 5xx makes, that the fault is ours, and it
    // sends whoever is debugging into the wrong half of the system: an empty
    // POST body rejected with FST_ERR_CTP_EMPTY_JSON_BODY was reported as a
    // 500 and hunted for in the signer and on chain for a day.
    const status = (err as {statusCode?: number}).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // The caller's fault: a line at info with the code, never a stack.
      request.log.info(
        {traceId, status, code: (err as {code?: string}).code ?? 'BAD_REQUEST'},
        'client error',
      );
      return reply
        .status(status)
        .type('application/problem+json')
        .send({
          type: 'https://pactoragents.com/errors/bad-request',
          title: 'Bad request',
          status,
          // The code is Fastify's own (FST_ERR_*) when it has one: the caller
          // has to be able to tell these apart to fix them.
          code: (err as {code?: string}).code ?? 'BAD_REQUEST',
          detail: err.message,
          traceId,
        });
    }

    // Logged without the statement's parameters: drizzle's DrizzleQueryError
    // carries `query` and `params`, and params are the caller's data (names,
    // messages). The code and constraint are what debugging needs.
    request.log.error({err: scrubDbError(err), traceId}, 'unhandled error');
    // Never leak an internal message to a caller; the traceId is how support
    // connects this response to the log line that has the detail.
    return reply.status(500).type('application/problem+json').send({
      type: 'https://pactoragents.com/errors/internal',
      title: 'Internal error',
      status: 500,
      code: 'INTERNAL',
      traceId,
    });
  });

  // Unmatched routes go through the rate limiter too (live probe): without
  // it `GET /v1/nope` was free, so a flood of them cost nothing.
  app.setNotFoundHandler(
    opts.notFoundPreHandler ? {preHandler: opts.notFoundPreHandler} : {},
    (request: FastifyRequest, reply: FastifyReply) =>
      reply
        .status(404)
        .type('application/problem+json')
        .send({
          type: 'https://pactoragents.com/errors/not-found',
          title: 'Not found',
          status: 404,
          code: 'NOT_FOUND',
          detail: `${request.method} ${request.url}`,
          traceId: request.id,
        }),
  );
}

/** The error without the statement's parameters (the caller's data), keeping what identifies it. */
export function scrubDbError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const e = err as Error & {query?: unknown; params?: unknown; parameters?: unknown; cause?: unknown};
  if (e.query === undefined && e.params === undefined && e.parameters === undefined && e.cause === undefined)
    return err;
  const cause = e.cause as
    {code?: string; constraint_name?: string; constraint?: string; message?: string} | undefined;
  return {
    name: e.name,
    message: e.message.split('\n')[0],
    stack: e.stack?.split('\n').slice(0, 6).join('\n'),
    ...(cause && typeof cause === 'object'
      ? {
          cause: {
            code: cause.code,
            constraint: cause.constraint_name ?? cause.constraint,
            message: cause.message,
          },
        }
      : {}),
  };
}

/** Any string in the body or query that carries a NUL byte, which no text column can hold. */
export function hasNul(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some((v) => hasNul(v, depth + 1));
  if (value && typeof value === 'object')
    return Object.values(value as Record<string, unknown>).some((v) => hasNul(v, depth + 1));
  return false;
}

const TITLES: Record<string, string> = {
  [ErrorCode.AGENT_NOT_HIREABLE]: 'Agent is not hireable',
  [ErrorCode.PRICE_ABOVE_MAX]: 'Price exceeds maxPrice',
  [ErrorCode.BUDGET_EXCEEDED]: 'Spending cap reached',
  [ErrorCode.INSUFFICIENT_FUNDS]: 'Insufficient funds',
  [ErrorCode.INVALID_STATE]: 'Illegal state transition',
  [ErrorCode.DEADLINE_PASSED]: 'Deadline has passed',
  [ErrorCode.SCHEMA_MISMATCH]: 'Result failed schema validation',
  [ErrorCode.IDEMPOTENCY_CONFLICT]: 'Idempotency key conflict',
  [ErrorCode.CHAIN_MISMATCH]: 'Wrong chain for this agent',
  [ErrorCode.CHAIN_NOT_ENABLED]: 'Chain not enabled',
  [ErrorCode.UNAUTHORIZED]: 'Missing or invalid API key',
  [ErrorCode.FORBIDDEN]: 'Not permitted for this agent',
  [ErrorCode.WRONG_CREDENTIAL]: 'Wrong kind of credential for this route',
  [ErrorCode.RESULT_MISMATCH]: 'The result committed on chain is not the one delivered',
  [ErrorCode.LIMIT_REACHED]: 'A limit was reached',
};

function titleFor(code: string): string {
  return TITLES[code] ?? 'Request failed';
}

export {ERROR_STATUS};

/**
 * Plain-language detail per unique constraint.
 *
 * Anything missing falls back to naming the constraint, which is still far
 * better than confidently describing the wrong one.
 */
const CONFLICT_DETAIL: Record<string, string> = {
  agents_chain_wallet_uk: 'an agent already exists for that wallet on this chain',
  agents_chain_agent_uk: 'an agent already exists for that ERC-8004 id on this chain',
  jobs_chain_job_uk: 'a job already exists for that on-chain job id',
  signer_idempotency_uk: 'that Idempotency-Key has already been used',
  api_keys_hash_uk: 'that API key already exists',
};

/** Socket-level codes (Node, postgres.js) that mean "could not reach it", not "it said no". */
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
]);

/**
 * True when the error (or what it wraps — drizzle puts the driver's error on
 * `cause`) is a failure to reach a dependency: a socket code, or a Postgres
 * SQLSTATE in class 08 (connection exception), 57P01–57P03 (shutting down,
 * cannot connect now) or 53300 (too many connections).
 */
export function isConnectionFailure(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 4; e = (e as {cause?: unknown}).cause, depth++) {
    const code = (e as {code?: unknown}).code;
    if (typeof code !== 'string') continue;
    if (CONNECTION_CODES.has(code)) return true;
    if (/^08...$/.test(code) || /^57P0[123]$/.test(code) || code === '53300') return true;
  }
  // AggregateError (Node's happy-eyeballs: one per address tried) carries the codes on `errors`.
  const errors =
    (error as {cause?: {errors?: unknown[]}; errors?: unknown[]}).errors ??
    (error as {cause?: {errors?: unknown[]}}).cause?.errors;
  return Array.isArray(errors) && errors.some((e) => isConnectionFailure(e));
}
