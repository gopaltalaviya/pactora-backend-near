import type {FastifyInstance} from 'fastify';
import {eq, sql} from 'drizzle-orm';
import {z} from 'zod';
import {agents, spendPolicies, type Db} from '@pactora/db';
import type {ChainConfig} from '@pactora/config';
import {ErrorCode, PactoraError} from '@pactora/shared';
import {authenticate, resolveChainId} from '../auth.js';
import type {BudgetReader} from '../chain-reads.js';

/**
 * The two endpoints an autonomous agent needs before it spends anything:
 * what network am I on, and what am I allowed to spend.
 *
 * Both exist because of the same failure. Without `/v1/budget` an agent
 * discovers its cap by hitting 402s, and an agent that retries on 402 is a
 * retry storm. Without `/v1/network` an agent cannot tell testnet play money
 * from real money — which is not a distinction to leave implicit in a system
 * that hands models a wallet.
 */

const BaseUnits = z.string().regex(/^\d+$/).describe('Base units of the payment token, as a decimal string');
const Bps = z.number().int().min(0).max(10_000).describe('Basis points: 100 = 1%');

/**
 * The `GET /v1/network` response. The only response whose shape the OpenAPI
 * document states exactly: it is what a client reads before it spends, and a
 * test holds the live response to it. The fee and limit fields come from
 * `chain/config/params.<slug>.json`, whose `onchain` half is what the
 * contract was deployed with. Shape: docs/NEAR-PORT.md §4.
 */
export const NetworkResponse = z.object({
  chainId: z.string().describe('CAIP-2 chain id, e.g. near:testnet'),
  nearNetworkId: z.string().describe('What the RPC `status` reports as chain_id'),
  name: z.string(),
  shortName: z.string(),
  testnet: z.boolean().describe('Whether the money is play money'),
  nativeCurrency: z.object({name: z.string(), symbol: z.string(), decimals: z.number().int()}),
  paymentToken: z.object({symbol: z.string(), decimals: z.number().int(), accountId: z.string().nullable()}),
  contracts: z.record(z.string(), z.string()).describe('Pactora, PaymentToken and Arbiter account ids'),
  rpcUrls: z.array(z.string()).describe('The public endpoints, never an RPC_URL_<SLUG> override'),
  explorerBaseUrl: z.string().nullable(),
  faucetUrls: z.array(z.string()),
  windows: z
    .object({
      accept: z.number().int(),
      work: z.number().int(),
      review: z.number().int(),
      dispute: z.number().int(),
      disputeGrace: z
        .number()
        .int()
        .describe(
          'After the dispute window, how long the arbiter may still rule before anyone may expire the dispute',
        ),
    })
    .describe('Seconds'),
  minJobAmount: BaseUnits.describe('The smallest job the escrow accepts'),
  minFee: BaseUnits.describe('The least any job pays in protocol fees'),
  fastPathMax: BaseUnits,
  fastPathMaxDisplay: z.string(),
  protocolFeeBps: Bps,
  bondBps: Bps.describe("The worker's per-job bond, as a share of the job"),
  minBond: BaseUnits.describe("The floor on the worker's bond"),
  disputeBondBps: Bps.describe('What disputing costs the client, as a share of the job'),
  minDisputeBond: BaseUnits.describe('The floor on the dispute bond'),
  maxJobAmount: BaseUnits.describe('The largest escrow job'),
  defaultPerTaskCap: BaseUnits.describe("A new agent's per-hire cap, until its owner sets one"),
  defaultDailyCap: BaseUnits.describe("A new agent's rolling 24 h cap, until its owner sets one"),
  minStake: BaseUnits.describe('The smallest stake that makes an agent hireable'),
  withdrawDelaySeconds: z.number().int().describe('How long a stake withdrawal waits, in seconds'),
  enabledChains: z.array(z.string()),
  agentMode: z
    .enum(['cached', 'live', 'record'])
    .describe(
      "AGENT_MODE: 'cached' replays recorded model answers (no tokens spent), 'live' calls the model, 'record' calls the model and saves its answers (tokens spent)",
    ),
});
export type NetworkResponse = z.infer<typeof NetworkResponse>;

/**
 * AGENT_MODE as the agents read it (agent-core's factory): unset or `cached`
 * replays, `record` calls the providers and saves, anything else calls them.
 */
export function agentModeOf(env: Record<string, string | undefined>): 'cached' | 'live' | 'record' {
  const mode = env['AGENT_MODE'] ?? 'cached';
  if (mode === 'cached') return 'cached';
  return mode === 'record' ? 'record' : 'live';
}

export interface MetaRouteDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  defaultChainId: string;
  readBudget?: BudgetReader;
}

export async function registerMetaRoutes(app: FastifyInstance, deps: MetaRouteDeps): Promise<void> {
  const {db, chains, defaultChainId, readBudget} = deps;
  const enabled = Object.keys(chains);

  /** Public: a client should be able to check the network before holding a key. */
  app.get('/v1/network', async (request): Promise<NetworkResponse> => {
    const asked = (request.query as {chainId?: string}).chainId;
    const chain = (asked !== undefined ? chains[asked] : undefined) ?? chains[defaultChainId]!;

    return {
      chainId: chain.chainId,
      nearNetworkId: chain.nearNetworkId,
      name: chain.name,
      shortName: chain.network.shortName,
      /** The field that matters most to an agent about to spend. */
      testnet: chain.testnet,
      nativeCurrency: chain.network.nativeCurrency,
      paymentToken: {
        symbol: chain.network.paymentToken.symbol,
        decimals: chain.network.paymentToken.decimals,
        accountId: chain.network.paymentToken.accountId,
      },
      contracts: {...chain.contracts},
      /**
       * The PUBLIC endpoints from networks.json — deliberately not
       * `chain.rpcUrl`, which `RPC_URL_<SLUG>` may have replaced with a keyed
       * private endpoint. Publishing the resolved value would hand that key
       * to every browser that loads the page.
       */
      rpcUrls: chain.network.rpcUrls,
      explorerBaseUrl: chain.network.blockExplorerUrls[0] ?? null,
      faucetUrls: chain.network.faucetUrls,
      /** Windows an agent must plan against, in seconds. */
      windows: {
        accept: Number(chain.params.acceptWindowSeconds),
        work: Number(chain.params.workWindowSeconds),
        review: Number(chain.params.reviewWindowSeconds),
        /** The arbiter's window to rule. */
        dispute: Number(chain.params.disputeTimeoutSeconds),
        /** Contract 1.1.0: after `dispute`, the arbiter may still rule for this long; only then may anyone expire the dispute. */
        disputeGrace: Number(chain.params.disputeGraceSeconds),
      },
      /** The smallest job the escrow accepts, and the least any job pays in fees. */
      minJobAmount: String(chain.params.minJobAmount),
      minFee: String(chain.params.minFee),
      fastPathMax: String(chain.params.fastPathMax),
      fastPathMaxDisplay: chain.formatToken(chain.params.fastPathMax),
      protocolFeeBps: Number(chain.params.protocolFeeBps),
      /** The worker's bond: a share of the job, with a floor. */
      bondBps: Number(chain.params.bondBps),
      minBond: String(chain.params.minBond),
      /** What a dispute costs the client: a share of the job, with a floor. */
      disputeBondBps: Number(chain.params.disputeBondBps),
      minDisputeBond: String(chain.params.minDisputeBond),
      maxJobAmount: String(chain.params.maxJobAmount),
      /** What a newly registered agent may spend before its owner sets caps. */
      defaultPerTaskCap: String(chain.params.defaultPerTaskCap),
      defaultDailyCap: String(chain.params.defaultDailyCap),
      minStake: String(chain.params.minStake),
      withdrawDelaySeconds: Number(chain.params.withdrawDelaySeconds),
      enabledChains: enabled,
      agentMode: agentModeOf(process.env),
    };
  });

  /**
   * What the caller may still spend.
   *
   * The chain is the authority — `AgentAccount` is what will actually revert —
   * so a live read wins and the cached policy is the fallback. Which one
   * answered is reported in `source`, because "0.20 left" from a stale cache
   * and "0.20 left" from the contract are not the same claim.
   */
  /**
   * Home-page figures (UI audit E): jobs the chain settled, who has a track
   * record — agents and people alike — and what is on offer. Cached 30 s:
   * the page is public and counts are not worth a query per visitor.
   */
  let statsCache: {at: number; chainId: string; body: Record<string, unknown>} | null = null;
  app.get('/v1/stats', async (request) => {
    const chainId = (request.query as {chainId?: string}).chainId ?? deps.defaultChainId;
    const chain = chains[chainId];
    if (!chain) throw new PactoraError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${chainId} is not enabled`);
    if (statsCache && statsCache.chainId === chainId && Date.now() - statsCache.at < 30_000)
      return statsCache.body;
    const [s] = (await db.execute(sql`
      WITH settled AS (
        SELECT DISTINCT j.id, j.amount, j.client_agent_id, j.worker_agent_id
          FROM jobs j JOIN job_events e ON e.job_id = j.id
         WHERE j.chain_id = ${chainId} AND e.kind IN ('settled', 'direct_paid') AND e.tx_hash IS NOT NULL
      ), parties AS (
        SELECT client_agent_id AS id FROM settled UNION SELECT worker_agent_id FROM settled
      )
      SELECT (SELECT count(*) FROM settled)::int AS jobs,
             (SELECT coalesce(sum(amount), 0)::text FROM settled) AS volume,
             (SELECT count(*) FROM parties p JOIN agents a ON a.id = p.id WHERE a.kind = 'agent')::int AS agents_with,
             (SELECT count(*) FROM parties p JOIN agents a ON a.id = p.id WHERE a.kind = 'person')::int AS people_with,
             (SELECT count(*) FROM agents WHERE chain_id = ${chainId} AND kind = 'agent' AND deleted_at IS NULL)::int AS agents,
             (SELECT count(*) FROM agents WHERE chain_id = ${chainId} AND kind = 'person' AND deleted_at IS NULL)::int AS people,
             (SELECT count(*) FROM listings WHERE chain_id = ${chainId} AND status = 'open' AND deadline > now() AND hidden_at IS NULL)::int AS open_listings
    `)) as unknown as {
      jobs: number;
      volume: string;
      agents_with: number;
      people_with: number;
      agents: number;
      people: number;
      open_listings: number;
    }[];
    const body = {
      chainId,
      jobsSettledOnChain: s!.jobs,
      volumeSettledBaseUnits: s!.volume,
      volumeSettledDisplay: chain.formatToken(BigInt(s!.volume)),
      agentsWithRecord: s!.agents_with,
      peopleWithRecord: s!.people_with,
      participantsWithRecord: s!.agents_with + s!.people_with,
      agents: s!.agents,
      people: s!.people,
      openListings: s!.open_listings,
      updatedAt: new Date().toISOString(),
    };
    statsCache = {at: Date.now(), chainId, body};
    return body;
  });

  app.get('/v1/budget', async (request) => {
    const caller = await authenticate(db, request);
    const chainId = resolveChainId(request, caller, enabled);
    const chain = chains[chainId]!;

    const agent = await db.query.agents.findFirst({where: eq(agents.id, caller.agentId)});
    const cached = await db.query.spendPolicies.findFirst({
      where: eq(spendPolicies.agentId, caller.agentId),
    });

    // A failing RPC must degrade to the cache, never 500. An agent that cannot
    // read its budget falls back to discovering it by being refused, which is
    // the retry storm this endpoint exists to prevent.
    const onChain = agent?.walletAddress
      ? await readBudget?.({chainId, walletAddress: agent.walletAddress}).catch(() => null)
      : null;

    const perTaskCap = onChain?.perTaskCap ?? BigInt(cached?.perTaskCap ?? '0');
    const dailyCap = onChain?.dailyCap ?? BigInt(cached?.dailyCap ?? '0');
    // The window rolls over 24 hours after it opened, as the signer's does.
    // Without this, yesterday's spending was reported as today's.
    const windowOpen = cached ? Date.now() - cached.dayStart.getTime() < DAY_MS : false;
    const spentToday = windowOpen ? BigInt(cached?.spentToday ?? '0') : 0n;
    const dailyRemaining = onChain?.dailyRemaining ?? max0(dailyCap - spentToday);

    return {
      agentId: String(caller.agentId),
      chainId,
      network: chain.name,
      testnet: chain.testnet,
      /** 'chain' is authoritative; 'cache' may be stale. Say which. */
      source: onChain ? ('chain' as const) : ('cache' as const),
      perTaskCap: perTaskCap.toString(),
      perTaskCapDisplay: chain.formatToken(perTaskCap),
      dailyCap: dailyCap.toString(),
      dailyCapDisplay: chain.formatToken(dailyCap),
      dailyRemaining: dailyRemaining.toString(),
      dailyRemainingDisplay: chain.formatToken(dailyRemaining),
      /**
       * The most a single hire can cost right now: the tighter of the two
       * caps, so an agent can compare it against a price without doing the
       * comparison itself and getting it wrong.
       */
      maxSingleSpend: min(perTaskCap, dailyRemaining).toString(),
      maxSingleSpendDisplay: chain.formatToken(min(perTaskCap, dailyRemaining)),
      allowlistOnly: onChain?.allowlistOnly ?? cached?.allowlistOnly ?? false,
      tokenBalance: onChain ? onChain.tokenBalance.toString() : null,
      tokenSymbol: chain.network.paymentToken.symbol,
      walletAddress: agent?.walletAddress ?? null,
      resetsInSeconds: onChain ? releasesIn(onChain.nextReleaseAt) : resetsIn(cached?.dayStart, spentToday),
    };
  });
}

const max0 = (v: bigint) => (v > 0n ? v : 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Seconds until an `AgentAccount`'s rolling cap next gives capacity back.
 *
 * v3: no 24 hours may exceed the cap, so nothing "resets"; the account says
 * when its oldest counted spend leaves the window. An agent told to wait
 * longer sits idle; told shorter, it is refused again.
 */
function releasesIn(nextReleaseAt: bigint): number {
  if (nextReleaseAt === 0n) return 0;
  return Math.max(0, Number(nextReleaseAt) - Math.floor(Date.now() / 1000));
}

/**
 * Seconds until a plain-EOA agent's off-chain cap refills: the signer's
 * cached 24h window, which still opens at a spend.
 */
function resetsIn(cachedDayStart: Date | undefined, spentToday: bigint): number {
  // The cached row carries a timestamp from the moment the agent registered,
  // so without this an agent that has spent nothing is told to wait a day for
  // a budget it already has in full.
  if (spentToday === 0n) return 0;
  const startMs = cachedDayStart?.getTime() ?? 0;
  if (startMs === 0) return 0;
  return Math.max(0, Math.ceil((startMs + DAY_MS - Date.now()) / 1000));
}

const DAY_MS = 24 * 60 * 60 * 1000;
