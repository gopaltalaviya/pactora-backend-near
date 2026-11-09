import {randomUUID, createHash} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import multipart from '@fastify/multipart';
import {and, asc, count, eq, isNull} from 'drizzle-orm';
import type {FastifyRequest, FastifyReply} from 'fastify';
import {jobFiles, jobs, type Db} from '@pactora/db';
import {ErrorCode, PactoraError} from '@pactora/shared';
import type {ChainConfig} from '@pactora/config';
import type {ObjectStore} from '@pactora/storage';
import {actorOf} from '../actor.js';
import {cleanImage} from '../images.js';
import {draftsOf, lockJob, partyOf, phaseOf, requireRole, type Job, type Reader} from '../evidence.js';
import type {EventBus} from '../events.js';
import {isPublicId, recordEvent} from './jobs.js';

/**
 * Evidence photos (docs/26 F6). Uploaded by the job's worker while the work
 * is open, read by the two parties only.
 *
 * Multipart parsing exists on exactly one route — the upload — inside its
 * own plugin scope, so no other route accepts a multipart body, and the
 * 256 KiB body limit everywhere else stays as it is.
 */

/** One photo, after nothing: the limit applies to the upload as sent. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** The route's whole body: the file plus the multipart framing around it. */
export const UPLOAD_BODY_LIMIT = 9 * 1024 * 1024;
export const MAX_ACTIVE_FILES = 10;
/** Withdrawn files count: storage cannot grow without limit by upload-and-withdraw. */
export const MAX_TOTAL_FILES = 30;
/** The client's dispute photos per job (0027). */
export const MAX_DISPUTE_FILES = 10;

/** The states a client may attach dispute evidence in: delivered, or already disputed. */
export const DISPUTE_EVIDENCE_STATES = new Set<Job['state']>(['submitted', 'disputed']);

export function refuseNotDisputable(job: Job): void {
  if (!DISPUTE_EVIDENCE_STATES.has(job.state)) {
    throw new PactoraError(
      ErrorCode.INVALID_STATE,
      `job is "${job.state}"; dispute evidence is attached while it is submitted or disputed`,
    );
  }
}

/**
 * At most `limit` uploads in flight across this process; the rest wait, and
 * a request that waited `waitMs` without a turn is refused with a retry.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(
    readonly limit: number,
    private readonly waitMs = 10_000,
  ) {}

  get inUse(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const turn = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const i = this.waiting.indexOf(turn);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(new PactoraError(ErrorCode.RATE_LIMITED, 'too many uploads in progress — retry shortly', 2));
        }, this.waitMs);
        this.waiting.push(turn);
      });
    } else {
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      // The slot passes straight to the next waiter; otherwise it is freed.
      if (next) next();
      else this.active--;
    };
  }
}

export interface FileRouteDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  bus: EventBus;
  /** Omitted: uploads and downloads answer 503 — evidence storage is not configured. */
  objectStore?: ObjectStore;
  /** Uploads in flight across the process; default 4. */
  uploadConcurrency?: number;
}

/** A job's files as the API shows them. */
export function fileView(f: typeof jobFiles.$inferSelect) {
  return {
    fileId: f.publicId,
    sha256: f.sha256,
    mime: f.mime,
    size: f.size,
    purpose: f.purpose,
    createdAt: f.createdAt,
    withdrawnAt: f.withdrawnAt,
    url: `/v1/files/${f.publicId}`,
  };
}

/** The worker's evidence photos only: dispute photos have their own cap. */
async function counts(db: Reader, jobId: number): Promise<{active: number; total: number}> {
  const [row] = await db
    .select({total: count(), withdrawn: count(jobFiles.withdrawnAt)})
    .from(jobFiles)
    .where(and(eq(jobFiles.jobId, jobId), eq(jobFiles.purpose, 'evidence')));
  const total = Number(row?.total ?? 0);
  // count(withdrawn_at) counts only the non-null ones: the withdrawn files.
  return {total, active: total - Number(row?.withdrawn ?? 0)};
}

/**
 * The checks an upload or a withdrawal makes, before and again under the
 * row lock: the work is open (Accepted on chain), and no draft has been
 * accepted or turned into a dispute — after that the evidence is fixed.
 */
async function refuseClosed(db: Reader, job: Job, what: string): Promise<void> {
  if (job.state !== 'accepted') {
    throw new PactoraError(ErrorCode.INVALID_STATE, `job is "${job.state}"; ${what} needs "accepted"`);
  }
  const phase = phaseOf(await draftsOf(db, job.id));
  if (phase === 'accepted' || phase === 'dispute_intent') {
    throw new PactoraError(
      ErrorCode.INVALID_STATE,
      phase === 'accepted'
        ? 'the client accepted a draft; its evidence is fixed — submit it'
        : 'the client intends to dispute; no more evidence is taken',
    );
  }
}

async function disputeCount(db: Reader, jobId: number): Promise<number> {
  const [row] = await db
    .select({n: count()})
    .from(jobFiles)
    .where(and(eq(jobFiles.jobId, jobId), eq(jobFiles.purpose, 'dispute')));
  return Number(row?.n ?? 0);
}

function refuseOverDisputeCap(n: number): void {
  if (n >= MAX_DISPUTE_FILES) {
    throw new PactoraError(ErrorCode.LIMIT_REACHED, `at most ${MAX_DISPUTE_FILES} dispute photos per job`);
  }
}

function refuseOverCap(c: {active: number; total: number}): void {
  if (c.active >= MAX_ACTIVE_FILES) {
    throw new PactoraError(
      ErrorCode.LIMIT_REACHED,
      `at most ${MAX_ACTIVE_FILES} active files per job — withdraw one first`,
    );
  }
  if (c.total >= MAX_TOTAL_FILES) {
    throw new PactoraError(
      ErrorCode.LIMIT_REACHED,
      `at most ${MAX_TOTAL_FILES} uploads per job, withdrawn ones included`,
    );
  }
}

export async function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): Promise<void> {
  const {db, chains, bus} = deps;
  const uploads = new Semaphore(deps.uploadConcurrency ?? 4);

  const store = (): ObjectStore => {
    if (!deps.objectStore) {
      throw new PactoraError(
        ErrorCode.UPSTREAM_UNAVAILABLE,
        'evidence storage is not configured on this API (OBJECT_STORE_BUCKET, docs/08)',
      );
    }
    return deps.objectStore;
  };

  await app.register(async (scope) => {
    await scope.register(multipart, {
      limits: {fileSize: MAX_FILE_BYTES, files: 1, fields: 0, headerPairs: 50},
    });

    /**
     * One pipeline for both uploads. `check(reader, job)` is what makes a
     * request refusable (the state, the caps), run cheaply first and again
     * under the row lock; `purpose` is what the row is for.
     */
    async function storeUpload(
      request: FastifyRequest,
      reply: FastifyReply,
      p: Awaited<ReturnType<typeof partyOf>>,
      purpose: 'evidence' | 'dispute',
      check: (reader: Reader, job: Job) => Promise<void>,
    ) {
      const objectStore = store();
      // 1. Cheap checks first: nothing is read for a request that would be refused.
      await check(db, p.job);
      if (!request.isMultipart()) {
        throw new PactoraError(
          ErrorCode.SCHEMA_MISMATCH,
          'send the photo as multipart/form-data, field "file"',
        );
      }

      // 2. Read, clean and store — the slow part, with no lock held.
      const release = await uploads.acquire();
      let key: string | null = null;
      try {
        const part = await request.file();
        if (!part) throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, 'no file in the upload (field "file")');
        // Throws 413 FST_REQ_FILE_TOO_LARGE past MAX_FILE_BYTES.
        const raw = await part.toBuffer();
        if (raw.length === 0) throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, 'the file is empty');
        const clean = cleanImage(raw);
        const sha256 = createHash('sha256').update(clean.bytes).digest('hex');
        const fileId = randomUUID();
        key = `${purpose}/${p.job.publicId}/${fileId}.${clean.ext}`;
        await objectStore.put(key, clean.bytes, clean.mime).catch((err: unknown) => {
          request.log.error({err}, 'object store put failed');
          key = null;
          throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'evidence storage did not take the file', 5);
        });

        // 3. The short re-check, under the job's row lock: the state and
        // the caps may have changed while the file was read.
        const row = await db.transaction(async (tx) => {
          const job = await lockJob(tx, p.job.id);
          await check(tx, job);
          const [inserted] = await tx
            .insert(jobFiles)
            .values({
              publicId: fileId,
              jobId: job.id,
              uploaderAgentId: p.actor.agent.id,
              objectKey: key!,
              sha256,
              mime: clean.mime,
              size: clean.bytes.length,
              purpose,
            })
            .returning();
          return inserted!;
        });
        key = null; // kept: the row names it
        if (clean.removed.length > 0) {
          request.log.info({fileId, removed: clean.removed}, 'evidence metadata removed');
        }
        await recordEvent(
          db,
          bus,
          p.job.id,
          p.job.chainId,
          purpose === 'dispute' ? 'job.dispute.file.added' : 'job.file.added',
          {jobId: p.job.publicId, fileId, sha256},
        );
        return reply
          .status(201)
          .send({jobId: p.job.publicId, ...fileView(row), metadataRemoved: clean.removed});
      } finally {
        release();
        // An orphan — stored, then refused on the re-check — is deleted.
        if (key) {
          const orphan: string = key;
          await objectStore
            .delete(orphan)
            .catch((err: unknown) => request.log.error({err, key: orphan}, 'orphan evidence not deleted'));
        }
      }
    }

    scope.post('/v1/jobs/:id/files', {bodyLimit: UPLOAD_BODY_LIMIT}, async (request, reply) => {
      const p = await partyOf(db, chains, request, (request.params as {id: string}).id);
      requireRole(p, 'worker', 'upload evidence');
      return storeUpload(request, reply, p, 'evidence', async (reader, job) => {
        await refuseClosed(reader, job, 'an upload');
        refuseOverCap(await counts(reader, job.id));
      });
    });

    /** The client's dispute photos (0027): while submitted or disputed, at most 10, same pipeline. */
    scope.post('/v1/jobs/:id/dispute/files', {bodyLimit: UPLOAD_BODY_LIMIT}, async (request, reply) => {
      const p = await partyOf(db, chains, request, (request.params as {id: string}).id);
      requireRole(p, 'client', 'attach dispute evidence');
      return storeUpload(request, reply, p, 'dispute', async (reader, job) => {
        refuseNotDisputable(job);
        refuseOverDisputeCap(await disputeCount(reader, job.id));
      });
    });
  });

  app.get('/v1/jobs/:id/files', async (request) => {
    const p = await partyOf(db, chains, request, (request.params as {id: string}).id);
    const rows = await db
      .select()
      .from(jobFiles)
      .where(eq(jobFiles.jobId, p.job.id))
      .orderBy(asc(jobFiles.id));
    const evidence = rows.filter((f) => f.purpose === 'evidence');
    const active = evidence.filter((f) => f.withdrawnAt === null).length;
    return {
      jobId: p.job.publicId,
      active,
      total: evidence.length,
      disputeFiles: rows.length - evidence.length,
      limits: {
        maxActive: MAX_ACTIVE_FILES,
        maxTotal: MAX_TOTAL_FILES,
        maxBytes: MAX_FILE_BYTES,
        maxDisputeFiles: MAX_DISPUTE_FILES,
      },
      files: rows.map(fileView),
    };
  });

  /** Withdraw: the file leaves future snapshots; its bytes stay for the ones that named it. */
  app.delete('/v1/jobs/:id/files/:fileId', async (request) => {
    const {id, fileId} = request.params as {id: string; fileId: string};
    const p = await partyOf(db, chains, request, id);
    requireRole(p, 'worker', 'withdraw evidence');
    const file = isPublicId(fileId)
      ? await db.query.jobFiles.findFirst({
          where: and(eq(jobFiles.publicId, fileId), eq(jobFiles.jobId, p.job.id)),
        })
      : undefined;
    if (!file) throw new PactoraError(ErrorCode.NOT_FOUND, `no file ${fileId} on this job`);
    if (file.purpose !== 'evidence') {
      throw new PactoraError(ErrorCode.INVALID_STATE, 'dispute evidence is not withdrawn once attached');
    }
    if (file.withdrawnAt) return {jobId: p.job.publicId, ...fileView(file), replayed: true};
    await refuseClosed(db, p.job, 'a withdrawal');
    const [row] = await db
      .update(jobFiles)
      .set({withdrawnAt: new Date()})
      .where(and(eq(jobFiles.id, file.id), isNull(jobFiles.withdrawnAt)))
      .returning();
    const latest = row ?? (await db.query.jobFiles.findFirst({where: eq(jobFiles.id, file.id)}))!;
    if (row) {
      await recordEvent(db, bus, p.job.id, p.job.chainId, 'job.file.withdrawn', {
        jobId: p.job.publicId,
        fileId: file.publicId,
      });
    }
    return {jobId: p.job.publicId, ...fileView(latest), replayed: !row};
  });

  /** The bytes, for the two parties only, as the type they were detected to be. */
  app.get('/v1/files/:fileId', async (request, reply) => {
    const {fileId} = request.params as {fileId: string};
    const actor = await actorOf(db, request);
    const found = isPublicId(fileId)
      ? await db
          .select({file: jobFiles, job: jobs})
          .from(jobFiles)
          .innerJoin(jobs, eq(jobs.id, jobFiles.jobId))
          .where(eq(jobFiles.publicId, fileId))
          .limit(1)
      : [];
    const hit = found[0];
    if (!hit) throw new PactoraError(ErrorCode.NOT_FOUND, `no file ${fileId}`);
    if (hit.job.clientAgentId !== actor.agent.id && hit.job.workerAgentId !== actor.agent.id) {
      throw new PactoraError(ErrorCode.FORBIDDEN, "only the job's client and worker may read its evidence");
    }
    const bytes = await store().get(hit.file.objectKey);
    if (!bytes) throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'the file is missing from storage', 5);
    const ext = hit.file.mime === 'image/png' ? 'png' : hit.file.mime === 'image/webp' ? 'webp' : 'jpg';
    return reply
      .header('content-type', hit.file.mime)
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `inline; filename="${hit.file.publicId}.${ext}"`)
      .header('cache-control', 'private, no-store')
      .header('x-sha256', hit.file.sha256)
      .send(Buffer.from(bytes));
  });
}
