import type {FastifyInstance} from 'fastify';
import {and, desc, eq, gt, isNull, sql} from 'drizzle-orm';
import {z} from 'zod';
import {agents, apiKeys, keyChallenges, type Db} from '@pactora/db';
import {PactoraError, ErrorCode} from '@pactora/shared';
import {authenticate, generateApiKey, hashApiKey} from '../auth.js';
import type {IdentityReader} from '../chain-reads.js';
import {CHALLENGE_TTL_MS, LIVE_PER_REQUESTER, NONCE_RE, newNonce, type OwnerVerifier} from '../challenges.js';

/** Live challenges tried when a re-issue does not say which one it signed. */
const MAX_TRIED = 20;

export interface KeyRouteDeps {
  db: Db;
  /** Omitted, re-issue trusts the owner recorded at registration. */
  readIdentity?: IdentityReader;
  /** NEP-413 with a full-access key of the owner (challenges.ts). */
  verifyOwner: OwnerVerifier;
}

/**
 * API keys after issue (v3). docs/17 had rotation and revocation as "SQL
 * only": a leaked key could be stopped only by someone with the database.
 */

/**
 * The owner's NEP-413 signature over the re-issue challenge, the public key
 * that made it — and, preferably, the nonce it signed. Without the nonce each
 * live challenge is tried in turn.
 */
export const ReissueBody = z.object({
  publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/, 'publicKey is ed25519:<base58>'),
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'signature is base64'),
  nonce: z.string().regex(NONCE_RE).optional(),
});

export async function registerKeyRoutes(app: FastifyInstance, deps: KeyRouteDeps): Promise<void> {
  const {db, readIdentity, verifyOwner} = deps;

  /** Swap the presented key for a new one. The old one is revoked in the same transaction. */
  app.post('/v1/keys/rotate', async (request) => {
    const caller = await authenticate(db, request);
    const {key, keyId} = generateApiKey();
    await db.transaction(async (tx) => {
      await tx.update(apiKeys).set({revokedAt: new Date()}).where(eq(apiKeys.keyId, caller.keyId));
      await tx.insert(apiKeys).values({agentId: caller.agentId, keyId, keyHash: hashApiKey(key)});
    });
    return {agentId: String(caller.agentId), apiKey: key, keyId, revokedKeyId: caller.keyId};
  });

  /** The kill switch for a key that leaked. */
  app.post('/v1/keys/revoke', async (request) => {
    const caller = await authenticate(db, request);
    await db.update(apiKeys).set({revokedAt: new Date()}).where(eq(apiKeys.keyId, caller.keyId));
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
  app.post('/v1/agents/:id/keys/challenge', async (request) => {
    const agent = await loadAgent(db, (request.params as {id: string}).id);
    const nonce = newNonce();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    const requester = request.ip;
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
  app.post('/v1/agents/:id/keys', async (request, reply) => {
    const agent = await loadAgent(db, (request.params as {id: string}).id);
    // A ZodError becomes a 422 that names the field (errors.ts).
    const {publicKey, signature, nonce} = ReissueBody.parse(request.body);

    // The one it names, or every live one for this agent, newest first.
    const live = await db
      .select()
      .from(keyChallenges)
      .where(
        and(
          eq(keyChallenges.agentId, agent.id),
          gt(keyChallenges.expiresAt, new Date()),
          nonce !== undefined ? eq(keyChallenges.nonce, nonce) : undefined,
        ),
      )
      .orderBy(desc(keyChallenges.expiresAt))
      .limit(MAX_TRIED);
    if (live.length === 0) {
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

    let challenge: (typeof live)[number] | undefined;
    for (const c of live) {
      const message = challengeMessage(agent.id, agent.chainId, c.nonce);
      if (
        await verifyOwner({
          chainId: agent.chainId,
          accountId: owner,
          publicKey,
          signature,
          message,
          nonce: c.nonce,
        })
      ) {
        challenge = c;
        break;
      }
    }
    if (!challenge) {
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
      await tx.insert(apiKeys).values({agentId: agent.id, keyId, keyHash: hashApiKey(key)});
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
