import {lookup as dnsLookup} from 'node:dns/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {BlockList, isIP} from 'node:net';

/**
 * Outbound HTTP to an address someone else chose (a webhook URL) without
 * letting them point it at us: SSRF.
 *
 * A hostname check alone is not enough: `hooks.example.com` can resolve to
 * 127.0.0.1, or to a public address when checked and a private one a moment
 * later (DNS rebinding). So the name is resolved, EVERY address must be
 * public, and the connection is then made to the address that was checked,
 * pinned through `lookup`, while TLS still verifies the certificate for the
 * name. Redirects are never followed.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64: maps to IPv4, checked below
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** The IPv4 address inside an IPv4-mapped/compatible or NAT64 IPv6 address, if any. */
function embeddedIpv4(addr: string): string | null {
  const lower = addr.toLowerCase();
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1]!;
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }
  return null;
}

/** Is this literal address one the public internet routes to? */
export function isPublicAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) return !blocked.check(addr, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIpv4(addr);
    if (v4) return isPublicAddress(v4);
    return !blocked.check(addr, 'ipv6');
  }
  return false;
}

export type Resolver = (host: string) => Promise<{address: string; family: number}[]>;
const systemResolver: Resolver = (host) => dnsLookup(host, {all: true, verbatim: true});

export class UnsafeTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeTargetError';
  }
}

export interface TargetPolicy {
  /** Allow http:// (local development only). Default: https only. */
  allowHttp?: boolean;
  /** Allow private and loopback addresses (local development and tests only). */
  allowPrivate?: boolean;
  resolver?: Resolver;
}

export interface CheckedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

/**
 * Parse and resolve a URL, or throw `UnsafeTargetError` saying why not. Every
 * address the name resolves to must be public, not just the first: a name
 * with one public and one private address is refused.
 */
export async function checkTarget(raw: string, policy: TargetPolicy = {}): Promise<CheckedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeTargetError('not a URL');
  }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) {
    throw new UnsafeTargetError(policy.allowHttp ? 'must be http(s)' : 'must be https');
  }
  if (url.username || url.password) throw new UnsafeTargetError('must not carry credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host);
  const addrs = literal
    ? [{address: host, family: literal}]
    : await (policy.resolver ?? systemResolver)(host).catch(() => {
        throw new UnsafeTargetError(`${host} does not resolve`);
      });
  if (addrs.length === 0) throw new UnsafeTargetError(`${host} does not resolve`);
  if (!policy.allowPrivate) {
    const bad = addrs.find((a) => !isPublicAddress(a.address));
    if (bad) throw new UnsafeTargetError(`${host} resolves to a non-public address (${bad.address})`);
  }
  const first = addrs[0]!;
  return {url, address: first.address, family: first.family === 6 ? 6 : 4};
}

export interface PinnedResponse {
  status: number;
  /** At most `maxBodyBytes` of the body, as text; the rest is discarded. */
  body: string;
}

/**
 * POST `body` to a checked target, connecting to the checked address only.
 * No redirect is followed (a 3xx is just a status); the whole exchange is
 * bounded by `timeoutMs`; at most `maxBodyBytes` of the answer is kept.
 */
export function postPinned(
  target: CheckedTarget,
  body: string,
  headers: Record<string, string>,
  opts: {timeoutMs?: number; maxBodyBytes?: number} = {},
): Promise<PinnedResponse> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const max = opts.maxBodyBytes ?? 4096;
  const {url, address, family} = target;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {...headers, 'content-length': String(Buffer.byteLength(body))},
        // The pin: whatever the name resolves to now, connect to the address checked.
        lookup: (_host, options, cb) => {
          if ((options as {all?: boolean}).all) {
            (cb as unknown as (e: null, a: {address: string; family: number}[]) => void)(null, [
              {address, family},
            ]);
          } else cb(null, address, family);
        },
        servername: isIP(url.hostname) ? undefined : url.hostname,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let kept = 0;
        res.on('data', (c: Buffer) => {
          if (kept < max) {
            chunks.push(c.subarray(0, max - kept));
            kept += Math.min(c.length, max - kept);
          }
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8')});
        });
        res.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end(body);
  });
}
