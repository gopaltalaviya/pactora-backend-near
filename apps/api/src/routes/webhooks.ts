import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {and, count, desc, eq, isNull} from 'drizzle-orm';
import {z} from 'zod';
import {webhookDeliveries, webhooks, type Db} from '@pactora/db';
import {ErrorCode, PactoraError} from '@pactora/shared';
import {checkTarget, seal, UnsafeTargetError, type TargetPolicy} from '@pactora/service';
import {actorOf} from '../actor.js';
import {isPublicId} from './jobs.js';

/**
 * Webhooks (docs/26 F9): the agent's feed, pushed. Each hook gets every
 * agent event (or the kinds it names), signed with a secret shown ONCE, at
 * creation, and stored only encrypted (AES-256-GCM under
 * WEBHOOK_SECRET_KEY, bound to the hook's row).
 *
 * The URL is checked here and again before every delivery: https, no
 * credentials, and every address its name resolves to public. The notifier
 * connects to the address it checked, follows no redirect, and gives a
 * delivery 8 tries.
 *
 * Signature: `Pactora-Signature: t=<unix seconds>,v1=<hex>` where
 * v1 = HMAC-SHA256(secret, `${t}.${deliveryId}.${body}`), and
 * `Pactora-Delivery: <deliveryId>`. A receiver recomputes v1, compares in
 * constant time, refuses a `t` older than 5 minutes, and keeps the
 * delivery ids it has handled (a delivery may arrive more than once).
 */

export const MAX_HOOKS_PER_AGENT = 5;

export const WebhookBody = z.object({
  url: z.string().max(2048),
  /** Event kinds to deliver (e.g. `job.message`); omitted or empty = every kind. */
  kinds: z
    .array(z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/, 'an event kind like job.message'))
    .max(50)
    .default([]),
});

export interface WebhookRouteDeps {
  db: Db;
  /** 32 bytes from WEBHOOK_SECRET_KEY; without it hooks cannot be created (503). */
  secretKey?: Buffer;
  /** Local development may allow http and private targets; production never does. */
  targetPolicy?: TargetPolicy;
}

const hookView = (h: typeof webhooks.$inferSelect) => ({
  webhookId: h.publicId,
  url: h.url,
  kinds: h.kinds,
  active: h.active,
  consecutiveFailures: h.consecutiveFailures,
  disabledReason: h.disabledReason,
  createdAt: h.createdAt,
});

/** The additional data a sealed secret is bound to: it opens only for its own row. */
export const secretAad = (publicId: string) => `webhook:${publicId}`;

export async function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): Promise<void> {
  const {db} = deps;

  const ownHook = async (agentId: number, id: string) => {
    if (!isPublicId(id)) throw new PactoraError(ErrorCode.NOT_FOUND, `no webhook ${id}`);
    const hook = await db.query.webhooks.findFirst({
      where: and(eq(webhooks.publicId, id), eq(webhooks.agentId, agentId), isNull(webhooks.deletedAt)),
    });
    if (!hook) throw new PactoraError(ErrorCode.NOT_FOUND, `no webhook ${id}`);
    return hook;
  };

  app.post('/v1/webhooks', async (request, reply) => {
    const actor = await actorOf(db, request);
    if (!deps.secretKey) {
      throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'webhooks are not configured on this server');
    }
    const body = WebhookBody.parse(request.body ?? {});
    try {
      await checkTarget(body.url, deps.targetPolicy ?? {});
    } catch (err) {
      if (err instanceof UnsafeTargetError) {
        throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, `url: ${err.message}`);
      }
      throw err;
    }
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const key = deps.secretKey;
    const hook = await db.transaction(async (tx) => {
      const [{n} = {n: 0}] = await tx
        .select({n: count()})
        .from(webhooks)
        .where(and(eq(webhooks.agentId, actor.agent.id), isNull(webhooks.deletedAt)));
      if (Number(n) >= MAX_HOOKS_PER_AGENT) {
        throw new PactoraError(ErrorCode.LIMIT_REACHED, `at most ${MAX_HOOKS_PER_AGENT} webhooks per agent`);
      }
      // The row's id is known before the insert, so the secret is sealed to it.
      const publicId = crypto.randomUUID();
      const [row] = await tx
        .insert(webhooks)
        .values({
          publicId,
          agentId: actor.agent.id,
          url: body.url,
          kinds: [...new Set(body.kinds)],
          secretEnc: seal(key, secret, secretAad(publicId)),
        })
        .returning();
      return row!;
    });
    return reply.status(201).send({
      ...hookView(hook),
      secret,
      note: 'The secret is shown only now. Verify Pactora-Signature with it (docs/15).',
    });
  });

  app.get('/v1/webhooks', async (request) => {
    const actor = await actorOf(db, request);
    const rows = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.agentId, actor.agent.id), isNull(webhooks.deletedAt)))
      .orderBy(desc(webhooks.id));
    return {webhooks: rows.map(hookView)};
  });

  app.delete('/v1/webhooks/:id', async (request) => {
    const actor = await actorOf(db, request);
    const hook = await ownHook(actor.agent.id, (request.params as {id: string}).id);
    await db.transaction(async (tx) => {
      await tx.update(webhooks).set({deletedAt: new Date(), active: false}).where(eq(webhooks.id, hook.id));
      // Nothing more goes out for it.
      await tx
        .update(webhookDeliveries)
        .set({status: 'failed', lastError: 'webhook deleted'})
        .where(and(eq(webhookDeliveries.webhookId, hook.id), eq(webhookDeliveries.status, 'pending')));
    });
    return {webhookId: hook.publicId, deleted: true};
  });

  /** A new signing secret, shown once; the old one stops signing at once (the notifier reads the row per delivery). */
  app.post('/v1/webhooks/:id/rotate', async (request) => {
    const actor = await actorOf(db, request);
    // Whose hook first: another tenant's is hidden (404) whatever the server's configuration.
    const hook = await ownHook(actor.agent.id, (request.params as {id: string}).id);
    if (!deps.secretKey) {
      throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'webhooks are not configured on this server');
    }
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    await db
      .update(webhooks)
      .set({secretEnc: seal(deps.secretKey, secret, secretAad(hook.publicId))})
      .where(eq(webhooks.id, hook.id));
    return {
      ...hookView(hook),
      secret,
      note: 'The new secret is shown only now; deliveries from here on are signed with it.',
    };
  });

  app.get('/v1/webhooks/:id/deliveries', async (request) => {
    const actor = await actorOf(db, request);
    const hook = await ownHook(actor.agent.id, (request.params as {id: string}).id);
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, hook.id))
      .orderBy(desc(webhookDeliveries.id))
      .limit(50);
    return {
      webhookId: hook.publicId,
      deliveries: rows.map((d) => ({
        deliveryId: d.publicId,
        seq: d.seq,
        status: d.status,
        attempts: d.attempts,
        lastStatus: d.lastStatus,
        lastError: d.lastError,
        nextAttemptAt: d.status === 'pending' ? d.nextAttemptAt : null,
        deliveredAt: d.deliveredAt,
      })),
    };
  });
}
