import type {FastifyInstance, FastifyRequest} from 'fastify';
import {and, asc, desc, eq, inArray, isNull, lt, ne, sql, type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {sha256Hex} from '@pactora/near';
import {
  agentCapabilities,
  agentStats,
  agents,
  applications,
  jobs,
  listingSlots,
  listings,
  publicProfiles,
  readTrust,
  type Db,
} from '@pactora/db';
import {BaseUnits, ChainId, ErrorCode, PactoraError, canonicalize, type JobSpec} from '@pactora/shared';
import type {ChainConfig} from '@pactora/config';
import {actorOf, optionalActorOf, type Actor, type AgentRow} from '../actor.js';
import {applicantSummary, recordAgentEvent} from '../agent-events.js';
import {notifyApplicants, reviveSetAsideBids} from '../listing-slots.js';
import {requireClear} from '../compliance.js';
import type {BudgetReader, ChainViewer} from '../chain-reads.js';
import {Cursor, page} from '../cursor.js';
import type {EventBus} from '../events.js';
import {feeOf, workerReceives} from '../fees.js';
import {listingMatchesSql, locationMatchesSql, textArray} from '../matching.js';
import {hire, isPublicId, requiredIdempotencyKey, specHashOf, type JobRouteDeps} from './jobs.js';
import {createJobCall} from './person-actions.js';

/**
 * Listings: work offered to many, priced by the people and agents who apply
 * (docs/26 F4, F5, F6-a, F18, F31).
 *
 * A listing holds no money. Each bid the client selects — or each claim, in
 * instant mode — becomes an ordinary 1:1 Pactora job at the bid's price:
 * the same `jobs` row, the same `create_job`, the same exits. An agent
 * client's job is funded by the signer through `hire()`; a person client is
 * handed the `create_job` FunctionCall to sign, the job row already written
 * so the indexer can link it by spec hash and parties.
 *
 * The fee: the contract takes `max(amount × bps / 10000, min_fee)` out of
 * the WORKER's payout when a job settles (`fee_of`, lib.rs), so a client
 * pays the bid price and not a unit more. What posting reserves against the
 * client's on-chain daily allowance is therefore max_workers × (ceiling +
 * 0): the ceiling alone, per worker.
 */

/** docs/26 F4 limits. */
export const LIMITS = {
  maxWorkers: 20,
  bidsPerApplicant: 3,
  applicationsPerListing: 1_000,
  pageSize: 20,
  deadlineDays: 90,
} as const;

/** Trimmed, every run of whitespace one space: what matching compares and the database stores. */
const oneLine = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(min).max(max));
/** Trimmed only: line breaks in a description or proposal are the author's. */
const text = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(min).max(max));

export const Skill = z
  .string()
  .transform((s) => s.replace(/\s+/g, ' ').trim().toLowerCase())
  .pipe(z.string().min(2, 'a skill is 2-50 characters').max(50, 'a skill is 2-50 characters'));

export const Location = oneLine(0, 120);

const ListingFields = {
  title: oneLine(5, 140),
  description: text(10, 5000),
  category: z.enum(['physical', 'expertise', 'judgment']),
  interactionMode: z.enum(['task', 'conversation', 'capture']),
  skills: z
    .array(Skill)
    .max(20, 'at most 20 skills')
    .transform((s) => [...new Set(s)]),
  location: Location,
  /** The most the client pays ONE worker, in base units. */
  maxPriceBaseUnits: BaseUnits,
  maxWorkers: z.number().int().min(1).max(LIMITS.maxWorkers),
  hiringMode: z.enum(['applications', 'instant']),
  estimatedMinutes: z.number().int().min(1).max(10_080),
  deadline: z.iso.datetime({offset: true}),
  criteria: text(10, 3000),
  acceptWindowSeconds: z.number().int().positive(),
  workWindowSeconds: z.number().int().positive(),
};

export const ListingBody = z.object({
  ...ListingFields,
  skills: ListingFields.skills.default([]),
  location: ListingFields.location.default(''),
  hiringMode: ListingFields.hiringMode.default('applications'),
  acceptWindowSeconds: ListingFields.acceptWindowSeconds.optional(),
  workWindowSeconds: ListingFields.workWindowSeconds.optional(),
});
export const ListingPatch = z
  .object(ListingFields)
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'nothing to change');

export const ListingQuery = z.object({
  /** Default `open`: taking applications, deadline not passed. */
  status: z.enum(['open', 'closed', 'filled', 'cancelled']).default('open'),
  category: ListingFields.category.optional(),
  interactionMode: ListingFields.interactionMode.optional(),
  hiringMode: ListingFields.hiringMode.optional(),
  /** One skill the listing must name. */
  skill: Skill.optional(),
  /** Listings a worker at this location may take (the F18 rule). */
  location: Location.optional(),
  /** `me`: the caller's own skills and location decide (needs a bearer). */
  match: z.literal('me').optional(),
  /** `true`: only listings the caller posted (needs a bearer). */
  mine: z.enum(['true', 'false']).optional(),
  /** Words to find in the title, description or skills (Postgres full text, every word must match). */
  q: z.string().trim().min(1).max(100, 'q is at most 100 characters').optional(),
  /** Default: the caller's chain, else the API's default. */
  chainId: ChainId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(LIMITS.pageSize),
  cursor: Cursor.optional(),
});

export const ApplicationBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('apply'),
    priceBaseUnits: BaseUnits,
    proposal: text(20, 3000),
  }),
  z.object({
    action: z.literal('withdraw'),
    /** Omitted: the caller's live bid. */
    applicationId: z.uuid().optional(),
  }),
]);

export const ApplicationsQuery = z.object({
  sort: z.enum(['recent', 'price_low', 'price_high', 'rating']).default('recent'),
  status: z.enum(['pending', 'selected', 'rejected', 'withdrawn']).optional(),
  page: z.coerce.number().int().min(1).max(50).default(1),
});

export const DecideBody = z.object({
  applicationId: z.uuid(),
  action: z.enum(['select', 'reject']),
  /** Shared with the applicant. */
  reason: text(10, 2000),
});

export const ClaimBody = z.object({proposal: text(20, 3000).optional()}).default({});

export const UnselectBody = z.object({applicationId: z.uuid()});
const UNSELECTED_REASON = 'The client released the selection before the job was funded.';

export interface ListingRouteDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  bus: EventBus;
  submit: JobRouteDeps['submit'];
  defaultChainId: string;
  /** The client's on-chain purse. Omitted, nothing can be posted: the reservation cannot be checked. */
  readBudget?: BudgetReader;
  /** Contract views; `stake_of` says whether a worker is hireable before a bid is selected. */
  viewChain?: ChainViewer;
}

type Listing = typeof listings.$inferSelect;
type Application = typeof applications.$inferSelect;

const CLOSED_REASON = 'Hiring closed before this bid was decided.';
const FILLED_REASON = 'Every worker slot on this listing was filled.';
const CANCELLED_REASON = 'The client cancelled this listing.';
const CLAIM_PROPOSAL = 'Claimed in instant mode at the listed price.';

/**
 * Full text over title, description and skills, as migration 0023 indexed
 * it. `websearch_to_tsquery` never throws on user input (unbalanced quotes,
 * stray operators), unlike `to_tsquery`.
 */
export function listingSearchSql(q: string): SQL {
  return sql`to_tsvector('simple', pactora_listing_search_text(${listings.title}, ${listings.description}, ${listings.skills})) @@ websearch_to_tsquery('simple', ${q})`;
}

/** Open in the database but past its deadline reads as closed: applications stop at the deadline. */
export function effectiveStatus(
  l: Pick<Listing, 'status' | 'deadline'>,
  now = Date.now(),
): Listing['status'] {
  return l.status === 'open' && l.deadline.getTime() <= now ? 'closed' : l.status;
}

/** A job's spec for a selected bid: the listing's terms, the bid, and the price — all inside the spec hash. */
export function listingJobSpec(
  listing: Listing,
  application: Pick<Application, 'publicId' | 'proposal' | 'price'>,
): JobSpec {
  const first = listing.skills[0]?.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return {
    capability: first && first.length >= 2 ? first : listing.category,
    input: {
      listing: {
        listingId: listing.publicId,
        title: listing.title,
        description: listing.description,
        category: listing.category,
        interactionMode: listing.interactionMode,
        skills: listing.skills,
        location: listing.location,
        estimatedMinutes: listing.estimatedMinutes,
        criteria: listing.criteria,
        deadline: listing.deadline.toISOString(),
        maxPriceBaseUnits: listing.maxPrice,
      },
      application: {applicationId: application.publicId, proposal: application.proposal},
      priceBaseUnits: application.price,
    },
    deadlineSeconds: Math.min(86_400, Math.max(10, listing.workWindowSeconds)),
  };
}

export async function registerListingRoutes(app: FastifyInstance, deps: ListingRouteDeps): Promise<void> {
  const {db, chains} = deps;

  const chainOf = (chainId: string) => {
    const chain = chains[chainId];
    if (!chain) throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${chainId} is not enabled`);
    return chain;
  };

  async function loadListing(request: FastifyRequest): Promise<Listing> {
    const id = (request.params as {id: string}).id;
    const row = isPublicId(id)
      ? await db.query.listings.findFirst({where: eq(listings.publicId, id)})
      : undefined;
    if (!row) throw new PactoraError(ErrorCode.NOT_FOUND, `no listing ${id}`);
    return row;
  }

  async function ownerOf(request: FastifyRequest): Promise<{actor: Actor; listing: Listing}> {
    const actor = await actorOf(db, request);
    const listing = await loadListing(request);
    if (listing.clientAgentId !== actor.agent.id) {
      throw new PactoraError(ErrorCode.FORBIDDEN, 'only the client who posted this listing may do that');
    }
    return {actor, listing};
  }

  const slotsOf = async (listingId: number) =>
    db
      .select()
      .from(listingSlots)
      .where(eq(listingSlots.listingId, listingId))
      .orderBy(asc(listingSlots.slot));

  async function view(listing: Listing) {
    const chain = chainOf(listing.chainId);
    const [client, slots] = await Promise.all([
      db.query.agents.findFirst({where: eq(agents.id, listing.clientAgentId)}),
      slotsOf(listing.id),
    ]);
    const ceiling = BigInt(listing.maxPrice);
    return {
      listingId: listing.publicId,
      chainId: listing.chainId,
      client: client
        ? {agentId: String(client.id), kind: client.kind, name: client.name, publicId: client.publicId}
        : null,
      title: listing.title,
      description: listing.description,
      category: listing.category,
      interactionMode: listing.interactionMode,
      skills: listing.skills,
      location: listing.location,
      maxPriceBaseUnits: listing.maxPrice,
      maxPriceDisplay: chain.formatToken(ceiling),
      /** The fee at the ceiling, taken from the worker's payout — the client pays the price alone. */
      feeAtCeilingBaseUnits: feeOf(ceiling, chain.params).toString(),
      workerReceivesAtCeilingBaseUnits: workerReceives(ceiling, chain.params).toString(),
      maxWorkers: listing.maxWorkers,
      slotsFilled: slots.length,
      hiringMode: listing.hiringMode,
      estimatedMinutes: listing.estimatedMinutes,
      deadline: listing.deadline.toISOString(),
      criteria: listing.criteria,
      acceptWindowSeconds: listing.acceptWindowSeconds,
      workWindowSeconds: listing.workWindowSeconds,
      status: effectiveStatus(listing),
      reservedBaseUnits: listing.reserved,
      /** Moderation hid it from the public board (0028); the owner still sees it here. */
      hidden: listing.hiddenAt !== null,
      createdAt: listing.createdAt.toISOString(),
      updatedAt: listing.updatedAt.toISOString(),
    };
  }

  function applicationView(a: Application, chain: ChainConfig, jobPublicId: string | null) {
    const price = BigInt(a.price);
    return {
      applicationId: a.publicId,
      status: a.status,
      priceBaseUnits: a.price,
      priceDisplay: chain.formatToken(price),
      /** What the worker is paid if the job settles: the price less the contract's fee. */
      feeBaseUnits: feeOf(price, chain.params).toString(),
      workerReceivesBaseUnits: workerReceives(price, chain.params).toString(),
      proposal: a.proposal,
      reason: a.reason,
      reopenable: a.reopenable,
      jobId: jobPublicId,
      createdAt: a.createdAt.toISOString(),
      decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
    };
  }

  async function jobPublicIds(ids: (number | null)[]): Promise<Map<number, string>> {
    const wanted = ids.filter((x): x is number => x !== null);
    if (wanted.length === 0) return new Map();
    const rows = await db
      .select({id: jobs.id, publicId: jobs.publicId})
      .from(jobs)
      .where(inArray(jobs.id, wanted));
    return new Map(rows.map((r) => [r.id, r.publicId]));
  }

  /** Of these agents, the ones in good standing (no hold, not blocked). */
  async function clearAmong(agentIds: number[]): Promise<Set<number>> {
    if (agentIds.length === 0) return new Set();
    const held = (await db.execute(
      sql`SELECT agent_id FROM account_standing WHERE standing <> 'clear' AND agent_id IN ${sql.raw(`(${[...new Set(agentIds)].map((n) => Number(n)).join(',')})`)}`,
    )) as unknown as {agent_id: string | number}[];
    const heldIds = new Set(held.map((h) => Number(h.agent_id)));
    return new Set(agentIds.filter((id) => !heldIds.has(id)));
  }

  /**
   * The chain's word on whether a worker can be hired right now (`stake_of
   * … hireable`): a person client's selection used to go through for a
   * worker the contract then refused (NotHireable), leaving a slot taken and
   * a job that could never be funded (live probe). Unreadable → not checked
   * (the signer or the chain still refuses).
   */
  async function refuseNotHireable(workerAgentId: number, chainId: string): Promise<void> {
    if (!deps.viewChain) return;
    const worker = await db.query.agents.findFirst({where: eq(agents.id, workerAgentId)});
    if (!worker?.chainAgentId) return;
    const chain = chainOf(chainId);
    const stake = (await deps
      .viewChain(chainId, chain.contracts.Pactora, 'stake_of', {agent_id: Number(worker.chainAgentId)})
      .catch(() => undefined)) as {hireable?: boolean} | null | undefined;
    if (stake === undefined) return;
    if (!stake || stake.hireable !== true) {
      throw new PactoraError(
        ErrorCode.AGENT_NOT_HIREABLE,
        `the contract reports this worker as not hireable right now (its unlocked stake is below min_stake); choose another bid or ask the worker to top up its stake`,
      );
    }
  }

  /** Windows within the contract's maxima (create_job refuses anything longer: WINDOW_TOO_LONG). */
  function checkWindows(chain: ChainConfig, accept: number, work: number) {
    const p = chain.params;
    if (accept > p.maxAcceptWindowSeconds) {
      throw new PactoraError(
        ErrorCode.SCHEMA_MISMATCH,
        `acceptWindowSeconds ${accept} is above this chain's maximum of ${p.maxAcceptWindowSeconds} s (max_accept_window)`,
      );
    }
    if (work > p.maxWorkWindowSeconds) {
      throw new PactoraError(
        ErrorCode.SCHEMA_MISMATCH,
        `workWindowSeconds ${work} is above this chain's maximum of ${p.maxWorkWindowSeconds} s (max_work_window, ${p.maxWorkWindowSeconds / 3600} h) — split the task or shorten it`,
      );
    }
  }

  function checkPriceBounds(chain: ChainConfig, price: bigint, what: string) {
    const {minJobAmount, maxJobAmount} = chain.params;
    if (price < minJobAmount) {
      throw new PactoraError(
        ErrorCode.SCHEMA_MISMATCH,
        `${what} ${chain.formatToken(price)} is below the escrow minimum of ${chain.formatToken(minJobAmount)}`,
      );
    }
    if (price > maxJobAmount) {
      throw new PactoraError(
        ErrorCode.SCHEMA_MISMATCH,
        `${what} ${chain.formatToken(price)} is above the escrow maximum of ${chain.formatToken(maxJobAmount)}`,
      );
    }
  }

  function checkDeadline(deadline: Date) {
    const now = Date.now();
    if (deadline.getTime() <= now) {
      throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, 'the deadline must be in the future');
    }
    if (deadline.getTime() > now + LIMITS.deadlineDays * 86_400_000) {
      throw new PactoraError(
        ErrorCode.SCHEMA_MISMATCH,
        `the deadline is at most ${LIMITS.deadlineDays} days away`,
      );
    }
  }

  /**
   * The reservation: every open listing of this client holds (unfilled slots
   * × ceiling) of its rolling daily allowance; a new or bigger one must fit
   * in what is left, and one worker's price must fit the per-task cap.
   */
  async function checkBudget(
    client: AgentRow,
    chainId: string,
    want: {maxPrice: bigint; maxWorkers: number},
    excludeListingId?: number,
  ): Promise<bigint> {
    const chain = chainOf(chainId);
    const reserved = want.maxPrice * BigInt(want.maxWorkers);
    if (!deps.readBudget) {
      throw new PactoraError(
        ErrorCode.UPSTREAM_UNAVAILABLE,
        'this API cannot read on-chain budgets, so it cannot reserve one',
        5,
      );
    }
    const budget = await deps.readBudget({chainId, walletAddress: client.walletAddress});
    if (!budget) {
      throw new PactoraError(
        ErrorCode.UPSTREAM_UNAVAILABLE,
        `could not read the on-chain purse of ${client.walletAddress} — retry`,
        5,
      );
    }
    if (want.maxPrice > budget.perTaskCap) {
      throw new PactoraError(
        ErrorCode.BUDGET_EXCEEDED,
        `the per-worker ceiling ${chain.formatToken(want.maxPrice)} is above your per-task cap of ${chain.formatToken(budget.perTaskCap)}`,
      );
    }
    const [row] = (await db.execute(sql`
      SELECT COALESCE(sum((l.max_workers - (SELECT count(*) FROM listing_slots s WHERE s.listing_id = l.id)) * l.max_price), 0)::text AS held
        FROM listings l
       WHERE l.client_agent_id = ${client.id} AND l.status = 'open' AND l.deadline > now()
         ${excludeListingId !== undefined ? sql`AND l.id <> ${excludeListingId}` : sql``}
    `)) as unknown as {held: string}[];
    const held = BigInt(row?.held ?? '0');
    if (reserved + held > budget.dailyRemaining) {
      throw new PactoraError(
        ErrorCode.BUDGET_EXCEEDED,
        `this listing reserves ${chain.formatToken(reserved)} (${want.maxWorkers} × ${chain.formatToken(want.maxPrice)}); ` +
          `your open listings already hold ${chain.formatToken(held)} and your rolling daily allowance has ${chain.formatToken(budget.dailyRemaining)} left`,
      );
    }
    if (reserved + held > budget.tokenBalance) {
      throw new PactoraError(
        ErrorCode.INSUFFICIENT_FUNDS,
        `this listing reserves ${chain.formatToken(reserved)} but your purse holds ${chain.formatToken(budget.tokenBalance)} (${chain.formatToken(held)} already held by open listings) — fund it first`,
      );
    }
    return reserved;
  }

  // ── post ──────────────────────────────────────────────────────────────

  app.post('/v1/listings', async (request, reply) => {
    const actor = await actorOf(db, request);
    // Standing gates posting (docs/26 F14), before anything else is read.
    await requireClear(db, actor.agent.id, 'post work');
    const key = requiredIdempotencyKey(request);
    const body = ListingBody.parse(request.body);
    const chain = chainOf(actor.chainId);
    if (!actor.agent.chainAgentId) {
      throw new PactoraError(
        ErrorCode.AGENT_NOT_HIREABLE,
        'your agent has no on-chain id yet — it cannot fund jobs',
        2,
      );
    }
    const accept = body.acceptWindowSeconds ?? chain.params.acceptWindowSeconds;
    const work = body.workWindowSeconds ?? chain.params.workWindowSeconds;
    const normalized = {...body, acceptWindowSeconds: accept, workWindowSeconds: work};
    const requestHash = sha256Hex(canonicalize(normalized));

    const prior = await db.query.listings.findFirst({
      where: and(eq(listings.clientAgentId, actor.agent.id), eq(listings.idempotencyKey, key)),
    });
    if (prior) {
      if (prior.requestHash !== requestHash) {
        throw new PactoraError(
          ErrorCode.IDEMPOTENCY_CONFLICT,
          `Idempotency-Key ${key} was already used for a different listing`,
        );
      }
      return reply.status(200).send(await view(prior));
    }

    checkWindows(chain, accept, work);
    const ceiling = BigInt(body.maxPriceBaseUnits);
    checkPriceBounds(chain, ceiling, 'the per-worker ceiling');
    const deadline = new Date(body.deadline);
    checkDeadline(deadline);
    const reserved = await checkBudget(actor.agent, actor.chainId, {
      maxPrice: ceiling,
      maxWorkers: body.maxWorkers,
    });

    const [row] = await db
      .insert(listings)
      .values({
        chainId: actor.chainId,
        clientAgentId: actor.agent.id,
        title: body.title,
        description: body.description,
        category: body.category,
        interactionMode: body.interactionMode,
        skills: body.skills,
        location: body.location,
        maxPrice: ceiling.toString(),
        maxWorkers: body.maxWorkers,
        hiringMode: body.hiringMode,
        estimatedMinutes: body.estimatedMinutes,
        deadline,
        criteria: body.criteria,
        acceptWindowSeconds: accept,
        workWindowSeconds: work,
        reserved: reserved.toString(),
        idempotencyKey: key,
        requestHash,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      // A concurrent request with the same key won the insert: answer as a replay.
      const won = await db.query.listings.findFirst({
        where: and(eq(listings.clientAgentId, actor.agent.id), eq(listings.idempotencyKey, key)),
      });
      if (!won || won.requestHash !== requestHash) {
        throw new PactoraError(
          ErrorCode.IDEMPOTENCY_CONFLICT,
          `Idempotency-Key ${key} was already used for a different listing`,
        );
      }
      return reply.status(200).send(await view(won));
    }
    await alertMatches(db, row);
    return reply.status(201).send(await view(row));
  });

  // ── read ──────────────────────────────────────────────────────────────

  app.get('/v1/listings', async (request) => {
    const query = ListingQuery.parse(request.query ?? {});
    const needsCaller = query.match === 'me' || query.mine === 'true';
    const actor = needsCaller
      ? await actorOf(db, request)
      : await optionalActorOf(db, request).catch(() => null);
    const chainId = query.chainId ?? actor?.chainId ?? deps.defaultChainId;
    chainOf(chainId);

    const status: SQL =
      query.status === 'open'
        ? sql`(${listings.status} = 'open' AND ${listings.deadline} > now())`
        : query.status === 'closed'
          ? sql`(${listings.status} = 'closed' OR (${listings.status} = 'open' AND ${listings.deadline} <= now()))`
          : sql`${listings.status} = ${query.status}`;

    let matchMe: SQL | undefined;
    if (query.match === 'me' && actor) {
      // The caller's capabilities and profile skills together (0026), and
      // the agent's location (the profile's is mirrored there).
      const caps = await db
        .select({c: agentCapabilities.capability})
        .from(agentCapabilities)
        .where(eq(agentCapabilities.agentId, actor.agent.id));
      const profile = await db.query.publicProfiles.findFirst({
        where: eq(publicProfiles.agentId, actor.agent.id),
      });
      const mine = [...new Set([...caps.map((c) => c.c.toLowerCase()), ...(profile?.skills ?? [])])];
      matchMe = listingMatchesSql(
        {skills: sql`${listings.skills}`, location: sql`${listings.location}`},
        {skills: textArray(mine), location: sql`${actor.agent.location}`},
      );
    }

    const fetched = await db
      .select()
      .from(listings)
      .where(
        and(
          eq(listings.chainId, chainId),
          status,
          // A hidden listing (moderation, 0028) is off the public board; its owner still lists it.
          query.mine === 'true' && actor ? undefined : isNull(listings.hiddenAt),
          query.category ? eq(listings.category, query.category) : undefined,
          query.interactionMode ? eq(listings.interactionMode, query.interactionMode) : undefined,
          query.hiringMode ? eq(listings.hiringMode, query.hiringMode) : undefined,
          query.skill ? sql`${query.skill} = ANY(${listings.skills})` : undefined,
          // The same expression migration 0023 indexed, or the index is not used.
          query.q ? listingSearchSql(query.q) : undefined,
          query.location !== undefined
            ? locationMatchesSql(sql`${listings.location}`, sql`${query.location}`)
            : undefined,
          matchMe,
          query.mine === 'true' && actor ? eq(listings.clientAgentId, actor.agent.id) : undefined,
          query.cursor !== undefined ? lt(listings.id, query.cursor) : undefined,
        ),
      )
      // Newest first: a board shows what was just posted.
      .orderBy(desc(listings.id))
      .limit(query.limit + 1);
    const {rows, nextCursor} = page(fetched, query.limit);
    return {count: rows.length, nextCursor, listings: await Promise.all(rows.map(view))};
  });

  app.get('/v1/listings/:id', async (request) => {
    const listing = await loadListing(request);
    const actor = await optionalActorOf(db, request);
    // Hidden by moderation: gone for everyone but its owner.
    if (listing.hiddenAt !== null && actor?.agent.id !== listing.clientAgentId) {
      throw new PactoraError(ErrorCode.NOT_FOUND, `no listing ${listing.publicId}`);
    }
    const base = await view(listing);
    if (!actor) return base;
    const chain = chainOf(listing.chainId);
    if (actor.agent.id === listing.clientAgentId) {
      const slots = await slotsOf(listing.id);
      const ids = await jobPublicIds(slots.map((s) => s.jobId));
      return {
        ...base,
        viewer: {
          isOwner: true,
          slots: slots.map((s) => ({
            slot: s.slot,
            jobId: s.jobId !== null ? (ids.get(s.jobId) ?? null) : null,
          })),
        },
      };
    }
    // An applicant sees its own bids, never anyone else's — and whether the client is in good standing.
    const clientClear = (await clearAmong([listing.clientAgentId])).has(listing.clientAgentId);
    const mine = await db
      .select()
      .from(applications)
      .where(and(eq(applications.listingId, listing.id), eq(applications.applicantAgentId, actor.agent.id)))
      .orderBy(desc(applications.id));
    const ids = await jobPublicIds(mine.map((a) => a.jobId));
    return {
      ...base,
      viewer: {
        isOwner: false,
        counterpartyClear: clientClear,
        applications: mine.map((a) =>
          applicationView(a, chain, a.jobId !== null ? (ids.get(a.jobId) ?? null) : null),
        ),
      },
    };
  });

  // ── edit, cancel ─────────────────────────────────────────────────────

  app.patch('/v1/listings/:id', async (request) => {
    const {actor, listing} = await ownerOf(request);
    const patch = ListingPatch.parse(request.body);
    const chain = chainOf(listing.chainId);
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM listings WHERE id = ${listing.id} FOR UPDATE`);
      const current = (await tx.query.listings.findFirst({where: eq(listings.id, listing.id)}))!;
      if (current.status !== 'open') {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          `the listing is ${current.status}; only an open listing can be edited`,
        );
      }
      const [{n}] = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM listing_slots WHERE listing_id = ${listing.id}`,
      )) as unknown as [{n: number}];
      if (n > 0) {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          'a worker has been selected; the listing can no longer be edited',
        );
      }
      const accept = patch.acceptWindowSeconds ?? current.acceptWindowSeconds;
      const work = patch.workWindowSeconds ?? current.workWindowSeconds;
      checkWindows(chain, accept, work);
      const ceiling =
        patch.maxPriceBaseUnits !== undefined ? BigInt(patch.maxPriceBaseUnits) : BigInt(current.maxPrice);
      checkPriceBounds(chain, ceiling, 'the per-worker ceiling');
      // A ceiling below a bid already made would leave that bid unselectable.
      const [{top}] = (await tx.execute(
        sql`SELECT COALESCE(max(price), 0)::text AS top FROM applications WHERE listing_id = ${listing.id} AND status = 'pending'`,
      )) as unknown as [{top: string}];
      if (ceiling < BigInt(top)) {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          `the ceiling cannot go below the highest live bid, ${chain.formatToken(BigInt(top))}`,
        );
      }
      const deadline = patch.deadline !== undefined ? new Date(patch.deadline) : current.deadline;
      if (patch.deadline !== undefined) checkDeadline(deadline);
      const maxWorkers = patch.maxWorkers ?? current.maxWorkers;
      const reserved = await checkBudget(
        actor.agent,
        listing.chainId,
        {maxPrice: ceiling, maxWorkers},
        listing.id,
      );
      const [row] = await tx
        .update(listings)
        .set({
          ...(patch.title !== undefined ? {title: patch.title} : {}),
          ...(patch.description !== undefined ? {description: patch.description} : {}),
          ...(patch.category !== undefined ? {category: patch.category} : {}),
          ...(patch.interactionMode !== undefined ? {interactionMode: patch.interactionMode} : {}),
          ...(patch.skills !== undefined ? {skills: patch.skills} : {}),
          ...(patch.location !== undefined ? {location: patch.location} : {}),
          ...(patch.hiringMode !== undefined ? {hiringMode: patch.hiringMode} : {}),
          ...(patch.estimatedMinutes !== undefined ? {estimatedMinutes: patch.estimatedMinutes} : {}),
          ...(patch.criteria !== undefined ? {criteria: patch.criteria} : {}),
          maxPrice: ceiling.toString(),
          maxWorkers,
          deadline,
          acceptWindowSeconds: accept,
          workWindowSeconds: work,
          reserved: reserved.toString(),
          updatedAt: new Date(),
        })
        .where(eq(listings.id, listing.id))
        .returning();
      return view(row!);
    });
  });

  app.delete('/v1/listings/:id', async (request) => {
    const {listing} = await ownerOf(request);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM listings WHERE id = ${listing.id} FOR UPDATE`);
      const current = (await tx.query.listings.findFirst({where: eq(listings.id, listing.id)}))!;
      if (current.status === 'cancelled') return;
      const [{n}] = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM listing_slots WHERE listing_id = ${listing.id}`,
      )) as unknown as [{n: number}];
      if (n > 0) {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          'a worker has been selected; cancel that job instead (the listing can only be closed)',
        );
      }
      await tx
        .update(listings)
        .set({status: 'cancelled', closedAt: new Date(), reserved: '0', updatedAt: new Date()})
        .where(eq(listings.id, listing.id));
      const set = await tx
        .update(applications)
        .set({status: 'rejected', reason: CANCELLED_REASON, reopenable: false, decidedAt: new Date()})
        .where(and(eq(applications.listingId, listing.id), eq(applications.status, 'pending')))
        .returning({publicId: applications.publicId, applicantAgentId: applications.applicantAgentId});
      await notifyApplicants(tx, listing, set, 'listing.cancelled', '');
    });
    return view((await db.query.listings.findFirst({where: eq(listings.id, listing.id)}))!);
  });

  // ── applications ─────────────────────────────────────────────────────

  /**
   * Who may bid or claim. Checked here and NOT again, more strictly, at
   * selection (docs/26 F4 risk: selection no stricter than application);
   * the trust gate is the one check `hire()` repeats, because a worker's
   * record can change between the bid and the choice.
   */
  async function checkApplicant(actor: Actor, listing: Listing, chain: ChainConfig) {
    const me = actor.agent;
    if (me.id === listing.clientAgentId) {
      throw new PactoraError(ErrorCode.FORBIDDEN, 'you cannot apply to your own listing');
    }
    const client = await db.query.agents.findFirst({where: eq(agents.id, listing.clientAgentId)});
    if (client && client.ownerAddress === me.ownerAddress) {
      // The contract refuses it too (SameOwner): said before anyone bids.
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        "the listing's client has the same owner as you; the contract refuses that hire",
      );
    }
    if (me.chainId !== listing.chainId) {
      throw new PactoraError(ErrorCode.CHAIN_MISMATCH, `the listing is on chain ${listing.chainId}`);
    }
    if (!me.chainAgentId) {
      throw new PactoraError(ErrorCode.AGENT_NOT_HIREABLE, 'your agent has no on-chain id yet', 2);
    }
    if (me.kind === 'agent' && !me.active) {
      throw new PactoraError(
        ErrorCode.AGENT_NOT_HIREABLE,
        'your agent is marked inactive; set active to apply',
      );
    }
    const trust = await readTrust(db, {
      chainId: listing.chainId,
      agentId: me.id,
      floor: Number(chain.params['confidenceFloor'] ?? 25),
    });
    if (trust.action === 'block') {
      throw new PactoraError(
        ErrorCode.COUNTERPARTY_BLOCKED,
        `you are blocked (${trust.verdict}): ${trust.reasons.join('; ')}`,
      );
    }
    const status = effectiveStatus(listing);
    if (status !== 'open') {
      throw new PactoraError(
        listing.deadline.getTime() <= Date.now() ? ErrorCode.DEADLINE_PASSED : ErrorCode.INVALID_STATE,
        `the listing is ${status}${listing.deadline.getTime() <= Date.now() ? ' (its deadline passed)' : ''}`,
      );
    }
  }

  /** Counts under the listing's row lock. */
  async function checkCounts(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    listingId: number,
    applicantId: number,
  ) {
    const [c] = (await tx.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE applicant_agent_id = ${applicantId} AND NOT reopenable)::int AS mine,
             count(*) FILTER (WHERE applicant_agent_id = ${applicantId} AND status IN ('pending', 'selected'))::int AS live
        FROM applications WHERE listing_id = ${listingId}
    `)) as unknown as {total: number; mine: number; live: number}[];
    if (c!.live > 0) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        'you already have a live bid on this listing — withdraw it first',
      );
    }
    if (c!.mine >= LIMITS.bidsPerApplicant) {
      throw new PactoraError(
        ErrorCode.LIMIT_REACHED,
        `at most ${LIMITS.bidsPerApplicant} bids per applicant per listing (bids closed by the client stopping hiring do not count)`,
      );
    }
    if (c!.total >= LIMITS.applicationsPerListing) {
      throw new PactoraError(
        ErrorCode.LIMIT_REACHED,
        `this listing has the maximum of ${LIMITS.applicationsPerListing} applications`,
      );
    }
  }

  app.post('/v1/listings/:id/applications', async (request, reply) => {
    const actor = await actorOf(db, request);
    const listing = await loadListing(request);
    const body = ApplicationBody.parse(request.body);
    const chain = chainOf(listing.chainId);
    if (body.action === 'apply') await requireClear(db, actor.agent.id, 'apply for work');

    if (body.action === 'withdraw') {
      const mine = await db.query.applications.findFirst({
        where: and(
          eq(applications.listingId, listing.id),
          eq(applications.applicantAgentId, actor.agent.id),
          body.applicationId
            ? eq(applications.publicId, body.applicationId)
            : inArray(applications.status, ['pending', 'selected']),
        ),
        orderBy: [desc(applications.id)],
      });
      if (!mine) throw new PactoraError(ErrorCode.NOT_FOUND, 'you have no such bid on this listing');
      if (mine.status === 'withdrawn') return reply.status(200).send(applicationView(mine, chain, null));
      if (mine.status !== 'pending') {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          mine.status === 'selected'
            ? 'this bid was selected and its job exists — decline or cancel the job instead'
            : `this bid is ${mine.status}`,
        );
      }
      const [row] = await db
        .update(applications)
        .set({status: 'withdrawn', decidedAt: new Date()})
        .where(and(eq(applications.id, mine.id), eq(applications.status, 'pending')))
        .returning();
      return reply.status(200).send(applicationView(row ?? mine, chain, null));
    }

    if (listing.hiringMode !== 'applications') {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        'this listing is instant: claim it (POST /v1/listings/:id/claim)',
      );
    }
    await checkApplicant(actor, listing, chain);
    const price = BigInt(body.priceBaseUnits);
    if (price > BigInt(listing.maxPrice)) {
      throw new PactoraError(
        ErrorCode.PRICE_ABOVE_MAX,
        `your price ${chain.formatToken(price)} is above the listing's ceiling of ${chain.formatToken(BigInt(listing.maxPrice))}`,
      );
    }
    checkPriceBounds(chain, price, 'your price');

    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM listings WHERE id = ${listing.id} FOR UPDATE`);
      const current = (await tx.query.listings.findFirst({where: eq(listings.id, listing.id)}))!;
      if (effectiveStatus(current) !== 'open') {
        throw new PactoraError(ErrorCode.INVALID_STATE, `the listing is ${effectiveStatus(current)}`);
      }
      if (price > BigInt(current.maxPrice)) {
        throw new PactoraError(ErrorCode.PRICE_ABOVE_MAX, "your price is above the listing's ceiling");
      }
      await checkCounts(tx, listing.id, actor.agent.id);
      const [inserted] = await tx
        .insert(applications)
        .values({
          listingId: listing.id,
          applicantAgentId: actor.agent.id,
          price: price.toString(),
          proposal: body.proposal,
        })
        .returning();
      // The client learns of the bid the way it learns of a job event (docs/26 F9).
      await recordAgentEvent(tx, {
        agentId: listing.clientAgentId,
        role: 'client',
        kind: 'listing.bid',
        payload: {
          listingId: listing.publicId,
          applicationId: inserted!.publicId,
          priceBaseUnits: inserted!.price,
          applicant: applicantSummary(actor.agent),
        },
        listingId: listing.id,
        dedupeKey: `listing.bid:${inserted!.publicId}`,
      });
      return inserted!;
    });
    return reply.status(201).send(applicationView(row, chain, null));
  });

  app.get('/v1/listings/:id/applications', async (request) => {
    const {listing} = await ownerOf(request);
    const query = ApplicationsQuery.parse(request.query ?? {});
    const chain = chainOf(listing.chainId);
    const order =
      query.sort === 'price_low'
        ? [sql`${applications.price} ASC`, asc(applications.id)]
        : query.sort === 'price_high'
          ? [sql`${applications.price} DESC`, asc(applications.id)]
          : query.sort === 'rating'
            ? [sql`COALESCE(${agentStats.score}, 50) DESC`, asc(applications.id)]
            : [desc(applications.id)];
    const where = and(
      eq(applications.listingId, listing.id),
      query.status ? eq(applications.status, query.status) : undefined,
    );
    const rows = await db
      .select({a: applications, ag: agents, st: agentStats})
      .from(applications)
      .innerJoin(agents, eq(agents.id, applications.applicantAgentId))
      .leftJoin(agentStats, eq(agentStats.agentId, applications.applicantAgentId))
      .where(where)
      .orderBy(...order)
      .limit(LIMITS.pageSize)
      .offset((query.page - 1) * LIMITS.pageSize);
    const [{n}] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM applications WHERE listing_id = ${listing.id} ${query.status ? sql`AND status = ${query.status}` : sql``}`,
    )) as unknown as [{n: number}];
    const ids = await jobPublicIds(rows.map((r) => r.a.jobId));
    const clearIds = await clearAmong(rows.map((r) => r.ag.id));
    return {
      total: n,
      page: query.page,
      pageSize: LIMITS.pageSize,
      sort: query.sort,
      applications: rows.map(({a, ag, st}) => ({
        ...applicationView(a, chain, a.jobId !== null ? (ids.get(a.jobId) ?? null) : null),
        applicant: {
          agentId: String(ag.id),
          publicId: ag.publicId,
          kind: ag.kind,
          name: ag.name,
          location: ag.location,
          score: st?.score ?? 50,
          completed: st?.completed ?? 0,
          /** Standing clear (no hold, not blocked): a yes/no, never the reason. */
          counterpartyClear: clearIds.has(ag.id),
        },
      })),
    };
  });

  // ── deciding, and the jobs it creates ─────────────────────────────────

  /**
   * Take a worker slot for `application` under the listing's row lock:
   * mark it selected and, when the last slot goes, close the listing to the
   * remaining bids (reopenable — they did not lose, hiring stopped).
   */
  async function takeSlot(
    listingId: number,
    within: (tx: Parameters<Parameters<Db['transaction']>[0]>[0], current: Listing) => Promise<Application>,
  ): Promise<Application> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM listings WHERE id = ${listingId} FOR UPDATE`);
      const current = (await tx.query.listings.findFirst({where: eq(listings.id, listingId)}))!;
      if (current.status === 'filled') {
        throw new PactoraError(
          ErrorCode.LIMIT_REACHED,
          `every one of the ${current.maxWorkers} worker slots is taken`,
        );
      }
      if (current.status === 'cancelled') {
        throw new PactoraError(ErrorCode.INVALID_STATE, 'the listing is cancelled');
      }
      const taken = await tx
        .select({slot: listingSlots.slot})
        .from(listingSlots)
        .where(eq(listingSlots.listingId, listingId));
      if (taken.length >= current.maxWorkers) {
        throw new PactoraError(
          ErrorCode.LIMIT_REACHED,
          `every one of the ${current.maxWorkers} worker slots is taken`,
        );
      }
      const application = await within(tx, current);
      const used = new Set(taken.map((t) => t.slot));
      let slot = 1;
      while (used.has(slot)) slot++;
      await tx.insert(listingSlots).values({listingId, slot, applicationId: application.id});
      if (taken.length + 1 >= current.maxWorkers) {
        const closedAt = new Date();
        await tx
          .update(listings)
          .set({status: 'filled', closedAt, updatedAt: closedAt})
          .where(eq(listings.id, listingId));
        const set = await tx
          .update(applications)
          .set({status: 'rejected', reason: FILLED_REASON, reopenable: true, decidedAt: closedAt})
          .where(
            and(
              eq(applications.listingId, listingId),
              eq(applications.status, 'pending'),
              ne(applications.id, application.id),
            ),
          )
          .returning({publicId: applications.publicId, applicantAgentId: applications.applicantAgentId});
        await notifyApplicants(tx, current, set, 'listing.closed', `:${closedAt.getTime()}`, {
          reason: 'filled',
        });
      }
      return application;
    });
  }

  /**
   * The job for a selected application: an agent client's through `hire()`
   * (the signer sends create_job at the bid price); a person client's row is
   * written and the create_job call handed back to sign. Idempotent on the
   * application: a retry reuses the job (and, for an agent, the signer's key).
   */
  async function fund(actor: Actor, listing: Listing, application: Application, traceId: string) {
    const chain = chainOf(listing.chainId);
    const spec = listingJobSpec(listing, application);
    const key = `listing-application:${application.publicId}`;
    const amount = BigInt(application.price);

    let job: typeof jobs.$inferSelect;
    let funding: Record<string, unknown>;
    const link = async (jobId: number) => {
      await db.update(applications).set({jobId}).where(eq(applications.id, application.id));
      await db.update(listingSlots).set({jobId}).where(eq(listingSlots.applicationId, application.id));
    };
    if (actor.via === 'agent') {
      const r = await hire(
        {db, bus: deps.bus, submit: deps.submit},
        {
          caller: actor.caller as Parameters<typeof hire>[1]['caller'],
          chainId: listing.chainId,
          chain,
          idempotencyKey: key,
          traceId,
        },
        {
          workerAgentId: String(application.applicantAgentId),
          spec,
          maxPrice: application.price,
          path: 'escrow',
        },
        {
          amount,
          acceptWindowSeconds: listing.acceptWindowSeconds,
          workWindowSeconds: listing.workWindowSeconds,
        },
      );
      job = (await db.query.jobs.findFirst({where: eq(jobs.publicId, r.jobId)}))!;
      await link(job.id);
      funding = {by: 'signer', txHash: r.txHash, explorerUrl: r.explorerUrl};
    } else {
      job =
        (await db.query.jobs.findFirst({
          where: and(eq(jobs.clientAgentId, listing.clientAgentId), eq(jobs.idempotencyKey, key)),
        })) ?? (await insertPersonJob(listing, application, spec, key, traceId));
      // Linked first: the create_job call reads the windows through the link.
      await link(job.id);
      funding = job.chainJobId
        ? {by: 'person', done: true}
        : {
            by: 'person',
            done: false,
            signerId: actor.agent.walletAddress,
            functionCall: await createJobCall(db, chain, job),
            confirm: `/v1/jobs/${job.publicId}/person-actions/confirm`,
          };
    }
    // Told once the job exists, so the event can name it; a funding retry
    // under the same application finds the dedupe key and says nothing more.
    await recordAgentEvent(db, {
      agentId: application.applicantAgentId,
      role: 'applicant',
      kind: 'application.selected',
      payload: {
        listingId: listing.publicId,
        applicationId: application.publicId,
        jobId: job.publicId,
        reason: application.reason,
      },
      listingId: listing.id,
      dedupeKey: `application.selected:${application.publicId}`,
    });
    return {
      job: {
        jobId: job.publicId,
        chainJobId: job.chainJobId,
        state: job.state,
        amount: job.amount,
        amountDisplay: chain.formatToken(BigInt(job.amount)),
        specHash: job.specHash,
        spec: job.spec,
      },
      funding,
    };
  }

  /** The job row a person client will fund: written BEFORE the browser signs, so the indexer can link it. */
  async function insertPersonJob(
    listing: Listing,
    application: Application,
    spec: JobSpec,
    key: string,
    traceId: string,
  ) {
    const [inserted] = await db
      .insert(jobs)
      .values({
        chainId: listing.chainId,
        clientAgentId: listing.clientAgentId,
        workerAgentId: application.applicantAgentId,
        path: 'escrow',
        amount: application.price,
        spec,
        specHash: '',
        traceId,
        idempotencyKey: key,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      return (await db.query.jobs.findFirst({
        where: and(eq(jobs.clientAgentId, listing.clientAgentId), eq(jobs.idempotencyKey, key)),
      }))!;
    }
    const [row] = await db
      .update(jobs)
      .set({specHash: specHashOf(spec, inserted.publicId)})
      .where(eq(jobs.id, inserted.id))
      .returning();
    return row!;
  }

  app.post('/v1/listings/:id/decide', async (request) => {
    const {actor, listing} = await ownerOf(request);
    const body = DecideBody.parse(request.body);
    // Selecting commits the owner's money to a worker; rejecting stays open.
    if (body.action === 'select') await requireClear(db, actor.agent.id, 'select a worker');
    const chain = chainOf(listing.chainId);
    const application = await db.query.applications.findFirst({
      where: and(eq(applications.listingId, listing.id), eq(applications.publicId, body.applicationId)),
    });
    if (!application)
      throw new PactoraError(ErrorCode.NOT_FOUND, `no application ${body.applicationId} on this listing`);

    const wanted = body.action === 'select' ? 'selected' : 'rejected';
    if (application.status !== 'pending') {
      // Answered once: the same decision again is a replay, a different one a conflict.
      if (application.status !== wanted || application.reason !== body.reason) {
        throw new PactoraError(
          application.status === 'withdrawn' ? ErrorCode.INVALID_STATE : ErrorCode.IDEMPOTENCY_CONFLICT,
          `this application is already ${application.status}`,
        );
      }
      if (wanted === 'rejected')
        return {application: applicationView(application, chain, null), replayed: true};
      const out = await fund(actor, listing, application, request.id);
      return {application: applicationView(application, chain, out.job.jobId), ...out, replayed: true};
    }

    if (body.action === 'reject') {
      const [row] = await db
        .update(applications)
        .set({status: 'rejected', reason: body.reason, reopenable: false, decidedAt: new Date()})
        .where(and(eq(applications.id, application.id), eq(applications.status, 'pending')))
        .returning();
      if (!row)
        throw new PactoraError(ErrorCode.INVALID_STATE, 'the application changed meanwhile — read it again');
      await recordAgentEvent(db, {
        agentId: row.applicantAgentId,
        role: 'applicant',
        kind: 'application.rejected',
        payload: {listingId: listing.publicId, applicationId: row.publicId, reason: row.reason},
        listingId: listing.id,
        dedupeKey: `application.rejected:${row.publicId}`,
      });
      return {application: applicationView(row, chain, null), replayed: false};
    }

    await refuseNotHireable(application.applicantAgentId, listing.chainId);
    const selected = await takeSlot(listing.id, async (tx) => {
      const [row] = await tx
        .update(applications)
        .set({status: 'selected', reason: body.reason, decidedAt: new Date()})
        .where(and(eq(applications.id, application.id), eq(applications.status, 'pending')))
        .returning();
      if (!row)
        throw new PactoraError(ErrorCode.INVALID_STATE, 'the application changed meanwhile — read it again');
      return row;
    });
    // The selection stands even if funding is refused (a cap, the signer
    // down): the same decision again retries the funding under the same key.
    const out = await fund(actor, listing, selected, request.id);
    return {application: applicationView(selected, chain, out.job.jobId), ...out, replayed: false};
  });

  app.post('/v1/listings/:id/claim', async (request, reply) => {
    const actor = await actorOf(db, request);
    const listing = await loadListing(request);
    const body = ClaimBody.parse(request.body ?? {});
    const chain = chainOf(listing.chainId);
    await requireClear(db, actor.agent.id, 'claim work');
    if (listing.hiringMode !== 'instant') {
      throw new PactoraError(ErrorCode.INVALID_STATE, 'this listing takes applications, not claims');
    }

    // A claim already won answers again (a retried request).
    const already = await db.query.applications.findFirst({
      where: and(
        eq(applications.listingId, listing.id),
        eq(applications.applicantAgentId, actor.agent.id),
        eq(applications.status, 'selected'),
      ),
    });
    if (already) {
      const client = await clientActor(listing);
      const out = await fund(client, listing, already, request.id);
      return reply
        .status(200)
        .send({application: applicationView(already, chain, out.job.jobId), ...out, replayed: true});
    }

    await checkApplicant(actor, listing, chain);
    await refuseNotHireable(actor.agent.id, listing.chainId);
    const won = await takeSlot(listing.id, async (tx, current) => {
      if (effectiveStatus(current) !== 'open') {
        throw new PactoraError(ErrorCode.INVALID_STATE, `the listing is ${effectiveStatus(current)}`);
      }
      await checkCounts(tx, listing.id, actor.agent.id);
      const [row] = await tx
        .insert(applications)
        .values({
          listingId: listing.id,
          applicantAgentId: actor.agent.id,
          price: current.maxPrice,
          proposal: body.proposal ?? CLAIM_PROPOSAL,
          status: 'selected',
          reason: 'Claimed first.',
          decidedAt: new Date(),
        })
        .returning();
      return row!;
    });
    // The client funds it: the signer for an agent client; a person client
    // is shown the create_job to sign on the listing (GET as owner).
    const client = await clientActor(listing);
    const out = await fund(client, listing, won, request.id);
    await recordAgentEvent(db, {
      agentId: listing.clientAgentId,
      role: 'client',
      kind: 'listing.claimed',
      payload: {
        listingId: listing.publicId,
        applicationId: won.publicId,
        jobId: out.job.jobId,
        applicant: applicantSummary(actor.agent),
      },
      listingId: listing.id,
      dedupeKey: `listing.claimed:${won.publicId}`,
    });
    return reply
      .status(201)
      .send({application: applicationView(won, chain, out.job.jobId), ...out, replayed: false});
  });

  /** The listing's client, as the actor that funds its jobs. */
  async function clientActor(listing: Listing): Promise<Actor> {
    const agent = (await db.query.agents.findFirst({where: eq(agents.id, listing.clientAgentId)}))!;
    if (agent.kind === 'person') {
      return {
        via: 'person',
        agent,
        chainId: agent.chainId,
        caller: {
          kind: 'person',
          account: agent.ownerAddress,
          chainId: agent.chainId,
          sessionId: 0,
          expiresAt: new Date(0),
        },
      };
    }
    return {
      via: 'agent',
      agent,
      chainId: agent.chainId,
      caller: {kind: 'agent', agentId: agent.id, chainId: agent.chainId, scopes: [], keyId: 'listing-claim'},
    };
  }

  // ── unselect: a selected bid whose job never reached the chain ────────

  /**
   * Release a selection the chain never funded (a person client who did not
   * sign, or whose create_job was refused): the slot and the bid are given
   * back, the unfunded job row is removed, and a listing that filling closed
   * reopens. A job with a chain id is money in escrow and cannot be
   * unselected: cancel that job instead.
   */
  app.post('/v1/listings/:id/unselect', async (request) => {
    const {listing} = await ownerOf(request);
    const body = UnselectBody.parse(request.body ?? {});
    const chain = chainOf(listing.chainId);
    const out = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM listings WHERE id = ${listing.id} FOR UPDATE`);
      const current = (await tx.query.listings.findFirst({where: eq(listings.id, listing.id)}))!;
      const application = await tx.query.applications.findFirst({
        where: and(eq(applications.listingId, listing.id), eq(applications.publicId, body.applicationId)),
      });
      if (!application)
        throw new PactoraError(ErrorCode.NOT_FOUND, `no application ${body.applicationId} on this listing`);
      if (application.status !== 'selected') {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          `this application is ${application.status}, not selected`,
        );
      }
      const job = application.jobId
        ? await tx.query.jobs.findFirst({where: eq(jobs.id, application.jobId)})
        : undefined;
      if (job?.chainJobId) {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          `job ${job.publicId} is funded on chain (${job.chainJobId}); cancel the job instead`,
        );
      }
      const [released] = await tx
        .update(applications)
        .set({
          status: 'rejected',
          reason: UNSELECTED_REASON,
          reopenable: false,
          jobId: null,
          decidedAt: new Date(),
        })
        .where(eq(applications.id, application.id))
        .returning();
      await tx.delete(listingSlots).where(eq(listingSlots.applicationId, application.id));
      if (job) await tx.delete(jobs).where(and(eq(jobs.id, job.id), isNull(jobs.chainJobId)));
      let reopened = false;
      if (current.status === 'filled' && current.deadline.getTime() > Date.now()) {
        const reopenedAt = new Date();
        await tx
          .update(listings)
          .set({status: 'open', closedAt: null, updatedAt: reopenedAt})
          .where(eq(listings.id, listing.id));
        const revived = await reviveSetAsideBids(tx, listing.id);
        await notifyApplicants(tx, listing, revived, 'listing.reopened', `:${reopenedAt.getTime()}`, {
          reason: 'unselected',
        });
        reopened = true;
      }
      await recordAgentEvent(tx, {
        agentId: application.applicantAgentId,
        role: 'applicant',
        kind: 'application.rejected',
        payload: {
          listingId: listing.publicId,
          applicationId: application.publicId,
          reason: UNSELECTED_REASON,
        },
        listingId: listing.id,
        dedupeKey: `application.unselected:${application.publicId}`,
      });
      return {released: released!, reopened};
    });
    return {application: applicationView(out.released, chain, null), released: true, reopened: out.reopened};
  });

  // ── close, reopen ────────────────────────────────────────────────────

  app.post('/v1/listings/:id/close', async (request) => {
    const {listing} = await ownerOf(request);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM listings WHERE id = ${listing.id} FOR UPDATE`);
      const current = (await tx.query.listings.findFirst({where: eq(listings.id, listing.id)}))!;
      if (current.status === 'closed') return;
      if (current.status !== 'open') {
        throw new PactoraError(ErrorCode.INVALID_STATE, `the listing is ${current.status}`);
      }
      const closedAt = new Date();
      await tx
        .update(listings)
        .set({status: 'closed', closedAt, updatedAt: closedAt})
        .where(eq(listings.id, listing.id));
      const set = await tx
        .update(applications)
        .set({status: 'rejected', reason: CLOSED_REASON, reopenable: true, decidedAt: closedAt})
        .where(and(eq(applications.listingId, listing.id), eq(applications.status, 'pending')))
        .returning({publicId: applications.publicId, applicantAgentId: applications.applicantAgentId});
      await notifyApplicants(tx, listing, set, 'listing.closed', `:${closedAt.getTime()}`, {
        reason: 'closed',
      });
    });
    return view((await db.query.listings.findFirst({where: eq(listings.id, listing.id)}))!);
  });

  app.post('/v1/listings/:id/reopen', async (request) => {
    const {listing} = await ownerOf(request);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM listings WHERE id = ${listing.id} FOR UPDATE`);
      const current = (await tx.query.listings.findFirst({where: eq(listings.id, listing.id)}))!;
      if (current.deadline.getTime() <= Date.now()) {
        throw new PactoraError(
          ErrorCode.DEADLINE_PASSED,
          'the deadline has passed; post a new listing instead',
        );
      }
      if (current.status === 'open') return;
      if (current.status !== 'closed') {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          `the listing is ${current.status}; only a closed listing reopens`,
        );
      }
      const reopenedAt = new Date();
      await tx
        .update(listings)
        .set({status: 'open', closedAt: null, updatedAt: reopenedAt})
        .where(eq(listings.id, listing.id));
      const revived = await reviveSetAsideBids(tx, listing.id);
      await notifyApplicants(tx, listing, revived, 'listing.reopened', `:${reopenedAt.getTime()}`);
    });
    return view((await db.query.listings.findFirst({where: eq(listings.id, listing.id)}))!);
  });
}

/** The most people one new listing alerts. */
export const MAX_MATCH_ALERTS = 200;

/**
 * Tell the people a new listing is for (docs/26 F18, 0026): every published
 * profile that is open to work, asked for alerts, is in good standing, has a
 * skill the listing names (a listing naming none alerts nobody) and is at a
 * matching location — never the client. One `listing.match` event each,
 * exactly once per listing (the dedupe key names the listing).
 */
export async function alertMatches(db: Db, listing: Listing): Promise<number> {
  if (listing.skills.length === 0) return 0;
  const mySkills = sql`(SELECT coalesce(array_agg(DISTINCT x), '{}'::text[]) FROM (SELECT unnest(p.skills) AS x UNION SELECT lower(c.capability) FROM agent_capabilities c WHERE c.agent_id = a.id) u)`;
  const people = (await db.execute(sql`
    SELECT a.id
      FROM public_profiles p JOIN agents a ON a.id = p.agent_id
     WHERE p.published AND p.available AND p.alerts
       AND a.chain_id = ${listing.chainId} AND a.id <> ${listing.clientAgentId}
       AND NOT EXISTS (SELECT 1 FROM account_standing s WHERE s.agent_id = a.id AND s.standing <> 'clear')
       AND ${listingMatchesSql(
         {skills: textArray(listing.skills), location: sql`${listing.location}`},
         {skills: mySkills, location: sql`a.location`},
       )}
     ORDER BY a.id LIMIT ${MAX_MATCH_ALERTS}
  `)) as unknown as {id: string | number}[];
  let n = 0;
  for (const p of people) {
    const seq = await recordAgentEvent(db, {
      agentId: Number(p.id),
      role: 'match',
      kind: 'listing.match',
      payload: {
        listingId: listing.publicId,
        title: listing.title,
        skills: listing.skills,
        location: listing.location,
        maxPriceBaseUnits: listing.maxPrice,
      },
      listingId: listing.id,
      dedupeKey: `listing.match:${listing.publicId}`,
    });
    if (seq !== null) n++;
  }
  return n;
}

/**
 * Listings whose deadline passed while they were open: tell the client and
 * every pending bidder, once (`GET /v1/listings` already reads them as
 * closed; nothing is updated). Run by the API on a timer (app.ts). The
 * dedupe key carries the deadline, so a listing whose deadline the client
 * moves out and that lapses again is announced again.
 */
export async function sweepExpiredListings(db: Db, limit = 50): Promise<number> {
  const expired = (await db.execute(sql`
    SELECT l.id, l.public_id, l.client_agent_id, l.title, l.deadline
      FROM listings l
     WHERE l.status = 'open' AND l.deadline <= now()
       AND NOT EXISTS (SELECT 1 FROM agent_events e
                        WHERE e.listing_id = l.id AND e.agent_id = l.client_agent_id
                          AND e.dedupe_key = 'listing.expired:' || l.public_id || ':' || (extract(epoch FROM l.deadline) * 1000)::bigint)
     ORDER BY l.deadline LIMIT ${limit}
  `)) as unknown as {
    id: string | number;
    public_id: string;
    client_agent_id: string | number;
    title: string;
    deadline: Date | string;
  }[];
  let written = 0;
  for (const l of expired) {
    const deadlineMs = new Date(l.deadline).getTime();
    const payload = {listingId: l.public_id, title: l.title};
    const seq = await recordAgentEvent(db, {
      agentId: Number(l.client_agent_id),
      role: 'client',
      kind: 'listing.expired',
      payload,
      listingId: Number(l.id),
      dedupeKey: `listing.expired:${l.public_id}:${deadlineMs}`,
    });
    if (seq !== null) written++;
    const pending = await db
      .select({publicId: applications.publicId, applicantAgentId: applications.applicantAgentId})
      .from(applications)
      .where(and(eq(applications.listingId, Number(l.id)), eq(applications.status, 'pending')));
    for (const p of pending) {
      const s = await recordAgentEvent(db, {
        agentId: p.applicantAgentId,
        role: 'applicant',
        kind: 'listing.expired',
        payload: {...payload, applicationId: p.publicId},
        listingId: Number(l.id),
        dedupeKey: `listing.expired:${p.publicId}:${deadlineMs}`,
      });
      if (s !== null) written++;
    }
  }
  return written;
}
