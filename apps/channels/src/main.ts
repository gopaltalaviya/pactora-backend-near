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
  registerHealth,
  registerMetrics,
  serviceLogger,
  serviceOptions,
} from '@pactora/service';
import {fanOut, handleUpdate, sendOutbox, sweep, type ChannelProvider} from './channels.js';
import {FakeEmail, TelegramBot} from './telegram.js';

/** Telegram and email (docs/26 F11, F12). One instance polls Telegram; outbox sending may scale out. */
const Env = z
  .object({
    NODE_ENV: env.nodeEnv(),
    DATABASE_URL: env.postgresUrl(),
    /** The bot's token from @BotFather. Unset: no Telegram. */
    TELEGRAM_BOT_TOKEN: z
      .string()
      .regex(/^\d+:[A-Za-z0-9_-]{30,}$/, 'TELEGRAM_BOT_TOKEN is not a bot token')
      .optional(),
    /** Email notifications: `fake` (development: kept in memory) or `none`. No real provider yet. */
    EMAIL_PROVIDER: z.enum(['none', 'fake']).default('none'),
    /** Where links in messages point (the interface). */
    CHANNELS_SITE_URL: env.httpUrl().default('http://localhost:3000'),
    CHANNELS_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    CHANNELS_INTERVAL_MS: env.positiveInt(2000),
    METRICS_TOKEN: z.string().optional(),
    LOG_LEVEL: env.logLevel(),
    DB_POOL_MAX: env.positiveInt(3),
  })
  .refine((e) => e.NODE_ENV !== 'production' || e.EMAIL_PROVIDER !== 'fake', {
    message: 'EMAIL_PROVIDER=fake keeps email in memory and is refused when NODE_ENV=production',
    path: ['EMAIL_PROVIDER'],
  });

const cfg = loadEnv(Env);
const logger = serviceLogger('channels', cfg.LOG_LEVEL);
const db = createDb(cfg.DATABASE_URL, {max: cfg.DB_POOL_MAX});
const metrics = createMetrics('channels');
const outcomes = metrics.counter('channel_messages_total', 'Outbox outcomes', ['outcome']);
const deps = {db, siteUrl: cfg.CHANNELS_SITE_URL.replace(/\/$/, '')};

const bot = cfg.TELEGRAM_BOT_TOKEN ? new TelegramBot(cfg.TELEGRAM_BOT_TOKEN) : null;
const providers: ChannelProvider[] = [
  ...(bot ? [bot] : []),
  ...(cfg.EMAIL_PROVIDER === 'fake' ? [new FakeEmail()] : []),
];
const secrets = cfg.TELEGRAM_BOT_TOKEN ? [cfg.TELEGRAM_BOT_TOKEN] : [];

await db.execute(sql`SELECT 1 FROM channel_outbox LIMIT 1`);
const health = cfg.CHANNELS_HEALTH_PORT ? Fastify({...serviceOptions(), logger: false}) : null;
if (health) {
  registerHealth(health, {
    checks: {database: () => db.execute(sql`SELECT 1`)},
    info: () => ({
      build: buildInfo({service: 'channels', packageJsonUrl: new URL('../package.json', import.meta.url)}),
      telegram: Boolean(bot),
      email: cfg.EMAIL_PROVIDER,
    }),
  });
  registerMetrics(health, metrics, cfg.METRICS_TOKEN ? {token: cfg.METRICS_TOKEN} : {});
  await health.listen({port: cfg.CHANNELS_HEALTH_PORT!, host: '0.0.0.0'});
}

let stopped = false;
let offset = 0;
async function pollTelegram() {
  while (bot && !stopped) {
    try {
      for (const u of await bot.getUpdates(offset)) {
        await handleUpdate(deps, u);
        offset = Math.max(offset, u.updateId + 1);
      }
    } catch (err) {
      logger.warn({err: err instanceof Error ? err.message : String(err)}, 'telegram poll failed');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
const timer = setInterval(() => {
  void (async () => {
    await fanOut(deps);
    const r = await sendOutbox(deps, providers, {secrets});
    for (const [k, v] of Object.entries(r)) if (v) outcomes.labels(k).inc(v);
    await sweep(deps);
  })().catch((err: unknown) =>
    logger.warn({err: err instanceof Error ? err.message : String(err)}, 'channels round failed'),
  );
}, cfg.CHANNELS_INTERVAL_MS);
void pollTelegram();
logger.info({telegram: Boolean(bot), email: cfg.EMAIL_PROVIDER}, 'channels started');

installShutdown({
  logger,
  closers: [
    [
      'loops',
      async () => {
        stopped = true;
        clearInterval(timer);
      },
    ],
    ['health', async () => health?.close()],
    ['database', () => closeDb(db)],
  ],
});
