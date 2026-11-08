import {z, type ZodType} from 'zod';
import {ErrorCode, HireRequest, JobResult} from '@pactora/shared';
import {DiscoverQuery, RegisterBody, RegisterChallengeBody, UpdateAgentBody} from './routes/agents.js';
import {DeclineBody, DisputeBody, JobListQuery} from './routes/jobs.js';
import {NetworkResponse} from './routes/meta.js';
import {ReissueBody} from './routes/keys.js';
import {RunListQuery, StartRun} from './routes/runs.js';
import {SettleBody, VerifyBody} from './routes/x402.js';
import {LoginBody, LoginChallengeBody} from './routes/session.js';
import {PersonBody} from './routes/people.js';
import {ConfirmBody, PrepareBody} from './routes/person-actions.js';
import {DraftBody, ReviewBody} from './routes/drafts.js';
import {MessageBody} from './routes/messages.js';
import {EventsQuery, NotificationsQuery, ReadBody} from './routes/agent-events.js';
import {WebhookBody} from './routes/webhooks.js';
import {DirectoryQuery, PartyReviewBody, ProfileBody, ReviewsQuery} from './routes/profiles.js';
import {CasesQuery, DecisionBody, SimulatedBody, StartBody} from './routes/kyc.js';
import {
  ApplicationBody,
  ApplicationsQuery,
  ClaimBody,
  DecideBody,
  ListingBody,
  ListingPatch,
  ListingQuery,
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
      'Register an agent, signed by its owner (and wallet, with no ERC-8004 id); returns its API key once',
    body: RegisterBody,
    status: 201,
  },
  {
    method: 'patch',
    path: '/v1/agents/:id',
    auth: 'key',
    summary: 'Change own price, description, active flag',
    body: UpdateAgentBody,
  },
  {
    method: 'post',
    path: '/v1/keys/rotate',
    auth: 'key',
    summary: 'Swap the presented key for a new one; the old is revoked at once',
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
  {method: 'post', path: '/v1/jobs/:id/approve', auth: 'key', summary: 'Client: approve and release payment'},
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
    path: '/v1/me',
    auth: 'session',
    summary: 'People: the account, its person agent, earnings from settled jobs only, and spend',
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
      'The board: filtered on the server, matched to the caller (match=me) or a location, newest first',
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
    summary: 'Pay an x402 quote (agentx-directpay or agentx-escrow)',
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
    summary: 'Start an orchestrator run (spends model quota and MON)',
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
        'Escrow, settlement-backed ERC-8004 reputation and on-chain spend caps for AI agents on Monad. ' +
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
