import type {FastifyInstance} from 'fastify';
import {and, eq} from 'drizzle-orm';
import {z} from 'zod';
import {agents, agentCapabilities, agentStats, type Db} from '@pactora/db';
import {Capability, ChainId, ErrorCode, PactoraError} from '@pactora/shared';
import {authenticatePerson} from '../auth.js';
import type {IdentityReader} from '../chain-reads.js';

/**
 * People register (docs/26 F2).
 *
 * A person is an on-chain Pactora agent whose owner AND wallet are the
 * person's own NEAR account: they called `register_agent(wallet = self)` and
 * `accept_wallet` from their browser wallet. This records the off-chain half
 * — a name, what they do — as an `agents` row of kind `person`. It issues no
 * API key: a person acts with a session and signs on chain themselves.
 *
 * The session already proved control of the account (a full-access NEP-413
 * signature). The chain proves the rest: the agent exists, is not frozen, and
 * names this account as owner and as accepted wallet.
 *
 * Until people can be hired (listings, M3) the row is `active = false`, so
 * agent discovery and the agent hire path, which both require `active`, leave
 * it alone.
 */

export const PersonBody = z.object({
  chainId: ChainId.optional(),
  chainAgentId: z.string().regex(/^[1-9]\d{0,19}$/, 'chainAgentId is the contract agent id (a u64)'),
  name: z.string().min(1).max(64),
  description: z.string().max(1_000).optional(),
  capabilities: z.array(Capability).max(16).optional(),
  /** "City" or "City, Region"; listings match on it (docs/26 F18). Omitted: anywhere. */
  location: z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .pipe(z.string().max(120))
    .optional(),
});

export interface PeopleRouteDeps {
  db: Db;
  enabled: string[];
  readIdentity?: IdentityReader;
}

const present = (row: {publicId: string; chainAgentId: string | null; name: string}) => ({
  publicId: row.publicId,
  chainAgentId: row.chainAgentId,
  name: row.name,
  kind: 'person' as const,
});

export async function registerPeopleRoutes(app: FastifyInstance, deps: PeopleRouteDeps): Promise<void> {
  const {db, enabled} = deps;

  app.post('/v1/people', async (request, reply) => {
    const caller = await authenticatePerson(db, request);
    const body = PersonBody.parse(request.body);
    const chainId = body.chainId ?? caller.chainId;
    if (!enabled.includes(chainId)) {
      throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${chainId} is not enabled`);
    }
    if (chainId !== caller.chainId) {
      throw new PactoraError(
        ErrorCode.CHAIN_MISMATCH,
        `this session is for ${caller.chainId}, not ${chainId} — sign in on that chain`,
      );
    }
    const account = caller.account;

    // A retry answers the record it made. Anything else holding this agent
    // id — an agent, or someone else — is refused, never overwritten.
    const existing = await db.query.agents.findFirst({
      where: and(eq(agents.chainId, chainId), eq(agents.chainAgentId, body.chainAgentId)),
    });
    if (existing) {
      if (existing.kind === 'person' && existing.ownerAddress === account) {
        return reply.status(200).send(present(existing));
      }
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        existing.kind === 'person'
          ? `agent ${body.chainAgentId} is already registered to another account`
          : `agent ${body.chainAgentId} is registered as an agent, not a person`,
      );
    }

    if (!deps.readIdentity) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        'this API cannot read the contract, so it cannot verify chainAgentId',
      );
    }
    const identity = await deps.readIdentity({chainId, chainAgentId: BigInt(body.chainAgentId)});
    if (!identity) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        `agent ${body.chainAgentId} does not exist on ${chainId}`,
      );
    }
    if (identity.owner !== account) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        `agent ${body.chainAgentId} is owned by ${identity.owner}, not ${account}`,
      );
    }
    if (identity.frozen) {
      throw new PactoraError(ErrorCode.INVALID_STATE, `agent ${body.chainAgentId} is frozen by its owner`);
    }
    if (identity.wallet !== account) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        identity.pendingWallet === account
          ? `agent ${body.chainAgentId}'s wallet is proposed but not accepted — call accept_wallet from ${account}`
          : `a person's agent must have their own account as its wallet; agent ${body.chainAgentId}'s is ${identity.wallet ?? 'unset'}`,
      );
    }

    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(agents)
        .values({
          kind: 'person',
          chainId,
          chainAgentId: body.chainAgentId,
          ownerAddress: account,
          walletAddress: account,
          name: body.name,
          description: body.description ?? null,
          location: body.location ?? '',
          pricePerTask: '0',
          // Inactive for agent discovery and the agent hire path, which both
          // require it: a person gets work through listings (docs/26 F4).
          active: false,
        })
        .returning();
      const caps = [...new Set(body.capabilities ?? [])];
      if (caps.length > 0) {
        await tx
          .insert(agentCapabilities)
          .values(caps.map((capability) => ({agentId: created!.id, capability})));
      }
      await tx.insert(agentStats).values({agentId: created!.id});
      return created!;
    });

    return reply.status(201).send(present(row));
  });
}
