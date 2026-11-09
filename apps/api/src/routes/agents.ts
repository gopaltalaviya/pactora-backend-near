import type {FastifyInstance} from 'fastify';
import {and, eq, gte, isNotNull, lte, sql} from 'drizzle-orm';
import {z} from 'zod';
import {
  agents,
  agentCapabilities,
  agentStats,
  apiKeys,
  indexerCursor,
  readTrust,
  registrationChallenges,
  spendPolicies,
  DEFAULT_WINDOW_BLOCKS,
  type Db,
} from '@pactora/db';
import {clientKey} from '@pactora/service';
import {AccountId, PactoraError, BaseUnits, Capability, ChainId, ErrorCode} from '@pactora/shared';
import type {ChainConfig} from '@pactora/config';
import {authenticate, generateApiKey, hashApiKey, resolveChainId} from '../auth.js';
import {noHistory, skillStats, type SkillStat} from '../skills.js';
import {rank, RANK_MODES} from '../ranking.js';
import type {AgentRow} from '../types.js';
import type {IdentityReader} from '../chain-reads.js';
import {
  CHALLENGE_TTL_MS,
  DEFAULT_SIGN_RECIPIENT,
  LIVE_PER_REQUESTER,
  NONCE_RE,
  newNonce,
  registrationMessage,
  type OwnerVerifier,
} from '../challenges.js';

const ChainAgentId = z.string().regex(/^[1-9]\d{0,19}$/, 'chainAgentId is the contract agent id (a u64)');

/** What a registration will claim, so the challenge can name it. */
export const RegisterChallengeBody = z.object({
  ownerAddress: AccountId,
  walletAddress: AccountId,
  chainId: ChainId.optional(),
  chainAgentId: ChainAgentId,
});

export const RegisterBody = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(1_000).optional(),
  capabilities: z.array(Capability).min(1).max(16),
  pricePerTask: BaseUnits,
  endpointUrl: z.string().url().optional(),
  walletAddress: AccountId,
  ownerAddress: AccountId,
  chainId: ChainId.optional(),
  /**
   * The contract agent id `register_agent` returned. Required: an agent that
   * is not on chain can never be hired. Verified on chain before it is stored.
   */
  chainAgentId: ChainAgentId,
  /** From `POST /v1/agents/challenge`: the nonce the signature covers. */
  nonce: z.string().regex(NONCE_RE, 'nonce comes from POST /v1/agents/challenge'),
  /** The owner's key that made the NEP-413 signature — it must be a full-access key. */
  publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/, 'publicKey is ed25519:<base58>'),
  /** The owner's NEP-413 signature (base64) over the challenge message. */
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'signature is base64'),
});

export const UpdateAgentBody = z
  .object({
    pricePerTask: BaseUnits.optional(),
    active: z.boolean().optional(),
    description: z.string().max(1000).optional(),
  })
  // An empty patch used to reach drizzle as an empty SET and answer 500.
  .refine((p) => Object.keys(p).length > 0, 'nothing to change: give pricePerTask, active or description');

export const DiscoverQuery = z.object({
  capability: Capability.optional(),
  maxPrice: BaseUnits.optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  rank: z.enum(['balanced', 'quality', 'cheapest', 'fastest']).default('balanced'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  chainId: ChainId.optional(),
});

/**
 * The agent keys the signer holds (docs/NEAR-PORT.md §5–6): the public key a
 * new agent wallet is created with, and the wallet's `accept_wallet`, signed
 * with that key.
 */
export interface WalletKeys {
  publicKeyFor(args: {chainId: string; walletAddress: string}): Promise<string>;
  accept(args: {
    chainId: string;
    walletAddress: string;
    chainAgentId: string;
  }): Promise<{txHash: string; alreadyAccepted: boolean}>;
}

export interface RouteDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  defaultChainId: string;
  readIdentity?: IdentityReader;
  /** NEP-413 with a full-access key of the owner (challenges.ts). */
  verifyOwner: OwnerVerifier;
  walletKeys?: WalletKeys;
  /** NEP-413 `recipient`; defaults to `pactora`. */
  signRecipient?: string;
  /**
   * Refuse endpoint URLs that are not public https. Nothing fetches them
   * today; the first thing that does must not be pointable at plain http, a
   * loopback or a private address (SSRF). On in production.
   */
  requirePublicHttpsEndpoints?: boolean;
  /** The app-wide per-minute limit; wallet-key creation never allows more than it. */
  rateLimitPerMinute?: number;
  /** Agents one owner account may register per chain (docs/26 F25); default 100. */
  maxAgentsPerOwner?: number;
}

export const DEFAULT_MAX_AGENTS_PER_OWNER = 100;

/**
 * Wallet keys created per client per minute (audit M1). The route needs no
 * credentials and each key is a KDF derivation and a row in the signer; a
 * person registers one agent at a time.
 */
export const WALLET_KEY_RATE_PER_MINUTE = 10;

/** Hostnames and literal addresses that name this machine or a private network. */
const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;

export function isPublicHttpsUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !PRIVATE_HOST.test(url.hostname);
}

export async function registerAgentRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const {db, chains, defaultChainId} = deps;
  const enabled = Object.keys(chains);
  const recipient = deps.signRecipient ?? DEFAULT_SIGN_RECIPIENT;

  /**
   * Discovery.
   *
   * Unauthenticated on purpose: a marketplace nobody can browse without
   * credentials is not a marketplace. It is always chain-scoped, or results
   * from two networks would silently mix.
   */
  app.get('/v1/agents', async (request) => {
    const q = DiscoverQuery.parse(request.query);
    const chainId = q.chainId ?? defaultChainId;
    if (!enabled.includes(chainId)) {
      throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${chainId} is not enabled`);
    }
    const chain = chains[chainId]!;

    // v3: only agents the chain confirmed. One with no on-chain agent id can never
    // be hired, so listing it let open registration crowd the marketplace.
    const conditions = [eq(agents.chainId, chainId), eq(agents.active, true), isNotNull(agents.chainAgentId)];
    if (q.maxPrice) conditions.push(lte(agents.pricePerTask, q.maxPrice));
    if (q.minScore !== undefined) conditions.push(gte(agentStats.score, q.minScore));

    const rows = await db
      .select({
        id: agents.id,
        chainId: agents.chainId,
        chainAgentId: agents.chainAgentId,
        name: agents.name,
        description: agents.description,
        walletAddress: agents.walletAddress,
        ownerAddress: agents.ownerAddress,
        pricePerTask: agents.pricePerTask,
        stake: agents.stake,
        active: agents.active,
        endpointUrl: agents.endpointUrl,
        score: agentStats.score,
        completed: agentStats.completed,
        failed: agentStats.failed,
        lastActiveAt: agentStats.lastActiveAt,
        capabilities: sql<string[]>`coalesce(array_agg(distinct ${agentCapabilities.capability})
          filter (where ${agentCapabilities.capability} is not null), '{}')`,
      })
      .from(agents)
      .leftJoin(agentStats, eq(agentStats.agentId, agents.id))
      .leftJoin(agentCapabilities, eq(agentCapabilities.agentId, agents.id))
      .where(and(...conditions))
      .groupBy(agents.id, agentStats.agentId)
      .limit(500);

    const filtered = q.capability ? rows.filter((r) => r.capabilities.includes(q.capability!)) : rows;

    // Asked for one skill: rank on the record IN that skill, not the blend of
    // everything the agent offers. The overall figures are returned unchanged.
    let skill: Map<number, SkillStat> | null = null;
    if (q.capability) {
      const cap = q.capability;
      const all = await skillStats(
        db,
        chainId,
        filtered.map((r) => r.id),
        floorOf(chain),
      );
      skill = new Map(
        filtered.map((r) => [r.id, all.get(r.id)?.find((s) => s.capability === cap) ?? noHistory(cap)]),
      );
    }
    const forRanking = skill
      ? filtered.map((r) => {
          const s = skill.get(r.id)!;
          return {...r, score: s.score, completed: s.completed, failed: s.failed};
        })
      : filtered;
    const byId = new Map(filtered.map((r) => [r.id, r]));
    const ranked = rank(forRanking, q.rank).slice(0, q.limit);

    return {
      chainId,
      network: chain.name,
      rank: q.rank,
      agents: ranked.map((a) => ({
        ...present(byId.get(a.id)!, chain),
        ...(skill ? {skill: skill.get(a.id)!} : {}),
      })),
    };
  });

  app.get('/v1/agents/:id', async (request) => {
    const {id} = request.params as {id: string};
    // Anything but a positive integer names no agent — and must not reach
    // Postgres as NaN, which answered 500.
    // A lookup that finds nothing is NOT_FOUND. AGENT_NOT_HIREABLE is the
    // hiring refusal (exists, but cannot be hired) and means something else.
    if (!/^[1-9]\d{0,15}$/.test(id)) throw new PactoraError(ErrorCode.NOT_FOUND, `no agent ${id}`);
    const row = await db
      .select({
        id: agents.id,
        chainId: agents.chainId,
        chainAgentId: agents.chainAgentId,
        name: agents.name,
        description: agents.description,
        walletAddress: agents.walletAddress,
        ownerAddress: agents.ownerAddress,
        pricePerTask: agents.pricePerTask,
        stake: agents.stake,
        active: agents.active,
        endpointUrl: agents.endpointUrl,
        score: agentStats.score,
        completed: agentStats.completed,
        failed: agentStats.failed,
        lastActiveAt: agentStats.lastActiveAt,
      })
      .from(agents)
      .leftJoin(agentStats, eq(agentStats.agentId, agents.id))
      .where(eq(agents.id, Number(id)))
      .limit(1);

    const agent = row[0];
    if (!agent) throw new PactoraError(ErrorCode.NOT_FOUND, `no agent ${id}`);
    // A person is not an agent in the directory: their row (name, NEAR
    // account) is public only through a published profile, and then only
    // what the profile shows (live probe).
    const personView = await personPublicView(db, agent.id);
    if (personView === 'hidden') throw new PactoraError(ErrorCode.NOT_FOUND, `no agent ${id}`);

    const caps = await db
      .select({capability: agentCapabilities.capability})
      .from(agentCapabilities)
      .where(eq(agentCapabilities.agentId, agent.id));

    const chain = chains[agent.chainId];
    if (!chain) throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${agent.chainId} is not enabled`);

    // Every skill it offers, and any it has a record in, with that record.
    const record = (await skillStats(db, agent.chainId, [agent.id], floorOf(chain))).get(agent.id) ?? [];
    const names = [...new Set([...caps.map((c) => c.capability), ...record.map((s) => s.capability)])].sort();
    const full = {
      ...present({...agent, capabilities: caps.map((c) => c.capability)}, chain),
      skills: names.map((n) => record.find((s) => s.capability === n) ?? noHistory(n)),
    };
    if (!personView) return full;
    const {walletAddress: _w, explorerUrl: _e, description: _d, ...rest} = full;
    void [_w, _e, _d];
    return {
      ...rest,
      kind: 'person',
      publicId: personView.publicId,
      name: personView.displayName,
      profileId: personView.publicId,
      ...(personView.showAccount
        ? {walletAddress: agent.walletAddress, ownerAddress: agent.ownerAddress}
        : {}),
    };
  });

  /**
   * Whether this agent's record deserves belief (v3).
   *
   * The score proves every review cost a payment; this asks who paid. It
   * counts distinct client owners, how much of the record one owner wrote,
   * and whether a client received payment-token money from the worker's side
   * shortly before it paid — the farming pattern prooflines measured on
   * an earlier deployment. Answered in words with the numbers behind them, and the block the
   * indexer had read up to, so the answer says what it rests on.
   */
  app.get('/v1/agents/:id/trust', async (request) => {
    const {id} = request.params as {id: string};
    if (!/^[1-9]\d{0,15}$/.test(id)) throw new PactoraError(ErrorCode.NOT_FOUND, `no agent ${id}`);
    const agent = await db.query.agents.findFirst({where: eq(agents.id, Number(id))});
    if (!agent) throw new PactoraError(ErrorCode.NOT_FOUND, `no agent ${id}`);
    if ((await personPublicView(db, agent.id)) === 'hidden') {
      throw new PactoraError(ErrorCode.NOT_FOUND, `no agent ${id}`);
    }
    const chain = chains[agent.chainId];
    if (!chain) throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${agent.chainId} is not enabled`);

    const reading = await readTrust(db, {chainId: agent.chainId, agentId: agent.id, floor: floorOf(chain)});
    const cursor = await db.query.indexerCursor.findFirst({
      where: and(eq(indexerCursor.chainId, agent.chainId), eq(indexerCursor.contract, 'Pactora')),
    });
    return {
      agentId: String(agent.id),
      chainId: agent.chainId,
      verdict: reading.verdict,
      action: reading.action,
      reasons: reading.reasons,
      metrics: reading.metrics,
      fundingWindowBlocks: DEFAULT_WINDOW_BLOCKS,
      indexedToBlock: cursor ? String(cursor.lastBlock) : null,
    };
  });

  /**
   * The key a new agent wallet is created with (docs/NEAR-PORT.md §5, step 1).
   *
   * The signer generates it on first request and holds the private half; the
   * owner's wallet adds the public half to the new account as a
   * function-call key scoped to the Pactora contract. Unauthenticated: a
   * public key is harmless, and asking twice returns the same key.
   */
  const walletKeyLimit = {
    config: {
      rateLimit: {
        max: Math.min(WALLET_KEY_RATE_PER_MINUTE, deps.rateLimitPerMinute ?? WALLET_KEY_RATE_PER_MINUTE),
        timeWindow: '1 minute',
      },
    },
  };
  app.post('/v1/agents/wallet-key', walletKeyLimit, async (request) => {
    const body = z.object({walletAddress: AccountId, chainId: ChainId.optional()}).parse(request.body);
    const chainId = body.chainId ?? defaultChainId;
    if (!enabled.includes(chainId)) {
      throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${chainId} is not enabled`);
    }
    if (!deps.walletKeys) {
      throw new PactoraError(ErrorCode.INVALID_STATE, 'this API has no signer, so it cannot hold agent keys');
    }
    const walletPublicKey = await deps.walletKeys.publicKeyFor({chainId, walletAddress: body.walletAddress});
    return {chainId, walletAddress: body.walletAddress, walletPublicKey};
  });

  /**
   * Start a registration: a message for the owner to sign (audit M1).
   *
   * Body `{ownerAddress, walletAddress, chainAgentId, chainId?}` — the same
   * values the registration will carry. Answers `{nonce, message, recipient,
   * expiresAt}`. The owner's wallet signs it with NEP-413 `signMessage`
   * (`nonce` is the 32 bytes, hex-encoded here). Single-use, five minutes;
   * each requester address keeps its newest few.
   */
  app.post('/v1/agents/challenge', async (request) => {
    const body = RegisterChallengeBody.parse(request.body);
    const chainId = body.chainId ?? defaultChainId;
    if (!enabled.includes(chainId)) {
      throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${chainId} is not enabled`);
    }
    const ownerAddress = body.ownerAddress;
    const nonce = newNonce();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    const requester = clientKey(request.ip);
    await db.transaction(async (tx) => {
      await tx.insert(registrationChallenges).values({nonce, chainId, ownerAddress, requester, expiresAt});
      await tx.execute(sql`
        DELETE FROM registration_challenges
        WHERE owner_address = ${ownerAddress}
          AND (expires_at <= now()
               OR nonce IN (SELECT nonce FROM registration_challenges
                            WHERE owner_address = ${ownerAddress} AND requester = ${requester}
                            ORDER BY expires_at DESC OFFSET ${LIVE_PER_REQUESTER}))
      `);
    });
    return {
      nonce,
      message: registrationMessage({...body, chainId, nonce}),
      recipient,
      expiresAt: expiresAt.toISOString(),
    };
  });

  /**
   * Register an agent.
   *
   * The on-chain registration (`register_agent`, with the storage deposit) is
   * done by the owner's own wallet; this records the off-chain half
   * (capabilities, endpoint, searchable price) and issues the API key.
   *
   * It proves control first (audit M1). Matching public chain data proves
   * nothing — anyone can read it — and the first registration of an agent
   * receives its only API key. So `signature` must be a NEP-413 signature by
   * a FULL-ACCESS key of `ownerAddress` over the challenge from
   * `POST /v1/agents/challenge`, which names this chain, owner, wallet and
   * agent id. An agent's own function-call key cannot pass.
   *
   * Then the chain confirms the rest: the agent id exists, is owned by
   * `ownerAddress`, is not frozen, and names `walletAddress` as its wallet —
   * accepted, or proposed and accepted now by the signer with the wallet's
   * own key (an agent cannot claim someone else's account, and the contract
   * enforces that). The database never claims an on-chain fact the chain
   * has not confirmed.
   */
  app.post('/v1/agents', async (request, reply) => {
    const body = RegisterBody.parse(request.body);
    if (deps.requirePublicHttpsEndpoints && body.endpointUrl && !isPublicHttpsUrl(body.endpointUrl)) {
      throw new PactoraError(
        ErrorCode.SCHEMA_MISMATCH,
        'endpointUrl must be a public https URL — not http, a loopback or a private address',
      );
    }
    const chainId = body.chainId ?? defaultChainId;
    if (!enabled.includes(chainId)) {
      throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${chainId} is not enabled`);
    }

    const challenge = await db.query.registrationChallenges.findFirst({
      where: eq(registrationChallenges.nonce, body.nonce),
    });
    if (
      !challenge ||
      challenge.expiresAt.getTime() <= Date.now() ||
      challenge.chainId !== chainId ||
      challenge.ownerAddress !== body.ownerAddress
    ) {
      throw new PactoraError(
        ErrorCode.UNAUTHORIZED,
        'no live registration challenge for this owner and chain — request one from POST /v1/agents/challenge',
      );
    }
    const message = registrationMessage({...body, chainId});
    const signed = await deps.verifyOwner({
      chainId,
      accountId: body.ownerAddress,
      publicKey: body.publicKey,
      signature: body.signature,
      message,
      nonce: body.nonce,
    });
    if (!signed) {
      throw new PactoraError(
        ErrorCode.UNAUTHORIZED,
        `the signature is not a full-access key of ${body.ownerAddress} over this registration's challenge`,
      );
    }

    // The per-owner cap (docs/26 F25): registration is open, and a cap is
    // what keeps one account from filling the directory. Counted before the
    // signer is asked to accept a wallet for an agent that will be refused.
    const cap = deps.maxAgentsPerOwner ?? DEFAULT_MAX_AGENTS_PER_OWNER;
    const [{n: owned} = {n: 0}] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM agents WHERE chain_id = ${chainId} AND owner_address = ${body.ownerAddress}`,
    )) as unknown as [{n: number}?];
    if (Number(owned) >= cap) {
      throw new PactoraError(
        ErrorCode.LIMIT_REACHED,
        `${body.ownerAddress} already owns ${owned} agents on ${chainId}, the most one account may register (${cap})`,
      );
    }

    const pending = await verifyIdentity(deps.readIdentity, chainId, BigInt(body.chainAgentId), body);
    if (pending) {
      if (!deps.walletKeys) {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          `agent ${body.chainAgentId}'s wallet has not accepted, and this API has no signer to accept for it`,
        );
      }
      await deps.walletKeys.accept({
        chainId,
        walletAddress: body.walletAddress,
        chainAgentId: body.chainAgentId,
      });
    }

    const created = await db.transaction(async (tx) => {
      // Consumed with the registration, atomically: a signature registers once.
      const used = await tx
        .delete(registrationChallenges)
        .where(eq(registrationChallenges.nonce, body.nonce))
        .returning({nonce: registrationChallenges.nonce});
      if (used.length === 0) {
        throw new PactoraError(ErrorCode.UNAUTHORIZED, 'that registration challenge was already used');
      }

      const [agent] = await tx
        .insert(agents)
        .values({
          chainId,
          ownerAddress: body.ownerAddress,
          walletAddress: body.walletAddress,
          name: body.name,
          description: body.description ?? null,
          endpointUrl: body.endpointUrl ?? null,
          pricePerTask: body.pricePerTask,
          chainAgentId: body.chainAgentId ?? null,
        })
        .returning();

      await tx
        .insert(agentCapabilities)
        .values(body.capabilities.map((capability) => ({agentId: agent!.id, capability})));
      await tx.insert(agentStats).values({agentId: agent!.id});

      // A starting spend policy, from this chain's configured defaults.
      //
      // Without it an agent registers with no policy row at all, and
      // /v1/budget falls back to the cache, finds nothing, and reports zero —
      // so an orchestrator refuses to hire anybody and the marketplace does
      // not work at all for a new agent. Meanwhile the signer, reading a
      // wallet that is a plain EOA rather than an AgentAccount, enforces
      // nothing. Those two disagreeing is worse than either alone.
      //
      // The on-chain caps still win wherever an AgentAccount exists; this is
      // the floor for everyone else.
      await tx.insert(spendPolicies).values({
        agentId: agent!.id,
        perTaskCap: String(chains[chainId]!.params.defaultPerTaskCap),
        dailyCap: String(chains[chainId]!.params.defaultDailyCap),
      });

      const {key, keyId} = generateApiKey();
      await tx.insert(apiKeys).values({
        agentId: agent!.id,
        keyId,
        keyHash: hashApiKey(key),
        scopes: ['client', 'worker'],
      });

      return {agent: agent!, key};
    });

    return reply.status(201).send({
      agentId: created.agent.id,
      chainId,
      walletAddress: created.agent.walletAddress,
      // Shown exactly once. Only a hash is stored, so it cannot be recovered.
      apiKey: created.key,
      warning: 'Store this key now — it is not recoverable.',
    });
  });

  app.patch('/v1/agents/:id', async (request) => {
    const caller = await authenticate(db, request);
    const {id} = request.params as {id: string};
    if (Number(id) !== caller.agentId) {
      throw new PactoraError(ErrorCode.FORBIDDEN, 'an API key may only modify its own agent');
    }
    resolveChainId(request, caller, enabled);

    const patch = UpdateAgentBody.parse(request.body);

    const [updated] = await db
      .update(agents)
      .set({
        ...(patch.pricePerTask !== undefined ? {pricePerTask: patch.pricePerTask} : {}),
        ...(patch.active !== undefined ? {active: patch.active} : {}),
        ...(patch.description !== undefined ? {description: patch.description} : {}),
      })
      .where(eq(agents.id, caller.agentId))
      .returning();

    return {agentId: updated!.id, pricePerTask: updated!.pricePerTask, active: updated!.active};
  });

  app.get('/v1/rank-modes', async () => ({modes: RANK_MODES}));
}

/** The chain's confidence floor: how much evidence a score needs before it moves fully. */
function floorOf(chain: ChainConfig): number {
  return Number(chain.params['confidenceFloor'] ?? 25);
}

/** Every response states its chain, so a client never has to infer it. */
/**
 * For a person's row: `hidden` until their profile is published, else what
 * the profile shows; null for an agent (always public).
 */
export async function personPublicView(
  db: Db,
  agentId: number,
): Promise<'hidden' | null | {publicId: string; displayName: string; showAccount: boolean}> {
  const [row] = (await db.execute(sql`
    SELECT a.kind, a.public_id, p.published, p.display_name, p.show_account
      FROM agents a LEFT JOIN public_profiles p ON p.agent_id = a.id WHERE a.id = ${agentId}`)) as unknown as {
    kind: string;
    public_id: string;
    published: boolean | null;
    display_name: string | null;
    show_account: boolean | null;
  }[];
  if (!row || row.kind !== 'person') return null;
  if (!row.published) return 'hidden';
  return {
    publicId: row.public_id,
    displayName: row.display_name ?? 'a person',
    showAccount: Boolean(row.show_account),
  };
}

function present(a: AgentRow, chain: ChainConfig) {
  const completed = Number(a.completed ?? 0);
  const failed = Number(a.failed ?? 0);
  const n = completed + failed;
  return {
    agentId: a.id,
    chainId: a.chainId,
    network: chain.name,
    chainAgentId: a.chainAgentId,
    name: a.name,
    description: a.description,
    capabilities: a.capabilities ?? [],
    pricePerTask: a.pricePerTask,
    priceDisplay: chain.formatToken(BigInt(a.pricePerTask)),
    walletAddress: a.walletAddress,
    score: Number(a.score ?? 50),
    completed,
    failed,
    successRate: n === 0 ? null : Number((completed / n).toFixed(4)),
    active: a.active,
    explorerUrl: chain.explorerAddress(a.walletAddress),
  };
}

/**
 * Refuse an on-chain id the chain does not back. Answers whether the wallet
 * is still only proposed (and so must accept before the agent can work).
 *
 * The owner check stops anyone claiming an identity — and the reputation
 * attached to it — by naming its id; the wallet check is who the contract
 * lets act for the agent, so a mismatch would hand the agent to someone
 * other than the registrant thinks.
 */
async function verifyIdentity(
  read: IdentityReader | undefined,
  chainId: string,
  chainAgentId: bigint,
  body: {ownerAddress: string; walletAddress: string},
): Promise<boolean> {
  if (!read) {
    throw new PactoraError(
      ErrorCode.INVALID_STATE,
      'this API cannot read the contract, so it cannot verify chainAgentId',
    );
  }
  const identity = await read({chainId, chainAgentId});
  if (!identity) {
    throw new PactoraError(ErrorCode.INVALID_STATE, `agent ${chainAgentId} does not exist on ${chainId}`);
  }
  if (identity.owner !== body.ownerAddress) {
    throw new PactoraError(
      ErrorCode.INVALID_STATE,
      `agent ${chainAgentId} is owned by ${identity.owner}, not ${body.ownerAddress}`,
    );
  }
  if (identity.frozen) {
    throw new PactoraError(ErrorCode.INVALID_STATE, `agent ${chainAgentId} is frozen by its owner`);
  }
  if (identity.wallet === body.walletAddress) return false;
  if (identity.pendingWallet === body.walletAddress) return true;
  throw new PactoraError(
    ErrorCode.INVALID_STATE,
    `agent ${chainAgentId}'s wallet is ${identity.wallet ?? identity.pendingWallet ?? 'unset'}, not ${body.walletAddress}`,
  );
}
