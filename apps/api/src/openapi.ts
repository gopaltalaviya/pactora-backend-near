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

type Auth = 'public' | 'key' | 'key+idempotency' | 'owner-signature' | 'metrics-token' | 'session';

interface Route {
  method: 'get' | 'post' | 'patch' | 'delete';
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
    auth: 'key',
    summary: "The caller's jobs, as worker and/or client",
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
      r.auth === 'key+idempotency'
        ? [{name: 'Idempotency-Key', in: 'header', required: true, schema: {type: 'string', maxLength: 200}}]
        : [];
    const security =
      r.auth === 'key' || r.auth === 'key+idempotency'
        ? [{apiKey: []}]
        : r.auth === 'metrics-token'
          ? [{metricsToken: []}]
          : r.auth === 'session'
            ? [{session: []}]
            : [];
    const ok = String(r.status ?? 200);
    const operation: Record<string, unknown> = {
      summary: r.summary,
      operationId: `${r.method}${r.path.replace(/[/:.-]+(\w)/g, (_m, c: string) => c.toUpperCase())}`,
      ...(security.length > 0 ? {security} : {}),
      parameters: [...params, ...headers, ...(r.query ? queryParameters(r.query) : [])],
      ...(r.body
        ? {requestBody: {required: true, content: {'application/json': {schema: schemaOf(r.body)}}}}
        : {}),
      responses: {
        [ok]:
          r.status === 204
            ? {description: 'Done; no body'}
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
