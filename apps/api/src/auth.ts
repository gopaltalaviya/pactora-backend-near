import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {eq, and, isNull, lte, sql} from 'drizzle-orm';
import type {FastifyRequest} from 'fastify';
import {
  type Db,
  REVOKED_KEYS_CHANGED,
  agents,
  apiKeys,
  loginChallenges,
  revokeSessionsOf,
  sessions,
} from '@pactora/db';
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

/**
 * Person sessions (docs/26 F1): `ps_<keyId>_<secret>`, the same shape as an
 * agent key with a different prefix, so neither can be mistaken for the
 * other. Bearer, never a cookie: the site and the API are on different
 * domains, and a token a page must attach itself is no ambient credential —
 * a hostile page cannot ride it, so no CSRF defence is needed. Only
 * `sha256$<hex>` of the whole token is stored.
 */
const SESSION_PATTERN = /^ps_([0-9a-f]{16})_([A-Za-z0-9_-]{32})$/;

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
  chainId: string;
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

  if (SESSION_PATTERN.test(presented)) {
    throw new PactoraError(
      ErrorCode.WRONG_CREDENTIAL,
      "a person's session token cannot call this route; it takes an agent API key (ax_<id>_<secret>)",
    );
  }

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

// ─────────────────────────── people ───────────────────────────

/** How long a session lasts. Not extended by use: signing in again is one wallet prompt. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateSessionToken(): {token: string; keyId: string} {
  const keyId = randomBytes(8).toString('hex');
  return {token: `ps_${keyId}_${randomBytes(24).toString('base64url')}`, keyId};
}

/** A signed-in person: the NEAR account that proved control, on one chain. */
export interface PersonCaller {
  kind: 'person';
  account: string;
  chainId: string;
  /** The session row; logging out acts on it. */
  sessionId: number;
  expiresAt: Date;
}

export type AgentCaller = Caller & {kind: 'agent'};

function bearerOf(request: FastifyRequest, what: string): string {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new PactoraError(ErrorCode.UNAUTHORIZED, `missing Authorization: Bearer <${what}>`);
  }
  return header.slice('Bearer '.length).trim();
}

/**
 * Resolve a person from `Authorization: Bearer ps_...`. Refuses an expired
 * or revoked session, and an agent key (which is a credential for software,
 * not for a person).
 */
export async function authenticatePerson(db: Db, request: FastifyRequest): Promise<PersonCaller> {
  const presented = bearerOf(request, 'session token');
  if (keyIdOf(presented)) {
    throw new PactoraError(
      ErrorCode.WRONG_CREDENTIAL,
      'an agent API key cannot call this route; sign in as a person (POST /v1/session)',
    );
  }
  const keyId = SESSION_PATTERN.exec(presented)?.[1];
  if (!keyId) {
    throw new PactoraError(ErrorCode.UNAUTHORIZED, 'not a Pactora session token (expected ps_<id>_<secret>)');
  }
  const row = await db.query.sessions.findFirst({where: eq(sessions.keyId, keyId)});
  if (!row || !verifyApiKey(presented, row.secretHash)) {
    throw new PactoraError(ErrorCode.UNAUTHORIZED, 'unknown, expired or signed-out session — sign in again');
  }
  // A session ended for a reason (a key change, migration 0025) says so:
  // the person should know why they were signed out, not guess.
  if (row.revokedAt) {
    throw new PactoraError(
      ErrorCode.UNAUTHORIZED,
      row.revokedReason ?? 'unknown, expired or signed-out session — sign in again',
    );
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new PactoraError(ErrorCode.UNAUTHORIZED, 'unknown, expired or signed-out session — sign in again');
  }
  await db.update(sessions).set({lastUsedAt: new Date()}).where(eq(sessions.id, row.id));
  return {
    kind: 'person',
    account: row.accountId,
    chainId: row.chainId,
    sessionId: row.id,
    expiresAt: row.expiresAt,
  };
}

/** For a route either kind of caller may use: dispatched on the token's prefix. */
export async function authenticateCaller(
  db: Db,
  request: FastifyRequest,
): Promise<AgentCaller | PersonCaller> {
  const presented = bearerOf(request, 'API key or session token');
  if (SESSION_PATTERN.test(presented)) return authenticatePerson(db, request);
  return {kind: 'agent', ...(await authenticate(db, request))};
}

/**
 * Delete expired sessions and sign-in challenges. Run hourly by the API
 * (app.ts); a lapsed row authenticates nobody, so this only bounds the tables.
 */
export async function sweepExpiredSessions(db: Db): Promise<{sessions: number; challenges: number}> {
  const now = new Date();
  const s = await db.delete(sessions).where(lte(sessions.expiresAt, now)).returning({id: sessions.id});
  const c = await db
    .delete(loginChallenges)
    .where(lte(loginChallenges.expiresAt, now))
    .returning({nonce: loginChallenges.nonce});
  return {sessions: s.length, challenges: c.length};
}

/** sha256 of an account's sorted full-access public keys: what a sign-in records (0025). */
export function accessKeysHash(keys: readonly string[]): string {
  return createHash('sha256')
    .update([...keys].sort().join('\n'))
    .digest('hex');
}

/**
 * End the sessions of every account whose full-access key set changed since
 * it signed in. Run by the API on a timer (SESSION_KEY_SWEEP_MS, default 5
 * minutes): a key the owner rotated — or one an attacker added — must not
 * leave the old session alive for a week. An account the chain cannot read
 * right now is left for the next pass; a deleted account is signed out.
 */
export async function sweepChangedKeySessions(
  db: Db,
  readAccessKeys: (args: {chainId: string; accountId: string}) => Promise<string[] | null>,
): Promise<{checked: number; revoked: number}> {
  const live = (await db.execute(
    sql`SELECT DISTINCT account_id, chain_id, access_keys_hash
          FROM sessions
         WHERE revoked_at IS NULL AND expires_at > now() AND access_keys_hash IS NOT NULL`,
  )) as unknown as {account_id: string; chain_id: string; access_keys_hash: string}[];
  let revoked = 0;
  for (const s of live) {
    let keys: string[] | null;
    try {
      keys = await readAccessKeys({chainId: s.chain_id, accountId: s.account_id});
    } catch {
      continue; // unreadable now: looked at again next pass
    }
    const now = keys === null ? 'gone' : accessKeysHash(keys);
    if (now === s.access_keys_hash) continue;
    revoked += await revokeSessionsOf(db, [s.account_id], REVOKED_KEYS_CHANGED);
  }
  return {checked: live.length, revoked};
}

/** The chain a request operates on: explicit `?chainId=`, else the caller's. */
export function resolveChainId(request: FastifyRequest, caller: Caller, enabled: string[]): string {
  const q = (request.query as {chainId?: string}).chainId;
  if (q === undefined) return caller.chainId;

  const asked = q;
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
