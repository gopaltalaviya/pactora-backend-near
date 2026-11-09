import type {FastifyInstance} from 'fastify';
import {and, eq, sql} from 'drizzle-orm';
import {z} from 'zod';
import {agents, jobs, partyReviews, publicProfiles, type Db} from '@pactora/db';
import {ErrorCode, PactoraError} from '@pactora/shared';
import {actorOf} from '../actor.js';
import {isPublicId} from './jobs.js';
import {Location, Skill} from './listings.js';

/**
 * Public profiles and two-way reviews (docs/26 F16, F17).
 *
 * Profiles: nothing is public until the agent or person publishes it, and
 * the account id appears only if they chose `showAccount`. The directory
 * lists published profiles of both kinds.
 *
 * Reviews: after a job SETTLES on chain (the indexer recorded a `settled`
 * or `direct_paid` event with its transaction), each party may write one
 * review of the other: 1–5 and 10–2000 characters, within 14 days. Blind:
 * a review is shown once both are in, or once the 14 days have passed, so
 * neither side writes in answer to the other. A hidden review (moderation)
 * is kept but never shown or counted.
 *
 * Ratings are computed when read, from exactly the reviews that are shown
 * at that moment. A stored total would go stale the moment a window closed.
 */

export const REVIEW_WINDOW_DAYS = 14;
export const PAGE_SIZE = 20;

export const ProfileBody = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, 'displayName is 1-60 characters')
    .max(60, 'displayName is 1-60 characters'),
  headline: z.string().trim().max(140, 'headline is at most 140 characters').default(''),
  bio: z.string().trim().max(2000, 'bio is at most 2000 characters').default(''),
  showAccount: z.boolean().default(false),
  published: z.boolean().default(false),
  /** Up to 20 lower-case tags (2-50 chars each); matched against listings' skills. */
  skills: z
    .array(Skill)
    .max(20, 'at most 20 skills')
    .transform((s) => [...new Set(s)])
    .default([]),
  /** "City" or "City, Region" (docs/26 F18); also the agent's matching location. */
  location: Location.default(''),
  /** "Open to work." */
  availability: z.boolean().default(false),
  /** Show open listings and job counts on the public profile. */
  showTaskList: z.boolean().default(false),
  /** A listing.match feed event for each new listing that matches (needs availability). */
  alerts: z.boolean().default(false),
});

export const DirectoryQuery = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(['person', 'agent']).optional(),
  /** `true`: only profiles open to work. */
  available: z.enum(['true', 'false']).optional(),
  /** One skill the profile (or the agent's capabilities) must name. */
  skill: Skill.optional(),
  sort: z.enum(['rating', 'recent', 'name']).default('rating'),
  page: z.coerce.number().int().min(1).max(500).default(1),
});

export const ReviewsQuery = z.object({page: z.coerce.number().int().min(1).max(500).default(1)});

export const PartyReviewBody = z.object({
  rating: z.number().int().min(1, 'rating is 1-5').max(5, 'rating is 1-5'),
  body: z.string().trim().min(10, 'body is 10-2000 characters').max(2000, 'body is 10-2000 characters'),
});

/** `r` (party_reviews) joined with `j` (jobs): shown to the public right now? */
const VISIBLE = sql`r.hidden_at IS NULL AND (
  EXISTS (SELECT 1 FROM party_reviews o WHERE o.job_id = r.job_id AND o.author_agent_id <> r.author_agent_id)
  OR j.settled_at < now() - ${sql.raw(`interval '${REVIEW_WINDOW_DAYS} days'`)})`;

/** The chain recorded this job's settlement (not just the API's view of it). */
const SETTLED_ON_CHAIN = (jobId: number) => sql`EXISTS (
  SELECT 1 FROM job_events e WHERE e.job_id = ${jobId} AND e.kind IN ('settled', 'direct_paid') AND e.tx_hash IS NOT NULL)`;

/** LIKE wildcards in a person's search are literal. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

interface ProfileRow {
  agent_id: string | number;
  public_id: string;
  kind: 'person' | 'agent';
  chain_agent_id: string | null;
  owner_address: string;
  wallet_address: string;
  location: string;
  display_name: string;
  headline: string;
  bio: string;
  show_account: boolean;
  skills: string[] | null;
  profile_location: string;
  available: boolean;
  show_task_list: boolean;
  alerts: boolean;
  published_at: Date | string | null;
  rating_avg: string | null;
  rating_count: string | number;
  settled_jobs: string | number;
  capabilities: string[] | null;
}

function profileView(r: ProfileRow, opts: {bio?: boolean} = {}) {
  const count = Number(r.rating_count);
  return {
    profileId: r.public_id,
    kind: r.kind,
    displayName: r.display_name,
    headline: r.headline,
    ...(opts.bio ? {bio: r.bio} : {}),
    // A person's account is their wallet; an agent's is its wallet account.
    account: r.show_account ? (r.kind === 'person' ? r.owner_address : r.wallet_address) : null,
    location: r.profile_location || r.location || null,
    skills: r.skills ?? [],
    availability: r.available,
    capabilities: r.capabilities ?? [],
    rating: {
      average: count > 0 && r.rating_avg !== null ? Number(Number(r.rating_avg).toFixed(2)) : null,
      count,
    },
    settledJobs: Number(r.settled_jobs),
    /** For an agent, its marketplace page (/agents/<id>). */
    chainAgentId: r.kind === 'agent' ? r.chain_agent_id : null,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
  };
}

/** Every column a profile view needs, for published profiles (or one agent's own). */
const PROFILE_SELECT = sql`
  SELECT a.id AS agent_id, a.public_id, a.kind, a.chain_agent_id, a.owner_address, a.wallet_address, a.location,
         p.display_name, p.headline, p.bio, p.show_account, p.published, p.published_at,
         p.skills, p.location AS profile_location, p.available, p.show_task_list, p.alerts,
         (SELECT avg(r.rating) FROM party_reviews r JOIN jobs j ON j.id = r.job_id
            WHERE r.subject_agent_id = a.id AND ${VISIBLE}) AS rating_avg,
         (SELECT count(*) FROM party_reviews r JOIN jobs j ON j.id = r.job_id
            WHERE r.subject_agent_id = a.id AND ${VISIBLE}) AS rating_count,
         (SELECT count(*) FROM jobs j2 WHERE j2.state = 'settled'
            AND (j2.client_agent_id = a.id OR j2.worker_agent_id = a.id)) AS settled_jobs,
         (SELECT array_agg(c.capability ORDER BY c.capability) FROM agent_capabilities c WHERE c.agent_id = a.id)
           AS capabilities
  FROM public_profiles p JOIN agents a ON a.id = p.agent_id`;

export interface ProfileRouteDeps {
  db: Db;
}

export async function registerProfileRoutes(app: FastifyInstance, deps: ProfileRouteDeps): Promise<void> {
  const {db} = deps;
  const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];

  const publishedProfile = async (publicId: string) => {
    if (!isPublicId(publicId)) throw new PactoraError(ErrorCode.NOT_FOUND, `no profile ${publicId}`);
    const [row] = await rows<ProfileRow>(
      sql`${PROFILE_SELECT} WHERE a.public_id = ${publicId} AND p.published`,
    );
    if (!row) throw new PactoraError(ErrorCode.NOT_FOUND, `no published profile ${publicId}`);
    return row;
  };

  const visibleReviews = async (subjectId: number, page: number, size: number) => {
    const list = await rows<{
      public_id: string;
      rating: number;
      body: string;
      author_role: 'client' | 'worker';
      created_at: Date | string;
      job_public_id: string;
      author_name: string | null;
    }>(sql`
      SELECT r.public_id, r.rating, r.body, r.author_role, r.created_at, j.public_id AS job_public_id,
             CASE WHEN ap.published THEN ap.display_name END AS author_name
      FROM party_reviews r JOIN jobs j ON j.id = r.job_id
      LEFT JOIN public_profiles ap ON ap.agent_id = r.author_agent_id
      WHERE r.subject_agent_id = ${subjectId} AND ${VISIBLE}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${size} OFFSET ${(page - 1) * size}`);
    return list.map((r) => ({
      reviewId: r.public_id,
      rating: r.rating,
      body: r.body,
      authorRole: r.author_role,
      // Only a name the author published; otherwise "a client" / "a worker".
      author: r.author_name,
      jobId: r.job_public_id,
      at: new Date(r.created_at).toISOString(),
    }));
  };

  app.get('/v1/profiles', async (request) => {
    const q = DirectoryQuery.parse(request.query ?? {});
    const where = sql.join(
      [
        sql`p.published`,
        ...(q.kind ? [sql`a.kind = ${q.kind}`] : []),
        ...(q.available === 'true'
          ? [sql`p.available`]
          : q.available === 'false'
            ? [sql`NOT p.available`]
            : []),
        ...(q.skill
          ? [
              sql`(${q.skill} = ANY(p.skills) OR EXISTS (SELECT 1 FROM agent_capabilities c WHERE c.agent_id = a.id AND c.capability = ${q.skill}))`,
            ]
          : []),
        ...(q.q
          ? [
              sql`(p.display_name ILIKE ${`%${likeEscape(q.q)}%`} OR p.headline ILIKE ${`%${likeEscape(q.q)}%`})`,
            ]
          : []),
      ],
      sql` AND `,
    );
    const order =
      q.sort === 'name'
        ? sql`lower(display_name) ASC, agent_id ASC`
        : q.sort === 'recent'
          ? sql`published_at DESC, agent_id DESC`
          : sql`rating_avg DESC NULLS LAST, rating_count DESC, agent_id ASC`;
    const list = await rows<ProfileRow>(sql`
      SELECT * FROM (${PROFILE_SELECT} WHERE ${where}) x
      ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${(q.page - 1) * PAGE_SIZE}`);
    const [{n} = {n: 0}] = await rows<{n: string | number}>(
      sql`SELECT count(*) AS n FROM public_profiles p JOIN agents a ON a.id = p.agent_id WHERE ${where}`,
    );
    return {
      total: Number(n),
      page: q.page,
      pageSize: PAGE_SIZE,
      sort: q.sort,
      profiles: list.map((r) => profileView(r)),
    };
  });

  app.get('/v1/profiles/:id', async (request) => {
    const row = await publishedProfile((request.params as {id: string}).id);
    return {
      ...profileView(row, {bio: true}),
      reviews: await visibleReviews(Number(row.agent_id), 1, 10),
      // Their open listings and job counts, only if they chose to show them.
      taskList: row.show_task_list ? await taskListOf(Number(row.agent_id)) : null,
    };
  });

  /** What `showTaskList` shows: the agent's open listings, and how many jobs are open and settled. */
  async function taskListOf(agentId: number) {
    const open = await rows<{public_id: string; title: string; status: string}>(sql`
      SELECT public_id, title, status FROM listings
       WHERE client_agent_id = ${agentId} AND status = 'open' AND deadline > now()
       ORDER BY id DESC LIMIT 20`);
    const [counts = {open: 0, settled: 0}] = await rows<{
      open: string | number;
      settled: string | number;
    }>(sql`
      SELECT count(*) FILTER (WHERE state IN ('created', 'accepted', 'submitted', 'disputed')) AS open,
             count(*) FILTER (WHERE state = 'settled') AS settled
        FROM jobs WHERE client_agent_id = ${agentId} OR worker_agent_id = ${agentId}`);
    return {
      listings: open.map((l) => ({listingId: l.public_id, title: l.title, status: l.status})),
      jobs: {open: Number(counts.open), settled: Number(counts.settled)},
    };
  }

  app.get('/v1/profiles/:id/reviews', async (request) => {
    const row = await publishedProfile((request.params as {id: string}).id);
    const q = ReviewsQuery.parse(request.query ?? {});
    return {
      profileId: row.public_id,
      page: q.page,
      pageSize: PAGE_SIZE,
      reviews: await visibleReviews(Number(row.agent_id), q.page, PAGE_SIZE),
    };
  });

  app.get('/v1/me/profile', async (request) => {
    const actor = await actorOf(db, request);
    const [row] = await rows<ProfileRow & {published: boolean}>(
      sql`${PROFILE_SELECT} WHERE a.id = ${actor.agent.id}`,
    );
    if (!row) {
      // No profile yet: what publishing would start from.
      return {
        exists: false,
        published: false,
        displayName: actor.agent.name,
        headline: '',
        bio: '',
        showAccount: false,
        skills: [],
        location: actor.agent.location || null,
        availability: false,
        showTaskList: false,
        alerts: false,
      };
    }
    return {
      exists: true,
      published: row.published,
      ...profileView(row, {bio: true}),
      showAccount: row.show_account,
      showTaskList: row.show_task_list,
      alerts: row.alerts,
    };
  });

  app.put('/v1/me/profile', async (request) => {
    const actor = await actorOf(db, request);
    const body = ProfileBody.parse(request.body ?? {});
    const now = new Date();
    const fields = {
      displayName: body.displayName,
      headline: body.headline,
      bio: body.bio,
      showAccount: body.showAccount,
      skills: body.skills,
      location: body.location,
      available: body.availability,
      showTaskList: body.showTaskList,
      alerts: body.alerts,
    };
    // One location per agent: matching (apps/api matching.ts) reads agents.location.
    await db.update(agents).set({location: body.location}).where(eq(agents.id, actor.agent.id));
    await db
      .insert(publicProfiles)
      .values({
        agentId: actor.agent.id,
        ...fields,
        published: body.published,
        publishedAt: body.published ? now : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: publicProfiles.agentId,
        set: {
          ...fields,
          published: body.published,
          // Kept from the first publish; cleared when unpublished.
          publishedAt: body.published
            ? sql`COALESCE(${publicProfiles.publishedAt}, ${now.toISOString()}::timestamptz)`
            : null,
          updatedAt: now,
        },
      });
    return {profileId: actor.agent.publicId, published: body.published};
  });

  // ── reviews of a job's other party ──────────────────────────────────────

  const partyJob = async (request: Parameters<typeof actorOf>[1], jobId: string) => {
    const actor = await actorOf(db, request);
    if (!isPublicId(jobId)) throw new PactoraError(ErrorCode.NOT_FOUND, `no job ${jobId}`);
    const job = await db.query.jobs.findFirst({where: eq(jobs.publicId, jobId)});
    if (!job) throw new PactoraError(ErrorCode.NOT_FOUND, `no job ${jobId}`);
    const role =
      job.clientAgentId === actor.agent.id
        ? 'client'
        : job.workerAgentId === actor.agent.id
          ? 'worker'
          : null;
    if (!role) throw new PactoraError(ErrorCode.FORBIDDEN, 'only the two parties review a job');
    const other = role === 'client' ? job.workerAgentId : job.clientAgentId;
    return {actor, job, role, other};
  };

  const windowOf = async (job: typeof jobs.$inferSelect) => {
    const [{ok} = {ok: false}] = await rows<{ok: boolean}>(sql`SELECT ${SETTLED_ON_CHAIN(job.id)} AS ok`);
    const settledOnChain = job.state === 'settled' && job.settledAt !== null && Boolean(ok);
    const closesAt = job.settledAt
      ? new Date(job.settledAt.getTime() + REVIEW_WINDOW_DAYS * 86_400_000)
      : null;
    return {
      settledOnChain,
      closesAt,
      open: settledOnChain && closesAt !== null && Date.now() < closesAt.getTime(),
    };
  };

  const reviewView = (r: typeof partyReviews.$inferSelect) => ({
    reviewId: r.publicId,
    rating: r.rating,
    body: r.body,
    authorRole: r.authorRole,
    at: r.createdAt.toISOString(),
    hidden: r.hiddenAt !== null,
  });

  app.get('/v1/jobs/:id/party-reviews', async (request) => {
    const {actor, job, role, other} = await partyJob(request, (request.params as {id: string}).id);
    const w = await windowOf(job);
    const all = await db.select().from(partyReviews).where(eq(partyReviews.jobId, job.id));
    const mine = all.find((r) => r.authorAgentId === actor.agent.id) ?? null;
    const theirs = all.find((r) => r.authorAgentId === other) ?? null;
    const revealed = Boolean(mine && theirs) || (w.closesAt !== null && Date.now() >= w.closesAt.getTime());
    return {
      jobId: job.publicId,
      role,
      window: {open: w.open, settledOnChain: w.settledOnChain, closesAt: w.closesAt?.toISOString() ?? null},
      mine: mine ? reviewView(mine) : null,
      // Blind: that they wrote one is known; what they wrote, only once revealed.
      theirs: theirs ? (revealed ? reviewView(theirs) : {submitted: true}) : null,
      revealed,
    };
  });

  app.post('/v1/jobs/:id/party-reviews', async (request, reply) => {
    const {actor, job, role, other} = await partyJob(request, (request.params as {id: string}).id);
    const body = PartyReviewBody.parse(request.body ?? {});
    const w = await windowOf(job);
    if (!w.settledOnChain) {
      throw new PactoraError(ErrorCode.INVALID_STATE, 'a job is reviewed after it settles on chain');
    }
    if (!w.open) {
      throw new PactoraError(
        ErrorCode.DEADLINE_PASSED,
        `the review window closed ${REVIEW_WINDOW_DAYS} days after settlement`,
      );
    }
    const [row] = await db
      .insert(partyReviews)
      .values({
        jobId: job.id,
        authorAgentId: actor.agent.id,
        subjectAgentId: other,
        authorRole: role,
        rating: body.rating,
        body: body.body,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const prior = await db.query.partyReviews.findFirst({
        where: and(eq(partyReviews.jobId, job.id), eq(partyReviews.authorAgentId, actor.agent.id)),
      });
      if (prior && prior.rating === body.rating && prior.body === body.body) {
        return reply.status(200).send({...reviewView(prior), replayed: true});
      }
      throw new PactoraError(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        'you already reviewed this job; a review is written once',
      );
    }
    return reply.status(201).send({...reviewView(row), replayed: false});
  });
}

/** Moderation (docs/26 F15 will call this from the admin console): hide, never delete. */
export async function hideReview(db: Db, reviewPublicId: string, reason: string): Promise<boolean> {
  const r = reason.trim();
  if (r.length < 3) throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, 'say why the review is hidden');
  const [row] = await db
    .update(partyReviews)
    .set({hiddenAt: new Date(), hiddenReason: r.slice(0, 500)})
    .where(eq(partyReviews.publicId, reviewPublicId))
    .returning({id: partyReviews.id});
  return Boolean(row);
}
