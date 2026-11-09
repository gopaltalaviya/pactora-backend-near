import type {FastifyInstance} from 'fastify';
import {and, eq, gt, isNull, sql} from 'drizzle-orm';
import {z} from 'zod';
import {
  REVOKED_API_KEY_CHANGED,
  agents,
  apiKeys,
  keyChallenges,
  revokeSessionsOf,
  type Db,
} from '@pactora/db';
import {clientKey} from '@pactora/service';
import {PactoraError, ErrorCode} from '@pactora/shared';
import {KEY_SCOPES, authenticate, generateApiKey, hashApiKey} from '../auth.js';
import type {IdentityReader} from '../chain-reads.js';
import {CHALLENGE_TTL_MS, LIVE_PER_REQUESTER, NONCE_RE, newNonce, type OwnerVerifier} from '../challenges.js';

/**
 * Requests per client per minute on the two re-issue routes, which need no
 * credentials: a challenge is a row, an issue a signature check (audit M2).
 */
export const REISSUE_RATE_PER_MINUTE = 20;

export interface KeyRouteDeps {
  db: Db;
  /** Omitted, re-issue trusts the owner recorded at registration. */
  readIdentity?: IdentityReader;
  /** NEP-413 with a full-access key of the owner (challenges.ts). */
  verifyOwner: OwnerVerifier;
  /** The app-wide per-minute limit; the re-issue routes never allow more than it. */
  rateLimitPerMinute?: number;
}

/**
 * API keys after issue (v3). docs/17 had rotation and revocation as "SQL
 * only": a leaked key could be stopped only by someone with the database.
 */

/**
 * The owner's NEP-413 signature over the re-issue challenge, the public key
 * that made it, and the nonce of the challenge it signed. The nonce is
 * required (audit M2): without it every live challenge was tried in turn,
 * each try reading the owner's access key over RPC.
 */
export const ReissueBody = z.object({
  publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/, 'publicKey is ed25519:<base58>'),
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'signature is base64'),
  nonce: z.string().regex(NONCE_RE, 'nonce comes from POST /v1/agents/:id/keys/challenge'),
});

/** Rotate may narrow the new key: a subset of the presenting key's scopes (a full key may ask for any). */
export const RotateBody = z
  .object({scopes: z.array(z.enum(KEY_SCOPES)).min(1).max(3).optional()})
  .default({});

export async function registerKeyRoutes(app: FastifyInstance, deps: KeyRouteDeps): Promise<void> {
  const {db, readIdentity, verifyOwner} = deps;
  const limited = {
    config: {
      rateLimit: {
        max: Math.min(REISSUE_RATE_PER_MINUTE, deps.rateLimitPerMinute ?? REISSUE_RATE_PER_MINUTE),
        timeWindow: '1 minute',
      },
    },
  };

  /**
   * Revoke the presented key — only if it is still live. Ten concurrent
   * rotates of one key used to mint ten live keys, because each revoked
   * unconditionally and inserted; now only the one whose revoke took a row
   * may insert, and the rest are told the key is gone (401).
   */
  async function revokeLive(tx: Pick<Db, 'update'>, keyId: string): Promise<void> {
    const gone = await tx
      .update(apiKeys)
      .set({revokedAt: new Date()})
      .where(and(eq(apiKeys.keyId, keyId), isNull(apiKeys.revokedAt)))
      .returning({id: apiKeys.id});
    if (gone.length === 0) {
      throw new PactoraError(ErrorCode.UNAUTHORIZED, 'this key was already rotated or revoked');
    }
  }

  /** A changed agent credential ends the owner account's person sessions too (0025). */
  async function endOwnerSessions(agentId: number): Promise<void> {
    const owner = await db.query.agents.findFirst({where: eq(agents.id, agentId)});
    if (owner) await revokeSessionsOf(db, [owner.ownerAddress], REVOKED_API_KEY_CHANGED);
  }

  /** Swap the presented key for a new one. The old one is revoked in the same transaction. */
  app.post('/v1/keys/rotate', async (request) => {
    const caller = await authenticate(db, request);
    const body = RotateBody.parse(request.body ?? {});
    // Never wider than the key presented: a worker-only key cannot mint a client key.
    const full =
      caller.scopes.length === 0 || (caller.scopes.includes('client') && caller.scopes.includes('worker'));
    const scopes = body.scopes ? [...new Set(body.scopes)] : full ? ['client', 'worker'] : [...caller.scopes];
    if (!full && scopes.some((s) => s !== 'read' && !caller.scopes.includes(s))) {
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        `a key with scopes (${caller.scopes.join(', ')}) cannot issue one with (${scopes.join(', ')})`,
      );
    }
    const {key, keyId} = generateApiKey();
    await db.transaction(async (tx) => {
      await revokeLive(tx, caller.keyId);
      await tx.insert(apiKeys).values({agentId: caller.agentId, keyId, keyHash: hashApiKey(key), scopes});
    });
    await endOwnerSessions(caller.agentId);
    return {agentId: String(caller.agentId), apiKey: key, keyId, scopes, revokedKeyId: caller.keyId};
  });

  /** The kill switch for a key that leaked. */
  app.post('/v1/keys/revoke', async (request) => {
    const caller = await authenticate(db, request);
    await revokeLive(db, caller.keyId);
    await endOwnerSessions(caller.agentId);
    return {agentId: String(caller.agentId), revokedKeyId: caller.keyId};
  });

  /**
   * Start a re-issue: a message for the agent's owner to sign. The nonce is
   * single-use and short-lived, so a captured signature cannot be replayed
   * into a second key.
   *
   * Earlier challenges stay live. This needs no credentials, and a new one
   * used to REPLACE the last — so anyone could keep invalidating the owner's
   * signature before it arrived (audit L2). Each requester address keeps its
   * newest few; nobody else's asking evicts them.
   */
  app.post('/v1/agents/:id/keys/challenge', limited, async (request) => {
    const agent = await loadAgent(db, (request.params as {id: string}).id);
    const nonce = newNonce();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    const requester = clientKey(request.ip);
    await db.transaction(async (tx) => {
      await tx.insert(keyChallenges).values({nonce, agentId: agent.id, requester, expiresAt});
      // Expired ones for this agent, and this requester's beyond its newest few.
      await tx.execute(sql`
        DELETE FROM key_challenges
        WHERE agent_id = ${agent.id}
          AND (expires_at <= now()
               OR nonce IN (SELECT nonce FROM key_challenges
                            WHERE agent_id = ${agent.id} AND requester = ${requester}
                            ORDER BY expires_at DESC OFFSET ${LIVE_PER_REQUESTER}))
      `);
    });
    return {
      agentId: String(agent.id),
      nonce,
      message: challengeMessage(agent.id, agent.chainId, nonce),
      expiresAt: expiresAt.toISOString(),
    };
  });

  /**
   * Finish a re-issue: a signature over the challenge from the agent's owner
   * — its CURRENT on-chain owner where the agent is on-chain, so someone who
   * sold the agent cannot mint keys for it. Every existing key is revoked;
   * the new one is shown once.
   */
  app.post('/v1/agents/:id/keys', limited, async (request, reply) => {
    const agent = await loadAgent(db, (request.params as {id: string}).id);
    // A ZodError becomes a 422 that names the field (errors.ts).
    const {publicKey, signature, nonce} = ReissueBody.parse(request.body);

    // The one challenge the signature names, if it is live.
    const challenge = await db.query.keyChallenges.findFirst({
      where: and(
        eq(keyChallenges.agentId, agent.id),
        eq(keyChallenges.nonce, nonce),
        gt(keyChallenges.expiresAt, new Date()),
      ),
    });
    if (!challenge) {
      throw new PactoraError(ErrorCode.UNAUTHORIZED, 'no live challenge for this agent — request a new one');
    }

    let owner = agent.ownerAddress;
    if (agent.chainAgentId && readIdentity) {
      const onChain = await readIdentity({chainId: agent.chainId, chainAgentId: BigInt(agent.chainAgentId)});
      if (!onChain) {
        throw new PactoraError(
          ErrorCode.UNAUTHORIZED,
          'the on-chain owner could not be read — retry shortly',
          5,
        );
      }
      owner = onChain.owner;
    }

    const signed = await verifyOwner({
      chainId: agent.chainId,
      accountId: owner,
      publicKey,
      signature,
      message: challengeMessage(agent.id, agent.chainId, challenge.nonce),
      nonce: challenge.nonce,
    });
    if (!signed) {
      throw new PactoraError(
        ErrorCode.UNAUTHORIZED,
        `the signature is not from a full-access key of the agent's on-chain owner ${owner}`,
      );
    }

    const {key, keyId} = generateApiKey();
    // Consumed and replaced in one transaction: the same signature cannot win twice.
    const issued = await db.transaction(async (tx) => {
      const used = await tx
        .delete(keyChallenges)
        .where(and(eq(keyChallenges.agentId, agent.id), eq(keyChallenges.nonce, challenge.nonce)))
        .returning({nonce: keyChallenges.nonce});
      if (used.length === 0) return false;
      await tx
        .update(apiKeys)
        .set({revokedAt: new Date()})
        .where(and(eq(apiKeys.agentId, agent.id), isNull(apiKeys.revokedAt)));
      await tx
        .insert(apiKeys)
        .values({agentId: agent.id, keyId, keyHash: hashApiKey(key), scopes: ['client', 'worker']});
      return true;
    });
    if (!issued) throw new PactoraError(ErrorCode.UNAUTHORIZED, 'that challenge was already used');

    reply.code(201);
    return {agentId: String(agent.id), apiKey: key, keyId};
  });
}

/** What the owner signs. Names the agent, the chain and the nonce, in words. */
function challengeMessage(agentId: number, chainId: string, nonce: string): string {
  return [
    'Pactora: issue a new API key, revoking every existing one.',
    `Agent: ${agentId}`,
    `Chain: ${chainId}`,
    `Nonce: ${nonce}`,
  ].join('\n');
}

async function loadAgent(db: Db, id: string) {
  if (!/^[1-9]\d{0,15}$/.test(id)) throw new PactoraError(ErrorCode.NOT_FOUND, `no agent ${id}`);
  const agent = await db.query.agents.findFirst({where: eq(agents.id, Number(id))});
  if (!agent) throw new PactoraError(ErrorCode.NOT_FOUND, `no agent ${id}`);
  return agent;
}
