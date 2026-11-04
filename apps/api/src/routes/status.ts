import type {FastifyInstance} from 'fastify';
import {desc, eq, ne} from 'drizzle-orm';
import {indexerCursor, runs, type Db} from '@pactora/db';
import type {ChainConfig} from '@pactora/config';
import {withTimeout, type BuildInfo} from '@pactora/service';

/**
 * `GET /v1/status` — is Pactora working, in terms a public status page can show.
 *
 * `/health` says the process is up and `/ready` whether a load balancer should
 * send it traffic; neither says whether the marketplace is actually current.
 * The indexer is what turns on-chain settlements into what the site shows, and
 * an indexer that is up but hours behind looked identical to a healthy one.
 *
 * Everything here is PUBLIC, so it is states and numbers only: never an error
 * message (a driver error names the host it could not reach; an RPC error can
 * carry a keyed URL), never a hostname, URL or key. The reason a check failed
 * goes to the log, where the operator is.
 *
 * It is also cheap by construction: one result is cached for `cacheMs` and
 * shared by every concurrent caller, so a burst of page loads is one database
 * query and one RPC call per chain, and each check is bounded by `timeoutMs`,
 * so a hanging RPC makes the answer "rpc: down", not a hanging request.
 */

export type ComponentStatus = 'up' | 'degraded' | 'down' | 'unknown';

export interface StatusDeps {
  /** Resolves when the signer answers its /health. Omitted: 'unknown'. */
  signer?: () => Promise<unknown>;
  /** The chain head, per chain. Omitted: 'unknown'. */
  headBlock?: (chainId: number) => Promise<bigint>;
  /** Blocks the indexer may trail the head before it is 'degraded'. Default 150. */
  maxIndexerLagBlocks?: number;
  /**
   * Seconds without progress, while there ARE blocks to index, before the
   * indexer is 'down' (stopped) rather than 'degraded' (catching up). Default
   * 120: past the indexer's own worst-case RPC backoff (60 s) plus polls.
   */
  maxIndexerSilenceSeconds?: number;
  /** How long one result is reused. Default 5000 ms; 0 disables. */
  cacheMs?: number;
  /** Per-check bound. Default 2000 ms. */
  timeoutMs?: number;
}

interface ChainStatus {
  chainId: number;
  name: string;
  testnet: boolean;
  rpc: ComponentStatus;
  headBlock: number | null;
  indexer: {
    status: ComponentStatus;
    indexedBlock: number | null;
    lagBlocks: number | null;
    lastIndexedAt: string | null;
    secondsSinceIndexed: number | null;
  };
}

export interface StatusReport {
  status: 'operational' | 'degraded' | 'down';
  checkedAt: string;
  build: BuildInfo | null;
  components: {
    api: ComponentStatus;
    database: ComponentStatus;
    signer: ComponentStatus;
    rpc: ComponentStatus;
    indexer: ComponentStatus;
  };
  chains: ChainStatus[];
  /**
   * The AI model the hosted runs think with — reported apart from the
   * components, because a model out of its free daily quota is not the
   * protocol being down. Read from real run outcomes, never by calling the
   * model, which would spend the quota it reports on.
   */
  model: ModelStatus;
  /**
   * Gas in the wallets the signer sends from (v3), from the signer's own
   * background reading. Reported beside the components, like the model: a
   * signer that reports nothing is `unknown`, not a fault; a low wallet
   * degrades the status, because the next transaction from it will fail.
   */
  gas: GasStatus;
}

export interface GasStatus {
  state: 'ok' | 'low' | 'unknown';
  checkedAt: string | null;
  wallets: {address: string; role: string; balanceWei: string; low: boolean}[];
}

/** The `wallets` block of the signer's /health, if it sent one. */
function gasOf(signerHealth: unknown): GasStatus {
  const w = (signerHealth as {wallets?: unknown} | undefined)?.wallets as
    {checkedAt?: unknown; anyLow?: unknown; wallets?: unknown} | undefined;
  if (!w || typeof w.checkedAt !== 'string' || !Array.isArray(w.wallets)) {
    return {state: 'unknown', checkedAt: null, wallets: []};
  }
  const wallets = (w.wallets as Record<string, unknown>[]).map((x) => ({
    address: String(x['address']),
    role: String(x['role']),
    balanceWei: String(x['balanceWei']),
    low: x['low'] === true,
  }));
  return {state: wallets.some((x) => x.low) ? 'low' : 'ok', checkedAt: w.checkedAt, wallets};
}

export interface ModelStatus {
  state: 'ok' | 'limited' | 'unknown';
  /** When the latest model failure ended its run. */
  since: string | null;
  /** That failure, in one sentence. */
  detail: string | null;
  /** The newest run that delivered — the proof that the rest works. */
  lastDelivered: {runId: string; at: string} | null;
}

/** How a model failure reads in a run's error or steps (older wording included). */
const MODEL_FAILURE = /AI model unavailable[^."\]\n]*|could not reach its model/;
/** Free quotas reset daily; an older failure says nothing about now. */
const MODEL_LIMIT_MEMORY_MS = 12 * 3600 * 1000;

const RANK: Record<ComponentStatus, number> = {up: 0, unknown: 1, degraded: 2, down: 3};
const worst = (all: ComponentStatus[]): ComponentStatus =>
  all.reduce<ComponentStatus>((w, s) => (RANK[s] > RANK[w] ? s : w), 'up');

export function registerStatusRoutes(
  app: FastifyInstance,
  deps: {db: Db; chains: Record<number, ChainConfig>; build?: BuildInfo; status?: StatusDeps},
): void {
  const opts = deps.status ?? {};
  const cacheMs = opts.cacheMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const maxLag = opts.maxIndexerLagBlocks ?? 150;
  const maxSilence = opts.maxIndexerSilenceSeconds ?? 120;

  /** Run one check; log why it failed, report only that it did. */
  const probe = async <T>(
    name: string,
    run: () => Promise<T>,
  ): Promise<{ok: true; value: T} | {ok: false}> => {
    try {
      return {
        ok: true,
        value: await withTimeout(run(), timeoutMs, `${name} did not answer within ${timeoutMs} ms`),
      };
    } catch (err) {
      app.log.warn({err, check: name}, 'status check failed');
      return {ok: false};
    }
  };

  async function compute(): Promise<StatusReport> {
    const chainIds = Object.keys(deps.chains).map(Number);

    const [cursors, signer, heads, model] = await Promise.all([
      probe('database', () =>
        deps.db.select().from(indexerCursor).where(eq(indexerCursor.contract, 'TaskEscrow')),
      ),
      opts.signer ? probe('signer', opts.signer) : Promise.resolve(null),
      Promise.all(
        chainIds.map((id) =>
          opts.headBlock ? probe(`rpc-${id}`, () => opts.headBlock!(id)) : Promise.resolve(null),
        ),
      ),
      probe('model', () => modelStatus(deps.db)),
    ]);

    const now = Date.now();
    const chains: ChainStatus[] = chainIds.map((chainId, i) => {
      const chain = deps.chains[chainId]!;
      const head = heads[i] ?? null;
      const headBlock = head?.ok ? Number(head.value) : null;
      const rpc: ComponentStatus = head === null ? 'unknown' : head.ok ? 'up' : 'down';

      const cursor = cursors.ok ? cursors.value.find((c) => Number(c.chainId) === chainId) : undefined;
      const indexedBlock = cursor ? Number(cursor.lastBlock) : null;
      const lagBlocks =
        indexedBlock !== null && headBlock !== null ? Math.max(0, headBlock - indexedBlock) : null;
      const updated = cursor ? new Date(cursor.updatedAt) : null;
      const silentFor = updated ? Math.max(0, Math.round((now - updated.getTime()) / 1000)) : null;

      // Behind AND not moving is stopped; behind and moving is catching up. A
      // caught-up indexer on a quiet chain has nothing to write, so silence
      // alone is not a fault.
      const stalled =
        lagBlocks !== null && lagBlocks > chain.confirmations && silentFor !== null && silentFor > maxSilence;
      const indexer: ComponentStatus =
        lagBlocks === null
          ? 'unknown'
          : stalled
            ? 'down'
            : lagBlocks > maxLag + chain.confirmations
              ? 'degraded'
              : 'up';

      return {
        chainId,
        name: chain.name,
        testnet: chain.testnet,
        rpc,
        headBlock,
        indexer: {
          status: indexer,
          indexedBlock,
          lagBlocks,
          lastIndexedAt: updated ? updated.toISOString() : null,
          secondsSinceIndexed: silentFor,
        },
      };
    });

    const database: ComponentStatus = cursors.ok ? 'up' : 'down';
    const components = {
      api: 'up' as const,
      database,
      signer: (signer === null ? 'unknown' : signer.ok ? 'up' : 'down') as ComponentStatus,
      rpc: worst(chains.map((c) => c.rpc)),
      indexer: worst(chains.map((c) => c.indexer.status)),
    };

    const gas = gasOf(signer?.ok ? signer.value : undefined);

    // Without the database the API can serve nothing; anything else short of
    // 'up' — including a component nobody can vouch for — is degraded, and so
    // is a wallet about to run out of gas.
    const status =
      database === 'down'
        ? ('down' as const)
        : Object.values(components).every((s) => s === 'up') && gas.state !== 'low'
          ? ('operational' as const)
          : ('degraded' as const);

    return {
      status,
      checkedAt: new Date(now).toISOString(),
      build: deps.build ?? null,
      components,
      chains,
      model: model.ok ? model.value : {state: 'unknown', since: null, detail: null, lastDelivered: null},
      gas,
    };
  }

  let cached: {at: number; report: Promise<StatusReport>} | null = null;

  app.get('/v1/status', async (_request, reply) => {
    const now = Date.now();
    if (!cached || cacheMs <= 0 || now - cached.at >= cacheMs) {
      cached = {at: now, report: compute()};
    }
    reply.header('cache-control', `public, max-age=${Math.floor(cacheMs / 1000)}`);
    return cached.report;
  });
}

async function modelStatus(db: Db): Promise<ModelStatus> {
  const [latest] = await db
    .select({state: runs.state, error: runs.error, steps: runs.steps, finishedAt: runs.finishedAt})
    .from(runs)
    .where(ne(runs.state, 'running'))
    .orderBy(desc(runs.finishedAt))
    .limit(1);
  const [delivered] = await db
    .select({publicId: runs.publicId, finishedAt: runs.finishedAt})
    .from(runs)
    .where(eq(runs.state, 'done'))
    .orderBy(desc(runs.finishedAt))
    .limit(1);
  const lastDelivered = delivered?.finishedAt
    ? {runId: delivered.publicId, at: new Date(delivered.finishedAt).toISOString()}
    : null;

  if (!latest?.finishedAt) return {state: 'unknown', since: null, detail: null, lastDelivered};
  const finished = new Date(latest.finishedAt);
  const failure =
    latest.state === 'failed'
      ? ((latest.error ?? '').match(MODEL_FAILURE)?.[0] ??
        JSON.stringify(latest.steps ?? []).match(MODEL_FAILURE)?.[0])
      : undefined;
  if (failure) {
    if (Date.now() - finished.getTime() > MODEL_LIMIT_MEMORY_MS) {
      return {state: 'unknown', since: null, detail: null, lastDelivered};
    }
    return {state: 'limited', since: finished.toISOString(), detail: failure.trim(), lastDelivered};
  }
  return {state: 'ok', since: null, detail: null, lastDelivered};
}
