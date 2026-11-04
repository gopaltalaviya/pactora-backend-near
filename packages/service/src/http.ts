import {randomUUID, timingSafeEqual} from 'node:crypto';
import type {FastifyInstance, FastifyServerOptions} from 'fastify';
import pino from 'pino';

/**
 * Fastify options every Pactora service shares.
 *
 * - Request ids: an incoming `x-request-id` is honoured, so one id follows a
 *   request from the load balancer through the API to the signer; otherwise
 *   a random UUID (it was `Math.random`, 8 base-36 characters).
 * - Limits: an explicit body limit and timeouts, rather than whatever the
 *   framework defaults to this year.
 */
export function serviceOptions(
  opts: {trustProxy?: boolean | number; bodyLimit?: number} = {},
): FastifyServerOptions {
  return {
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    // Behind Railway's proxy `req.ip` is the proxy unless this is set — which
    // makes an IP rate limit one bucket shared by every client. A number
    // trusts that many hops and no more, so a client's own X-Forwarded-For
    // entry is never taken as its address. Passed as a function: Fastify 5
    // reads a bare number as "trust nothing", which would quietly put every
    // client behind the proxy back into one bucket.
    trustProxy: typeof opts.trustProxy === 'number' ? trustHops(opts.trustProxy) : (opts.trustProxy ?? false),
    bodyLimit: opts.bodyLimit ?? 256 * 1024,
    connectionTimeout: 30_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 5_000,
  };
}

/** Trust the nearest `hops` addresses in the forwarding chain, and nothing past them. */
function trustHops(hops: number): (address: string, index: number) => boolean {
  return (_address, index) => index < hops;
}

/** Paths redacted from every log line: credentials, payments, key material. */
export const REDACT = [
  'req.headers.authorization',
  'req.headers["x-payment"]',
  'req.headers.cookie',
  'headers.authorization',
  '*.apiKey',
  '*.privateKey',
  '*.password',
  '*.passphrase',
  '*.token',
];

export function serviceLogger(service: string, level = 'info') {
  return pino({level, base: {service}, redact: {paths: REDACT, censor: '[redacted]'}});
}

/**
 * Liveness and readiness.
 *
 * `/health` answers whether the process is up — for a restart policy.
 * `/ready` answers whether it can do its job — the database and whatever else
 * it depends on — for a load balancer. They used to be one static endpoint
 * that said "ok" while the database was down.
 */
export function registerHealth(
  app: FastifyInstance,
  opts: {
    checks: Record<string, () => Promise<unknown>>;
    timeoutMs?: number;
    info?: () => Record<string, unknown>;
  },
): void {
  app.get('/health', async () => ({ok: true, ...(opts.info?.() ?? {})}));

  app.get('/ready', async (_request, reply) => {
    const timeoutMs = opts.timeoutMs ?? 2_000;
    const results = await Promise.all(
      Object.entries(opts.checks).map(async ([name, check]) => {
        try {
          await withTimeout(check(), timeoutMs, `${name} did not answer within ${timeoutMs} ms`);
          return [name, {ok: true}] as const;
        } catch (err) {
          return [name, {ok: false, error: err instanceof Error ? err.message : String(err)}] as const;
        }
      }),
    );
    const checks: Record<string, {ok: boolean; error?: string}> = {};
    for (const [name, result] of results) checks[name] = result;
    const ok = results.every(([, r]) => r.ok);
    return reply.status(ok ? 200 : 503).send({ok, checks});
  });
}

/** Constant-time bearer check. `expected` unset means the endpoint is open. */
export function bearerMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}
