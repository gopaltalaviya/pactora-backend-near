import Fastify from 'fastify';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {loadConfig} from '@pactora/config';
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
import {ChainLinkError, Indexer, StartBlockPrunedError} from './indexer.js';
import {runIndexerLoop} from './loop.js';
import {openSource} from './source.js';

/**
 * One indexer worker per enabled chain, all in one process.
 *
 * Running testnet and mainnet together is a config value, not a second
 * deployment — `ENABLED_CHAINS=near:testnet,near:mainnet` and both are watched.
 * Each reads final blocks from the network's `blockSource`: neardata on
 * testnet and mainnet, RPC polling on the local sandbox (docs/NEAR-PORT.md §3).
 */
const Env = z.object({
  DATABASE_URL: env.postgresUrl(),
  INDEXER_POLL_MS: env.positiveInt(2_000),
  INDEXER_MAX_BACKOFF_MS: env.positiveInt(60_000),
  /**
   * A FIRST start begins at the newest final block instead of the deployment
   * block. For a new deployment whose database holds none of that history
   * anyway. An existing cursor is never moved.
   */
  INDEXER_START_AT_HEAD: env.flag(),
  /** Optional: serve /health, /ready and /metrics. A worker has no other face. */
  INDEXER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  METRICS_TOKEN: z.string().optional(),
  LOG_LEVEL: env.logLevel(),
  DB_POOL_MAX: env.positiveInt(3),
  /** FastNear key for neardata (testnet, mainnet). Without it the free limit cannot keep pace with testnet. */
  NEARDATA_API_KEY: z.string().min(1).optional(),
});

const cfg = loadEnv(Env);
const logger = serviceLogger('indexer', cfg.LOG_LEVEL);

const config = loadConfig();
const db = createDb(cfg.DATABASE_URL, {max: cfg.DB_POOL_MAX});

const metrics = createMetrics('indexer');
const ticks = metrics.counter('indexer_ticks_total', 'Indexer ticks, by chain and outcome', [
  'chain',
  'outcome',
]);
const lastOk = metrics.gauge('indexer_last_success_seconds', 'Unix time of the last successful tick', [
  'chain',
]);
const headBlock = metrics.gauge('indexer_head_block', 'The chain head the last tick read', ['chain']);
const indexedBlock = metrics.gauge('indexer_indexed_block', 'The block the indexer has indexed up to', [
  'chain',
]);
const lagBlocks = metrics.gauge('indexer_lag_blocks', 'Blocks between the chain head and the indexed block', [
  'chain',
]);
const lastSuccess = new Map<string, number>();
/** Per chain: a stall only the operator can fix, until a good tick clears it. */
const stalled = new Map<string, {state: string; fix: string}>();
const build = buildInfo({service: 'indexer', packageJsonUrl: new URL('../package.json', import.meta.url)});

const health = cfg.INDEXER_HEALTH_PORT ? Fastify({...serviceOptions(), logger: false}) : null;

const shutdown = installShutdown({
  logger,
  closers: [
    // The loops watch the shutdown signal and return after their current tick.
    ['workers', () => workersDone],
    ['health', async () => health?.close()],
    ['database', () => closeDb(db)],
  ],
});

const workersDone = Promise.all(
  Object.values(config.chains).map(async (chain) => {
    const source = await openSource(
      chain,
      cfg.NEARDATA_API_KEY ? {neardataApiKey: cfg.NEARDATA_API_KEY} : {},
    );
    const indexer = new Indexer({db, chain, source, logger});
    if (cfg.INDEXER_START_AT_HEAD) {
      const at = await indexer.seedCursorToHead();
      logger.info({chainId: chain.chainId, seededAt: at ?? 'existing cursor kept'}, 'start at head');
    }
    logger.info({chainId: chain.chainId, name: chain.name, startBlock: chain.startBlock}, 'indexer started');

    return runIndexerLoop(
      async () => {
        await indexer.tick();
        const {headBlock: head, indexedBlock: indexed} = indexer.progress();
        const label = String(chain.chainId);
        if (head !== null) headBlock.labels(label).set(head);
        if (indexed !== null) indexedBlock.labels(label).set(indexed);
        if (head !== null && indexed !== null) lagBlocks.labels(label).set(head - indexed);
        const now = Date.now();
        if (stalled.delete(chain.chainId)) logger.info({chainId: chain.chainId}, 'indexer no longer stalled');
        lastSuccess.set(chain.chainId, now);
        lastOk.labels(String(chain.chainId)).set(Math.floor(now / 1000));
        ticks.labels(String(chain.chainId), 'ok').inc();
      },
      {
        pollMs: cfg.INDEXER_POLL_MS,
        maxBackoffMs: cfg.INDEXER_MAX_BACKOFF_MS,
        signal: shutdown.signal,
        onError: (err, failures, nextDelayMs) => {
          ticks.labels(String(chain.chainId), 'failed').inc();
          if (err instanceof StartBlockPrunedError) {
            // One clear error naming the fix; then quiet, at the longest backoff.
            if (!stalled.has(chain.chainId)) {
              logger.error(
                {
                  chainId: chain.chainId,
                  startBlock: err.startBlock,
                  earliest: err.earliest,
                  fix: err.fix,
                  retryingInMs: nextDelayMs,
                },
                `indexer ${err.state}: ${err.message}`,
              );
            }
            stalled.set(chain.chainId, {state: err.state, fix: err.fix});
            return;
          }
          // Escalate with persistence. One failed tick is noise on any public
          // RPC; twenty in a row is an outage someone needs to see.
          const line = {
            chainId: chain.chainId,
            err: (err as Error).message,
            failures,
            retryingInMs: nextDelayMs,
          };
          // A broken block chain is not an outage that passes: it never
          // indexes past it, so it is an error from the first time.
          if (err instanceof ChainLinkError)
            logger.error(line, 'indexer halted: block does not follow the cursor');
          else if (failures >= 5) logger.error(line, 'indexer is failing');
          else logger.warn(line, 'tick failed, retrying');
        },
        onRecovered: (afterFailures) =>
          logger.info({chainId: chain.chainId, afterFailures}, 'indexer recovered'),
      },
    );
  }),
);

if (health) {
  // Ready = the database answers AND every chain indexed successfully within
  // the backoff ceiling. Behind that, the indexer is failing, not waiting.
  registerHealth(health, {
    info: () => ({
      build,
      // Per chain: `indexing`, or the stall and its fix.
      indexer: Object.fromEntries(
        Object.values(config.chains).map((c) => [
          c.chainId,
          stalled.get(c.chainId) ?? {state: 'indexing', fix: null},
        ]),
      ),
    }),
    checks: {
      database: () => db.execute(sql`SELECT 1`),
      ...Object.fromEntries(
        Object.values(config.chains).map((chain) => [
          `chain-${chain.chainId}`,
          async () => {
            const stall = stalled.get(chain.chainId);
            if (stall) throw new Error(`${stall.state}: ${stall.fix}`);
            const at = lastSuccess.get(chain.chainId);
            const limit = cfg.INDEXER_MAX_BACKOFF_MS + cfg.INDEXER_POLL_MS * 5;
            if (!at || Date.now() - at > limit) {
              throw new Error(
                at
                  ? `no successful tick for ${Math.round((Date.now() - at) / 1000)} s`
                  : 'no successful tick yet',
              );
            }
          },
        ]),
      ),
    },
  });
  registerMetrics(health, metrics, cfg.METRICS_TOKEN ? {token: cfg.METRICS_TOKEN} : {});
  await health.listen({port: cfg.INDEXER_HEALTH_PORT!, host: '0.0.0.0'});
  logger.info({port: cfg.INDEXER_HEALTH_PORT}, 'indexer health endpoint listening');
}

await workersDone;
logger.info('indexer stopped');
