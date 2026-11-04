import type {FastifyInstance} from 'fastify';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import {agents, spendPolicies, type Db} from '@pactora/db';
import type {ChainConfig} from '@pactora/config';
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
 * `chain/config/params.<chainId>.json`, which the drift checker keeps equal to
 * the contracts. Those added in v3 are optional so a client also copes with
 * an older API that does not send them.
 */
export const NetworkResponse = z.object({
  chainId: z.number().int(),
  name: z.string(),
  shortName: z.string(),
  testnet: z.boolean().describe('Whether the money is play money'),
  nativeCurrency: z.object({name: z.string(), symbol: z.string(), decimals: z.number().int()}),
  paymentToken: z.object({symbol: z.string(), decimals: z.number().int(), address: z.string().nullable()}),
  contracts: z.record(z.string(), z.string()),
  erc8004: z
    .object({referenceImplementation: z.boolean()})
    .catchall(z.union([z.string(), z.boolean()]))
    .describe('Registry addresses by name, and which registry ABI the chain has'),
  rpcUrls: z.array(z.string()).describe('The public endpoints, never an RPC_URL_<chainId> override'),
  explorerBaseUrl: z.string().nullable(),
  faucetUrls: z.array(z.string()),
  confirmations: z.number().int(),
  windows: z
    .object({
      accept: z.number().int(),
      work: z.number().int(),
      review: z.number().int(),
      dispute: z.number().int(),
    })
    .describe('Seconds'),
  minJobAmount: BaseUnits.describe('The smallest job the escrow accepts'),
  minFee: BaseUnits.describe('The least any job pays in protocol fees'),
  fastPathMax: BaseUnits,
  fastPathMaxDisplay: z.string(),
  protocolFeeBps: Bps,
  bondBps: Bps.optional().describe("The worker's per-job bond, as a share of the job"),
  minBond: BaseUnits.optional().describe("The floor on the worker's bond"),
  disputeBondBps: Bps.optional().describe('What disputing costs the client, as a share of the job'),
  minDisputeBond: BaseUnits.optional().describe('The floor on the dispute bond'),
  maxJobAmount: BaseUnits.optional().describe('The largest escrow job'),
  defaultPerTaskCap: BaseUnits.optional().describe("A new agent's per-hire cap, until its owner sets one"),
  defaultDailyCap: BaseUnits.optional().describe("A new agent's rolling 24 h cap, until its owner sets one"),
  minStake: BaseUnits.optional().describe('The smallest stake the registry accepts'),
  withdrawDelaySeconds: z.number().int().optional().describe('How long a stake withdrawal waits, in seconds'),
  enabledChains: z.array(z.number().int()),
});
export type NetworkResponse = z.infer<typeof NetworkResponse>;

export interface MetaRouteDeps {
  db: Db;
  chains: Record<number, ChainConfig>;
  defaultChainId: number;
  readBudget?: BudgetReader;
}

export async function registerMetaRoutes(app: FastifyInstance, deps: MetaRouteDeps): Promise<void> {
  const {db, chains, defaultChainId, readBudget} = deps;
  const enabled = Object.keys(chains).map(Number);

  /** Public: a client should be able to check the network before holding a key. */
  app.get('/v1/network', async (request): Promise<NetworkResponse> => {
    const asked = (request.query as {chainId?: string}).chainId;
    const chainId = asked === undefined ? defaultChainId : Number(asked);
    const chain = chains[chainId] ?? chains[defaultChainId]!;

    return {
      chainId: chain.chainId,
      name: chain.name,
      shortName: chain.network.shortName,
      /** The field that matters most to an agent about to spend. */
      testnet: chain.testnet,
      nativeCurrency: chain.network.nativeCurrency,
      paymentToken: {
        symbol: chain.network.paymentToken.symbol,
        decimals: chain.network.paymentToken.decimals,
        address: chain.network.paymentToken.address,
      },
      contracts: chain.contracts,
      erc8004: {
        ...chain.erc8004,
        /**
         * Which registry ABI this chain has.
         *
         * The reference implementation takes `register(uri, wallet)`; the
         * canonical registry takes `register(uri)` and resolves the payout
         * wallet separately. A client that guesses wrong sends a transaction
         * that reverts, and on mainnet it pays for the privilege — so the
         * network states it rather than leaving it to be inferred from a
         * chain id.
         */
        referenceImplementation: chain.network.erc8004.deployWithProtocol,
      },
      /**
       * The PUBLIC endpoints from networks.json — deliberately not
       * `chain.rpcUrl`, which `RPC_URL_<chainId>` may have replaced with a
       * keyed private endpoint. Publishing the resolved value would hand that
       * key to every browser that loads the page.
       *
       * A browser needs these to add the chain to a wallet: Monad is in no
       * wallet's default list.
       */
      rpcUrls: chain.network.rpcUrls,
      explorerBaseUrl: chain.network.blockExplorerUrls[0] ?? null,
      faucetUrls: chain.network.faucetUrls,
      confirmations: chain.confirmations,
      /** Windows an agent must plan against, in seconds. */
      windows: {
        accept: Number(chain.params.acceptWindowSeconds),
        work: Number(chain.params.workWindowSeconds),
        review: Number(chain.params.reviewWindowSeconds),
        /** After this, anyone may settle a disputed job for the worker. */
        dispute: Number(chain.params.disputeTimeoutSeconds),
      },
      /** The smallest job the escrow accepts, and the least any job pays in fees. */
      minJobAmount: String(chain.params.minJobAmount),
      minFee: String(chain.params.minFee),
      fastPathMax: String(chain.params.fastPathMax),
      fastPathMaxDisplay: chain.formatToken(chain.params.fastPathMax as bigint),
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
