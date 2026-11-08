import type {FastifyInstance, FastifyRequest} from 'fastify';
import {and, asc, desc, eq, inArray, or} from 'drizzle-orm';
import {z} from 'zod';
import {sha256Hex} from '@pactora/near';
import {
  agents,
  jobDrafts,
  jobEvents,
  jobFiles,
  jobMessages,
  jobs,
  partyReviews,
  sessions,
  type Db,
} from '@pactora/db';
import type {ChainConfig} from '@pactora/config';
import {ErrorCode, PactoraError, canonicalize} from '@pactora/shared';
import type {ObjectStore} from '@pactora/storage';
import {authenticatePerson} from '../auth.js';
import type {ChainViewer} from '../chain-reads.js';
import {audit} from '../compliance.js';
import {hideReview} from './profiles.js';
import {isPublicId} from './jobs.js';

/**
 * The admin console's API (docs/26 F15): the DAO dispute desk, moderation,
 * and (with /v1/compliance) the compliance queue.
 *
 * Who is admin is read LIVE, on every request: the council is whoever the
 * Pactora contract's arbiter (`get_roles`) lists in its Sputnik policy
 * (`get_policy`); reviewers are COMPLIANCE_REVIEWERS. Nothing in our
 * database grants it. An admin session must be at most an hour old.
 *
 * The API never signs a ruling. It builds the exact `add_proposal` (with
 * the 0.1 NEAR bond) and `act_proposal` calls, and the member's own wallet
 * signs them; the DAO's 2-of-3 vote is what moves money. A proposal is
 * bound to an evidence hash over what the desk showed; a stale one is
 * refused, so nobody rules on evidence that changed under them.
 */

export const ADMIN_SESSION_MAX_MS = 60 * 60 * 1000;
export const PROPOSAL_BOND_YOCTO = '100000000000000000000000'; // 0.1 NEAR
const TGAS = 1_000_000_000_000n;

export type AdminRole = 'council' | 'reviewer';

export const ProposalBody = z.object({
  forWorker: z.boolean(),
  /** The evidence hash the member saw; a different current one is refused. */
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/, 'evidenceHash is 64 lowercase hex'),
});
export const VoteBody = z.object({action: z.enum(['VoteApprove', 'VoteReject'])});
export const HideBody = z.object({reason: z.string().trim().min(3).max(500)});

interface DaoPolicy {
  roles?: {name: string; kind: unknown; permissions?: string[]}[];
}
interface DaoProposal {
  id: number;
  proposer: string;
  description: string;
  kind: unknown;
  status: string;
  votes: Record<string, string>;
}

export interface AdminRouteDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  view?: ChainViewer;
  reviewers: () => string[];
  objectStore?: ObjectStore;
  /** How long a read of the DAO's council is reused; default 30 s. */
  councilCacheMs?: number;
}

/** The `resolve_dispute` call a ruling proposal carries (as scripts/lib/dao.mjs builds it). */
export function rulingKind(pactora: string, chainJobId: number, forWorker: boolean) {
  return {
    FunctionCall: {
      receiver_id: pactora,
      actions: [
        {
          method_name: 'resolve_dispute',
          args: Buffer.from(JSON.stringify({job_id: chainJobId, for_worker: forWorker})).toString('base64'),
          deposit: '0',
          gas: String(50n * TGAS),
        },
      ],
    },
  };
}

/** The ruling a proposal makes, if it is a resolve_dispute on this contract; else null. */
export function rulingOf(kind: unknown, pactora: string): {jobId: number; forWorker: boolean} | null {
  const fc = (
    kind as {FunctionCall?: {receiver_id?: string; actions?: {method_name?: string; args?: string}[]}}
  )?.FunctionCall;
  if (!fc || fc.receiver_id !== pactora || fc.actions?.length !== 1) return null;
  const a = fc.actions[0]!;
  if (a.method_name !== 'resolve_dispute' || typeof a.args !== 'string') return null;
  try {
    const args = JSON.parse(Buffer.from(a.args, 'base64').toString('utf8')) as {
      job_id?: unknown;
      for_worker?: unknown;
    };
    return typeof args.job_id === 'number' && typeof args.for_worker === 'boolean'
      ? {jobId: args.job_id, forWorker: args.for_worker}
      : null;
  } catch {
    return null;
  }
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): Promise<void> {
  const {db} = deps;
  const cacheMs = deps.councilCacheMs ?? 30_000;
  const councilCache = new Map<string, {at: number; dao: string | null; members: string[]}>();

  /** The arbiter DAO and its council, from the chain. A plain-account arbiter has no council. */
  async function council(chainId: string): Promise<{dao: string | null; members: string[]}> {
    const hit = councilCache.get(chainId);
    if (hit && Date.now() - hit.at < cacheMs) return hit;
    const chain = deps.chains[chainId];
    let out: {dao: string | null; members: string[]} = {dao: null, members: []};
    if (chain && deps.view) {
      const roles = (await deps.view(chainId, chain.contracts.Pactora, 'get_roles').catch(() => null)) as {
        arbiter?: string;
      } | null;
      const dao = roles?.arbiter ?? null;
      if (dao) {
        const policy = (await deps.view(chainId, dao, 'get_policy').catch(() => null)) as DaoPolicy | null;
        const members = (policy?.roles ?? []).flatMap((r) => {
          const g = (r.kind as {Group?: unknown})?.Group;
          return Array.isArray(g) && (r.permissions ?? []).some((p) => p.endsWith(':VoteApprove'))
            ? (g as string[])
            : [];
        });
        out = {dao: policy ? dao : null, members: [...new Set(members)]};
      }
    }
    councilCache.set(chainId, {...out, at: Date.now()});
    return out;
  }

  async function admin(request: FastifyRequest, need?: AdminRole | 'any') {
    const person = await authenticatePerson(db, request);
    const s = await db.query.sessions.findFirst({where: eq(sessions.id, person.sessionId)});
    if (!s || Date.now() - s.createdAt.getTime() > ADMIN_SESSION_MAX_MS) {
      throw new PactoraError(
        ErrorCode.UNAUTHORIZED,
        'admin needs a sign-in less than an hour old: sign in again',
      );
    }
    const c = await council(person.chainId);
    const roles: AdminRole[] = [];
    if (c.members.includes(person.account)) roles.push('council');
    if (deps.reviewers().includes(person.account)) roles.push('reviewer');
    if (roles.length === 0 || (need && need !== 'any' && !roles.includes(need))) {
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        need === 'council' ? 'only the arbiter council may do this' : 'admin only',
      );
    }
    return {person, roles, council: c, chain: deps.chains[person.chainId]!};
  }

  /**
   * A job that is, or was, disputed. The desk shows a job's chat, drafts and
   * photos, which are otherwise the two parties' alone: a job nobody
   * disputed is not the council's to read, so it is hidden (404). A ruled
   * dispute stays readable — its job has left `disputed` but keeps the event.
   */
  /**
   * A member who is a party recuses: the desk builds no proposal or vote for
   * someone ruling on their own job. Reading stays open — a party has the
   * evidence anyway. The DAO itself cannot know who is a party, so this is the
   * desk's rule, not the chain's.
   */
  async function recuse(account: string, job: {clientAgentId: number; workerAgentId: number}) {
    const party = await db.query.agents.findFirst({
      where: and(
        inArray(agents.id, [job.clientAgentId, job.workerAgentId]),
        or(eq(agents.ownerAddress, account), eq(agents.walletAddress, account)),
      ),
    });
    if (party) {
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        'you are a party to this dispute (your account owns the client or the worker): another council member must rule',
      );
    }
  }

  async function disputedJob(id: string, chainId: string) {
    if (!isPublicId(id)) throw new PactoraError(ErrorCode.NOT_FOUND, `no job ${id}`);
    const job = await db.query.jobs.findFirst({where: and(eq(jobs.publicId, id), eq(jobs.chainId, chainId))});
    const disputed =
      job &&
      (job.state === 'disputed' ||
        (await db.query.jobEvents.findFirst({
          where: and(eq(jobEvents.jobId, job.id), eq(jobEvents.kind, 'job.disputed')),
        })));
    if (!job || !disputed) throw new PactoraError(ErrorCode.NOT_FOUND, `no disputed job ${id}`);
    return job;
  }

  /** Everything the desk shows about a job, and the hash a ruling is bound to. */
  async function evidenceOf(job: typeof jobs.$inferSelect) {
    const [drafts, files, messages, events, dispute] = await Promise.all([
      db.select().from(jobDrafts).where(eq(jobDrafts.jobId, job.id)).orderBy(asc(jobDrafts.round)),
      db.select().from(jobFiles).where(eq(jobFiles.jobId, job.id)).orderBy(asc(jobFiles.id)),
      db.select().from(jobMessages).where(eq(jobMessages.jobId, job.id)).orderBy(asc(jobMessages.id)),
      db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id)).orderBy(asc(jobEvents.id)),
      db.query.jobEvents.findFirst({
        where: and(eq(jobEvents.jobId, job.id), eq(jobEvents.kind, 'job.disputed')),
      }),
    ]);
    const parties = await db
      .select()
      .from(agents)
      .where(inArray(agents.id, [job.clientAgentId, job.workerAgentId]));
    const name = (id: number) => parties.find((p) => p.id === id)?.name ?? null;
    const reason = (dispute?.payload as {reason?: string} | undefined)?.reason ?? null;
    const evidenceHash = sha256Hex(
      canonicalize({
        v: 1,
        jobId: job.publicId,
        chainJobId: job.chainJobId,
        state: job.state,
        resultHash: job.resultHash,
        disputeReason: reason,
        drafts: drafts.map((d) => d.snapshotHash),
        files: files.map((f) => [f.sha256, f.withdrawnAt !== null]),
        messages: messages.map((m) => m.publicId),
      }),
    );
    return {
      jobId: job.publicId,
      chainJobId: job.chainJobId,
      state: job.state,
      amount: job.amount,
      resultHash: job.resultHash,
      resultMismatch: job.resultMismatch,
      client: {agentId: job.clientAgentId, name: name(job.clientAgentId)},
      worker: {agentId: job.workerAgentId, name: name(job.workerAgentId)},
      spec: job.spec,
      result: job.result,
      disputeReason: reason,
      drafts: drafts.map((d) => ({round: d.round, snapshotHash: d.snapshotHash, snapshot: d.snapshot})),
      files: files.map((f) => ({
        fileId: f.publicId,
        sha256: f.sha256,
        mime: f.mime,
        size: f.size,
        withdrawnAt: f.withdrawnAt,
        url: `/v1/admin/files/${f.publicId}`,
      })),
      messages: messages.map((m) => ({
        messageId: m.publicId,
        from: m.authorAgentId === job.workerAgentId ? 'worker' : 'client',
        body: m.body,
        at: m.createdAt,
      })),
      timeline: events.map((e) => ({kind: e.kind, txHash: e.txHash, at: e.occurredAt})),
      evidenceHash,
    };
  }

  app.get('/v1/admin/me', async (request) => {
    const a = await admin(request, 'any');
    return {account: a.person.account, chainId: a.person.chainId, roles: a.roles, arbiterDao: a.council.dao};
  });

  app.get('/v1/admin/disputes', async (request) => {
    const a = await admin(request, 'council');
    const rows = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.chainId, a.person.chainId), eq(jobs.state, 'disputed')))
      .orderBy(asc(jobs.id))
      .limit(100);
    return {
      arbiterDao: a.council.dao,
      disputes: rows.map((j) => ({
        jobId: j.publicId,
        chainJobId: j.chainJobId,
        amount: j.amount,
        createdAt: j.createdAt,
      })),
    };
  });

  app.get('/v1/admin/disputes/:id', async (request) => {
    const a = await admin(request, 'council');
    return evidenceOf(await disputedJob((request.params as {id: string}).id, a.person.chainId));
  });

  app.get('/v1/admin/files/:fileId', async (request, reply) => {
    const a = await admin(request, 'council');
    const {fileId} = request.params as {fileId: string};
    if (!isPublicId(fileId)) throw new PactoraError(ErrorCode.NOT_FOUND, 'no such file');
    const [hit] = await db
      .select({file: jobFiles, job: jobs})
      .from(jobFiles)
      .innerJoin(jobs, eq(jobs.id, jobFiles.jobId))
      .where(eq(jobFiles.publicId, fileId));
    // The council sees evidence of disputed jobs only.
    if (!hit || hit.job.state !== 'disputed' || hit.job.chainId !== a.person.chainId) {
      throw new PactoraError(ErrorCode.NOT_FOUND, 'no such file on a disputed job');
    }
    if (!deps.objectStore)
      throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'evidence storage is not configured');
    const bytes = await deps.objectStore.get(hit.file.objectKey);
    if (!bytes) throw new PactoraError(ErrorCode.NOT_FOUND, 'the file is not in storage');
    await audit(db, a.person.account, 'admin.file.read', {detail: {file: fileId, job: hit.job.publicId}});
    return reply
      .header('content-type', hit.file.mime)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(bytes));
  });

  app.post('/v1/admin/disputes/:id/proposal', async (request) => {
    const a = await admin(request, 'council');
    const body = ProposalBody.parse(request.body ?? {});
    if (!a.council.dao)
      throw new PactoraError(ErrorCode.INVALID_STATE, 'the arbiter is not a DAO on this chain');
    const job = await disputedJob((request.params as {id: string}).id, a.person.chainId);
    await recuse(a.person.account, job);
    if (job.state !== 'disputed' || !job.chainJobId)
      throw new PactoraError(ErrorCode.INVALID_STATE, `job is "${job.state}"`);
    const ev = await evidenceOf(job);
    if (ev.evidenceHash !== body.evidenceHash) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        `stale evidence: it is now ${ev.evidenceHash}; reload and look again`,
      );
    }
    const description = `Pactora job ${job.publicId} (on chain ${job.chainJobId}): ${body.forWorker ? 'pay the worker' : 'refund the client'}. Evidence sha256 ${ev.evidenceHash}.`;
    await audit(db, a.person.account, 'admin.proposal.built', {
      detail: {job: job.publicId, forWorker: body.forWorker, evidenceHash: ev.evidenceHash},
    });
    return {
      dao: a.council.dao,
      functionCall: {
        receiverId: a.council.dao,
        methodName: 'add_proposal',
        args: {
          proposal: {
            description,
            kind: rulingKind(a.chain.contracts.Pactora, Number(job.chainJobId), body.forWorker),
          },
        },
        gas: String(100n * TGAS),
        deposit: PROPOSAL_BOND_YOCTO,
      },
    };
  });

  /** The DAO's proposals that rule on this job, read from the chain. */
  async function proposalsFor(chainId: string, dao: string, pactora: string, chainJobId: number) {
    if (!deps.view) return [];
    const last = Number(await deps.view(chainId, dao, 'get_last_proposal_id'));
    const out: (DaoProposal & {ruling: {forWorker: boolean}})[] = [];
    for (let from = Math.max(0, last - 200); from < last; from += 50) {
      const page = (await deps.view(chainId, dao, 'get_proposals', {
        from_index: from,
        limit: 50,
      })) as DaoProposal[];
      for (const p of page) {
        const r = rulingOf(p.kind, pactora);
        if (r && r.jobId === chainJobId) out.push({...p, ruling: {forWorker: r.forWorker}});
      }
    }
    return out;
  }

  app.get('/v1/admin/disputes/:id/proposals', async (request) => {
    const a = await admin(request, 'council');
    const job = await disputedJob((request.params as {id: string}).id, a.person.chainId);
    if (!a.council.dao || !job.chainJobId) return {proposals: []};
    const list = await proposalsFor(
      a.person.chainId,
      a.council.dao,
      a.chain.contracts.Pactora,
      Number(job.chainJobId),
    );
    return {
      dao: a.council.dao,
      council: a.council.members,
      proposals: list.map((p) => ({
        id: p.id,
        proposer: p.proposer,
        description: p.description,
        status: p.status,
        votes: p.votes,
        forWorker: p.ruling.forWorker,
        youVoted: p.votes[a.person.account] ?? null,
      })),
    };
  });

  app.post('/v1/admin/disputes/:id/proposals/:pid/vote', async (request) => {
    const a = await admin(request, 'council');
    const {id, pid} = request.params as {id: string; pid: string};
    const body = VoteBody.parse(request.body ?? {});
    const job = await disputedJob(id, a.person.chainId);
    await recuse(a.person.account, job);
    if (!a.council.dao || !job.chainJobId)
      throw new PactoraError(ErrorCode.INVALID_STATE, 'nothing to vote on');
    const p = (
      await proposalsFor(a.person.chainId, a.council.dao, a.chain.contracts.Pactora, Number(job.chainJobId))
    ).find((x) => String(x.id) === pid);
    if (!p) throw new PactoraError(ErrorCode.NOT_FOUND, `no ruling proposal ${pid} for this job`);
    if (p.status !== 'InProgress')
      throw new PactoraError(ErrorCode.INVALID_STATE, `proposal ${pid} is ${p.status}`);
    // The kind as the chain holds it: Sputnik refuses a vote whose kind differs.
    return {
      dao: a.council.dao,
      functionCall: {
        receiverId: a.council.dao,
        methodName: 'act_proposal',
        args: {id: p.id, action: body.action, proposal: p.kind},
        gas: String(300n * TGAS),
        deposit: '0',
      },
    };
  });

  // ── moderation ───────────────────────────────────────────────────────

  app.get('/v1/admin/reviews', async (request) => {
    await admin(request, 'any');
    const rows = await db.select().from(partyReviews).orderBy(desc(partyReviews.id)).limit(100);
    return {
      reviews: rows.map((r) => ({
        reviewId: r.publicId,
        rating: r.rating,
        body: r.body,
        authorRole: r.authorRole,
        at: r.createdAt,
        hidden: r.hiddenAt !== null,
        hiddenReason: r.hiddenReason,
      })),
    };
  });

  app.post('/v1/admin/reviews/:id/hide', async (request) => {
    const a = await admin(request, 'any');
    const {id} = request.params as {id: string};
    if (!isPublicId(id)) throw new PactoraError(ErrorCode.NOT_FOUND, `no review ${id}`);
    const body = HideBody.parse(request.body ?? {});
    if (!(await hideReview(db, id, body.reason)))
      throw new PactoraError(ErrorCode.NOT_FOUND, `no review ${id}`);
    await audit(db, a.person.account, 'admin.review.hidden', {detail: {review: id, reason: body.reason}});
    return {reviewId: id, hidden: true};
  });
}
