import Fastify from 'fastify';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {closeDb, createDb} from '@pactora/db';
import {
  buildInfo,
  createMetrics,
  env,
  installShutdown,
  loadEnv,
  parseSecretKey,
  registerHealth,
  registerMetrics,
  serviceLogger,
  serviceOptions,
} from '@pactora/service';
import {Notifier} from './notifier.js';

/** The webhook sender (docs/26 F9). One or more may run; deliveries are claimed with SKIP LOCKED. */
const Env = z
  .object({
    NODE_ENV: env.nodeEnv(),
    DATABASE_URL: env.postgresUrl(),
    /** The same key the API seals hook secrets with. Required: a notifier without it cannot sign. */
    WEBHOOK_SECRET_KEY: z.string().refine((v) => {
      try {
        parseSecretKey(v);
        return true;
      } catch {
        return false;
      }
    }, 'WEBHOOK_SECRET_KEY must be 32 random bytes: 64 hex characters or 44 base64 characters'),
    /** Local development only: deliver to http and private addresses. Refused in production. */
    WEBHOOK_ALLOW_PRIVATE: env.flag(),
    NOTIFIER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
    NOTIFIER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(10_000),
    NOTIFIER_IDLE_MS: env.positiveInt(1000),
    NOTIFIER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    METRICS_TOKEN: z.string().optional(),
    LOG_LEVEL: env.logLevel(),
    DB_POOL_MAX: env.positiveInt(3),
  })
  .refine((e) => e.NODE_ENV !== 'production' || !e.WEBHOOK_ALLOW_PRIVATE, {
    message: 'WEBHOOK_ALLOW_PRIVATE is for local development and is refused when NODE_ENV=production',
    path: ['WEBHOOK_ALLOW_PRIVATE'],
  });

const cfg = loadEnv(Env);
const logger = serviceLogger('notifier', cfg.LOG_LEVEL);
const db = createDb(cfg.DATABASE_URL, {max: cfg.DB_POOL_MAX});
const metrics = createMetrics('notifier');
const outcomes = metrics.counter('webhook_deliveries_total', 'Webhook delivery attempts, by outcome', [
  'outcome',
]);

const notifier = new Notifier({
  db,
  secretKey: parseSecretKey(cfg.WEBHOOK_SECRET_KEY),
  ...(cfg.WEBHOOK_ALLOW_PRIVATE ? {policy: {allowHttp: true, allowPrivate: true}} : {}),
  concurrency: cfg.NOTIFIER_CONCURRENCY,
  timeoutMs: cfg.NOTIFIER_TIMEOUT_MS,
  logger,
  onOutcome: (o) => outcomes.labels(o).inc(),
});

const health = cfg.NOTIFIER_HEALTH_PORT ? Fastify({...serviceOptions(), logger: false}) : null;
if (health) {
  registerHealth(health, {
    checks: {database: () => db.execute(sql`SELECT 1`)},
    info: () => ({
      build: buildInfo({service: 'notifier', packageJsonUrl: new URL('../package.json', import.meta.url)}),
    }),
  });
  registerMetrics(health, metrics, cfg.METRICS_TOKEN ? {token: cfg.METRICS_TOKEN} : {});
  await health.listen({port: cfg.NOTIFIER_HEALTH_PORT!, host: '0.0.0.0'});
}

// Fail at start on a database that is not there, not on the first delivery.
await db.execute(sql`SELECT 1 FROM webhook_deliveries LIMIT 1`);
const stop = notifier.start(cfg.NOTIFIER_IDLE_MS);
logger.info(
  {concurrency: cfg.NOTIFIER_CONCURRENCY, allowPrivate: cfg.WEBHOOK_ALLOW_PRIVATE},
  'notifier started',
);

installShutdown({
  logger,
  closers: [
    ['notifier', stop],
    ['health', async () => health?.close()],
    ['database', () => closeDb(db)],
  ],
});
