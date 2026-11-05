import {z} from 'zod';

/**
 * The single definition of what a job is.
 *
 * Types are DERIVED from these schemas, never written alongside them — that is
 * what stops validation and types drifting apart. The API validates with them,
 * agents construct with them, and the interface renders from them.
 */

// ── money ────────────────────────────────────────────────────────────────
/**
 * Token amounts are integer base units carried as decimal STRINGS.
 *
 * Not numbers: 2^53 is ~9e15, and a uint128 amount exceeds that. A JSON number
 * would silently lose precision somewhere in the stack, and the first symptom
 * would be a payment that does not reconcile.
 */
export const BaseUnits = z
  .string()
  .regex(/^\d+$/, 'must be an integer string of token base units')
  .refine((s) => s.length <= 39, 'exceeds uint128');

export type BaseUnits = z.infer<typeof BaseUnits>;

/** The contract's agent id (`AgentId`, a u64), carried as a decimal string. */
export const AgentId = z.string().regex(/^\d+$/, 'agent id must be a numeric string');
export type AgentId = z.infer<typeof AgentId>;

/**
 * A network, as a CAIP-2 chain id string (docs/NEAR-PORT.md §1).
 *
 * `near:<network>` is the form NEAR x402 code uses; the ChainAgnostic
 * registry has no NEAR profile yet, so it is a convention, not a registered
 * standard. `near:sandbox` is a local node only.
 */
export const CHAIN_IDS = ['near:testnet', 'near:sandbox'] as const;
export const ChainId = z.enum(CHAIN_IDS);
export type ChainId = z.infer<typeof ChainId>;

/**
 * A NEAR account id: 2–64 characters, nearcore's rule — lowercase
 * alphanumeric parts separated by `-` or `_`, joined by `.`. Covers named
 * (`alice.testnet`) and implicit (64 hex) accounts.
 */
export const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const AccountId = z.string().min(2).max(64).regex(ACCOUNT_ID_RE, 'must be a NEAR account id');
export type AccountId = z.infer<typeof AccountId>;

export function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 2 && value.length <= 64 && ACCOUNT_ID_RE.test(value);
}

/** sha256 as 64 lowercase hex, no `0x` — what the contract's `check_hash` accepts. */
export const Hash32 = z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hash: 64 lowercase hex');

/** A NEAR transaction hash: 32 bytes in base58. */
export const TxHash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, 'must be a base58 transaction hash');

// ── capabilities ─────────────────────────────────────────────────────────
/**
 * Kebab-case, lowercase, bounded. A free-form capability string makes
 * discovery unmatchable: "Market Research" and "market-research" would be
 * different capabilities and no agent would ever be found.
 */
export const Capability = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'capability must be lowercase kebab-case');

export type Capability = z.infer<typeof Capability>;

// ── job spec ─────────────────────────────────────────────────────────────
export const JobSpec = z.object({
  capability: Capability,
  /** Arbitrary task input. Opaque to the protocol; meaningful to the worker. */
  input: z.record(z.string(), z.unknown()),
  /**
   * JSON Schema the result MUST satisfy. Validated before the result is
   * shown to any model — a result that fails is disputed, never read.
   * See docs/04 §7.3 (prompt-injection containment).
   */
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  deadlineSeconds: z.number().int().min(10).max(86_400).default(120),
});

export type JobSpec = z.infer<typeof JobSpec>;

export const JobResult = z.object({
  output: z.record(z.string(), z.unknown()),
  producedAt: z.string().datetime(),
  /** Optional self-reported cost/latency. Never trusted, useful for ranking. */
  meta: z
    .object({
      latencyMs: z.number().int().nonnegative().optional(),
      model: z.string().max(128).optional(),
    })
    .optional(),
});

export type JobResult = z.infer<typeof JobResult>;

// ── lifecycle ────────────────────────────────────────────────────────────
/** Mirrors the contract's `JobState` exactly. Divergence here is a real bug. */
export const JobState = z.enum(['created', 'accepted', 'submitted', 'disputed', 'settled', 'refunded']);
export type JobState = z.infer<typeof JobState>;

export const JobPath = z.enum(['escrow', 'direct']);
export type JobPath = z.infer<typeof JobPath>;

export const Outcome = z.enum(['success', 'failed', 'dispute_lost']);
export type Outcome = z.infer<typeof Outcome>;

// ── requests ─────────────────────────────────────────────────────────────
export const HireRequest = z.object({
  workerAgentId: AgentId,
  spec: JobSpec,
  maxPrice: BaseUnits,
  /** 'auto' applies the fast-path rule in docs/02 §4. */
  path: z.union([JobPath, z.literal('auto')]).default('auto'),
  chainId: ChainId.optional(),
});

export type HireRequest = z.infer<typeof HireRequest>;

/**
 * Canonical JSON for hashing. `specHash` is committed on-chain, so producing
 * it must be deterministic across every language and process that computes it.
 * Key order is the only thing that varies in practice, so sort it.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}
