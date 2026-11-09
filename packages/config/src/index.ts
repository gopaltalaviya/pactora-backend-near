import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {ACCOUNT_ID_RE, ChainId as ChainIdSchema, legacyEnvProblems, type ChainId} from '@pactora/shared';

/**
 * @pactora/config — the ONE import for chain facts, protocol parameters and
 * contract addresses.
 *
 * Assembled from three versioned sources plus env, validated, and frozen:
 *
 *   config/networks.json        what each network is, keyed by CAIP-2 id
 *   config/params.<slug>.json   protocol parameters: `onchain` is what the
 *                               deploy passes to `new` (and `get_params`
 *                               returns); `offchain` is the backend's own
 *   deployments/<slug>.json     generated account ids
 *   env                         secrets and wiring ONLY
 *
 * No chain object is defined anywhere else. No contract account is ever an env
 * var. See docs/NEAR-PORT.md §3.
 */

// ── schemas ──────────────────────────────────────────────────────────────
const AccountId = z.string().regex(ACCOUNT_ID_RE, 'must be a NEAR account id').min(2).max(64);
const Units = z.string().regex(/^\d+$/);

const NetworkSchema = z.object({
  chainId: ChainIdSchema,
  /** Names the params/deployments files (`:` is not allowed in Windows paths). */
  slug: z.string().regex(/^[a-z0-9-]+$/),
  /** What RPC `status.chain_id` must answer; every service checks it at start. */
  nearNetworkId: z.string().min(1),
  name: z.string().min(1),
  shortName: z.string().min(1),
  testnet: z.boolean(),
  nativeCurrency: z.object({name: z.string(), symbol: z.string(), decimals: z.number().int()}),
  rpcUrls: z.array(z.string().url()).min(1),
  /** Where the indexer reads final blocks: neardata (testnet, mainnet) or RPC polling (sandbox). */
  blockSource: z.discriminatedUnion('kind', [
    z.object({kind: z.literal('neardata'), url: z.string().url()}),
    z.object({kind: z.literal('rpc')}),
  ]),
  blockExplorerUrls: z.array(z.string().url()),
  faucetUrls: z.array(z.string().url()).default([]),
  paymentToken: z.object({
    symbol: z.string(),
    decimals: z.literal(6),
    accountId: AccountId.nullable(),
    deployWithProtocol: z.boolean(),
    note: z.string().optional(),
  }),
});

/** The contract's `Params`, exactly as `get_params` returns them (snake_case JSON). */
export const OnchainParamsSchema = z
  .object({
    protocol_fee_bps: z.number().int().min(0).max(1000),
    min_fee: Units,
    min_job_amount: Units,
    max_job_amount: Units,
    fast_path_max: Units,
    review_window: z.number().int().positive(),
    max_accept_window: z.number().int().positive(),
    max_work_window: z.number().int().positive(),
    dispute_timeout: z.number().int().positive(),
    /** 1.1.0: after dispute_deadline, how long the arbiter may still rule before anyone may expire the dispute. */
    dispute_grace: z.number().int().positive(),
    bond_bps: z.number().int().min(0).max(10_000),
    min_bond: Units,
    dispute_bond_bps: z.number().int().min(0).max(10_000),
    min_dispute_bond: Units,
    min_stake: Units,
    withdraw_delay: z.number().int().positive(),
    default_per_task_cap: Units,
    default_daily_cap: Units,
  })
  .strict();

const OffchainParamsSchema = z
  .object({
    /** The windows the backend asks for on each job; the contract caps them at max_*_window. */
    acceptWindowSeconds: z.number().int().positive(),
    workWindowSeconds: z.number().int().positive(),
    fastPathMinScore: z.number().int().min(0).max(100),
    confidenceFloor: z.number().int().positive(),
  })
  .strict();

const ParamsFileSchema = z.object({onchain: OnchainParamsSchema, offchain: OffchainParamsSchema});

const DeploymentSchema = z.object({
  chainId: ChainIdSchema,
  deployedAt: z.string(),
  startBlock: z.number().int().nonnegative(),
  commit: z.string().optional(),
  contracts: z.object({Pactora: AccountId, PaymentToken: AccountId, Arbiter: AccountId}).catchall(AccountId),
  /** sha256 of each deployed wasm, from the CI build that produced it. */
  wasm: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)).optional(),
});

export type Network = z.infer<typeof NetworkSchema>;
export type OnchainParams = z.infer<typeof OnchainParamsSchema>;
export type Deployment = z.infer<typeof DeploymentSchema>;

/** The parameters the backend reads, by the names it has always used. */
export interface Params {
  minStake: bigint;
  fastPathMax: bigint;
  minJobAmount: bigint;
  minFee: bigint;
  maxJobAmount: bigint;
  minBond: bigint;
  minDisputeBond: bigint;
  defaultPerTaskCap: bigint;
  defaultDailyCap: bigint;
  bondBps: number;
  disputeBondBps: number;
  protocolFeeBps: number;
  withdrawDelaySeconds: number;
  reviewWindowSeconds: number;
  disputeTimeoutSeconds: number;
  /** After the dispute deadline, the arbiter may still rule for this long; only then may anyone expire the dispute. */
  disputeGraceSeconds: number;
  maxAcceptWindowSeconds: number;
  maxWorkWindowSeconds: number;
  acceptWindowSeconds: number;
  workWindowSeconds: number;
  fastPathMinScore: number;
  confidenceFloor: number;
}

// ── the resolved shape ───────────────────────────────────────────────────
export interface ChainConfig {
  readonly chainId: ChainId;
  readonly slug: string;
  readonly nearNetworkId: string;
  readonly name: string;
  readonly testnet: boolean;
  readonly rpcUrl: string;
  readonly blockSource: Network['blockSource'];
  readonly network: Network;
  readonly params: Readonly<Params>;
  /** The on-chain half of the params file, as passed to `new` and returned by `get_params`. */
  readonly onchainParams: Readonly<OnchainParams>;
  readonly contracts: Readonly<Deployment['contracts']>;
  readonly startBlock: number;
  explorerTx(hash: string): string;
  explorerAddress(account: string): string;
  formatToken(amount: bigint): string;
  parseToken(human: string): bigint;
}

export interface PactoraConfig {
  readonly defaultChainId: ChainId;
  /** Enabled chains only, keyed by CAIP-2 id. */
  readonly chains: Readonly<Record<string, ChainConfig>>;
  chain(chainId?: string): ChainConfig;
}

// ── loader ───────────────────────────────────────────────────────────────
export interface LoadOptions {
  /** Root of the contracts checkout (or the installed @pactora/contracts). */
  contractsRoot?: string;
  env?: NodeJS.ProcessEnv;
}

class ConfigError extends Error {
  constructor(problems: string[]) {
    super(['', '✗ Pactora config invalid', '', ...problems.map((p) => `  • ${p}`), ''].join('\n'));
    this.name = 'ConfigError';
  }
}

/** The contracts checkout: `PACTORA_CONTRACTS_ROOT`, else the sibling `pactora-contracts-near`. */
export function defaultContractsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env['PACTORA_CONTRACTS_ROOT'] ?? join(process.cwd(), '..', 'pactora-contracts-near');
}

/**
 * Validate everything at startup and report ALL problems at once.
 *
 * A service that boots with broken config and fails on the first user request
 * is strictly worse than one that refuses to boot.
 */
export function loadConfig(opts: LoadOptions = {}): PactoraConfig {
  const env = opts.env ?? process.env;
  // Before anything else: an unsupported variable would otherwise
  // send the loader to the defaults and report a confusing problem there.
  const legacy = legacyEnvProblems(env);
  if (legacy.length > 0) throw new ConfigError(legacy);
  const root = opts.contractsRoot ?? defaultContractsRoot(env);

  const problems: string[] = [];
  const readJson = (rel: string): unknown => {
    const path = join(root, rel);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      problems.push(`${rel}: not valid JSON (${(err as Error).message})`);
      return undefined;
    }
  };

  const rawNetworks = readJson('config/networks.json');
  if (rawNetworks === undefined) {
    throw new ConfigError([
      `config/networks.json not found under ${root}`,
      'set PACTORA_CONTRACTS_ROOT to the pactora-contracts-near checkout (or the backend chain/ copy)',
    ]);
  }

  const enabledRaw = (env['ENABLED_CHAINS'] ?? 'near:testnet')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const enabled: ChainId[] = [];
  for (const id of enabledRaw) {
    const parsed = ChainIdSchema.safeParse(id);
    if (parsed.success) enabled.push(parsed.data);
    else
      problems.push(`ENABLED_CHAINS: "${id}" is not a supported chain (${ChainIdSchema.options.join(', ')})`);
  }
  if (enabledRaw.length === 0) problems.push('ENABLED_CHAINS is empty');

  const defaultRaw = env['DEFAULT_CHAIN'] ?? enabled[0];
  const defaultChainId = enabled.find((c) => c === defaultRaw);
  if (defaultRaw !== undefined && defaultChainId === undefined) {
    problems.push(`DEFAULT_CHAIN=${defaultRaw} is not in ENABLED_CHAINS=${enabledRaw.join(',')}`);
  }

  const chains: Partial<Record<ChainId, ChainConfig>> = {};

  for (const chainId of enabled) {
    const netRaw = (rawNetworks as Record<string, unknown>)[chainId];
    if (netRaw === undefined) {
      problems.push(`${chainId}: not present in config/networks.json`);
      continue;
    }
    const net = NetworkSchema.safeParse(netRaw);
    if (!net.success) {
      for (const issue of net.error.issues) {
        problems.push(`${chainId}: networks.json ${issue.path.join('.')} — ${issue.message}`);
      }
      continue;
    }
    if (net.data.chainId !== chainId) {
      problems.push(`${chainId}: networks.json entry says chainId ${net.data.chainId}`);
      continue;
    }
    const slug = net.data.slug;

    const paramsRaw = readJson(`config/params.${slug}.json`);
    if (paramsRaw === undefined) {
      problems.push(`${chainId}: config/params.${slug}.json not found`);
      continue;
    }
    const {_comment: _c, ...paramsBody} = paramsRaw as Record<string, unknown>;
    const params = ParamsFileSchema.safeParse(paramsBody);
    if (!params.success) {
      for (const issue of params.error.issues) {
        problems.push(`${chainId}: params.${slug}.json ${issue.path.join('.')} — ${issue.message}`);
      }
      continue;
    }

    const deployRaw = readJson(`deployments/${slug}.json`);
    if (deployRaw === undefined) {
      problems.push(
        `${chainId}: deployments/${slug}.json not found → deploy with pactora-contracts-near ` +
          `scripts/deploy.mjs, or drop ${chainId} from ENABLED_CHAINS`,
      );
      continue;
    }
    const deployment = DeploymentSchema.safeParse(deployRaw);
    if (!deployment.success) {
      for (const issue of deployment.error.issues) {
        problems.push(`${chainId}: deployments/${slug}.json ${issue.path.join('.')} — ${issue.message}`);
      }
      continue;
    }
    // The deployment must belong to the network it claims.
    if (deployment.data.chainId !== chainId) {
      problems.push(
        `${chainId}: deployments/${slug}.json declares chainId ${deployment.data.chainId} — wrong file for this network`,
      );
      continue;
    }

    const rpcUrl = env[`RPC_URL_${slug.toUpperCase().replace(/-/g, '_')}`] ?? net.data.rpcUrls[0]!;
    const explorer = net.data.blockExplorerUrls[0]?.replace(/\/$/, '') ?? '';
    const decimals = net.data.paymentToken.decimals;
    // A token deployed with the protocol has no id in networks.json; the
    // deploy wrote it to the deployment. Resolve it once, here, for every reader.
    const paymentToken = Object.freeze({
      ...net.data.paymentToken,
      accountId: net.data.paymentToken.accountId ?? deployment.data.contracts.PaymentToken,
    });
    if (!net.data.testnet && net.data.paymentToken.accountId === null) {
      problems.push(
        `${chainId}: no payment token — set paymentToken.accountId in networks.json ` +
          `before enabling a network that is not a testnet`,
      );
      continue;
    }

    const on = params.data.onchain;
    const off = params.data.offchain;
    const windows: Array<[string, number, number]> = [
      ['acceptWindowSeconds', off.acceptWindowSeconds, on.max_accept_window],
      ['workWindowSeconds', off.workWindowSeconds, on.max_work_window],
    ];
    for (const [name, asked, max] of windows) {
      if (asked > max)
        problems.push(`${chainId}: offchain.${name}=${asked} exceeds the contract's maximum ${max}`);
    }

    chains[chainId] = Object.freeze({
      chainId,
      slug,
      nearNetworkId: net.data.nearNetworkId,
      name: net.data.name,
      testnet: net.data.testnet,
      rpcUrl,
      blockSource: net.data.blockSource,
      network: Object.freeze({...net.data, paymentToken}),
      onchainParams: Object.freeze({...on}),
      params: Object.freeze({
        // Money, so bigint — never a JS number.
        minStake: BigInt(on.min_stake),
        fastPathMax: BigInt(on.fast_path_max),
        minJobAmount: BigInt(on.min_job_amount),
        minFee: BigInt(on.min_fee),
        maxJobAmount: BigInt(on.max_job_amount),
        minBond: BigInt(on.min_bond),
        minDisputeBond: BigInt(on.min_dispute_bond),
        defaultPerTaskCap: BigInt(on.default_per_task_cap),
        defaultDailyCap: BigInt(on.default_daily_cap),
        bondBps: on.bond_bps,
        disputeBondBps: on.dispute_bond_bps,
        protocolFeeBps: on.protocol_fee_bps,
        withdrawDelaySeconds: on.withdraw_delay,
        reviewWindowSeconds: on.review_window,
        disputeTimeoutSeconds: on.dispute_timeout,
        disputeGraceSeconds: on.dispute_grace,
        maxAcceptWindowSeconds: on.max_accept_window,
        maxWorkWindowSeconds: on.max_work_window,
        acceptWindowSeconds: off.acceptWindowSeconds,
        workWindowSeconds: off.workWindowSeconds,
        fastPathMinScore: off.fastPathMinScore,
        confidenceFloor: off.confidenceFloor,
      }),
      contracts: Object.freeze({...deployment.data.contracts}),
      startBlock: deployment.data.startBlock,

      // nearblocks: /txns/<hash>, /address/<account>.
      explorerTx: (hash: string) => `${explorer}/txns/${hash}`,
      explorerAddress: (account: string) => `${explorer}/address/${account}`,

      /** Base units → human. Never float arithmetic. */
      formatToken(amount: bigint): string {
        const negative = amount < 0n;
        const abs = negative ? -amount : amount;
        const base = 10n ** BigInt(decimals);
        const whole = abs / base;
        const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
        const sym = net.data.paymentToken.symbol;
        return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''} ${sym}`;
      },

      /** Human → base units, exact. Rejects more precision than the token has. */
      parseToken(human: string): bigint {
        const m = /^(\d+)(?:\.(\d+))?$/.exec(human.trim());
        if (!m) throw new Error(`not a decimal amount: "${human}"`);
        const frac = m[2] ?? '';
        if (frac.length > decimals) {
          throw new Error(`"${human}" has more than ${decimals} decimal places`);
        }
        return BigInt(m[1]! + frac.padEnd(decimals, '0'));
      },
    });
  }

  if (problems.length > 0 || defaultChainId === undefined) {
    throw new ConfigError(problems.length > 0 ? problems : ['no chain enabled']);
  }

  return Object.freeze({
    defaultChainId,
    chains: Object.freeze(chains),
    chain(chainId?: string): ChainConfig {
      const id = chainId ?? defaultChainId;
      const c = chains[id as ChainId];
      if (!c) {
        throw new Error(`chain ${id} not enabled (ENABLED_CHAINS=${Object.keys(chains).join(',')})`);
      }
      return c;
    },
  });
}
