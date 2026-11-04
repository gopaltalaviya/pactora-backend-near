import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {eq, and, isNull} from 'drizzle-orm';
import type {FastifyRequest} from 'fastify';
import {type Db, apiKeys, agents} from '@pactora/db';
import {PactoraError, ErrorCode} from '@pactora/shared';

/**
 * API keys, one per agent: `ax_<keyId>_<secret>`.
 *
 * `keyId` is 16 hex characters, public, and indexed — a request finds its one
 * row by it. `secret` is 24 random bytes. Only `sha256$<hex>` of the whole key
 * is stored, so a database dump yields no working credential.
 *
 * v1 stored a salted scrypt hash and no id, so authenticating meant loading
 * EVERY key and running a synchronous scrypt against each, on the event loop,
 * for every request: 20 requests with garbage keys against 25 stored keys
 * blocked the API for 12.9 s (apps/api/test/auth.test.ts). A key is 192 random
 * bits, not a password — there is nothing for a slow hash to protect, and on a
 * hot path it is a denial-of-service lever. This is how GitHub and Stripe
 * store API tokens. Keys issued in the v1 format are refused with a message
 * saying to re-issue them.
 */
const KEY_PATTERN = /^ax_([0-9a-f]{16})_([A-Za-z0-9_-]{32})$/;

export function generateApiKey(): {key: string; keyId: string} {
  const keyId = randomBytes(8).toString('hex');
  return {key: `ax_${keyId}_${randomBytes(24).toString('base64url')}`, keyId};
}

export function hashApiKey(key: string): string {
  return `sha256$${createHash('sha256').update(key).digest('hex')}`;
}

export function verifyApiKey(key: string, stored: string): boolean {
  const [scheme, hex] = stored.split('$');
  if (scheme !== 'sha256' || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = createHash('sha256').update(key).digest();
  // Constant time: a short-circuiting compare leaks the hash to anyone
  // willing to measure.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The key id of a well-formed key, or null. */
export function keyIdOf(key: string): string | null {
  return KEY_PATTERN.exec(key)?.[1] ?? null;
}

export interface Caller {
  agentId: number;
  chainId: number;
  scopes: string[];
  /** The public id of the key that authenticated this request (rotate/revoke act on it alone). */
  keyId: string;
}

/**
 * Resolve the caller from `Authorization: Bearer ax_...`.
 *
 * Every key is bound to exactly one agent, and an agent belongs to exactly one
 * chain — so authentication also fixes the chain, and a key used against
 * another network fails with CHAIN_MISMATCH rather than quietly operating on
 * the wrong one.
 */
export async function authenticate(db: Db, request: FastifyRequest): Promise<Caller> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new PactoraError(ErrorCode.UNAUTHORIZED, 'missing Authorization: Bearer <api key>');
  }
  const presented = header.slice('Bearer '.length).trim();

  const keyId = keyIdOf(presented);
  if (!keyId) {
    throw new PactoraError(
      ErrorCode.UNAUTHORIZED,
      'not a Pactora API key (expected ax_<id>_<secret>); keys issued before 2026-09-30 must be re-issued',
    );
  }

  // One indexed lookup, one hash. The id is public; the hash is what proves
  // the caller holds the secret.
  const match = await db.query.apiKeys.findFirst({
    where: and(eq(apiKeys.keyId, keyId), isNull(apiKeys.revokedAt)),
  });
  if (!match || !verifyApiKey(presented, match.keyHash)) {
    throw new PactoraError(ErrorCode.UNAUTHORIZED, 'unknown or revoked API key');
  }

  const agent = await db.query.agents.findFirst({where: eq(agents.id, match.agentId)});
  if (!agent) throw new PactoraError(ErrorCode.AGENT_NOT_HIREABLE, 'the key belongs to a deleted agent');

  await db.update(apiKeys).set({lastUsedAt: new Date()}).where(eq(apiKeys.id, match.id));

  return {agentId: agent.id, chainId: agent.chainId, scopes: match.scopes, keyId};
}

/** The chain a request operates on: explicit `?chainId=`, else the caller's. */
export function resolveChainId(request: FastifyRequest, caller: Caller, enabled: number[]): number {
  const q = (request.query as {chainId?: string}).chainId;
  if (q === undefined) return caller.chainId;

  const asked = Number(q);
  if (!enabled.includes(asked)) {
    throw new PactoraError(
      ErrorCode.CHAIN_NOT_ENABLED,
      `chain ${asked} is not enabled (have ${enabled.join(',')})`,
    );
  }
  if (asked !== caller.chainId) {
    throw new PactoraError(
      ErrorCode.CHAIN_MISMATCH,
      `this key belongs to an agent on chain ${caller.chainId}, not ${asked}`,
    );
  }
  return asked;
}

export {and};
