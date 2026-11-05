import {
  uuid,
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Pactora database schema.
 *
 * The chain is the source of truth for money; this is a queryable projection
 * plus the off-chain payloads. Two rules run through all of it:
 *
 * 1. **Money is NUMERIC(38,0)** — integer base units, never float, never
 *    bigint. A uint128 amount exceeds 2^53, so a JS number would lose
 *    precision and the first symptom would be a payment that fails to
 *    reconcile.
 *
 * 2. **Every chain-derived table carries `chain_id`, and every uniqueness
 *    constraint is scoped to it.** Agent #42 on testnet and agent #42 on
 *    mainnet are different agents with separate reputations. A global unique
 *    on `chain_agent_id` would make the second network fail to index at
 *    agent #1. See docs/08 §8.
 */

/** Token amounts and uint256 chain ids. Integer base units as strings. */
const baseUnits = (name: string) => numeric(name, {precision: 38, scale: 0});
const chainUint = (name: string) => numeric(name, {precision: 78, scale: 0});

export const jobState = pgEnum('job_state', [
  'created',
  'accepted',
  'submitted',
  'disputed',
  'settled',
  'refunded',
]);

export const jobPath = pgEnum('job_path', ['escrow', 'direct']);

export const outcome = pgEnum('outcome', ['success', 'failed', 'dispute_lost']);

// ─────────────────────────── identity ───────────────────────────

export const agents = pgTable(
  'agents',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    chainId: text('chain_id').notNull(),
    /** ERC-8004 ERC-721 token id. NULL until the indexer sees Registered. */
    chainAgentId: chainUint('chain_agent_id'),
    ownerAddress: text('owner_address').notNull(),
    /** The AgentAccount. Per-chain unique, never globally unique. */
    walletAddress: text('wallet_address').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /**
     * NEVER DEREFERENCED SERVER-SIDE. Both of these are agent-supplied URLs,
     * stored and returned verbatim.
     *
     * That is what makes threat T15 (SSRF via a hostile metadata URI) not
     * apply: there is no fetch to attack. If anything ever does fetch them,
     * the guard must be built FIRST — size cap, timeout, content-type
     * allowlist, no redirects into private ranges, no credentials attached.
     * See docs/04 §9.2 T15.
     */
    endpointUrl: text('endpoint_url'),
    pricePerTask: baseUnits('price_per_task').notNull(),
    stake: baseUnits('stake').notNull().default('0'),
    metadataUri: text('metadata_uri'),
    active: boolean('active').notNull().default(true),
    registeredAt: timestamp('registered_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agents_chain_agent_uk').on(t.chainId, t.chainAgentId),
    uniqueIndex('agents_chain_wallet_uk').on(t.chainId, t.walletAddress),
    // Discovery is ALWAYS chain-scoped, or the marketplace silently mixes
    // networks and a testnet agent appears next to a mainnet one.
    index('agents_discovery_idx').on(t.chainId, t.active, t.pricePerTask),
    // Target of the composite FK that makes a cross-chain job impossible.
    uniqueIndex('agents_id_chain_uk').on(t.id, t.chainId),
  ],
);

export const agentCapabilities = pgTable(
  'agent_capabilities',
  {
    agentId: bigint('agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    /** Lowercase kebab-case, enforced by @pactora/shared before insert. */
    capability: text('capability').notNull(),
  },
  (t) => [
    primaryKey({columns: [t.agentId, t.capability]}),
    index('agent_capabilities_capability_idx').on(t.capability),
  ],
);

// ─────────────────── reputation (projection of ERC-8004) ───────────────────

/**
 * Derived from indexed `NewFeedback` events, NOT from a live `getSummary()`
 * call. That function loops over every feedback entry per client, and Pactora
 * is a single client address, so an agent with 1,284 settled jobs means a
 * 1,284-iteration loop in one eth_call. It will hit RPC gas caps.
 */
export const agentStats = pgTable('agent_stats', {
  agentId: bigint('agent_id', {mode: 'number'})
    .primaryKey()
    .references(() => agents.id, {onDelete: 'cascade'}),
  completed: bigint('completed', {mode: 'number'}).notNull().default(0),
  failed: bigint('failed', {mode: 'number'}).notNull().default(0),
  disputed: bigint('disputed', {mode: 'number'}).notNull().default(0),
  volume: baseUnits('volume').notNull().default('0'),
  /** Mirrors the smoothed, volume-damped formula in docs/04 §2.3. */
  score: smallint('score').notNull().default(50),
  lastActiveAt: timestamp('last_active_at', {withTimezone: true}),
});

// ─────────────────────────── jobs ───────────────────────────

export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    /**
     * The only id the API shows. Random, so a job cannot be found by counting:
     * reads are public by design (a job is shareable evidence), and the serial
     * `id` made every job in the system enumerable by walking 1, 2, 3.
     */
    publicId: uuid('public_id').notNull().defaultRandom(),
    chainId: text('chain_id').notNull(),
    chainJobId: chainUint('chain_job_id'),
    clientAgentId: bigint('client_agent_id', {mode: 'number'}).notNull(),
    workerAgentId: bigint('worker_agent_id', {mode: 'number'}).notNull(),
    path: jobPath('path').notNull(),
    state: jobState('state').notNull().default('created'),
    amount: baseUnits('amount').notNull(),
    fee: baseUnits('fee'),
    spec: jsonb('spec').notNull(),
    specHash: text('spec_hash').notNull(),
    result: jsonb('result'),
    resultHash: text('result_hash'),
    resultUri: text('result_uri'),
    acceptDeadline: timestamp('accept_deadline', {withTimezone: true}),
    workDeadline: timestamp('work_deadline', {withTimezone: true}),
    reviewDeadline: timestamp('review_deadline', {withTimezone: true}),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
    settledAt: timestamp('settled_at', {withTimezone: true}),
    /** Links the row to the agent's OpenTelemetry trace. */
    traceId: text('trace_id'),
    /**
     * The client's Idempotency-Key for the hire. A replayed hire returns this
     * row instead of inserting another: it used to insert a phantom job each
     * time — settled on the fast path, never linkable on escrow — while the
     * signer correctly refused to pay twice.
     */
    idempotencyKey: text('idempotency_key'),
  },
  (t) => [
    uniqueIndex('jobs_chain_job_uk').on(t.chainId, t.chainJobId),
    uniqueIndex('jobs_public_id_uk').on(t.publicId),
    uniqueIndex('jobs_client_idempotency_uk').on(t.clientAgentId, t.idempotencyKey),
    index('jobs_worker_idx').on(t.chainId, t.workerAgentId, t.state),
    index('jobs_client_idx').on(t.chainId, t.clientAgentId, t.createdAt),
    index('jobs_open_idx').on(t.chainId, t.state),
  ],
);

/**
 * Append-only audit log. Never updated, never deleted.
 *
 * `UNIQUE (chain_id, receipt_id, log_index)` is what makes the indexer safely
 * re-runnable: replaying a block range becomes a no-op rather than a
 * duplication. On NEAR an event belongs to a receipt, not a transaction —
 * one transaction's receipts run across several blocks, each with its own
 * logs — so the receipt is the key and `tx_hash` is kept for links.
 * Off-chain events carry a NULL receipt_id, and Postgres treats NULLs as
 * distinct, so they are unaffected.
 */
export const jobEvents = pgTable(
  'job_events',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    chainId: text('chain_id').notNull(),
    jobId: bigint('job_id', {mode: 'number'})
      .notNull()
      .references(() => jobs.id, {onDelete: 'cascade'}),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    txHash: text('tx_hash'),
    receiptId: text('receipt_id'),
    blockNumber: bigint('block_number', {mode: 'number'}),
    logIndex: integer('log_index'),
    occurredAt: timestamp('occurred_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('job_events_idempotency_uk').on(t.chainId, t.receiptId, t.logIndex),
    index('job_events_job_idx').on(t.jobId, t.id),
  ],
);

// ─────────────────────────── money ───────────────────────────

export const payments = pgTable(
  'payments',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    chainId: text('chain_id').notNull(),
    jobId: bigint('job_id', {mode: 'number'}).references(() => jobs.id),
    fromAgentId: bigint('from_agent_id', {mode: 'number'}).references(() => agents.id),
    toAgentId: bigint('to_agent_id', {mode: 'number'}).references(() => agents.id),
    amount: baseUnits('amount').notNull(),
    fee: baseUnits('fee').notNull().default('0'),
    txHash: text('tx_hash').notNull(),
    blockNumber: bigint('block_number', {mode: 'number'}).notNull(),
    confirmedAt: timestamp('confirmed_at', {withTimezone: true}),
  },
  (t) => [uniqueIndex('payments_uk').on(t.chainId, t.txHash, t.jobId)],
);

/**
 * Payment-token transfers that touch a known agent's wallet or owner (v3).
 *
 * The funding graph a reputation needs: prooflines measured on Monad that
 * paid reviews are farmable by an owner who funds the raters' wallets
 * seconds before they pay. A transfer from the worker's side to a client
 * before that client hires is the signature of it. Recorded by the indexer
 * from the token's own NEP-141 `ft_transfer` events, in the same blocks it
 * reads the protocol; accounts are NEAR account ids (lower case by rule).
 * Kept when EITHER side is known, so a rater wallet funded before it
 * registered is still caught from the worker's side. One `ft_transfer` log
 * can list several transfers: `log_index` is 256 × the log line + the entry.
 */
export const tokenTransfers = pgTable(
  'token_transfers',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    chainId: text('chain_id').notNull(),
    blockNumber: bigint('block_number', {mode: 'number'}).notNull(),
    txHash: text('tx_hash').notNull(),
    receiptId: text('receipt_id').notNull(),
    logIndex: integer('log_index').notNull(),
    fromAddress: text('from_address').notNull(),
    toAddress: text('to_address').notNull(),
    amount: baseUnits('amount').notNull(),
  },
  (t) => [
    uniqueIndex('token_transfers_uk').on(t.chainId, t.receiptId, t.logIndex),
    index('token_transfers_to_idx').on(t.chainId, t.toAddress, t.blockNumber),
    index('token_transfers_from_idx').on(t.chainId, t.fromAddress, t.blockNumber),
  ],
);

export const spendPolicies = pgTable('spend_policies', {
  agentId: bigint('agent_id', {mode: 'number'})
    .primaryKey()
    .references(() => agents.id, {onDelete: 'cascade'}),
  perTaskCap: baseUnits('per_task_cap').notNull(),
  dailyCap: baseUnits('daily_cap').notNull(),
  /** A cache for fast rejection. AgentAccount.spentToday is the authority. */
  spentToday: baseUnits('spent_today').notNull().default('0'),
  dayStart: timestamp('day_start', {withTimezone: true}).notNull().defaultNow(),
  allowlistOnly: boolean('allowlist_only').notNull().default(false),
});

/**
 * Nonce ledger and replay guard for the signer.
 *
 * Agents retry, and a retried hire must not create a second job — so the
 * idempotency key is unique, and (agent_id, nonce) cannot collide.
 *
 * The key is unique PER AGENT, and a replay must also carry the same call
 * (`payload_hash`). It was unique on its own and bound to nothing, so a
 * caller who reused another request's key was handed that request's
 * transaction as `replayed: true` — and the API recorded a payment or a
 * submit that had never been sent for it (audit H1).
 */
export const signerTxs = pgTable(
  'signer_txs',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    chainId: text('chain_id').notNull(),
    agentId: bigint('agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id),
    idempotencyKey: text('idempotency_key').notNull(),
    /**
     * sha256 of the call (method, args, spend) this key was first used
     * for. NULL only on rows from before it existed, which never replay.
     */
    payloadHash: text('payload_hash'),
    /**
     * The access-key nonce. NEAR's start at (block height × 10^6), about
     * 2·10^14 on testnet today — inside a JS number's exact range (2^53).
     */
    nonce: bigint('nonce', {mode: 'number'}).notNull(),
    txHash: text('tx_hash'),
    /**
     * pending (claimed, not signed) → signed (hash known before broadcast,
     * outcome not yet) → final | reverted; failed = never left the building.
     */
    status: text('status').notNull().default('pending'),
    /** The call's JSON return value once final — a replay returns it (the job id of a hire). */
    result: jsonb('result'),
    /** The node's failure, as JSON, when the transaction reverted on chain. */
    failure: text('failure'),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('signer_idempotency_uk').on(t.chainId, t.agentId, t.idempotencyKey),
    uniqueIndex('signer_nonce_uk').on(t.chainId, t.agentId, t.nonce),
  ],
);

/**
 * The signer's generated keys (NEAR function-call keys, one per wallet
 * account), encrypted.
 *
 * In the database rather than files: every replica sees the same key, the
 * unique index makes "create if missing" race-free across replicas, and the
 * key is backed up with the rows that refer to it. The ciphertext alone is
 * useless — the passphrase lives only in the signer's environment
 * (`SIGNER_KEY_PASSPHRASE`), never in this database.
 */
export const signerKeys = pgTable(
  'signer_keys',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    chainId: text('chain_id').notNull(),
    accountId: text('account_id').notNull(),
    /** `ed25519:<base58>` — public, so it is stored in the clear for lookup. */
    publicKey: text('public_key').notNull(),
    /** AES-256-GCM of the near-cli credential JSON; see apps/signer keystore.ts. */
    ciphertext: text('ciphertext').notNull(),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('signer_keys_account_uk').on(t.chainId, t.accountId)],
);

/**
 * Transactions the signer sent for a wallet that has no agent row yet —
 * `accept_wallet` during registration, before the API inserts the agent.
 * Kept so the per-wallet nonce discipline sees them.
 */
export const signerWalletTxs = pgTable(
  'signer_wallet_txs',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    chainId: text('chain_id').notNull(),
    walletAddress: text('wallet_address').notNull(),
    method: text('method').notNull(),
    /** The contract agent id the call was for (decimal u64). */
    chainAgentId: text('chain_agent_id').notNull(),
    nonce: bigint('nonce', {mode: 'number'}).notNull(),
    txHash: text('tx_hash'),
    status: text('status').notNull().default('pending'),
    failure: text('failure'),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('signer_wallet_txs_nonce_uk').on(t.chainId, t.walletAddress, t.nonce)],
);

// ─────────────────────────── disputes & auth ───────────────────────────

export const disputes = pgTable('disputes', {
  jobId: bigint('job_id', {mode: 'number'})
    .primaryKey()
    .references(() => jobs.id),
  raisedBy: bigint('raised_by', {mode: 'number'})
    .notNull()
    .references(() => agents.id),
  reason: text('reason').notNull(),
  reasonHash: text('reason_hash').notNull(),
  resolvedFor: text('resolved_for'),
  resolvedAt: timestamp('resolved_at', {withTimezone: true}),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    agentId: bigint('agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    /**
     * The public half of the key (`ax_<keyId>_<secret>`): how a request finds
     * its row by index instead of hashing against every row. Not secret.
     */
    keyId: text('key_id'),
    /**
     * `sha256$<hex>` of the whole key. The key is shown once and never stored.
     * SHA-256, not a slow KDF: a key is 192 random bits, not a password, so
     * there is nothing for a slow hash to protect — and a slow hash on every
     * request is a denial-of-service lever.
     */
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    lastUsedAt: timestamp('last_used_at', {withTimezone: true}),
    revokedAt: timestamp('revoked_at', {withTimezone: true}),
  },
  (t) => [uniqueIndex('api_keys_hash_uk').on(t.keyHash), uniqueIndex('api_keys_key_id_uk').on(t.keyId)],
);

/**
 * A pending owner challenge for re-issuing an agent's API key (v3).
 *
 * An owner who lost every key proves control by signing a message that
 * carries this nonce. Deleted when used, and worthless after `expiresAt`, so a
 * captured signature cannot be replayed into a second key.
 *
 * Several may be live per agent. It was one per agent, a new challenge
 * replacing the last — and asking for one needs no credentials, so anyone
 * could keep invalidating the owner's signature (audit L2). Each requester
 * address now keeps its own few; nobody else's request can evict them.
 */
export const keyChallenges = pgTable(
  'key_challenges',
  {
    nonce: text('nonce').primaryKey(),
    agentId: bigint('agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    /** The client address that asked for it. */
    requester: text('requester').notNull().default(''),
    expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
  },
  (t) => [index('key_challenges_agent_idx').on(t.agentId, t.requester)],
);

/**
 * A pending challenge for registering an agent (audit M1).
 *
 * Registration used to check only that the owner and wallet named matched
 * public chain data — which anyone can read. A front-runner registered the
 * victim's ERC-8004 agent and received its only API key. Now the owner signs
 * a message carrying this nonce, and the details being registered; the nonce
 * is consumed by the registration it was issued for.
 */
export const registrationChallenges = pgTable(
  'registration_challenges',
  {
    nonce: text('nonce').primaryKey(),
    chainId: text('chain_id').notNull(),
    /** Lower-case. */
    ownerAddress: text('owner_address').notNull(),
    requester: text('requester').notNull().default(''),
    expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
  },
  (t) => [index('registration_challenges_owner_idx').on(t.ownerAddress, t.requester)],
);

/**
 * Shared rate-limit windows (v3), for more than one API replica. The
 * in-memory limiter counts per process, so N replicas allowed N times the
 * limit; with RATE_LIMIT_STORE=postgres every replica counts here instead.
 */
export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  windowStart: timestamp('window_start', {withTimezone: true}).notNull(),
});

// ─────────────────────────── indexer ───────────────────────────

/**
 * One cursor per (chain, contract). `last_block_hash` is how a reorg is
 * detected: if the hash at `last_block` no longer matches, roll back and
 * replay — which the job_events unique constraint makes idempotent.
 */
export const indexerCursor = pgTable(
  'indexer_cursor',
  {
    chainId: text('chain_id').notNull(),
    contract: text('contract').notNull(),
    lastBlock: bigint('last_block', {mode: 'number'}).notNull(),
    lastBlockHash: text('last_block_hash').notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [primaryKey({columns: [t.chainId, t.contract]})],
);

// ─────────────────────────── runs ───────────────────────────

export const runState = pgEnum('run_state', ['running', 'done', 'failed']);

/**
 * One orchestrator run: a goal in, an answer and a trail of payments out.
 *
 * Persisted rather than held in memory because the live demo page IS the
 * submission video. A run that vanishes when the page is refreshed cannot be
 * re-watched, re-recorded, or shown to a judge who arrived late — and a
 * finished run is exactly the artefact worth keeping.
 */
export const runs = pgTable(
  'runs',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    /** The only id the API shows; see `jobs.publicId`. */
    publicId: uuid('public_id').notNull().defaultRandom(),
    chainId: text('chain_id').notNull(),
    /** The orchestrator agent that owns the spending caps this run ran under. */
    agentId: bigint('agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    goal: text('goal').notNull(),
    state: runState('state').notNull().default('running'),
    answer: text('answer'),
    /** Final per-step outcomes, as the orchestrator reported them. */
    steps: jsonb('steps').notNull().default([]),
    spent: baseUnits('spent').notNull().default('0'),
    /** Why a run ended as `failed`. Null on every other state. */
    error: text('error'),
    startedAt: timestamp('started_at', {withTimezone: true}).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', {withTimezone: true}),
  },
  (t) => [index('runs_agent_idx').on(t.agentId, t.id), uniqueIndex('runs_public_id_uk').on(t.publicId)],
);

/**
 * Append-only trace of a run.
 *
 * No `tx_hash` uniqueness here, unlike `job_events`: these are produced by the
 * orchestrator rather than replayed from the chain, so there is nothing to
 * deduplicate and every line is meant to be kept in order.
 */
export const runEvents = pgTable(
  'run_events',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    runId: bigint('run_id', {mode: 'number'})
      .notNull()
      .references(() => runs.id, {onDelete: 'cascade'}),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    occurredAt: timestamp('occurred_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [index('run_events_run_idx').on(t.runId, t.id)],
);

/**
 * x402 payment receipts a worker has already honoured.
 *
 * An x402 payment is a fast-path job: `directPay`, settled on chain the
 * moment it lands. The receipt the client presents is that job, so the one
 * thing the chain cannot stop is the same receipt being shown twice — paid
 * once, served forever. The primary key makes redemption a single atomic
 * insert: the first presentation wins, every later one conflicts.
 */
export const x402Redemptions = pgTable('x402_redemptions', {
  jobId: bigint('job_id', {mode: 'number'})
    .primaryKey()
    .references(() => jobs.id, {onDelete: 'cascade'}),
  resource: text('resource').notNull(),
  redeemedAt: timestamp('redeemed_at', {withTimezone: true}).notNull().defaultNow(),
});
