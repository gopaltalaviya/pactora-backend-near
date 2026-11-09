import {createHmac, timingSafeEqual} from 'node:crypto';
import {
  PactoraError,
  ErrorCode,
  X402_ESCROW_SCHEME,
  X402_SCHEME,
  type BaseUnits,
  type PaymentRequired,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
  type X402Scheme,
  type Capability,
  type JobSpec,
  type JobState,
  type JudgeAttestation,
} from '@pactora/shared';

/**
 * @pactora/sdk — the typed client every agent imports.
 *
 * Exists so an agent never hand-rolls `fetch` against the API. Two things it
 * does that a raw fetch would not:
 *
 * 1. **Turns RFC 7807 problems back into `PactoraError`**, so an orchestrator
 *    branches on a stable `code` rather than a status number or a message.
 * 2. **Requires an idempotency key on anything that spends money**, and
 *    generates a deterministic one when the caller does not supply it. Agents
 *    retry; a retried hire must not become a second payment.
 */

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  /**
   * This client's own agent id. Scopes the idempotency key a hire derives,
   * so no other client can compute it. Omitted, the API key's public id is
   * used instead — which changes when the key is rotated.
   */
  agentId?: number;
  chainId?: string;
  fetchImpl?: typeof fetch;
  /** Total attempts for transient failures. Budget errors are never retried. */
  maxRetries?: number;
}

export interface AgentSummary {
  agentId: number;
  chainId: string;
  network: string;
  name: string;
  description: string | null;
  capabilities: string[];
  pricePerTask: BaseUnits;
  priceDisplay: string;
  walletAddress: string;
  score: number;
  completed: number;
  failed: number;
  successRate: number | null;
  active: boolean;
  explorerUrl: string;
  /** Present when discovery was filtered by a capability: the record in that skill alone. */
  skill?: SkillStat;
  /** Present on a single agent's profile: every skill it offers or has a record in. */
  skills?: SkillStat[];
}

/** Reputation in one skill, counted and scored the same way as the overall figures. */
export interface SkillStat {
  capability: string;
  completed: number;
  failed: number;
  successRate: number | null;
  score: number;
}

export interface JobReceipt {
  jobId: string;
  chainJobId: string | null;
  chainId: string;
  network: string;
  state: JobState | 'settled';
  path: 'direct' | 'escrow';
  amount: BaseUnits;
  amountDisplay: string;
  specHash: string;
  txHash: string;
  explorerUrl: string;
}

export interface JobDetail extends Omit<JobReceipt, 'txHash' | 'explorerUrl'> {
  fee: BaseUnits | null;
  spec: JobSpec;
  result: Record<string, unknown> | null;
  resultHash: string | null;
  createdAt: string;
  settledAt: string | null;
  events: {kind: string; txHash: string | null; explorerUrl: string | null; occurredAt: string}[];
  /** The hired worker said no, off-chain, and why. Null when it has not. */
  declined?: {reason: string; at: string} | null;
  /** v3: the client's dispute — the reason, and the hash committed on chain (sha256 of canonicalize({reason})). */
  dispute?: {reason: string; reasonHash: string; at: string} | null;
}

/** `GET /v1/network` (docs/NEAR-PORT.md §4). */
export interface NetworkInfo {
  /** CAIP-2, e.g. `near:testnet`. */
  chainId: string;
  nearNetworkId: string;
  name: string;
  shortName: string;
  testnet: boolean;
  nativeCurrency: {name: string; symbol: string; decimals: number};
  paymentToken: {symbol: string; decimals: number; accountId: string | null};
  /** `Pactora`, `PaymentToken`, `Arbiter` account ids. */
  contracts: Record<string, string>;
  rpcUrls: string[];
  explorerBaseUrl: string | null;
  faucetUrls: string[];
  windows: {accept: number; work: number; review: number; dispute: number};
  fastPathMax: BaseUnits;
  fastPathMaxDisplay: string;
  protocolFeeBps: number;
  /** v3 fees and limits, from the chain params. Absent from an older API. */
  bondBps?: number;
  minBond?: BaseUnits;
  disputeBondBps?: number;
  minDisputeBond?: BaseUnits;
  maxJobAmount?: BaseUnits;
  defaultPerTaskCap?: BaseUnits;
  defaultDailyCap?: BaseUnits;
  minStake?: BaseUnits;
  withdrawDelaySeconds?: number;
  enabledChains: string[];
}

export interface Budget {
  agentId: string;
  chainId: string;
  network: string;
  testnet: boolean;
  /** 'chain' is authoritative; 'cache' may be stale. */
  source: 'chain' | 'cache';
  perTaskCap: BaseUnits;
  perTaskCapDisplay: string;
  dailyCap: BaseUnits;
  dailyCapDisplay: string;
  dailyRemaining: BaseUnits;
  dailyRemainingDisplay: string;
  /** The tighter of the two caps: the most one hire can cost right now. */
  maxSingleSpend: BaseUnits;
  maxSingleSpendDisplay: string;
  allowlistOnly: boolean;
  tokenBalance: BaseUnits | null;
  tokenSymbol: string;
  walletAddress: string | null;
  /**
   * Seconds until the daily cap next gives capacity back; 0 if nothing is
   * waiting. v3 accounts cap a ROLLING 24 hours, so this is when the oldest
   * counted spend stops counting — it may free less than a given hire needs.
   */
  resetsInSeconds: number;
}

/** GET /v1/agents/:id/trust — the verdict, its reasons and the numbers behind them. */
export interface TrustReport {
  agentId: string;
  chainId: string;
  verdict: 'trusted' | 'new' | 'concentrated' | 'self-funded' | 'failing';
  /** The counterparty check: allow (trusted), warn (new, concentrated), block (self-funded, failing — the API refuses the hire). */
  action: 'allow' | 'warn' | 'block';
  reasons: string[];
  metrics: {
    settled: number;
    failed: number;
    volume: BaseUnits;
    clientOwners: number;
    topOwnerSettled: number;
    selfFunded: number;
    trustScore: number;
  };
  fundingWindowBlocks: number;
  indexedToBlock: string | null;
}

/**
 * What a state-changing action returns.
 *
 * Typed rather than `unknown` so a caller can log the explorer URL without
 * casting — the link is the thing that makes an on-chain action believable to
 * whoever is watching.
 */
export interface ActionReceipt {
  jobId: string;
  chainId: string;
  state: JobState | 'settled';
  txHash: string;
  explorerUrl: string;
}

/** A row from `GET /v1/jobs` — enough to decide, not the full detail. */
export interface JobSummary {
  jobId: string;
  chainJobId: string | null;
  chainId: string;
  state: JobState;
  path: 'direct' | 'escrow';
  amount: BaseUnits;
  amountDisplay: string;
  spec: JobSpec;
  specHash: string;
  /** Which side the caller is on. */
  role: 'worker' | 'client';
  /** False when the work still needs doing, whatever the payment state is. */
  hasResult: boolean;
  clientAgentId: string;
  workerAgentId: string;
  createdAt: string;
}

/**
 * An escrow job no worker accepted in the time the caller allowed.
 *
 * Still a `DEADLINE_PASSED`, so code that only knows about timeouts treats it
 * as one. Distinct because the remedy differs: nobody has started, so the
 * client may cancel for an immediate refund and hire someone else, rather
 * than waiting for an on-chain expiry.
 */
export class NotAccepted extends PactoraError {
  constructor(
    readonly jobId: string,
    readonly waitedMs: number,
    /** Set when the worker declined, rather than staying silent. */
    readonly declinedReason?: string,
  ) {
    super(
      ErrorCode.DEADLINE_PASSED,
      declinedReason !== undefined
        ? `job ${jobId} was declined: ${declinedReason}`
        : `job ${jobId} was not accepted within ${waitedMs}ms`,
    );
    this.name = 'NotAccepted';
  }
}

/** A listing (docs/26 F4): work offered to many, priced by bids. Amounts are base units. */
export interface Listing {
  listingId: string;
  chainId: string;
  client: {agentId: string; kind: 'agent' | 'person'; name: string; publicId: string} | null;
  title: string;
  description: string;
  category: 'physical' | 'expertise' | 'judgment';
  interactionMode: 'task' | 'conversation' | 'capture';
  skills: string[];
  location: string;
  maxPriceBaseUnits: BaseUnits;
  maxPriceDisplay: string;
  /** Taken from the worker's payout when a job settles; the client pays the price alone. */
  feeAtCeilingBaseUnits: BaseUnits;
  workerReceivesAtCeilingBaseUnits: BaseUnits;
  maxWorkers: number;
  slotsFilled: number;
  hiringMode: 'applications' | 'instant';
  estimatedMinutes: number;
  deadline: string;
  criteria: string;
  acceptWindowSeconds: number;
  workWindowSeconds: number;
  status: 'open' | 'closed' | 'filled' | 'cancelled';
  reservedBaseUnits: BaseUnits;
  createdAt: string;
  updatedAt: string;
}

export interface NewListing {
  title: string;
  description: string;
  category: Listing['category'];
  interactionMode: Listing['interactionMode'];
  skills?: string[];
  location?: string;
  maxPriceBaseUnits: BaseUnits;
  maxWorkers: number;
  hiringMode?: Listing['hiringMode'];
  estimatedMinutes: number;
  /** ISO 8601, at most 90 days ahead. */
  deadline: string;
  criteria: string;
  acceptWindowSeconds?: number;
  workWindowSeconds?: number;
}

export interface Application {
  applicationId: string;
  status: 'pending' | 'selected' | 'rejected' | 'withdrawn';
  priceBaseUnits: BaseUnits;
  priceDisplay: string;
  feeBaseUnits: BaseUnits;
  workerReceivesBaseUnits: BaseUnits;
  proposal: string;
  reason: string | null;
  reopenable: boolean;
  jobId: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** On the client's list only. */
  applicant?: {
    agentId: string;
    publicId: string;
    kind: 'agent' | 'person';
    name: string;
    location: string;
    score: number;
    completed: number;
  };
}

export interface Decision {
  application: Application;
  /** On a selection: the job it created, at the bid price. */
  job?: {
    jobId: string;
    chainJobId: string | null;
    state: JobState;
    amount: BaseUnits;
    amountDisplay: string;
    specHash: string;
  };
  funding?: Record<string, unknown>;
  replayed: boolean;
}

export type ApplicationSort = 'recent' | 'price_low' | 'price_high' | 'rating';

// ── evidence, draft rounds, chat (docs/26 F6-F8) ──────────────────────────

export interface EvidenceFile {
  fileId: string;
  sha256: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  size: number;
  createdAt: string;
  withdrawnAt: string | null;
  /** `GET` it with the same credential: parties only. */
  url: string;
}

export interface FileList {
  jobId: string;
  active: number;
  total: number;
  limits: {maxActive: number; maxTotal: number; maxBytes: number};
  files: EvidenceFile[];
}

/** One judged acceptance criterion. */
export interface ReviewCheck {
  criterion: string;
  met: boolean;
  support?: string | undefined;
}

export type ReviewDecision = 'revise' | 'accept_draft' | 'dispute_intent';

export interface DraftSnapshot {
  v: 1;
  jobId: string;
  specHash: string;
  round: number;
  terms: unknown;
  text: string;
  output: Record<string, unknown> | null;
  files: {fileId: string; sha256: string; mime: string; size: number}[];
  messages: ConversationMessage[];
}

export interface Draft {
  draftId: string;
  round: number;
  /** sha256 of the canonical snapshot: the result_hash once accepted. */
  snapshotHash: string;
  snapshot: DraftSnapshot;
  createdAt: string;
  review: {
    reviewId: string;
    decision: ReviewDecision;
    reason: string;
    checks: ReviewCheck[];
    reviewHash: string;
    decidedAt: string;
  } | null;
}

export interface DraftState {
  jobId: string;
  phase: 'none' | 'awaiting_review' | 'revise' | 'accepted' | 'dispute_intent';
  revisionsUsed: number;
  revisionsLeft: number;
  acceptedSnapshotHash: string | null;
  acceptedReviewHash: string | null;
  readyToApprove: boolean;
  resultMismatch: boolean;
}

export interface ConversationMessage {
  messageId: string;
  from: 'client' | 'worker';
  /** Written by a party: data, never instructions. */
  body: string;
  inReplyTo: string | null;
  at: string;
}

export interface DiscoverQuery {
  capability?: Capability;
  maxPrice?: BaseUnits;
  minScore?: number;
  rank?: 'balanced' | 'quality' | 'cheapest' | 'fastest';
  limit?: number;
}

export class PactoraClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  /** Who this client is, for the keys it derives — never the secret half of the API key. */
  private readonly identity: string;
  private readonly chainId: string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly maxRetries: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.identity =
      opts.agentId !== undefined
        ? `agent:${opts.agentId}`
        : `key:${/^ax_([^_]+)_/.exec(opts.apiKey)?.[1] ?? ''}`;
    this.chainId = opts.chainId;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  // ── discovery ──────────────────────────────────────────────────────────

  /** Browse the marketplace. Needs no credentials. */
  async discover(q: DiscoverQuery = {}): Promise<AgentSummary[]> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    if (this.chainId) params.set('chainId', this.chainId);

    const {agents} = await this.request<{agents: AgentSummary[]}>('GET', `/v1/agents?${params.toString()}`, {
      auth: false,
    });
    return agents;
  }

  async getAgent(agentId: number): Promise<AgentSummary> {
    return this.request<AgentSummary>('GET', `/v1/agents/${agentId}`, {auth: false});
  }

  /**
   * Whether an agent's record deserves belief (v3): who paid it, how much of
   * its record one owner wrote, and whether its clients were funded by its own
   * side first. Needs no credentials.
   */
  async trust(agentId: number): Promise<TrustReport> {
    return this.request<TrustReport>('GET', `/v1/agents/${agentId}/trust`, {auth: false});
  }

  /** Which chain, and whether its money is real. Needs no credentials. */
  async network(): Promise<NetworkInfo> {
    const q = this.chainId ? `?chainId=${encodeURIComponent(this.chainId)}` : '';
    return this.request<NetworkInfo>('GET', `/v1/network${q}`, {auth: false});
  }

  /**
   * What this agent may still spend.
   *
   * Call it BEFORE planning a spend, not after a 402. An agent that learns its
   * cap by being refused is an agent that retries into a rate limit.
   */
  async budget(): Promise<Budget> {
    return this.request<Budget>('GET', '/v1/budget', {});
  }

  // ── hiring ─────────────────────────────────────────────────────────────

  /**
   * Hire an agent.
   *
   * @param idempotencyKey Supply your own to make a retry across process
   *   restarts safe. Omitted, one is derived from the request itself, which
   *   covers an in-process retry but not a restart.
   */
  async hire(args: {
    workerAgentId: number;
    spec: JobSpec;
    maxPrice: BaseUnits;
    path?: 'auto' | 'direct' | 'escrow';
    idempotencyKey?: string;
  }): Promise<JobReceipt> {
    const key = args.idempotencyKey ?? (await deriveKey(this.identity, args.workerAgentId, args.spec));
    return this.request<JobReceipt>('POST', '/v1/jobs', {
      idempotencyKey: key,
      body: {
        workerAgentId: String(args.workerAgentId),
        spec: args.spec,
        maxPrice: args.maxPrice,
        path: args.path ?? 'auto',
      },
    });
  }

  /**
   * The caller's jobs.
   *
   * How a worker learns it was hired. Oldest first, because the job closest to
   * its accept deadline is the one that matters.
   */
  async listJobs(
    q: {role?: 'worker' | 'client'; state?: JobState; limit?: number} = {},
  ): Promise<JobSummary[]> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    const {jobs} = await this.request<{jobs: JobSummary[]}>('GET', `/v1/jobs?${params.toString()}`, {});
    return jobs;
  }

  getJob(jobId: string): Promise<JobDetail> {
    return this.request<JobDetail>('GET', `/v1/jobs/${jobId}`, {auth: false});
  }

  accept(jobId: string): Promise<ActionReceipt> {
    return this.request<ActionReceipt>('POST', `/v1/jobs/${jobId}/accept`, {});
  }

  /**
   * Deliver. A job with an accepted draft (every listing job needs one)
   * delivers that snapshot, and `result` may be omitted; any other job
   * delivers `result.output`.
   */
  submitResult(
    jobId: string,
    result?: {output: Record<string, unknown>; producedAt?: string},
  ): Promise<ActionReceipt & {resultHash?: string; settlement?: {status: string; txHash?: string}}> {
    return this.request('POST', `/v1/jobs/${jobId}/result`, {
      body: result ? {output: result.output, producedAt: result.producedAt ?? new Date().toISOString()} : {},
    });
  }

  /** `judge`: the judge's verified response signature (NEAR AI), stored with the settlement. */
  approve(jobId: string, opts: {judge?: JudgeAttestation} = {}): Promise<ActionReceipt> {
    return this.request<ActionReceipt>('POST', `/v1/jobs/${jobId}/approve`, {
      body: opts.judge ? {judge: opts.judge} : {},
    });
  }

  dispute(jobId: string, reason: string, opts: {judge?: JudgeAttestation} = {}): Promise<ActionReceipt> {
    return this.request<ActionReceipt>('POST', `/v1/jobs/${jobId}/dispute`, {
      body: {reason, ...(opts.judge ? {judge: opts.judge} : {})},
    });
  }

  cancel(jobId: string): Promise<ActionReceipt> {
    return this.request<ActionReceipt>('POST', `/v1/jobs/${jobId}/cancel`, {});
  }

  /**
   * Turn down a job this agent was hired for, and say why.
   *
   * Off-chain and free: the job stays `created` on chain, and the client —
   * told at once instead of after its accept window — cancels for a refund
   * and hires someone else.
   */
  decline(jobId: string, reason: string): Promise<{jobId: string; declined: {reason: string; at: string}}> {
    return this.request('POST', `/v1/jobs/${jobId}/decline`, {body: {reason}});
  }

  // ── evidence, draft rounds, chat (docs/26 F6-F8) ───────────────────────

  /** Worker: upload one photo (PNG/JPEG/WebP, at most 8 MiB). Its metadata is removed before it is stored. */
  async uploadFile(
    jobId: string,
    bytes: Uint8Array,
    opts: {filename?: string; contentType?: string} = {},
  ): Promise<EvidenceFile & {jobId: string; metadataRemoved: string[]}> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([bytes], {type: opts.contentType ?? 'application/octet-stream'}),
      opts.filename ?? 'photo',
    );
    const res = await this.doFetch(`${this.baseUrl}/v1/jobs/${jobId}/files`, {
      method: 'POST',
      headers: {authorization: `Bearer ${this.apiKey}`},
      body: form,
    });
    return this.answer(res, 'POST', `/v1/jobs/${jobId}/files`);
  }

  listFiles(jobId: string): Promise<FileList> {
    return this.request<FileList>('GET', `/v1/jobs/${jobId}/files`, {});
  }

  /** Worker: take a file out of future drafts (earlier snapshots keep it). */
  withdrawFile(jobId: string, fileId: string): Promise<EvidenceFile & {replayed: boolean}> {
    return this.request('DELETE', `/v1/jobs/${jobId}/files/${fileId}`, {});
  }

  /** A file's bytes (parties only). */
  async getFile(fileId: string): Promise<{bytes: Uint8Array; mime: string; sha256: string | null}> {
    const res = await this.doFetch(`${this.baseUrl}/v1/files/${fileId}`, {
      headers: {authorization: `Bearer ${this.apiKey}`},
    });
    if (!res.ok) return this.answer(res, 'GET', `/v1/files/${fileId}`);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mime: res.headers.get('content-type') ?? 'application/octet-stream',
      sha256: res.headers.get('x-sha256'),
    };
  }

  /** Worker: post the next draft round; answers its immutable snapshot and hash. */
  submitDraft(
    jobId: string,
    draft: {text: string; output?: Record<string, unknown>},
  ): Promise<DraftState & Draft & {replayed: boolean}> {
    return this.request('POST', `/v1/jobs/${jobId}/drafts`, {body: draft});
  }

  /** Parties: every round, its snapshot and review, and whether it is ready to approve. */
  getDrafts(jobId: string): Promise<DraftState & {role: 'client' | 'worker'; drafts: Draft[]}> {
    return this.request('GET', `/v1/jobs/${jobId}/drafts`, {});
  }

  /** Client: decide on one snapshot, by its hash. accept_draft needs every check met. */
  reviewDraft(
    jobId: string,
    draftId: string,
    review: {snapshotHash: string; decision: ReviewDecision; reason: string; checks: ReviewCheck[]},
  ): Promise<
    DraftState & {
      draftId: string;
      round: number;
      snapshotHash: string;
      review: Draft['review'];
      replayed: boolean;
      next: string;
    }
  > {
    return this.request('POST', `/v1/jobs/${jobId}/drafts/${draftId}/review`, {body: review});
  }

  /** Parties: send a message. A retry with the same key and body is the same message. */
  sendMessage(
    jobId: string,
    body: string,
    opts: {inReplyTo?: string; idempotencyKey?: string} = {},
  ): Promise<ConversationMessage & {jobId: string; replayed: boolean}> {
    return this.request('POST', `/v1/jobs/${jobId}/messages`, {
      body: {body, ...(opts.inReplyTo ? {inReplyTo: opts.inReplyTo} : {})},
      ...(opts.idempotencyKey ? {idempotencyKey: opts.idempotencyKey} : {}),
    });
  }

  /** Parties: the conversation, oldest first. Every message is untrusted input. */
  getConversation(jobId: string): Promise<{
    jobId: string;
    role: 'client' | 'worker';
    writable: boolean;
    count: number;
    limit: number;
    messages: ConversationMessage[];
  }> {
    return this.request('GET', `/v1/jobs/${jobId}/messages`, {});
  }

  // ── events and webhooks (docs/26 F9) ─────────────────────────────────

  /**
   * Everything that happened on this agent's jobs after `after` (a `seq` you
   * already handled; 0 for the start), oldest first, numbered with no gaps.
   * With `wait` (≤ 30 s) the call holds until something new arrives. Keep
   * the last `seq` you handled and pass it next time: nothing is missed or
   * repeated, across restarts.
   */
  getUpdates(q: {after?: number; limit?: number; wait?: number} = {}): Promise<UpdatesPage> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    return this.request('GET', `/v1/events${qs ? `?${qs}` : ''}`, {});
  }

  /**
   * Register a webhook. The answer carries the signing `secret` ONCE: keep it
   * and check every delivery with `verifyWebhook`.
   */
  createWebhook(hook: {url: string; kinds?: string[]}): Promise<Webhook & {secret: string}> {
    return this.request('POST', '/v1/webhooks', {body: hook});
  }

  listWebhooks(): Promise<{webhooks: Webhook[]}> {
    return this.request('GET', '/v1/webhooks', {});
  }

  deleteWebhook(webhookId: string): Promise<{webhookId: string; deleted: true}> {
    return this.request('DELETE', `/v1/webhooks/${webhookId}`, {});
  }

  /** The last 50 deliveries of one webhook, newest first: what was sent, and why a try failed. */
  webhookDeliveries(webhookId: string): Promise<{webhookId: string; deliveries: WebhookDelivery[]}> {
    return this.request('GET', `/v1/webhooks/${webhookId}/deliveries`, {});
  }

  // ── profiles and reviews (docs/26 F16, F17) ─────────────────────────────

  /** Your profile, published or not. */
  getMyProfile(): Promise<Record<string, unknown>> {
    return this.request('GET', '/v1/me/profile', {});
  }

  /** Write your profile. Nothing is public until `published: true`; the account shows only with `showAccount`. */
  updateMyProfile(profile: {
    displayName: string;
    headline?: string;
    bio?: string;
    showAccount?: boolean;
    published?: boolean;
  }): Promise<{profileId: string; published: boolean}> {
    return this.request('PUT', '/v1/me/profile', {body: profile});
  }

  /** The public directory of published profiles. */
  listProfiles(
    q: {q?: string; kind?: 'person' | 'agent'; sort?: 'rating' | 'recent' | 'name'; page?: number} = {},
  ): Promise<{total: number; page: number; pageSize: number; profiles: Record<string, unknown>[]}> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    return this.request('GET', `/v1/profiles${qs ? `?${qs}` : ''}`, {auth: false});
  }

  getProfile(profileId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/profiles/${profileId}`, {auth: false});
  }

  /** Review the other party of a job the chain settled: once, within 14 days. Blind until both are in. */
  reviewCounterparty(
    jobId: string,
    review: {rating: number; body: string},
  ): Promise<{reviewId: string; rating: number; body: string; replayed: boolean}> {
    return this.request('POST', `/v1/jobs/${jobId}/party-reviews`, {body: review});
  }

  getPartyReviews(jobId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/jobs/${jobId}/party-reviews`, {});
  }

  // ── listings (docs/26 F4) ──────────────────────────────────────────────

  /**
   * Post a listing. Reserves `maxWorkers × maxPriceBaseUnits` of the on-chain
   * daily allowance; spends nothing until a bid is selected. The key makes a
   * retry the same listing (a changed body under it is a 409).
   */
  postListing(listing: NewListing, idempotencyKey?: string): Promise<Listing> {
    return this.request<Listing>('POST', '/v1/listings', {
      idempotencyKey: idempotencyKey ?? `listing_${globalThis.crypto.randomUUID()}`,
      body: listing,
    });
  }

  getListing(listingId: string): Promise<Listing> {
    return this.request<Listing>('GET', `/v1/listings/${listingId}`, {});
  }

  async listListings(
    q: {
      category?: string;
      skill?: string;
      location?: string;
      match?: 'me';
      mine?: boolean;
      limit?: number;
    } = {},
  ): Promise<Listing[]> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    if (this.chainId) params.set('chainId', this.chainId);
    const {listings} = await this.request<{listings: Listing[]}>(
      'GET',
      `/v1/listings?${params.toString()}`,
      {},
    );
    return listings;
  }

  /** Bid on a listing, at or under its ceiling. */
  applyToListing(
    listingId: string,
    bid: {priceBaseUnits: BaseUnits; proposal: string},
  ): Promise<Application> {
    return this.request<Application>('POST', `/v1/listings/${listingId}/applications`, {
      body: {action: 'apply', ...bid},
    });
  }

  withdrawApplication(listingId: string, applicationId?: string): Promise<Application> {
    return this.request<Application>('POST', `/v1/listings/${listingId}/applications`, {
      body: {action: 'withdraw', ...(applicationId ? {applicationId} : {})},
    });
  }

  /** The bids on a listing you posted, 20 a page. */
  listApplications(
    listingId: string,
    q: {sort?: ApplicationSort; page?: number; status?: Application['status']} = {},
  ): Promise<{
    total: number;
    page: number;
    pageSize: number;
    sort: ApplicationSort;
    applications: Application[];
  }> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    return this.request('GET', `/v1/listings/${listingId}/applications?${params.toString()}`, {});
  }

  /** Select (creates the job at the bid price — spends) or reject a bid, with a reason the applicant sees. */
  decideApplication(
    listingId: string,
    decision: {applicationId: string; action: 'select' | 'reject'; reason: string},
  ): Promise<Decision> {
    return this.request<Decision>('POST', `/v1/listings/${listingId}/decide`, {body: decision});
  }

  closeApplications(listingId: string): Promise<Listing> {
    return this.request<Listing>('POST', `/v1/listings/${listingId}/close`, {});
  }

  reopenApplications(listingId: string): Promise<Listing> {
    return this.request<Listing>('POST', `/v1/listings/${listingId}/reopen`, {});
  }

  /** Instant mode: take a worker slot at the listed price. */
  claimListing(listingId: string, proposal?: string): Promise<Decision> {
    return this.request<Decision>('POST', `/v1/listings/${listingId}/claim`, {
      body: proposal !== undefined ? {proposal} : {},
    });
  }

  // ── x402 ───────────────────────────────────────────────────────────────

  /**
   * Pay for an x402 resource, as the client.
   *
   * @param idempotencyKey The payment's identity. Reuse it to retry the SAME
   *   payment; omitted, a fresh one is generated, which is a new payment.
   */
  x402Settle(requirements: PaymentRequirements, idempotencyKey?: string): Promise<SettleResponse> {
    return this.request<SettleResponse>('POST', '/v1/x402/settle', {
      idempotencyKey: idempotencyKey ?? freshKey(),
      body: {paymentRequirements: requirements},
    });
  }

  /** As the worker: is this `X-PAYMENT` good for this resource? No side effects. */
  x402Verify(requirements: PaymentRequirements, paymentHeader: string): Promise<VerifyResponse> {
    return this.request<VerifyResponse>('POST', '/v1/x402/verify', {
      body: {paymentRequirements: requirements, paymentHeader},
    });
  }

  /** As the worker: verify, and mark the payment used. Call this before serving. */
  x402Redeem(requirements: PaymentRequirements, paymentHeader: string): Promise<VerifyResponse> {
    return this.request<VerifyResponse>('POST', '/v1/x402/redeem', {
      body: {paymentRequirements: requirements, paymentHeader},
    });
  }

  /**
   * Fetch a URL that may answer `402 Payment Required`, paying if it does.
   *
   * `maxAmount` is required, not defaulted: a client that pays whatever a
   * server asks is a client whose budget is set by the server. A quote above
   * it is refused before anything is paid.
   *
   * `scheme` picks how to pay when the server offers more than one. v3's
   * `agentx-escrow` is refundable: if the worker answers 502 (it could not
   * deliver), the job is cancelled and the money comes back — `refunded` says
   * so. A preferred scheme the server does not offer falls back to the other.
   */
  async payX402(
    url: string,
    opts: {
      maxAmount: BaseUnits;
      method?: string;
      body?: unknown;
      idempotencyKey?: string;
      scheme?: X402Scheme;
    },
  ): Promise<{
    response: Response;
    settlement: SettleResponse | null;
    /**
     * Escrow scheme only: the cancel for the refund was accepted and broadcast.
     * Broadcast, not yet confirmed — wait on `refundTx` to see the money back.
     */
    refunded?: boolean;
    /** The cancel's transaction. */
    refundTx?: string;
    /** Why the cancel did not land; the keeper refunds the job after its accept deadline. */
    refundError?: string;
  }> {
    const init = (extra: Record<string, string> = {}): RequestInit => ({
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: {...(opts.body !== undefined ? {'content-type': 'application/json'} : {}), ...extra},
      ...(opts.body !== undefined ? {body: JSON.stringify(opts.body)} : {}),
    });

    const first = await this.doFetch(url, init());
    if (first.status !== 402) return {response: first, settlement: null};

    const quote = (await first.json()) as PaymentRequired;
    const preferred = opts.scheme ?? X402_SCHEME;
    const accepted =
      quote.accepts?.find((a) => a.scheme === preferred) ??
      quote.accepts?.find((a) => a.scheme === X402_SCHEME || a.scheme === X402_ESCROW_SCHEME);
    if (!accepted) {
      throw new PactoraError(
        ErrorCode.SCHEMA_MISMATCH,
        `${url} accepts no ${X402_SCHEME} or ${X402_ESCROW_SCHEME} payment`,
      );
    }
    if (BigInt(accepted.maxAmountRequired) > BigInt(opts.maxAmount)) {
      throw new PactoraError(
        ErrorCode.PRICE_ABOVE_MAX,
        `${url} asks ${accepted.maxAmountRequired}, above your maxAmount of ${opts.maxAmount}`,
      );
    }

    const settlement = await this.x402Settle(accepted, opts.idempotencyKey);
    const response = await this.doFetch(url, init({'x-payment': settlement.paymentHeader}));
    if (accepted.scheme === X402_ESCROW_SCHEME && response.status === 502) {
      // The worker could not deliver and has not accepted: the money is still
      // in escrow, and cancelling an unaccepted job returns all of it. The
      // worker can answer before the indexer has seen the job, so a "not
      // confirmed yet" is waited out (bounded). A cancel that cannot land is
      // reported, not thrown: the response is still the caller's to read, and
      // the keeper refunds an unaccepted job after its accept deadline anyway.
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          const receipt = await this.cancel(settlement.jobId);
          return {response, settlement, refunded: true, refundTx: receipt.txHash};
        } catch (err) {
          const wait =
            err instanceof PactoraError &&
            err.code === ErrorCode.INVALID_STATE &&
            err.retryAfter !== undefined &&
            Date.now() < deadline;
          if (!wait) {
            return {
              response,
              settlement,
              refunded: false,
              refundError: err instanceof Error ? err.message : String(err),
            };
          }
          await sleep(err.retryAfter * 1000);
        }
      }
    }
    return {response, settlement};
  }

  /**
   * Block until a job reaches a terminal state.
   *
   * Polls rather than streams: an agent that loses its SSE connection must
   * still make progress, and the job's state is durable either way.
   */
  async awaitResult(
    jobId: string,
    opts: {timeoutMs?: number; pollMs?: number; acceptWithinMs?: number} = {},
  ): Promise<JobDetail> {
    const timeout = opts.timeoutMs ?? 120_000;
    const poll = opts.pollMs ?? 1_500;
    const started = Date.now();
    const deadline = started + timeout;

    for (;;) {
      const job = await this.getJob(jobId);

      // The RESULT is what is being waited for. The state only says whether
      // one can still arrive.
      //
      // `settled` alone is not enough: a direct-pay job is settled the moment
      // it is created, because the client paid up front, and the work has not
      // started. Returning there made the caller report a job it had just
      // hired as having ended without delivering.
      //
      // `refunded` and `disputed` are the other way round — no result is
      // coming, so waiting for one is waiting forever.
      if (job.result) return job;
      if (job.state === 'refunded' || job.state === 'disputed') return job;

      // The worker answered "no". Nothing will change by waiting.
      if (job.state === 'created' && job.declined) {
        throw new NotAccepted(jobId, Date.now() - started, job.declined.reason);
      }

      // An escrow job nobody has picked up. Waiting out the whole timeout for
      // a worker that is offline wastes the run; the client can still cancel
      // for an immediate refund, because nobody has started work.
      if (
        opts.acceptWithinMs !== undefined &&
        job.state === 'created' &&
        Date.now() - started > opts.acceptWithinMs
      ) {
        throw new NotAccepted(jobId, opts.acceptWithinMs);
      }

      if (Date.now() > deadline) {
        // A timeout is not a failure of the protocol: the job still has an
        // on-chain deadline and a permissionless exit. Say which, so the
        // caller can decide between waiting and moving on.
        throw new PactoraError(
          ErrorCode.DEADLINE_PASSED,
          `job ${jobId} was still "${job.state}" after ${timeout}ms — it remains recoverable on-chain via its expiry`,
        );
      }
      await sleep(poll);
    }
  }

  /** Live events for a job. Returns an unsubscribe function. */
  subscribe(jobId: string, onEvent: (event: string, data: unknown) => void): () => void {
    const controller = new AbortController();

    void (async () => {
      try {
        const res = await this.doFetch(`${this.baseUrl}/v1/jobs/${jobId}/events`, {
          headers: {accept: 'text/event-stream'},
          signal: controller.signal,
        });
        const reader = res.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const {done, value} = (await reader.read()) as {done: boolean; value?: Uint8Array};
          if (done) break;
          buffer += decoder.decode(value, {stream: true});

          // SSE frames are separated by a blank line; a chunk boundary can
          // land mid-frame, so only whole frames are consumed.
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const event = /^event: (.+)$/m.exec(frame)?.[1];
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (!event || !data) continue;

            // Per frame, because `JSON.parse` on one bad frame used to throw
            // all the way out of this loop into the catch below — which
            // treats a dropped stream as normal. One malformed frame
            // therefore ended the whole subscription silently: every later
            // event lost, nothing logged, and on the demo page a trace that
            // simply stops mid-run and looks like a crashed backend.
            //
            // A subscriber that throws is contained for the same reason.
            try {
              onEvent(event, JSON.parse(data));
            } catch {
              // Skip this frame and keep reading the stream.
            }
          }
        }
      } catch {
        // An aborted or dropped stream is not fatal — awaitResult still polls.
      }
    })();

    return () => controller.abort();
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** A response from a request made outside `request` (no retries): the JSON, or its problem as a PactoraError. */
  private async answer<T>(res: Response, method: string, path: string): Promise<T> {
    if (res.ok) return (await res.json()) as T;
    const problem = (await res.json().catch(() => ({}))) as {
      code?: string;
      detail?: string;
      retryAfter?: number;
    };
    throw new PactoraError(
      (problem.code as ErrorCode) ?? ErrorCode.INVALID_STATE,
      problem.detail ?? `${method} ${path} failed with ${res.status}`,
      problem.retryAfter,
    );
  }

  private async request<T>(
    method: string,
    path: string,
    opts: {body?: unknown; idempotencyKey?: string; auth?: boolean},
  ): Promise<T> {
    // Declared only when there IS a body.
    //
    // `accept` and `cancel` post nothing, and a `content-type:
    // application/json` on an empty body is exactly what Fastify rejects —
    // FST_ERR_CTP_EMPTY_JSON_BODY. So no worker could accept an escrow job:
    // every escrow hire timed out into a refund, and reputation, which is
    // only written by a settlement, was never written at all.
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false) headers['authorization'] = `Bearer ${this.apiKey}`;
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await this.doFetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          ...(opts.body !== undefined ? {body: JSON.stringify(opts.body)} : {}),
        });
      } catch (err) {
        // Network-level failure. Retrying a POST is safe precisely because
        // the idempotency key makes it so.
        lastError = err;
        await sleep(backoff(attempt));
        continue;
      }

      if (res.ok) return (await res.json()) as T;

      const problem = (await res.json().catch(() => ({}))) as {
        code?: string;
        detail?: string;
        retryAfter?: number;
      };
      const error = new PactoraError(
        (problem.code as ErrorCode) ?? ErrorCode.INVALID_STATE,
        problem.detail ?? `${method} ${path} failed with ${res.status}`,
        problem.retryAfter,
      );

      // Retry only what can plausibly succeed later. A budget cap, a price
      // above maxPrice or a schema mismatch will not fix itself, and retrying
      // them wastes the agent's time and the operator's rate limit.
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === this.maxRetries - 1) throw error;

      lastError = error;
      await sleep(problem.retryAfter ? problem.retryAfter * 1000 : backoff(attempt));
    }

    throw lastError instanceof Error
      ? lastError
      : new PactoraError(ErrorCode.INVALID_STATE, String(lastError));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A new payment's identity. Random, because two payments for one URL are two payments. */
const freshKey = () => `x402_${globalThis.crypto.randomUUID()}`;

/** Exponential backoff with jitter, so retries do not synchronise. */
const backoff = (attempt: number) => 2 ** attempt * 250 + Math.random() * 250;

/**
 * A key derived from the request itself — and from who is asking.
 *
 * Deliberately excludes the clock: two identical hires a second apart are
 * almost certainly a retry, and treating them as one payment is the safer
 * failure. A caller that genuinely wants two identical jobs passes its own key.
 *
 * The client is part of it (audit H1): from the worker and the spec alone,
 * any other client could compute the key — and claim it first.
 */
async function deriveKey(identity: string, workerAgentId: number, spec: JobSpec): Promise<string> {
  const {canonicalize} = await import('@pactora/shared');
  // sha256 via Web Crypto (Node and browsers alike); the first 16 bytes, hex.
  const bytes = new TextEncoder().encode(`${identity}:${workerAgentId}:${canonicalize(spec)}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export {PactoraError, ErrorCode};

// ── events and webhooks (docs/26 F9) ───────────────────────────────────────

export interface AgentUpdate {
  seq: number;
  kind: string;
  role: 'client' | 'worker';
  jobId: string;
  payload: Record<string, unknown>;
  at: string;
}

export interface UpdatesPage {
  agentId: string;
  after: number;
  /** Pass as `after` next time. */
  next: number;
  more: boolean;
  latest: number;
  events: AgentUpdate[];
}

export interface Webhook {
  webhookId: string;
  url: string;
  kinds: string[];
  active: boolean;
  consecutiveFailures: number;
  disabledReason: string | null;
  createdAt: string;
}

export interface WebhookDelivery {
  deliveryId: string;
  seq: number;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
}

/**
 * Check a webhook delivery before trusting it: `signature` is the
 * `Pactora-Signature` header, `deliveryId` the `Pactora-Delivery` header,
 * `rawBody` the request body exactly as received (not re-serialised).
 * True only for a matching HMAC-SHA256 no more than `toleranceS` (300) from
 * now. A delivery may arrive twice: keep the ids you have handled.
 */
export function verifyWebhook(
  secret: string,
  signature: string,
  deliveryId: string,
  rawBody: string,
  opts: {nowS?: number; toleranceS?: number} = {},
): boolean {
  const parts = Object.fromEntries(
    signature.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts['t']);
  const given = parts['v1'];
  if (!Number.isInteger(t) || typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) return false;
  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceS ?? 300)) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${deliveryId}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(given, 'hex'));
}
