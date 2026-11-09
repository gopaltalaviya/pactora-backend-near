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
import {sql} from 'drizzle-orm';

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

/**
 * Who an `agents` row is (docs/26 F2). `agent`: software, with an API key and
 * a function-call key the signer holds. `person`: a human whose own NEAR
 * account is both the on-chain agent's owner and its wallet, who signs in
 * with a session and signs transactions in the browser — never an API key.
 */
export const agentKind = pgEnum('agent_kind', ['agent', 'person']);

// ─────────────────────────── identity ───────────────────────────

export const agents = pgTable(
  'agents',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    /** The id a person's record is shown by (docs/26 F2); agents are still shown by `id`. */
    publicId: uuid('public_id').notNull().defaultRandom(),
    kind: agentKind('kind').notNull().default('agent'),
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
    /**
     * Where the agent or person works, "City" or "City, Region" (docs/26
     * F18); '' = anywhere. Read by listing matching (apps/api matching.ts).
     */
    location: text('location').notNull().default(''),
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
    uniqueIndex('agents_public_id_uk').on(t.publicId),
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
    /**
     * The `result_hash` the chain committed is not the one stored for the
     * delivery (docs/26 gap 2). Set by the indexer or a person's confirm,
     * never cleared; the API refuses approval while it is true.
     */
    resultMismatch: boolean('result_mismatch').notNull().default(false),
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
    /** For a deposit into an agent's balance in the contract (`funded`): that agent's chain id. */
    toChainAgentId: bigint('to_chain_agent_id', {mode: 'number'}),
    amount: baseUnits('amount').notNull(),
  },
  (t) => [
    uniqueIndex('token_transfers_uk').on(t.chainId, t.receiptId, t.logIndex),
    index('token_transfers_to_idx').on(t.chainId, t.toAddress, t.blockNumber),
    index('token_transfers_from_idx').on(t.chainId, t.fromAddress, t.blockNumber),
    index('token_transfers_to_agent_idx').on(t.chainId, t.toChainAgentId, t.blockNumber),
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
 * A pending person sign-in (docs/26 F1): the nonce a person signs with
 * NEP-413 to prove control of `accountId`. Same rules as
 * `registration_challenges`: single-use (deleted when spent), five minutes,
 * a few live per requester address.
 */
export const loginChallenges = pgTable(
  'login_challenges',
  {
    nonce: text('nonce').primaryKey(),
    chainId: text('chain_id').notNull(),
    accountId: text('account_id').notNull(),
    requester: text('requester').notNull().default(''),
    expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
  },
  (t) => [index('login_challenges_account_idx').on(t.accountId, t.requester)],
);

/**
 * A person's signed-in session (docs/26 F1): a bearer token
 * `ps_<keyId>_<secret>`, distinct from an agent's `ax_` key. Only
 * `sha256$<hex>` of the whole token is stored, as for API keys. Not a cookie:
 * the site and the API are on different domains.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    /** The public half of the token; how a request finds its row. */
    keyId: text('key_id').notNull(),
    secretHash: text('secret_hash').notNull(),
    accountId: text('account_id').notNull(),
    chainId: text('chain_id').notNull(),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
    revokedAt: timestamp('revoked_at', {withTimezone: true}),
    lastUsedAt: timestamp('last_used_at', {withTimezone: true}),
    /** The client address that signed in. */
    requester: text('requester').notNull().default(''),
    /** sha256 of the account's full-access public keys at sign-in; a change ends the session (0025). */
    accessKeysHash: text('access_keys_hash'),
    /** Why it was revoked, told to the next request that presents it. */
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    uniqueIndex('sessions_key_id_uk').on(t.keyId),
    index('sessions_account_idx').on(t.accountId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
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

// ─────────────────────────── listings (docs/26 F4, F5, F6-a, F31) ───────────────────────────

export const listingCategory = pgEnum('listing_category', ['physical', 'expertise', 'judgment']);
export const interactionMode = pgEnum('interaction_mode', ['task', 'conversation', 'capture']);
/** `applications`: the client picks among priced bids. `instant`: the first eligible claimers win. */
export const hiringMode = pgEnum('hiring_mode', ['applications', 'instant']);
/**
 * open: taking applications or claims. closed: the client stopped hiring.
 * filled: every worker slot is taken. cancelled: the client withdrew it
 * before selecting anyone. A deadline that passed reads as closed.
 */
export const listingStatus = pgEnum('listing_status', ['open', 'closed', 'filled', 'cancelled']);
export const applicationStatus = pgEnum('application_status', [
  'pending',
  'selected',
  'rejected',
  'withdrawn',
]);

/**
 * Work offered to many (docs/26 F4). A listing holds no money: each selected
 * bid becomes an ordinary 1:1 Pactora job (F5). `reserved` is what posting
 * checked against the client's on-chain daily allowance: max_workers × the
 * per-worker ceiling (the contract takes its fee out of the worker's
 * payout, so the client's cost per worker is at most the ceiling).
 */
export const listings = pgTable(
  'listings',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    publicId: uuid('public_id').notNull().defaultRandom(),
    chainId: text('chain_id').notNull(),
    clientAgentId: bigint('client_agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    title: text('title').notNull(),
    description: text('description').notNull(),
    category: listingCategory('category').notNull(),
    interactionMode: interactionMode('interaction_mode').notNull(),
    /** Lower-case, at most 20. */
    skills: text('skills').array().notNull().default([]),
    location: text('location').notNull().default(''),
    /** The most the client pays ONE worker, in base units. */
    maxPrice: baseUnits('max_price').notNull(),
    maxWorkers: smallint('max_workers').notNull(),
    hiringMode: hiringMode('hiring_mode').notNull(),
    estimatedMinutes: integer('estimated_minutes').notNull(),
    deadline: timestamp('deadline', {withTimezone: true}).notNull(),
    criteria: text('criteria').notNull(),
    acceptWindowSeconds: integer('accept_window_seconds').notNull(),
    workWindowSeconds: integer('work_window_seconds').notNull(),
    status: listingStatus('status').notNull().default('open'),
    reserved: baseUnits('reserved').notNull(),
    /** The client's Idempotency-Key, and the sha256 of the body it was first used with. */
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
    closedAt: timestamp('closed_at', {withTimezone: true}),
  },
  (t) => [
    uniqueIndex('listings_public_id_uk').on(t.publicId),
    uniqueIndex('listings_client_idempotency_uk').on(t.clientAgentId, t.idempotencyKey),
    index('listings_board_idx').on(t.chainId, t.status, t.id),
    index('listings_client_idx').on(t.clientAgentId, t.id),
  ],
);

/**
 * A priced bid on a listing. `reopenable` is the explicit flag (never a
 * reason string) marking a bid rejected only because hiring closed:
 * reopening revives exactly those, and they do not count toward the 3-bid
 * limit.
 */
export const applications = pgTable(
  'applications',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    publicId: uuid('public_id').notNull().defaultRandom(),
    listingId: bigint('listing_id', {mode: 'number'})
      .notNull()
      .references(() => listings.id, {onDelete: 'cascade'}),
    applicantAgentId: bigint('applicant_agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    price: baseUnits('price').notNull(),
    proposal: text('proposal').notNull(),
    status: applicationStatus('status').notNull().default('pending'),
    /** The client's reason, shown to the applicant; or why the API closed it. */
    reason: text('reason'),
    reopenable: boolean('reopenable').notNull().default(false),
    /** The job a selection created. */
    jobId: bigint('job_id', {mode: 'number'}).references(() => jobs.id),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', {withTimezone: true}),
  },
  (t) => [
    uniqueIndex('applications_public_id_uk').on(t.publicId),
    // One live bid per applicant per listing, enforced by the database.
    uniqueIndex('applications_one_live_uk')
      .on(t.listingId, t.applicantAgentId)
      .where(sql`status IN ('pending', 'selected')`),
    index('applications_listing_idx').on(t.listingId, t.createdAt),
    index('applications_applicant_idx').on(t.applicantAgentId, t.listingId),
  ],
);

/** One row per filled worker slot (listing, slot 1..max_workers): the primary key makes over-filling impossible. */
export const listingSlots = pgTable(
  'listing_slots',
  {
    listingId: bigint('listing_id', {mode: 'number'})
      .notNull()
      .references(() => listings.id, {onDelete: 'cascade'}),
    slot: smallint('slot').notNull(),
    applicationId: bigint('application_id', {mode: 'number'})
      .notNull()
      .references(() => applications.id, {onDelete: 'cascade'}),
    jobId: bigint('job_id', {mode: 'number'}).references(() => jobs.id),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({columns: [t.listingId, t.slot]}),
    uniqueIndex('listing_slots_application_uk').on(t.applicationId),
  ],
);

/**
 * A transaction a person signs in the browser (docs/26 "prepare → sign →
 * confirm"): what the API told them to sign and, once confirmed, the
 * transaction that did it. A confirmed hash is unique per job, so a replayed
 * confirm answers the first result.
 */
export const personActions = pgTable(
  'person_actions',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    jobId: bigint('job_id', {mode: 'number'})
      .notNull()
      .references(() => jobs.id, {onDelete: 'cascade'}),
    agentId: bigint('agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    action: text('action').notNull(),
    /** The FunctionCall: receiverId, methodName, args, gas, deposit. */
    call: jsonb('call').notNull(),
    /** Off-chain words a hash commits to (a dispute's reason). */
    payload: jsonb('payload').notNull().default({}),
    txHash: text('tx_hash'),
    confirmedAt: timestamp('confirmed_at', {withTimezone: true}),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('person_actions_tx_uk').on(t.jobId, t.txHash),
    index('person_actions_job_idx').on(t.jobId, t.agentId, t.action),
  ],
);

// ─────────────────────── evidence, review, chat (docs/26 F6-F8) ───────────────────────

/**
 * An evidence photo a job's worker uploaded. The bytes are in object
 * storage under `object_key` (never in Postgres, never on the API's disk);
 * this row is what a snapshot names. `sha256` is of the STORED bytes — the
 * image after its metadata was removed. Withdrawing sets `withdrawn_at` and
 * keeps the bytes, so a snapshot that named the file stays checkable.
 */
export const jobFiles = pgTable(
  'job_files',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    publicId: uuid('public_id').notNull().defaultRandom(),
    jobId: bigint('job_id', {mode: 'number'})
      .notNull()
      .references(() => jobs.id, {onDelete: 'cascade'}),
    uploaderAgentId: bigint('uploader_agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    objectKey: text('object_key').notNull(),
    sha256: text('sha256').notNull(),
    /** Detected from the bytes, never the client's Content-Type. */
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
    withdrawnAt: timestamp('withdrawn_at', {withTimezone: true}),
  },
  (t) => [
    uniqueIndex('job_files_public_id_uk').on(t.publicId),
    uniqueIndex('job_files_object_key_uk').on(t.objectKey),
    index('job_files_job_idx').on(t.jobId, t.id),
  ],
);

/**
 * One draft round: an immutable snapshot of what the worker delivers (the
 * job's terms, their text and output, the active files' hashes, the chat)
 * and its sha256. The hash of the accepted draft is the `result_hash` the
 * worker submits on chain, so no contract change is needed for revisions.
 */
export const jobDrafts = pgTable(
  'job_drafts',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    publicId: uuid('public_id').notNull().defaultRandom(),
    jobId: bigint('job_id', {mode: 'number'})
      .notNull()
      .references(() => jobs.id, {onDelete: 'cascade'}),
    round: smallint('round').notNull(),
    authorAgentId: bigint('author_agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    snapshot: jsonb('snapshot').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('job_drafts_public_id_uk').on(t.publicId),
    uniqueIndex('job_drafts_snapshot_hash_uk').on(t.snapshotHash),
    uniqueIndex('job_drafts_round_uk').on(t.jobId, t.round),
  ],
);

export const reviewDecision = pgEnum('review_decision', ['revise', 'accept_draft', 'dispute_intent']);

/** The client's decision on one draft, written once (the unique draft id), bound to its snapshot hash. */
export const jobReviews = pgTable(
  'job_reviews',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    publicId: uuid('public_id').notNull().defaultRandom(),
    draftId: bigint('draft_id', {mode: 'number'})
      .notNull()
      .references(() => jobDrafts.id, {onDelete: 'cascade'}),
    jobId: bigint('job_id', {mode: 'number'})
      .notNull()
      .references(() => jobs.id, {onDelete: 'cascade'}),
    decision: reviewDecision('decision').notNull(),
    reason: text('reason').notNull(),
    /** [{criterion, met, support}], 1-30. */
    checks: jsonb('checks').notNull(),
    /** sha256 of the canonical review payload; the `review_hash` an approval carries. */
    reviewHash: text('review_hash').notNull(),
    decidedBy: bigint('decided_by', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('job_reviews_public_id_uk').on(t.publicId),
    uniqueIndex('job_reviews_draft_uk').on(t.draftId),
    index('job_reviews_job_idx').on(t.jobId, t.id),
  ],
);

/** A message between a job's two parties. Untrusted input to any model that reads it. */
export const jobMessages = pgTable(
  'job_messages',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    publicId: uuid('public_id').notNull().defaultRandom(),
    jobId: bigint('job_id', {mode: 'number'})
      .notNull()
      .references(() => jobs.id, {onDelete: 'cascade'}),
    authorAgentId: bigint('author_agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    body: text('body').notNull(),
    inReplyTo: bigint('in_reply_to', {mode: 'number'}),
    /** The author's optional key: the same key and body is the same message. */
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('job_messages_public_id_uk').on(t.publicId),
    uniqueIndex('job_messages_idempotency_uk').on(t.jobId, t.authorAgentId, t.idempotencyKey),
    index('job_messages_job_idx').on(t.jobId, t.id),
  ],
);

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

// ──────────────── events, webhooks, notifications, faucet (docs/26 F9, F10, F23) ────────────────

/**
 * The next sequence number per agent. A trigger on job_events takes this row
 * FOR UPDATE, so two writers for one agent serialise and the sequence has no
 * gaps; writers for different agents never wait on each other.
 */
export const agentEventSeq = pgTable('agent_event_seq', {
  agentId: bigint('agent_id', {mode: 'number'})
    .primaryKey()
    .references(() => agents.id, {onDelete: 'cascade'}),
  last: bigint('last', {mode: 'number'}).notNull().default(0),
});

/**
 * Every job event, once per party (client and worker), numbered per agent.
 * Written by the trigger in the same transaction as the job_events row, by
 * the API and the indexer alike. `GET /v1/events?after=<seq>` reads it.
 *
 * Since 0024 a row may name a LISTING instead of a job (a bid, a selection,
 * a closed or expired listing, a match), written by `pactora_agent_event()`
 * with the same numbering; `dedupe_key` makes each such event exactly once.
 */
export const agentEvents = pgTable(
  'agent_events',
  {
    agentId: bigint('agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    seq: bigint('seq', {mode: 'number'}).notNull(),
    /** Null for a listing or account event. */
    jobEventId: bigint('job_event_id', {mode: 'number'}).references(() => jobEvents.id, {
      onDelete: 'cascade',
    }),
    jobId: bigint('job_id', {mode: 'number'}).references(() => jobs.id, {onDelete: 'cascade'}),
    listingId: bigint('listing_id', {mode: 'number'}).references(() => listings.id, {onDelete: 'cascade'}),
    /** The agent's side: 'client' or 'worker' of a job; 'applicant', 'match' or 'account' otherwise. */
    role: text('role').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    /** Writer-chosen; unique per agent, so a retried write is a no-op. */
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({columns: [t.agentId, t.seq]}),
    uniqueIndex('agent_events_once_uk').on(t.agentId, t.jobEventId),
    uniqueIndex('agent_events_dedupe_uk')
      .on(t.agentId, t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL`),
  ],
);

/** A person's notifications are their person agent's events; this is how far they have read. */
export const agentEventReads = pgTable('agent_event_reads', {
  agentId: bigint('agent_id', {mode: 'number'})
    .primaryKey()
    .references(() => agents.id, {onDelete: 'cascade'}),
  readSeq: bigint('read_seq', {mode: 'number'}).notNull().default(0),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
});

export const webhooks = pgTable(
  'webhooks',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    publicId: uuid('public_id').notNull().defaultRandom(),
    agentId: bigint('agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    url: text('url').notNull(),
    /** The signing secret, AES-256-GCM under WEBHOOK_SECRET_KEY: iv.tag.ciphertext, base64url. */
    secretEnc: text('secret_enc').notNull(),
    /** Event kinds to deliver; empty = every kind. */
    kinds: text('kinds')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    active: boolean('active').notNull().default(true),
    /** Deliveries given up in a row; the hook is switched off at the limit. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    disabledReason: text('disabled_reason'),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', {withTimezone: true}),
  },
  (t) => [uniqueIndex('webhooks_public_id_uk').on(t.publicId), index('webhooks_agent_idx').on(t.agentId)],
);

/**
 * One row per (hook, agent event). Queued by the same trigger, claimed by the
 * notifier with FOR UPDATE SKIP LOCKED, sent with no transaction open.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    publicId: uuid('public_id').notNull().defaultRandom(),
    webhookId: bigint('webhook_id', {mode: 'number'})
      .notNull()
      .references(() => webhooks.id, {onDelete: 'cascade'}),
    agentId: bigint('agent_id', {mode: 'number'}).notNull(),
    seq: bigint('seq', {mode: 'number'}).notNull(),
    /** pending → delivered | failed; `leased_until` marks one being sent. */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', {withTimezone: true}).notNull().defaultNow(),
    leasedUntil: timestamp('leased_until', {withTimezone: true}),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', {withTimezone: true}),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_public_id_uk').on(t.publicId),
    uniqueIndex('webhook_deliveries_once_uk').on(t.webhookId, t.agentId, t.seq),
    index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt),
  ],
);

/** Test-token claims (testnet and sandbox only), counted per account, per IP and per day. */
export const faucetClaims = pgTable(
  'faucet_claims',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    chainId: text('chain_id').notNull(),
    account: text('account').notNull(),
    ip: text('ip').notNull(),
    amount: numeric('amount', {precision: 78, scale: 0}).notNull(),
    /** The UTC day the claim counts against. */
    day: text('day').notNull(),
    status: text('status').notNull().default('pending'),
    txHash: text('tx_hash'),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('faucet_claims_account_day_uk').on(t.chainId, t.account, t.day),
    index('faucet_claims_ip_day_idx').on(t.ip, t.day),
    index('faucet_claims_day_idx').on(t.chainId, t.day),
  ],
);

// ──────────────── public profiles and two-way reviews (docs/26 F16, F17) ────────────────

/**
 * What an agent or a person chose to show in the public directory. Nothing
 * is public until `published`; the account id is shown only with
 * `show_account`. One row per agent, created on the first edit.
 */
export const publicProfiles = pgTable(
  'public_profiles',
  {
    agentId: bigint('agent_id', {mode: 'number'})
      .primaryKey()
      .references(() => agents.id, {onDelete: 'cascade'}),
    published: boolean('published').notNull().default(false),
    displayName: text('display_name').notNull(),
    headline: text('headline').notNull().default(''),
    bio: text('bio').notNull().default(''),
    showAccount: boolean('show_account').notNull().default(false),
    /** Lower-case tags, at most 20 (0026). */
    skills: text('skills')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** "City" or "City, Region"; mirrored to agents.location, which matching reads. */
    location: text('location').notNull().default(''),
    /** "Open to work": shown, filterable, and a condition for listing.match alerts. */
    available: boolean('available').notNull().default(false),
    /** Show open listings and job counts on the public profile. */
    showTaskList: boolean('show_task_list').notNull().default(false),
    /** Receive a listing.match feed event for a new listing that matches. */
    alerts: boolean('alerts').notNull().default(false),
    publishedAt: timestamp('published_at', {withTimezone: true}),
    updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [index('public_profiles_published_idx').on(t.published, t.updatedAt)],
);

/**
 * One written review per party per settled job: the client of the worker,
 * and the worker of the client. Blind: neither is shown until both are in,
 * or the review window (14 days from settlement) has closed. Moderation
 * hides a review (`hidden_at`) without deleting it.
 */
export const partyReviews = pgTable(
  'party_reviews',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    publicId: uuid('public_id').notNull().defaultRandom(),
    jobId: bigint('job_id', {mode: 'number'})
      .notNull()
      .references(() => jobs.id, {onDelete: 'cascade'}),
    authorAgentId: bigint('author_agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    subjectAgentId: bigint('subject_agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    /** The author's side of the job. */
    authorRole: text('author_role').notNull(),
    rating: smallint('rating').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
    hiddenAt: timestamp('hidden_at', {withTimezone: true}),
    hiddenReason: text('hidden_reason'),
  },
  (t) => [
    uniqueIndex('party_reviews_public_id_uk').on(t.publicId),
    uniqueIndex('party_reviews_once_uk').on(t.jobId, t.authorAgentId),
    index('party_reviews_subject_idx').on(t.subjectAgentId, t.createdAt),
  ],
);

// ──────────────── identity, sanctions screening, standing (docs/26 F13, F14, F27) ────────────────

/** One fetched copy of a sanctions list. Exactly one `active` per source (partial unique index, 0020). */
export const sanctionsListVersions = pgTable('sanctions_list_versions', {
  id: bigserial('id', {mode: 'number'}).primaryKey(),
  source: text('source').notNull(),
  sha256: text('sha256').notNull(),
  entryCount: integer('entry_count').notNull(),
  active: boolean('active').notNull().default(false),
  fetchedAt: timestamp('fetched_at', {withTimezone: true}).notNull().defaultNow(),
});

export const sanctionsEntries = pgTable(
  'sanctions_entries',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    versionId: bigint('version_id', {mode: 'number'})
      .notNull()
      .references(() => sanctionsListVersions.id, {onDelete: 'cascade'}),
    source: text('source').notNull(),
    ref: text('ref').notNull(),
    kind: text('kind').notNull(),
    names: text('names').array().notNull(),
    /** Digital currency addresses the list gives, `TICKER address`. */
    addresses: text('addresses')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [index('sanctions_entries_version_idx').on(t.versionId, t.kind)],
);

/**
 * A person's identity check with a provider. Only what is needed is kept:
 * the outcome, whether an identity document was verified, and the
 * provider's session id. Never the document itself.
 */
export const identityVerifications = pgTable(
  'identity_verifications',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    publicId: uuid('public_id').notNull().defaultRandom(),
    agentId: bigint('agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    provider: text('provider').notNull(),
    providerSessionId: text('provider_session_id'),
    /** screening → pending → approved | rejected | expired; held = stopped by a sanctions match. */
    status: text('status').notNull().default('screening'),
    documentVerified: boolean('document_verified').notNull().default(false),
    /** The name screened before any vendor session was created. */
    legalName: text('legal_name').notNull(),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', {withTimezone: true}),
  },
  (t) => [
    uniqueIndex('identity_verifications_public_id_uk').on(t.publicId),
    uniqueIndex('identity_verifications_session_uk').on(t.provider, t.providerSessionId),
    index('identity_verifications_agent_idx').on(t.agentId, t.createdAt),
  ],
);

/** clear | hold | blocked. No row = clear. Every change is in compliance_audit. */
export const accountStanding = pgTable('account_standing', {
  agentId: bigint('agent_id', {mode: 'number'})
    .primaryKey()
    .references(() => agents.id, {onDelete: 'cascade'}),
  standing: text('standing').notNull(),
  reason: text('reason').notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
});

/** A screening hit for reviewers: open → cleared | confirmed. */
export const complianceCases = pgTable(
  'compliance_cases',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    publicId: uuid('public_id').notNull().defaultRandom(),
    agentId: bigint('agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    /** The account the case is about: a reviewer may never decide their own. */
    subjectAccount: text('subject_account').notNull(),
    source: text('source').notNull(),
    entryRef: text('entry_ref').notNull(),
    queryName: text('query_name').notNull(),
    matchedName: text('matched_name').notNull(),
    score: numeric('score', {precision: 5, scale: 4}).notNull(),
    /** strong: needs two different reviewers to clear. */
    strength: text('strength').notNull(),
    status: text('status').notNull().default('open'),
    /** Bumped by each decision; a decision names the version it read (stale → 409). */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
    closedAt: timestamp('closed_at', {withTimezone: true}),
  },
  (t) => [
    uniqueIndex('compliance_cases_public_id_uk').on(t.publicId),
    index('compliance_cases_status_idx').on(t.status, t.createdAt),
  ],
);

export const complianceDecisions = pgTable(
  'compliance_decisions',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    caseId: bigint('case_id', {mode: 'number'})
      .notNull()
      .references(() => complianceCases.id, {onDelete: 'cascade'}),
    reviewer: text('reviewer').notNull(),
    decision: text('decision').notNull(),
    reason: text('reason').notNull(),
    caseVersion: integer('case_version').notNull(),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  },
  // One decision per reviewer per case: a second is a replay or a conflict.
  (t) => [uniqueIndex('compliance_decisions_once_uk').on(t.caseId, t.reviewer)],
);

/** Append-only: a trigger (0020) refuses UPDATE and DELETE. */
export const complianceAudit = pgTable(
  'compliance_audit',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    at: timestamp('at', {withTimezone: true}).notNull().defaultNow(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    agentId: bigint('agent_id', {mode: 'number'}),
    caseId: bigint('case_id', {mode: 'number'}),
    detail: jsonb('detail').notNull().default({}),
  },
  (t) => [index('compliance_audit_agent_idx').on(t.agentId, t.at)],
);

// ──────────────── channels: Telegram and email (docs/26 F11, F12) ────────────────

/** A person's verified address on a channel: a Telegram chat id, or an email. */
export const channelLinks = pgTable(
  'channel_links',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    agentId: bigint('agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    channel: text('channel').notNull(),
    address: text('address').notNull(),
    /** The last agent_events seq already pushed to this link. */
    cursorSeq: bigint('cursor_seq', {mode: 'number'}).notNull().default(0),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channel_links_address_uk').on(t.channel, t.address),
    uniqueIndex('channel_links_agent_uk').on(t.agentId, t.channel),
  ],
);

/**
 * A linking code: shown in the browser with a 4-digit number, typed into
 * the channel. 10 minutes; 3 wrong numbers cancel it.
 */
export const linkCodes = pgTable(
  'link_codes',
  {
    code: text('code').primaryKey(),
    agentId: bigint('agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    channel: text('channel').notNull(),
    /** The number the person must type in the channel (Telegram) or the code sent (email). */
    secret: text('secret').notNull(),
    /** Telegram: the chat that presented the code and must now type the number. */
    pendingAddress: text('pending_address'),
    /** Email: the address being verified. */
    address: text('address'),
    tries: integer('tries').notNull().default(0),
    expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [index('link_codes_agent_idx').on(t.agentId, t.createdAt)],
);

/** Bad linking codes per channel address; 5 lock it for 15 minutes, across restarts. */
export const channelFailures = pgTable(
  'channel_failures',
  {
    channel: text('channel').notNull(),
    address: text('address').notNull(),
    failures: integer('failures').notNull().default(0),
    lockedUntil: timestamp('locked_until', {withTimezone: true}),
    updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [primaryKey({columns: [t.channel, t.address]})],
);

/** Inbound updates, once each (the provider's id), handled in order. */
export const channelInbox = pgTable(
  'channel_inbox',
  {
    channel: text('channel').notNull(),
    updateId: bigint('update_id', {mode: 'number'}).notNull(),
    address: text('address').notNull(),
    text: text('text').notNull().default(''),
    handled: boolean('handled').notNull().default(false),
    receivedAt: timestamp('received_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({columns: [t.channel, t.updateId]}),
    index('channel_inbox_address_idx').on(t.channel, t.address, t.receivedAt),
  ],
);

/** Outbound messages: sent once, dropped after 24 h, text scrubbed once sent. */
export const channelOutbox = pgTable(
  'channel_outbox',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    channel: text('channel').notNull(),
    address: text('address').notNull(),
    body: text('body').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', {withTimezone: true}).notNull().defaultNow(),
    leasedUntil: timestamp('leased_until', {withTimezone: true}),
    errorClass: text('error_class'),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
    sentAt: timestamp('sent_at', {withTimezone: true}),
  },
  (t) => [index('channel_outbox_due_idx').on(t.status, t.nextAttemptAt)],
);
