import {and, asc, eq, sql} from 'drizzle-orm';
import {agentEvents, agents, jobs, webhookDeliveries, webhooks, type Db} from '@pactora/db';
import {
  checkTarget,
  open,
  postPinned,
  UnsafeTargetError,
  webhookSignature,
  type CheckedTarget,
  type PinnedResponse,
  type TargetPolicy,
} from '@pactora/service';

/**
 * Webhook delivery (docs/26 F9).
 *
 * Fairness: each round claims at most ONE due delivery per webhook (the
 * oldest), with FOR UPDATE SKIP LOCKED, and sends different webhooks in
 * parallel. A slow or dead endpoint holds one slot for at most the timeout
 * and never delays another agent's hooks. Several notifiers can run: a
 * claimed row carries a lease, and SKIP LOCKED keeps two from taking it.
 *
 * No transaction is open during the HTTP call: the claim commits, the POST
 * runs, the outcome is written in a second statement. A notifier that dies
 * mid-send leaves a lease that expires, and the delivery is sent again —
 * so a receiver may see a delivery twice and must de-duplicate by its id.
 *
 * Every send re-checks the target (DNS may have changed since the hook was
 * made) and connects to the address it checked. 8 tries with exponential
 * backoff; after that the delivery fails, and a hook whose deliveries keep
 * failing is switched off with the reason.
 */

export const MAX_ATTEMPTS = 8;
/** A hook is switched off after this many deliveries in a row gave up. */
export const DISABLE_AFTER = 10;

export interface NotifierDeps {
  db: Db;
  secretKey: Buffer;
  policy?: TargetPolicy;
  /** Injected in tests; the real ones resolve DNS and open a socket. */
  check?: (url: string, policy: TargetPolicy) => Promise<CheckedTarget>;
  post?: (target: CheckedTarget, body: string, headers: Record<string, string>) => Promise<PinnedResponse>;
  now?: () => Date;
  /** Webhooks sent to at once; default 8. */
  concurrency?: number;
  leaseMs?: number;
  timeoutMs?: number;
  /** First retry delay; doubles each time, capped at an hour. Default 30 s. */
  baseDelayMs?: number;
  logger?: {warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void};
  onOutcome?: (outcome: 'delivered' | 'retry' | 'failed') => void;
}

/** When the next try is due after `attempts` failures. */
export function backoffMs(attempts: number, baseMs = 30_000): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempts - 1), 3_600_000);
}

type Delivery = typeof webhookDeliveries.$inferSelect;

export class Notifier {
  private readonly d: Required<Pick<NotifierDeps, 'concurrency' | 'leaseMs' | 'timeoutMs' | 'baseDelayMs'>> &
    NotifierDeps;

  constructor(deps: NotifierDeps) {
    this.d = {concurrency: 8, leaseMs: 60_000, timeoutMs: 10_000, baseDelayMs: 30_000, ...deps};
  }

  private now() {
    return this.d.now?.() ?? new Date();
  }

  /** Claim up to `concurrency` deliveries, one per webhook, oldest first. */
  async claim(): Promise<Delivery[]> {
    const {db} = this.d;
    const now = this.now();
    // ISO strings with casts: postgres-js does not serialise a Date in a raw template.
    const at = now.toISOString();
    const due = sql`status = 'pending' AND next_attempt_at <= ${at}::timestamptz AND (leased_until IS NULL OR leased_until < ${at}::timestamptz)`;
    const hooks = (await db.execute(
      sql`SELECT webhook_id FROM webhook_deliveries WHERE ${due}
          GROUP BY webhook_id ORDER BY min(next_attempt_at) LIMIT ${this.d.concurrency}`,
    )) as unknown as {webhook_id: string | number}[];
    const claimed: Delivery[] = [];
    for (const h of hooks) {
      const rows = (await db.execute(sql`
        UPDATE webhook_deliveries SET leased_until = ${new Date(now.getTime() + this.d.leaseMs).toISOString()}::timestamptz
        WHERE id = (
          SELECT id FROM webhook_deliveries
          WHERE webhook_id = ${Number(h.webhook_id)} AND ${due}
          ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id`)) as unknown as {id: string | number}[];
      const id = rows[0]?.id;
      if (id === undefined) continue;
      const row = await db.query.webhookDeliveries.findFirst({where: eq(webhookDeliveries.id, Number(id))});
      if (row) claimed.push(row);
    }
    return claimed;
  }

  /** One round: claim, send in parallel, record. Returns how many were attempted. */
  async runOnce(): Promise<number> {
    const batch = await this.claim();
    await Promise.all(batch.map((d) => this.deliver(d)));
    return batch.length;
  }

  /** The JSON a receiver gets: the same shape as one GET /v1/events item, plus the delivery's ids. */
  async bodyOf(d: Delivery, hookPublicId: string): Promise<string | null> {
    const [row] = await this.d.db
      .select({e: agentEvents, jobId: jobs.publicId, agentId: agents.publicId})
      .from(agentEvents)
      .innerJoin(jobs, eq(jobs.id, agentEvents.jobId))
      .innerJoin(agents, eq(agents.id, agentEvents.agentId))
      .where(and(eq(agentEvents.agentId, d.agentId), eq(agentEvents.seq, d.seq)))
      .orderBy(asc(agentEvents.seq))
      .limit(1);
    if (!row) return null;
    return JSON.stringify({
      deliveryId: d.publicId,
      webhookId: hookPublicId,
      agentId: row.agentId,
      seq: row.e.seq,
      kind: row.e.kind,
      role: row.e.role,
      jobId: row.jobId,
      payload: row.e.payload,
      at: row.e.createdAt.toISOString(),
    });
  }

  async deliver(d: Delivery): Promise<void> {
    const {db} = this.d;
    const hook = await db.query.webhooks.findFirst({where: eq(webhooks.id, d.webhookId)});
    if (!hook || !hook.active || hook.deletedAt) {
      await this.finish(d, 'failed', {lastError: 'webhook is off or deleted'});
      return;
    }
    const body = await this.bodyOf(d, hook.publicId);
    if (body === null) {
      await this.finish(d, 'failed', {lastError: 'the event no longer exists'});
      return;
    }
    let status: number | null = null;
    let error: string | null = null;
    try {
      const target = await (this.d.check ?? checkTarget)(hook.url, this.d.policy ?? {});
      const secret = open(this.d.secretKey, hook.secretEnc, `webhook:${hook.publicId}`);
      const t = Math.floor(this.now().getTime() / 1000);
      const res = await (this.d.post ?? ((tg, b, h) => postPinned(tg, b, h, {timeoutMs: this.d.timeoutMs})))(
        target,
        body,
        {
          'content-type': 'application/json',
          'user-agent': 'Pactora-Webhooks/1',
          'pactora-delivery': d.publicId,
          'pactora-signature': webhookSignature(secret, t, d.publicId, body),
        },
      );
      status = res.status;
      if (status >= 200 && status < 300) {
        await this.finish(d, 'delivered', {lastStatus: status});
        await db.update(webhooks).set({consecutiveFailures: 0}).where(eq(webhooks.id, hook.id));
        return;
      }
      error = `answered ${status}`;
    } catch (err) {
      error =
        err instanceof UnsafeTargetError
          ? `refused target: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
    }
    const attempts = d.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.finish(d, 'failed', {lastStatus: status, lastError: error, attempts});
      const [h] = await db
        .update(webhooks)
        .set({consecutiveFailures: sql`${webhooks.consecutiveFailures} + 1`})
        .where(eq(webhooks.id, hook.id))
        .returning({n: webhooks.consecutiveFailures});
      if ((h?.n ?? 0) >= DISABLE_AFTER) {
        await db
          .update(webhooks)
          .set({active: false, disabledReason: `${DISABLE_AFTER} deliveries in a row failed; last: ${error}`})
          .where(eq(webhooks.id, hook.id));
        this.d.logger?.warn({webhook: hook.publicId}, 'webhook switched off after repeated failures');
      }
      return;
    }
    await db
      .update(webhookDeliveries)
      .set({
        attempts,
        lastStatus: status,
        lastError: error?.slice(0, 500) ?? null,
        leasedUntil: null,
        nextAttemptAt: new Date(this.now().getTime() + backoffMs(attempts, this.d.baseDelayMs)),
      })
      .where(eq(webhookDeliveries.id, d.id));
    this.d.onOutcome?.('retry');
  }

  private async finish(
    d: Delivery,
    status: 'delivered' | 'failed',
    extra: {lastStatus?: number | null; lastError?: string | null; attempts?: number},
  ) {
    await this.d.db
      .update(webhookDeliveries)
      .set({
        status,
        attempts: extra.attempts ?? d.attempts + 1,
        leasedUntil: null,
        lastStatus: extra.lastStatus ?? null,
        lastError: extra.lastError?.slice(0, 500) ?? null,
        ...(status === 'delivered' ? {deliveredAt: this.now()} : {}),
      })
      .where(eq(webhookDeliveries.id, d.id));
    this.d.onOutcome?.(status);
  }

  /** Run rounds until stopped: straight away while there is work, else every `idleMs`. */
  start(idleMs = 1000): () => Promise<void> {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let running: Promise<void> = Promise.resolve();
    const tick = () => {
      running = this.runOnce()
        .then((n) => {
          if (!stopped) timer = setTimeout(tick, n > 0 ? 0 : idleMs);
        })
        .catch((err: unknown) => {
          this.d.logger?.warn({err}, 'notifier round failed');
          if (!stopped) timer = setTimeout(tick, idleMs);
        });
    };
    tick();
    return async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    };
  }
}
