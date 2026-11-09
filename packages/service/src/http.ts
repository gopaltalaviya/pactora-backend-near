import {randomUUID, timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
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
    // An incoming x-request-id is honoured only when it is a plain token
    // (≤ 64 of [A-Za-z0-9_-]); anything else is replaced. It was echoed into
    // x-trace-id and every problem body unbounded (live probe: 5 KB of
    // markup came straight back).
    requestIdHeader: false,
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      const one = Array.isArray(given) ? given[0] : given;
      return one && /^[A-Za-z0-9_-]{1,64}$/.test(one) ? one : randomUUID();
    },
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

/**
 * The key a client's address counts under, for rate limits and per-requester
 * caps (audit L1). An IPv4 address is itself, as is an IPv4 address mapped
 * into IPv6. An IPv6 address is its /64: a client is given a /64 (often
 * more) and can pick a fresh address inside it for every request, so a
 * per-address bucket is no bucket at all. Anything that is not an address
 * is returned as it is — Fastify gives `req.ip` from the socket or a trusted
 * X-Forwarded-For, so that does not happen in practice.
 */
export function clientKey(ip: string): string {
  const bare = ip.replace(/%.*$/, ''); // a zone id (fe80::1%eth0) is not part of the address
  const family = isIP(bare);
  if (family === 4) return bare;
  if (family !== 6) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped) return mapped[1]!;
  const groups = expandIpv6(bare);
  if (!groups) return ip;
  const mappedHex = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mappedHex) {
    const hi = groups[6]!;
    const lo = groups[7]!;
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }
  const prefix = groups.slice(0, 4).map((g) => g.toString(16));
  while (prefix.length > 0 && prefix[prefix.length - 1] === '0') prefix.pop();
  return `${prefix.join(':')}::/64`;
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function expandIpv6(addr: string): number[] | null {
  let text = addr;
  // A trailing dotted quad (::ffff:1.2.3.4) becomes two hex groups.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, -dotted[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array.from({length: missing}, () => '0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
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
