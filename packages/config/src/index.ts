import {readFileSync, existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {legacyEnvProblems} from '@pactora/shared';

/**
 * @pactora/config — the ONE import for chain facts, protocol parameters and
 * contract addresses.
 *
 * Assembled from three versioned sources plus env, validated, and frozen:
 *
 *   config/networks.json          what each chain is
 *   config/params.<chainId>.json  protocol parameters (same bytes the deploy
 *                                 script writes on-chain)
 *   deployments/<chainId>.json    generated addresses
 *   env                           secrets and wiring ONLY
 *
 * No chain object is defined anywhere else. No contract address is ever an env
 * var. See docs/08.
 */

// ── schemas ──────────────────────────────────────────────────────────────
const Address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

const NetworkSchema = z.object({
  chainId: z.number().int().positive(),
  name: z.string().min(1),
  shortName: z.string().min(1),
  foundryAlias: z.string().min(1),
  testnet: z.boolean(),
  nativeCurrency: z.object({
    name: z.string(),
    symbol: z.string(),
    decimals: z.number().int(),
  }),
  rpcUrls: z.array(z.string().url()).min(1),
  blockExplorerUrls: z.array(z.string().url()),
  faucetUrls: z.array(z.string().url()).default([]),
  confirmations: z.number().int().positive(),
  maxLogRange: z.number().int().positive().default(100),
  maxLogRangeNote: z.string().optional(),
  paymentToken: z.object({
    symbol: z.string(),
    decimals: z.literal(6),
    address: Address.nullable(),
    deployWithProtocol: z.boolean(),
    note: z.string().optional(),
  }),
  erc8004: z.object({
    deployWithProtocol: z.boolean(),
    identityRegistry: Address.nullable(),
    reputationRegistry: Address.nullable(),
    identityImplementationPinned: Address.optional(),
    note: z.string().optional(),
  }),
});

const ParamsSchema = z.object({
  minStake: z.string().regex(/^\d+$/),
  withdrawDelaySeconds: z.number().int().positive(),
  fastPathMax: z.string().regex(/^\d+$/),
  /** v2: the smallest job the escrow accepts, and the fee floor — both on chain. */
  minJobAmount: z.string().regex(/^\d+$/),
  minFee: z.string().regex(/^\d+$/),
  fastPathMinScore: z.number().int().min(0).max(100),
  protocolFeeBps: z.number().int().min(0).max(1000),
  acceptWindowSeconds: z.number().int().positive(),
  workWindowSeconds: z.number().int().positive(),
  reviewWindowSeconds: z.number().int().positive(),
  /** v2: how long the arbiter has before anyone may expire a dispute. */
  disputeTimeoutSeconds: z.number().int().positive(),
  /** v2: the delay on handing over the contracts' admin role. */
  adminDelaySeconds: z.number().int().positive(),
  /** v3: the largest escrow job; also the ceiling for an escrow-backed x402 payment. */
  maxJobAmount: z.string().regex(/^\d+$/),
  /** v3: the gas every review gets (TaskEscrow.Config.feedbackGas). */
  feedbackGas: z.number().int().positive(),
  /** v3: the worker's per-job bond — a share of the job, with a floor. */
  bondBps: z.number().int().min(0).max(10_000),
  minBond: z.string().regex(/^\d+$/),
  /** v3: what disputing costs the client — a share of the job, with a floor. */
  disputeBondBps: z.number().int().min(0).max(10_000),
  minDisputeBond: z.string().regex(/^\d+$/),
  confidenceFloor: z.number().int().positive(),
  /**
   * What a newly registered agent may spend before its owner configures
   * anything. Off-chain only — the on-chain authority is AgentAccount, and an
   * agent paid from a plain EOA has no contract to read.
   *
   * It must not default to zero. A zero budget reads as "you may spend
   * nothing", so an orchestrator refuses to hire anyone and the marketplace
   * is broken on arrival — while the signer, finding no AgentAccount, would
   * happily have signed. Reporting and enforcement must not disagree.
   */
  defaultPerTaskCap: z.string().regex(/^\d+$/),
  defaultDailyCap: z.string().regex(/^\d+$/),
});

const DeploymentSchema = z.object({
  chainId: z.number().int(),
  deployedAt: z.string(),
  startBlock: z.number().int().nonnegative(),
  commit: z.string().optional(),
  contracts: z.record(z.string(), Address),
  erc8004: z.record(z.string(), Address).optional(),
});

export type Network = z.infer<typeof NetworkSchema>;
export type Params = z.infer<typeof ParamsSchema>;
export type Deployment = z.infer<typeof DeploymentSchema>;

// ── the resolved shape ───────────────────────────────────────────────────
export interface ChainConfig {
  readonly chainId: number;
  readonly name: string;
  readonly testnet: boolean;
  readonly rpcUrl: string;
  readonly confirmations: number;
  /** Largest eth_getLogs span this RPC will serve. */
  readonly maxLogRange: number;
  readonly network: Network;
  readonly params: Readonly<Record<keyof Params, bigint | number>>;
  readonly contracts: Readonly<Record<string, string>>;
  readonly erc8004: Readonly<Record<string, string>>;
  readonly startBlock: number;
  explorerTx(hash: string): string;
  explorerAddress(address: string): string;
  formatToken(amount: bigint): string;
  parseToken(human: string): bigint;
}

export interface PactoraConfig {
  readonly defaultChainId: number;
  readonly chains: Readonly<Record<number, ChainConfig>>;
  chain(chainId?: number): ChainConfig;
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

/**
 * Validate everything at startup and report ALL problems at once.
 *
 * A service that boots with broken config and fails on the first user request
 * is strictly worse than one that refuses to boot.
 */
export function loadConfig(opts: LoadOptions = {}): PactoraConfig {
  const env = opts.env ?? process.env;
  // Before anything else: a stale AGENTX_CONTRACTS_ROOT would otherwise send
  // the loader to the default path and report a confusing problem there.
  const legacy = legacyEnvProblems(env);
  if (legacy.length > 0) throw new ConfigError(legacy);
  const root =
    opts.contractsRoot ?? env['PACTORA_CONTRACTS_ROOT'] ?? join(process.cwd(), '..', 'agentx-contracts');

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
      'set PACTORA_CONTRACTS_ROOT to the agentx-contracts checkout',
    ]);
  }

  const enabled = (env['ENABLED_CHAIN_IDS'] ?? '10143')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);

  if (enabled.length === 0 || enabled.some(Number.isNaN)) {
    problems.push(`ENABLED_CHAIN_IDS="${env['ENABLED_CHAIN_IDS']}" is not a list of chain ids`);
  }

  const defaultChainId = Number(env['DEFAULT_CHAIN_ID'] ?? enabled[0]);
  if (!enabled.includes(defaultChainId)) {
    problems.push(`DEFAULT_CHAIN_ID=${defaultChainId} is not in ENABLED_CHAIN_IDS=${enabled.join(',')}`);
  }

  const chains: Record<number, ChainConfig> = {};

  for (const chainId of enabled) {
    const netRaw = (rawNetworks as Record<string, unknown>)[String(chainId)];
    if (netRaw === undefined) {
      problems.push(`chain ${chainId}: not present in config/networks.json`);
      continue;
    }

    const net = NetworkSchema.safeParse(netRaw);
    if (!net.success) {
      for (const issue of net.error.issues) {
        problems.push(`chain ${chainId}: networks.json ${issue.path.join('.')} — ${issue.message}`);
      }
      continue;
    }

    const paramsRaw = readJson(`config/params.${chainId}.json`);
    if (paramsRaw === undefined) {
      problems.push(`chain ${chainId}: config/params.${chainId}.json not found`);
      continue;
    }
    const stripped = Object.fromEntries(
      Object.entries(paramsRaw as Record<string, unknown>).filter(([k]) => !k.startsWith('_')),
    );
    const params = ParamsSchema.safeParse(stripped);
    if (!params.success) {
      for (const issue of params.error.issues) {
        problems.push(`chain ${chainId}: params.${issue.path.join('.')} — ${issue.message}`);
      }
      continue;
    }

    const deployRaw = readJson(`deployments/${chainId}.json`);
    if (deployRaw === undefined) {
      problems.push(
        `chain ${chainId}: deployments/${chainId}.json not found ` +
          `→ run \`make deploy NETWORK=${net.data.foundryAlias}\`, ` +
          `or drop ${chainId} from ENABLED_CHAIN_IDS`,
      );
      continue;
    }
    const deployment = DeploymentSchema.safeParse(deployRaw);
    if (!deployment.success) {
      for (const issue of deployment.error.issues) {
        problems.push(`chain ${chainId}: deployments.${issue.path.join('.')} — ${issue.message}`);
      }
      continue;
    }

    // The deployment must belong to the chain it claims.
    if (deployment.data.chainId !== chainId) {
      problems.push(
        `chain ${chainId}: deployments/${chainId}.json declares chainId ` +
          `${deployment.data.chainId} — wrong file for this network`,
      );
      continue;
    }

    const rpcUrl = env[`RPC_URL_${chainId}`] ?? net.data.rpcUrls[0]!;
    const explorer = net.data.blockExplorerUrls[0]?.replace(/\/$/, '') ?? '';
    const decimals = net.data.paymentToken.decimals;
    // A token deployed with the protocol has no address in networks.json; the
    // deploy wrote it to the deployment. Resolve it once, here, for every reader.
    const paymentToken = Object.freeze({
      ...net.data.paymentToken,
      address: net.data.paymentToken.address ?? deployment.data.contracts['PaymentToken'] ?? null,
    });
    // v3: real money is never denominated in nothing.
    if (!net.data.testnet && !paymentToken.address) {
      problems.push(
        `chain ${chainId}: no payment token — set paymentToken.address in networks.json (D8) ` +
          `before enabling a non-testnet chain`,
      );
      continue;
    }

    chains[chainId] = Object.freeze({
      chainId,
      name: net.data.name,
      testnet: net.data.testnet,
      rpcUrl,
      confirmations: net.data.confirmations,
      maxLogRange: net.data.maxLogRange,
      network: Object.freeze({...net.data, paymentToken}),
      params: Object.freeze({
        minStake: BigInt(params.data.minStake),
        fastPathMax: BigInt(params.data.fastPathMax),
        minJobAmount: BigInt(params.data.minJobAmount),
        minFee: BigInt(params.data.minFee),
        maxJobAmount: BigInt(params.data.maxJobAmount),
        minBond: BigInt(params.data.minBond),
        minDisputeBond: BigInt(params.data.minDisputeBond),
        feedbackGas: params.data.feedbackGas,
        bondBps: params.data.bondBps,
        disputeBondBps: params.data.disputeBondBps,
        // Money, so bigint like the rest — never a JS number.
        defaultPerTaskCap: BigInt(params.data.defaultPerTaskCap),
        defaultDailyCap: BigInt(params.data.defaultDailyCap),
        withdrawDelaySeconds: params.data.withdrawDelaySeconds,
        fastPathMinScore: params.data.fastPathMinScore,
        protocolFeeBps: params.data.protocolFeeBps,
        acceptWindowSeconds: params.data.acceptWindowSeconds,
        workWindowSeconds: params.data.workWindowSeconds,
        reviewWindowSeconds: params.data.reviewWindowSeconds,
        disputeTimeoutSeconds: params.data.disputeTimeoutSeconds,
        adminDelaySeconds: params.data.adminDelaySeconds,
        confidenceFloor: params.data.confidenceFloor,
      }),
      contracts: Object.freeze(deployment.data.contracts),
      erc8004: Object.freeze(deployment.data.erc8004 ?? {}),
      startBlock: deployment.data.startBlock,

      explorerTx: (hash: string) => `${explorer}/tx/${hash}`,
      explorerAddress: (address: string) => `${explorer}/address/${address}`,

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

  if (problems.length > 0) throw new ConfigError(problems);

  return Object.freeze({
    defaultChainId,
    chains: Object.freeze(chains),
    chain(chainId?: number): ChainConfig {
      const id = chainId ?? defaultChainId;
      const c = chains[id];
      if (!c) {
        throw new Error(`chain ${id} not enabled (ENABLED_CHAIN_IDS=${Object.keys(chains).join(',')})`);
      }
      return c;
    },
  });
}

/**
 * ABIs, generated by `make export` in the contracts repo.
 *
 * Loaded from the same contracts checkout as everything else, so there is one
 * source for chain artifacts rather than a copy that drifts. In production
 * this resolves through the published `@pactora/contracts` package instead;
 * the shape is identical either way.
 */
export function loadAbis(contractsRoot?: string): Record<string, unknown[]> {
  const root =
    contractsRoot ?? process.env['PACTORA_CONTRACTS_ROOT'] ?? join(process.cwd(), '..', 'agentx-contracts');
  const dir = join(root, 'export', 'abis');

  if (!existsSync(dir)) {
    throw new Error(
      `ABIs not found at ${dir}
` + '  → run `make export` in agentx-contracts, or set PACTORA_CONTRACTS_ROOT',
    );
  }

  const abis: Record<string, unknown[]> = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    abis[file.replace('.json', '')] = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown[];
  }
  return abis;
}
