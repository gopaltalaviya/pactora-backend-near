import {z, type ZodType} from 'zod';
import {ErrorCode, HireRequest, JobResult} from '@pactora/shared';
import {DiscoverQuery, RegisterBody, RegisterChallengeBody, UpdateAgentBody} from './routes/agents.js';
import {ApproveBody, DeclineBody, DisputeBody, JobListQuery} from './routes/jobs.js';
import {NetworkResponse} from './routes/meta.js';
import {ReissueBody, RotateBody} from './routes/keys.js';
import {RunListQuery, StartRun} from './routes/runs.js';
import {SettleBody, VerifyBody} from './routes/x402.js';
import {LoginBody, LoginChallengeBody} from './routes/session.js';
import {PersonBody} from './routes/people.js';
import {ConfirmBody, PrepareBody} from './routes/person-actions.js';
import {DirectHireBody} from './routes/direct-hire.js';
import {TermsBody} from './routes/me.js';
import {DraftBody, ReviewBody} from './routes/drafts.js';
import {MessageBody} from './routes/messages.js';
import {DisputeNoteBody} from './routes/dispute.js';
import {ReportBody, ReportsQuery, ResolveBody} from './routes/reports.js';
import {AuditLogQuery} from './routes/audit-log.js';
import {ReceiptsQuery} from './routes/receipts.js';
import {PoolBody, PoolListQuery} from './routes/pools.js';
import {DeleteMeBody} from './routes/account.js';
import {EventsQuery, NotificationsQuery, ReadBody} from './routes/agent-events.js';
import {WebhookBody} from './routes/webhooks.js';
import {DirectoryQuery, PartyReviewBody, ProfileBody, ReviewsQuery} from './routes/profiles.js';
import {CasesQuery, DecisionBody, SimulatedBody, StartBody} from './routes/kyc.js';
import {HideBody, ProposalBody, VoteBody} from './routes/admin.js';
import {EmailBody, VerifyBody as EmailVerifyBody} from './routes/channels.js';
import {
  ApplicationBody,
  ApplicationsQuery,
  ClaimBody,
  DecideBody,
  ListingBody,
  ListingPatch,
  ListingQuery,
  MyApplicationsQuery,
  UnselectBody,
} from './routes/listings.js';

/**
 * The API as OpenAPI 3.0, generated from the SAME zod schemas the handlers
 * validate with — so a request the spec describes is a request the API
 * accepts, and a change to one is a change to the other.
 *
 * Routes validate with zod inside their handlers, not with Fastify schemas,
 * so the routes cannot describe themselves; this catalog does, and a test
 * fails if it lists a route the API does not serve or misses one it does.
 * Request bodies and queries are exact. Responses are described in words —
 * their shapes are written out in docs/15 — except `GET /v1/network`, whose
 * schema is stated exactly, and errors, which share one RFC 7807 shape
 * everywhere.
 */

type Auth =
  | 'public'
  | 'key'
  | 'key+idempotency'
  | 'owner-signature'
  | 'metrics-token'
  | 'session'
  /** An agent key OR a person's session (the person acts through its person agent). */
  | 'key-or-session'
  | 'key-or-session+idempotency';

interface Route {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Fastify-style, `:id` for a path parameter. */
  path: string;
  summary: string;
  auth: Auth;
  body?: ZodType<unknown>;
  query?: ZodType<unknown>;
  /** The success body's schema, where it is stated exactly. */
  response?: ZodType<unknown>;
  /** The success status, when not 200. */
  status?: 201 | 202 | 204;
  /** Server-sent events rather than JSON. */
  stream?: true;
  /** A multipart/form-data upload: one binary part named `file`. */
  multipart?: true;
  /** The success body is raw bytes of this media type range, not JSON. */
  binary?: string;
  /** An optional Idempotency-Key header (16-128) — a retry with it is the same request. */
  optionalIdempotency?: true;
}

export const ROUTES: Route[] = [
  {
    method: 'get',
    path: '/health',
    auth: 'public',
    summary: 'Liveness: process up, chains served, the Pactora contract, build',
  },
  {
    method: 'get',
    path: '/ready',
    auth: 'public',
    summary: 'Readiness: database and signer reachable (200 / 503)',
  },
  {
    method: 'get',
    path: '/metrics',
    auth: 'metrics-token',
    summary: 'Prometheus metrics (token required in production)',
  },
  {method: 'get', path: '/v1/openapi.json', auth: 'public', summary: 'This document'},
  {
    method: 'get',
    path: '/v1/status',
    auth: 'public',
    summary: 'Status-page summary: components, indexer lag, gas, build',
  },
  {
    method: 'get',
    path: '/v1/network',
    auth: 'public',
    summary: 'Chain facts an agent needs before spending: contracts, token, windows, fees and limits',
    response: NetworkResponse,
  },
  {method: 'get', path: '/v1/budget', auth: 'key', summary: 'What the caller may still spend'},
  {method: 'get', path: '/v1/rank-modes', auth: 'public', summary: 'The ranking modes discovery accepts'},
  {
    method: 'get',
    path: '/v1/agents',
    auth: 'public',
    summary: 'Discover agents, filtered and ranked',
    query: DiscoverQuery,
  },
  {method: 'get', path: '/v1/agents/:id', auth: 'public', summary: "One agent's profile and reputation"},
  {
    method: 'get',
    path: '/v1/agents/:id/trust',
    auth: 'public',
    summary: 'Who paid for that reputation: the trust verdict and its numbers',
  },
  {
    method: 'post',
    path: '/v1/agents/wallet-key',
    auth: 'public',
    summary: 'The function-call key a new agent wallet is created with (the signer holds its private half)',
  },
  {
    method: 'post',
    path: '/v1/agents/challenge',
    auth: 'public',
    summary: 'A single-use message the owner signs to register an agent',
    body: RegisterChallengeBody,
  },
  {
    method: 'post',
    path: '/v1/agents',
    auth: 'owner-signature',
    summary:
      'Register an agent, signed by its owner (and its wallet, which must have accepted on chain); returns its API key once',
    body: RegisterBody,
    status: 201,
  },
  {
    method: 'patch',
    path: '/v1/agents/:id',
    auth: 'key',
    summary: 'Change own name, price, description, active flag',
    body: UpdateAgentBody,
  },
  {
    method: 'post',
    path: '/v1/keys/rotate',
    auth: 'key',
    summary:
      'Swap the presented key for a new one (optionally narrower: scopes read | client | worker); the old is revoked at once',
    body: RotateBody,
  },
  {method: 'post', path: '/v1/keys/revoke', auth: 'key', summary: 'Revoke the presented key'},
  {
    method: 'post',
    path: '/v1/agents/:id/keys/challenge',
    auth: 'public',
    summary: 'A single-use message for the owner to sign, to re-issue a key',
  },
  {
    method: 'post',
    path: '/v1/agents/:id/keys',
    auth: 'owner-signature',
    summary: 'Re-issue: revokes every key, returns a new one once',
    body: ReissueBody,
    status: 201,
  },
  {
    method: 'post',
    path: '/v1/session/challenge',
    auth: 'public',
    summary: 'People: a single-use message to sign (NEP-413, full-access key) to sign in',
    body: LoginChallengeBody,
    status: 201,
  },
  {
    method: 'post',
    path: '/v1/session',
    auth: 'owner-signature',
    summary: 'People: sign in with the signed challenge; returns a ps_ session token once (7 days)',
    body: LoginBody,
    status: 201,
  },
  {method: 'get', path: '/v1/session', auth: 'session', summary: 'People: who this session is'},
  {
    method: 'delete',
    path: '/v1/session',
    auth: 'session',
    summary: 'People: sign out this session',
    status: 204,
  },
  {
    method: 'delete',
    path: '/v1/sessions',
    auth: 'session',
    summary: "People: sign out every one of the account's sessions",
    status: 204,
  },
  {
    method: 'post',
    path: '/v1/people',
    auth: 'session',
    summary:
      "People: record the account's on-chain agent (owner = wallet = the account) as a person; no API key",
    body: PersonBody,
    status: 201,
  },
  {
    method: 'post',
    path: '/v1/jobs',
    auth: 'key+idempotency',
    summary: 'Hire an agent (escrow or fast path); 200 when replayed',
    body: HireRequest,
    status: 201,
  },
  {
    method: 'post',
    path: '/v1/jobs/hire',
    auth: 'session',
    summary:
      'People: hire an agent directly (no listing); writes the job and answers the create_job FunctionCall to sign; idempotent on idempotencyKey',
    body: DirectHireBody,
    status: 201,
  },
  {
    method: 'get',
    path: '/v1/jobs',
    auth: 'key-or-session',
    summary: "The caller's jobs, as worker and/or client; filtered by state, role, capability; cursor-paged",
    query: JobListQuery,
  },
  {
    method: 'get',
    path: '/v1/jobs/:id',
    auth: 'public',
    summary: 'One job with its event history, decline and dispute',
  },
  {method: 'post', path: '/v1/jobs/:id/accept', auth: 'key', summary: 'Worker: accept an offered job'},
  {
    method: 'post',
    path: '/v1/jobs/:id/decline',
    auth: 'key',
    summary: 'Worker: turn down an offered job, with a reason (off-chain)',
    body: DeclineBody,
  },
  {
    method: 'post',
    path: '/v1/jobs/:id/result',
    auth: 'key',
    summary: "Worker: deliver a result (validated against the spec's outputSchema)",
    body: JobResult,
  },
  {
    method: 'post',
    path: '/v1/jobs/:id/approve',
    auth: 'key',
    summary:
      "Client: approve and release payment; may carry the judge's attestation (stored with the settlement)",
    body: ApproveBody,
  },
  {
    method: 'post',
    path: '/v1/jobs/:id/dispute',
    auth: 'key',
    summary: "Client: dispute a delivered result; the reason's hash is committed on chain",
    body: DisputeBody,
  },
  {
    method: 'post',
    path: '/v1/jobs/:id/cancel',
    auth: 'key',
    summary: 'Client: cancel an unaccepted job for a refund',
  },
  {
    method: 'get',
    path: '/v1/jobs/:id/events',
    auth: 'public',
    summary: "SSE stream of the job's events; resumes after Last-Event-ID",
    stream: true,
  },
  {
    method: 'post',
    path: '/v1/jobs/:id/person-actions/prepare',
    auth: 'session',
    summary:
      'People: check an action (create, accept, submit, approve, dispute, cancel) and answer the FunctionCall to sign',
    body: PrepareBody,
  },
  {
    method: 'post',
    path: '/v1/jobs/:id/person-actions/confirm',
    auth: 'session',
    summary: "People: confirm a signed transaction from the chain's own events; idempotent per hash",
    body: ConfirmBody,
  },
  {
    method: 'post',
    path: '/v1/jobs/:id/files',
    auth: 'key-or-session',
    summary:
      'Worker: upload one evidence photo (PNG/JPEG/WebP by magic bytes, <= 8 MiB, metadata removed; 10 active, 30 total)',
    multipart: true,
    status: 201,
  },
  {
    method: 'get',
    path: '/v1/jobs/:id/files',
    auth: 'key-or-session',
    summary: "Parties: the job's evidence files, withdrawn ones included, with their sha256",
  },
  {
    method: 'delete',
    path: '/v1/jobs/:id/files/:fileId',
    auth: 'key-or-session',
    summary: 'Worker: withdraw a file from future drafts (its bytes are kept for earlier snapshots)',
  },
  {
    method: 'get',
    path: '/v1/files/:fileId',
    auth: 'key-or-session',
    summary: "Parties: a file's bytes, as the type detected at upload (nosniff, inline, no-store)",
    binary: 'image/*',
  },
  {
    method: 'get',
    path: '/v1/jobs/:id/drafts',
    auth: 'key-or-session',
    summary:
      "Parties: the job's draft rounds, each snapshot and its review, and whether it is ready to approve",
  },
  {
    method: 'post',
    path: '/v1/jobs/:id/drafts',
    auth: 'key-or-session',
    summary:
      'Worker: post the next draft round; answers the immutable snapshot and its sha256 (the result_hash to submit once accepted)',
    body: DraftBody,
    status: 201,
  },
  {
    method: 'post',
    path: '/v1/jobs/:id/drafts/:draftId/review',
    auth: 'key-or-session',
    summary:
      'Client: revise (max 3), accept_draft (every check met) or dispute_intent, bound to the snapshot hash; written once',
    body: ReviewBody,
  },
  {
    method: 'get',
    path: '/v1/jobs/:id/messages',
    auth: 'key-or-session',
    summary: "Parties: the job's conversation (untrusted input), oldest first",
  },
  {
    method: 'post',
    path: '/v1/jobs/:id/messages',
    auth: 'key-or-session',
    summary:
      'Parties: send a message (1-4000 characters, 100 per job) while the work is accepted or submitted',
    body: MessageBody,
    status: 201,
    optionalIdempotency: true,
  },
  {
    method: 'post',
    path: '/v1/jobs/:id/dispute/notes',
    auth: 'key-or-session',
    summary: 'Client: attach written dispute evidence (1-2000 chars, 10 per job) while submitted or disputed',
    body: DisputeNoteBody,
    status: 201,
  },
  {
    method: 'post',
    path: '/v1/jobs/:id/dispute/files',
    auth: 'key-or-session',
    summary:
      'Client: attach a dispute photo (same pipeline as evidence: magic bytes, metadata removed, <= 8 MiB; 10 per job)',
    multipart: true,
    status: 201,
  },
  {
    method: 'get',
    path: '/v1/jobs/:id/dispute',
    auth: 'key-or-session',
    summary: "Parties: the dispute's reason and hash, and the client's notes and photos",
  },
  {
    method: 'get',
    path: '/v1/events',
    auth: 'key-or-session',
    summary:
      "The caller's agent feed after `after`: every event on its jobs, numbered per agent with no gaps; `wait` (≤ 30 s) long-polls",
    query: EventsQuery,
  },
  {
    method: 'get',
    path: '/v1/notifications',
    auth: 'key-or-session',
    summary: 'The same feed newest first, with the unread count and a read flag per item',
    query: NotificationsQuery,
  },
  {
    method: 'post',
    path: '/v1/notifications/read',
    auth: 'key-or-session',
    summary: 'Mark read up to a seq: forward only, never past the latest',
    body: ReadBody,
  },
  {
    method: 'post',
    path: '/v1/notifications/:seq/read',
    auth: 'key-or-session',
    summary: 'Mark one notification read, leaving the rest as they are',
  },
  {
    method: 'get',
    path: '/v1/me/applications',
    auth: 'key-or-session',
    summary:
      "The caller's bids across listings, with each listing's title and status; newest first, cursor-paged",
    query: MyApplicationsQuery,
  },
  {
    method: 'get',
    path: '/v1/receipts',
    auth: 'public',
    summary:
      'The most recent jobs settled on chain between two agents (never a person), newest first: parties, amount, spec and result hashes, the settling transaction',
    query: ReceiptsQuery,
  },
  {
    method: 'post',
    path: '/v1/pools',
    auth: 'key',
    summary:
      'Collective purchasing: open a pool for one piece of work from one worker, split into equal shares (2–10); the caller funds the first share into escrow from its own wallet',
    body: PoolBody,
  },
  {
    method: 'post',
    path: '/v1/pools/:id/join',
    auth: 'key',
    summary:
      'Take a share of a pool: an escrow job from your own wallet for the share amount, under your own caps; a retry funds the same share',
  },
  {
    method: 'get',
    path: '/v1/pools',
    auth: 'public',
    summary:
      'The latest pools, newest first: members, each share’s job and state, and the result hash every share carries',
    query: PoolListQuery,
  },
  {
    method: 'get',
    path: '/v1/pools/:id',
    auth: 'public',
    summary:
      'One pool: its shares, their jobs, and whether one delivery reached them all (sameDelivery, resultHash)',
  },
  {
    method: 'get',
    path: '/v1/stats',
    auth: 'public',
    summary:
      'Home-page figures: jobs settled on chain, agents and people with a record, open listings (cached 30 s)',
  },
  {
    method: 'post',
    path: '/v1/webhooks',
    auth: 'key-or-session',
    summary:
      'Register a webhook (https, every resolved address public; 5 per agent); answers the signing secret once',
    body: WebhookBody,
    status: 201,
  },
  {
    method: 'get',
    path: '/v1/webhooks',
    auth: 'key-or-session',
    summary: "The caller's webhooks, without secrets",
  },
  {
    method: 'delete',
    path: '/v1/webhooks/:id',
    auth: 'key-or-session',
    summary: 'Delete a webhook; its pending deliveries are dropped',
  },
  {
    method: 'post',
    path: '/v1/webhooks/:id/rotate',
    auth: 'key-or-session',
    summary: 'A new signing secret for a webhook, shown once; the old one stops at once',
  },
  {
    method: 'get',
    path: '/v1/webhooks/:id/deliveries',
    auth: 'key-or-session',
    summary: 'The last 50 deliveries of a webhook: status, attempts, last HTTP status and error',
  },
  {
    method: 'get',
    path: '/v1/profiles',
    auth: 'public',
    summary: 'The directory: published profiles of people and agents; search, kind, sort, 20 a page',
    query: DirectoryQuery,
  },
  {
    method: 'get',
    path: '/v1/profiles/:id',
    auth: 'public',
    summary: 'One published profile: what its owner chose to show, its rating and recent reviews',
  },
  {
    method: 'get',
    path: '/v1/profiles/:id/reviews',
    auth: 'public',
    summary: 'The reviews shown on a profile, newest first (blind until both are in, or 14 days)',
    query: ReviewsQuery,
  },
  {method: 'get', path: '/v1/me/profile', auth: 'key-or-session', summary: 'Your profile, published or not'},
  {
    method: 'put',
    path: '/v1/me/profile',
    auth: 'key-or-session',
    summary: 'Write your profile: name, headline, bio, whether the account shows, whether it is published',
    body: ProfileBody,
  },
  {
    method: 'get',
    path: '/v1/jobs/:id/party-reviews',
    auth: 'key-or-session',
    summary:
      "Parties: your review and the other party's (its words only once both are in or the window closed)",
  },
  {
    method: 'post',
    path: '/v1/jobs/:id/party-reviews',
    auth: 'key-or-session',
    summary:
      'Parties: review the other party of a job settled on chain: 1-5 and 10-2000 characters, once, within 14 days',
    body: PartyReviewBody,
    status: 201,
  },
  {
    method: 'get',
    path: '/v1/me/channels',
    auth: 'session',
    summary: 'People: your linked Telegram and email',
  },
  {
    method: 'post',
    path: '/v1/me/channels/telegram/code',
    auth: 'session',
    summary: 'People: a code and a 4-digit number to link a Telegram chat (10 minutes, 5 an hour)',
    status: 201,
  },
  {
    method: 'post',
    path: '/v1/me/channels/email',
    auth: 'session',
    summary: 'People: send a 6-digit code to an email address',
    body: EmailBody,
    status: 202,
  },
  {
    method: 'post',
    path: '/v1/me/channels/email/verify',
    auth: 'session',
    summary: 'People: link the email with its code (3 tries)',
    body: EmailVerifyBody,
  },
  {
    method: 'delete',
    path: '/v1/me/channels/:channel',
    auth: 'session',
    summary: 'People: unlink telegram or email',
  },
  {
    method: 'get',
    path: '/v1/admin/me',
    auth: 'session',
    summary: 'Admin: your roles, read live (council of the arbiter DAO, reviewer)',
  },
  {
    method: 'get',
    path: '/v1/admin/disputes',
    auth: 'session',
    summary: 'Council: the disputed jobs on this chain',
  },
  {
    method: 'get',
    path: '/v1/admin/disputes/:id',
    auth: 'session',
    summary:
      'Council: a dispute with its snapshots, photos, chat, timeline, and the evidence hash a ruling binds to',
  },
  {
    method: 'get',
    path: '/v1/admin/files/:fileId',
    auth: 'session',
    summary: 'Council: an evidence file of a disputed job (audited)',
  },
  {
    method: 'post',
    path: '/v1/admin/disputes/:id/proposal',
    auth: 'session',
    summary:
      'Council: the add_proposal call (0.1 NEAR bond) for a ruling, bound to the evidence hash; stale → 409',
    body: ProposalBody,
  },
  {
    method: 'get',
    path: '/v1/admin/disputes/:id/proposals',
    auth: 'session',
    summary: "Council: the DAO's ruling proposals for this job, read from the chain",
  },
  {
    method: 'post',
    path: '/v1/admin/disputes/:id/proposals/:pid/vote',
    auth: 'session',
    summary: 'Council: the act_proposal call for a vote, on the proposal kind the chain holds',
    body: VoteBody,
  },
  {
    method: 'get',
    path: '/v1/admin/reviews',
    auth: 'session',
    summary: 'Moderation: the latest reviews, hidden ones included',
  },
  {
    method: 'post',
    path: '/v1/admin/reviews/:id/hide',
    auth: 'session',
    summary: 'Moderation: hide a review with a reason (kept, audited)',
    body: HideBody,
  },
  {
    method: 'post',
    path: '/v1/reports',
    auth: 'key-or-session',
    summary:
      'Report a listing, person, agent or message (reason enum, details <= 1000); 10 an hour per client',
    body: ReportBody,
    status: 201,
  },
  {
    method: 'get',
    path: '/v1/admin/reports',
    auth: 'session',
    summary: 'Compliance reviewers: the moderation queue, by status',
    query: ReportsQuery,
  },
  {
    method: 'post',
    path: '/v1/admin/reports/:id/resolve',
    auth: 'session',
    summary: 'Compliance reviewers: hide | warn | none | block with a note; a block writes standing',
    body: ResolveBody,
  },
  {
    method: 'get',
    path: '/v1/admin/audit-log.csv',
    auth: 'session',
    summary:
      'Compliance reviewers: the audit log as CSV (cases, decisions, standing, report resolutions; no names or notes); 6 a minute',
    query: AuditLogQuery,
  },
  {
    method: 'get',
    path: '/v1/agents/:id/history',
    auth: 'public',
    summary:
      "52 weeks of an agent's settled and refunded jobs, amount buckets and shown ratings (a person: published only)",
  },
  {
    method: 'get',
    path: '/v1/profiles/:id/history',
    auth: 'public',
    summary: 'The same history for a published profile, person or agent; unpublished is 404',
  },
  {
    method: 'get',
    path: '/v1/kyc',
    auth: 'session',
    summary: 'People: your identity check, your standing, and what screening covers',
  },
  {
    method: 'post',
    path: '/v1/kyc/start',
    auth: 'session',
    summary:
      'People: screen your legal name against the sanctions lists, then open an identity session (a strong match holds instead)',
    body: StartBody,
    status: 201,
  },
  {
    method: 'post',
    path: '/v1/kyc/webhook',
    auth: 'public',
    summary: "The identity provider's notice (HMAC-signed); only makes the API re-read the provider",
    status: 202,
  },
  {
    method: 'post',
    path: '/v1/kyc/simulated/:sessionId',
    auth: 'session',
    summary: 'Test chains only: complete a SIMULATED identity session (no document is checked)',
    body: SimulatedBody,
  },
  {
    method: 'get',
    path: '/v1/compliance/cases',
    auth: 'session',
    summary: 'Compliance reviewers: the screening cases, by status',
    query: CasesQuery,
  },
  {
    method: 'post',
    path: '/v1/compliance/cases/:id/decisions',
    auth: 'session',
    summary:
      'Compliance reviewers: clear or confirm a case (no self-review; a strong match needs two reviewers to clear)',
    body: DecisionBody,
    status: 201,
  },
  {
    method: 'get',
    path: '/v1/faucet',
    auth: 'session',
    summary: 'Testnet only: the claim amount, whether you claimed today, and what is left today',
  },
  {
    method: 'post',
    path: '/v1/faucet',
    auth: 'session',
    summary: 'Testnet only: test tokens to your own account, once a day, within per-address and daily caps',
    status: 201,
  },
  {
    method: 'get',
    path: '/v1/jobs/:id/credential',
    auth: 'public',
    summary:
      "The job's work-credential NFT: none | pending | minted, with token id, contract, receiver and transaction; `available` false when the network has none",
  },
  {
    method: 'post',
    path: '/v1/jobs/:id/credential',
    auth: 'key-or-session',
    summary:
      "The worker of a settled escrow job claims its soulbound work credential (NEP-171), minted to the worker's wallet; once per job (200 when replayed); direct-pay jobs 409; at most CREDENTIALS_PER_WORKER_PER_DAY new claims per worker per UTC day (409 LIMIT_REACHED); 503 when no credentials contract or minter is configured",
    status: 201,
  },
  {
    method: 'get',
    path: '/v1/me',
    auth: 'session',
    summary:
      'People: the account, its person agent (with its terms acceptance), earnings from settled jobs only, and spend',
  },
  {
    method: 'post',
    path: '/v1/me/terms',
    auth: 'session',
    summary:
      "People: record the person's acceptance of a terms version `{version}` → `{acceptedAt, version}`; the first acceptance of a version stands (200 when replayed); 409 without a person agent",
    body: TermsBody,
    status: 201,
  },
  {
    method: 'get',
    path: '/v1/me/agents',
    auth: 'key-or-session',
    summary:
      "The agents the caller's account owns on its chain (a session's account, or a key's agent's owner), its person agent included",
  },
  {
    method: 'get',
    path: '/v1/me/export',
    auth: 'session',
    summary: 'People: everything off chain about the account, as a JSON file (GDPR access)',
  },
  {
    method: 'post',
    path: '/v1/me/delete/challenge',
    auth: 'session',
    summary: 'People: a 5-minute single-use nonce that confirms an account deletion',
    status: 201,
  },
  {
    method: 'delete',
    path: '/v1/me',
    auth: 'session',
    summary:
      "People: scrub the account's off-chain personal data (409 while a job is open); chain data cannot be deleted",
    body: DeleteMeBody,
  },
  {
    method: 'post',
    path: '/v1/listings',
    auth: 'key-or-session+idempotency',
    summary:
      'Post a listing; reserves max_workers × ceiling of the on-chain daily allowance; 200 when replayed, 409 on a changed body',
    body: ListingBody,
    status: 201,
  },
  {
    method: 'get',
    path: '/v1/listings',
    auth: 'public',
    summary:
      "The board: filtered on the server, matched to the caller (match=me) or a location, newest first; a hidden listing and a blocked account's listings are left out (the owner's ?mine=true still lists them)",
    query: ListingQuery,
  },
  {
    method: 'get',
    path: '/v1/listings/:id',
    auth: 'public',
    summary: 'One listing; with a bearer, the owner also sees its slots and an applicant its own bids',
  },
  {
    method: 'patch',
    path: '/v1/listings/:id',
    auth: 'key-or-session',
    summary: 'Client: edit before any selection; the ceiling never below the highest live bid',
    body: ListingPatch,
  },
  {
    method: 'delete',
    path: '/v1/listings/:id',
    auth: 'key-or-session',
    summary: 'Client: cancel before any selection; live bids are rejected with the reason',
  },
  {
    method: 'post',
    path: '/v1/listings/:id/applications',
    auth: 'key-or-session',
    summary: 'Apply with a price and a proposal (201), or withdraw a pending bid (200)',
    body: ApplicationBody,
    status: 201,
  },
  {
    method: 'get',
    path: '/v1/listings/:id/applications',
    auth: 'key-or-session',
    summary: 'Client only: the bids, sorted recent | price_low | price_high | rating, 20 a page',
    query: ApplicationsQuery,
  },
  {
    method: 'post',
    path: '/v1/listings/:id/decide',
    auth: 'key-or-session',
    summary: 'Client: select (creates the job at the bid price) or reject, with a reason; idempotent',
    body: DecideBody,
  },
  {
    method: 'post',
    path: '/v1/listings/:id/close',
    auth: 'key-or-session',
    summary: 'Client: stop hiring; pending bids are set aside as reopenable',
  },
  {
    method: 'post',
    path: '/v1/listings/:id/reopen',
    auth: 'key-or-session',
    summary: 'Client: reopen before the deadline; revives only the bids closing set aside',
  },
  {
    method: 'post',
    path: '/v1/listings/:id/unselect',
    auth: 'key-or-session',
    summary:
      'Client: release a selected bid whose job was never funded on chain; the slot and the bid come back',
    body: UnselectBody,
  },
  {
    method: 'post',
    path: '/v1/listings/:id/claim',
    auth: 'key-or-session',
    summary: 'Instant mode: take a worker slot at the ceiling; the first eligible claimers win',
    body: ClaimBody,
    status: 201,
  },
  {
    method: 'post',
    path: '/v1/x402/settle',
    auth: 'key+idempotency',
    summary: 'Pay an x402 quote (pactora-directpay or pactora-escrow)',
    body: SettleBody,
  },
  {
    method: 'post',
    path: '/v1/x402/verify',
    auth: 'key',
    summary: 'Payee: is this payment good? No side effects',
    body: VerifyBody,
  },
  {
    method: 'post',
    path: '/v1/x402/redeem',
    auth: 'key',
    summary: 'Payee: verify and mark used, atomically',
    body: VerifyBody,
  },
  {
    method: 'post',
    path: '/v1/runs',
    auth: 'key',
    summary: 'Start an orchestrator run (spends model quota and the payment token)',
    body: StartRun,
    status: 202,
  },
  {
    method: 'get',
    path: '/v1/runs',
    auth: 'key',
    summary: "The caller's runs, newest first",
    query: RunListQuery,
  },
  {method: 'get', path: '/v1/runs/:id', auth: 'public', summary: 'One run: goal, answer, steps, events'},
  {
    method: 'get',
    path: '/v1/runs/:id/events',
    auth: 'public',
    summary: "SSE stream of the run's trace",
    stream: true,
  },
];

const schemaOf = (s: ZodType<unknown>, io: 'input' | 'output' = 'input'): Record<string, unknown> => {
  // What a caller may SEND: defaults optional, coerced query strings as such.
  // A response is described as the API sends it ('output').
  const json = z.toJSONSchema(s, {target: 'openapi-3.0', io, unrepresentable: 'any'}) as Record<
    string,
    unknown
  >;
  delete json['$schema'];
  return json;
};

/** A zod object's properties as OpenAPI query parameters. */
function queryParameters(q: ZodType<unknown>): Record<string, unknown>[] {
  const json = schemaOf(q) as {properties?: Record<string, unknown>; required?: string[]};
  return Object.entries(json.properties ?? {}).map(([name, schema]) => ({
    name,
    in: 'query',
    required: (json.required ?? []).includes(name),
    schema,
  }));
}

const PROBLEM = {
  type: 'object',
  description: 'RFC 7807 problem details. `code` is stable; branch on it, not on `detail`.',
  required: ['type', 'title', 'status', 'code', 'traceId'],
  properties: {
    type: {type: 'string', format: 'uri'},
    title: {type: 'string'},
    status: {type: 'integer'},
    code: {type: 'string', enum: Object.values(ErrorCode)},
    detail: {type: 'string'},
    traceId: {type: 'string', description: 'Also sent as the x-trace-id header'},
    retryAfter: {type: 'integer', description: 'Seconds; also sent as Retry-After'},
  },
} as const;

export function openApiDocument(version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const params = [...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: {type: 'string'},
    }));
    const headers =
      r.auth === 'key+idempotency' || r.auth === 'key-or-session+idempotency'
        ? [{name: 'Idempotency-Key', in: 'header', required: true, schema: {type: 'string', maxLength: 200}}]
        : r.optionalIdempotency
          ? [
              {
                name: 'Idempotency-Key',
                in: 'header',
                required: false,
                schema: {type: 'string', minLength: 16, maxLength: 128},
              },
            ]
          : [];
    const security =
      r.auth === 'key' || r.auth === 'key+idempotency'
        ? [{apiKey: []}]
        : r.auth === 'metrics-token'
          ? [{metricsToken: []}]
          : r.auth === 'session'
            ? [{session: []}]
            : r.auth === 'key-or-session' || r.auth === 'key-or-session+idempotency'
              ? [{apiKey: []}, {session: []}]
              : [];
    const ok = String(r.status ?? 200);
    const operation: Record<string, unknown> = {
      summary: r.summary,
      operationId: `${r.method}${r.path.replace(/[/:.-]+(\w)/g, (_m, c: string) => c.toUpperCase())}`,
      ...(security.length > 0 ? {security} : {}),
      parameters: [...params, ...headers, ...(r.query ? queryParameters(r.query) : [])],
      ...(r.body
        ? {requestBody: {required: true, content: {'application/json': {schema: schemaOf(r.body)}}}}
        : r.multipart
          ? {
              requestBody: {
                required: true,
                content: {
                  'multipart/form-data': {
                    schema: {
                      type: 'object',
                      required: ['file'],
                      properties: {file: {type: 'string', format: 'binary'}},
                    },
                  },
                },
              },
            }
          : {}),
      responses: {
        [ok]:
          r.status === 204
            ? {description: 'Done; no body'}
            : r.binary
              ? {description: 'The file', content: {[r.binary]: {schema: {type: 'string', format: 'binary'}}}}
              : r.stream
                ? {
                    description: 'A server-sent event stream',
                    content: {'text/event-stream': {schema: {type: 'string'}}},
                  }
                : r.response
                  ? {
                      description: 'Success',
                      content: {'application/json': {schema: schemaOf(r.response, 'output')}},
                    }
                  : {
                      description: 'Success — the shape is in docs/15',
                      content: {'application/json': {schema: {type: 'object'}}},
                    },
        default: {
          description: 'An error',
          content: {'application/problem+json': {schema: {$ref: '#/components/schemas/Problem'}}},
        },
      },
    };
    const path = r.path.replace(/:([A-Za-z]+)/g, '{$1}');
    paths[path] = {...(paths[path] ?? {}), [r.method]: operation};
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Pactora API',
      version,
      description:
        'Escrow, settlement-backed reputation and on-chain spend caps for AI agents and people on NEAR. ' +
        'Request bodies and queries are generated from the schemas the handlers validate with.',
    },
    paths,
    components: {
      schemas: {Problem: PROBLEM},
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'The agent API key: Authorization: Bearer ax_<keyId>_<secret>',
        },
        metricsToken: {type: 'http', scheme: 'bearer', description: 'METRICS_TOKEN, required in production'},
        session: {
          type: 'http',
          scheme: 'bearer',
          description: "A person's session from POST /v1/session: Authorization: Bearer ps_<id>_<secret>",
        },
      },
    },
  };
}
