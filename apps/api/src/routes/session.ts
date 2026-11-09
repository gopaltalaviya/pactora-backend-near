import type {FastifyInstance} from 'fastify';
import {and, eq, gt, isNull, sql} from 'drizzle-orm';
import {z} from 'zod';
import {agents, loginChallenges, sessions, type Db} from '@pactora/db';
import {clientKey} from '@pactora/service';
import {AccountId, ChainId, ErrorCode, PactoraError} from '@pactora/shared';
import {authenticatePerson, generateSessionToken, hashApiKey, SESSION_TTL_MS} from '../auth.js';
import {
  CHALLENGE_TTL_MS,
  DEFAULT_SIGN_RECIPIENT,
  LIVE_PER_REQUESTER,
  NONCE_RE,
  loginMessage,
  newNonce,
  type OwnerVerifier,
} from '../challenges.js';

/**
 * People sign in (docs/26 F1).
 *
 * A person proves control of a NEAR account the way an agent's owner does to
 * register: a NEP-413 signature, by a FULL-ACCESS key of that account, over a
 * single-use server challenge. An agent's function-call key — which the
 * signer holds — can sign NEP-413 too, and cannot sign in.
 *
 * What it buys is a bearer session token, `ps_<id>_<secret>`, 7 days. Not a
 * cookie: the site and the API are on different domains, and a token the
 * page attaches itself is not an ambient credential, so no CSRF defence is
 * needed (docs/04).
 */

/** Requests per client per minute on the two sign-in routes (each costs a signature check or a row). */
export const AUTH_RATE_PER_MINUTE = 40;

export const LoginChallengeBody = z.object({
  chainId: ChainId.optional(),
  accountId: AccountId,
});

export const LoginBody = z.object({
  chainId: ChainId.optional(),
  accountId: AccountId,
  /** The account's key that made the NEP-413 signature — it must be a full-access key. */
  publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/, 'publicKey is ed25519:<base58>'),
  /** NEP-413 signature (base64) over the challenge message. */
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'signature is base64'),
  nonce: z.string().regex(NONCE_RE, 'nonce comes from POST /v1/session/challenge'),
});

export interface SessionRouteDeps {
  db: Db;
  enabled: string[];
  defaultChainId: string;
  verifyOwner: OwnerVerifier;
  signRecipient?: string;
  /** The app-wide per-minute limit; the auth routes never allow more than it. */
  rateLimitPerMinute?: number;
}

/** The person record this account has on this chain, if it registered as one. */
export async function personOf(db: Db, account: string, chainId: string) {
  const row = await db.query.agents.findFirst({
    where: and(eq(agents.chainId, chainId), eq(agents.ownerAddress, account), eq(agents.kind, 'person')),
  });
  return row ? {publicId: row.publicId, chainAgentId: row.chainAgentId, name: row.name} : null;
}

export async function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): Promise<void> {
  const {db, enabled, defaultChainId, verifyOwner} = deps;
  const recipient = deps.signRecipient ?? DEFAULT_SIGN_RECIPIENT;
  const limited = {
    config: {
      rateLimit: {
        max: Math.min(AUTH_RATE_PER_MINUTE, deps.rateLimitPerMinute ?? AUTH_RATE_PER_MINUTE),
        timeWindow: '1 minute',
      },
    },
  };

  const chainOf = (asked: string | undefined) => {
    const chainId = asked ?? defaultChainId;
    if (!enabled.includes(chainId)) {
      throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${chainId} is not enabled`);
    }
    return chainId;
  };

  /**
   * Start a sign-in. Body `{accountId, chainId?}`; answers `{nonce, message,
   * recipient, expiresAt}` for the wallet's `signMessage`. Single-use, five
   * minutes; each requester address keeps its newest few per account, so
   * nobody else's asking evicts yours.
   */
  app.post('/v1/session/challenge', limited, async (request, reply) => {
    const body = LoginChallengeBody.parse(request.body);
    const chainId = chainOf(body.chainId);
    const accountId = body.accountId;
    const nonce = newNonce();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    const requester = clientKey(request.ip);
    await db.transaction(async (tx) => {
      await tx.insert(loginChallenges).values({nonce, chainId, accountId, requester, expiresAt});
      await tx.execute(sql`
        DELETE FROM login_challenges
        WHERE account_id = ${accountId}
          AND (expires_at <= now()
               OR nonce IN (SELECT nonce FROM login_challenges
                            WHERE account_id = ${accountId} AND requester = ${requester}
                            ORDER BY expires_at DESC OFFSET ${LIVE_PER_REQUESTER}))
      `);
    });
    return reply.status(201).send({
      nonce,
      message: loginMessage({chainId, accountId, nonce}),
      recipient,
      expiresAt: expiresAt.toISOString(),
    });
  });

  /**
   * Finish a sign-in: the signature over the challenge. Answers the session
   * token — shown once, only its hash is stored — and the person record the
   * account has, if any.
   */
  app.post('/v1/session', limited, async (request, reply) => {
    const body = LoginBody.parse(request.body);
    const chainId = chainOf(body.chainId);
    const refused =
      'no live sign-in challenge for this account and chain — request one from POST /v1/session/challenge';

    const challenge = await db.query.loginChallenges.findFirst({
      where: eq(loginChallenges.nonce, body.nonce),
    });
    if (
      !challenge ||
      challenge.expiresAt.getTime() <= Date.now() ||
      challenge.chainId !== chainId ||
      challenge.accountId !== body.accountId
    ) {
      throw new PactoraError(ErrorCode.UNAUTHORIZED, refused);
    }
    const signed = await verifyOwner({
      chainId,
      accountId: body.accountId,
      publicKey: body.publicKey,
      signature: body.signature,
      message: loginMessage({chainId, accountId: body.accountId, nonce: body.nonce}),
      nonce: body.nonce,
    });
    if (!signed) {
      throw new PactoraError(
        ErrorCode.UNAUTHORIZED,
        `the signature is not a full-access key of ${body.accountId} over this sign-in challenge`,
      );
    }

    const {token, keyId} = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.transaction(async (tx) => {
      // Spent with the session, atomically, and only while still live: one
      // signature opens one session.
      const used = await tx
        .delete(loginChallenges)
        .where(
          and(
            eq(loginChallenges.nonce, body.nonce),
            eq(loginChallenges.accountId, body.accountId),
            gt(loginChallenges.expiresAt, new Date()),
          ),
        )
        .returning({nonce: loginChallenges.nonce});
      if (used.length === 0) throw new PactoraError(ErrorCode.UNAUTHORIZED, refused);
      await tx.insert(sessions).values({
        keyId,
        secretHash: hashApiKey(token),
        accountId: body.accountId,
        chainId,
        expiresAt,
        requester: clientKey(request.ip),
      });
    });

    return reply.status(201).send({
      token,
      account: body.accountId,
      chainId,
      expiresAt: expiresAt.toISOString(),
      person: await personOf(db, body.accountId, chainId),
    });
  });

  /** Who this session is. */
  app.get('/v1/session', async (request) => {
    const caller = await authenticatePerson(db, request);
    return {
      account: caller.account,
      chainId: caller.chainId,
      expiresAt: caller.expiresAt.toISOString(),
      person: await personOf(db, caller.account, caller.chainId),
    };
  });

  /** Sign out this session. */
  app.delete('/v1/session', async (request, reply) => {
    const caller = await authenticatePerson(db, request);
    await db.update(sessions).set({revokedAt: new Date()}).where(eq(sessions.id, caller.sessionId));
    return reply.status(204).send();
  });

  /** Sign out everywhere: every live session of this account, on every chain. */
  app.delete('/v1/sessions', async (request, reply) => {
    const caller = await authenticatePerson(db, request);
    await db
      .update(sessions)
      .set({revokedAt: new Date()})
      .where(and(eq(sessions.accountId, caller.account), isNull(sessions.revokedAt)));
    return reply.status(204).send();
  });
}
