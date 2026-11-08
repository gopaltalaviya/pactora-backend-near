/**
 * Machine-readable error codes, shared by API, agents and interface.
 *
 * One enum so all three branch on the same constants. An agent that sees
 * BUDGET_EXCEEDED must be able to react without string-matching a message.
 * Wire format is RFC 7807 problem details (docs/04 §5.3).
 */
export const ErrorCode = {
  AGENT_NOT_HIREABLE: 'AGENT_NOT_HIREABLE',
  PRICE_ABOVE_MAX: 'PRICE_ABOVE_MAX',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  INVALID_STATE: 'INVALID_STATE',
  DEADLINE_PASSED: 'DEADLINE_PASSED',
  SCHEMA_MISMATCH: 'SCHEMA_MISMATCH',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  CHAIN_MISMATCH: 'CHAIN_MISMATCH',
  CHAIN_NOT_ENABLED: 'CHAIN_NOT_ENABLED',
  /** No key, or one that is unknown or revoked. */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** A valid key acting on something that is not its agent's to act on. */
  FORBIDDEN: 'FORBIDDEN',
  /** No such job, run or agent — or an id that could not name one. */
  NOT_FOUND: 'NOT_FOUND',
  /** A service this one depends on did not answer usefully. Safe to retry. */
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  /** Too many requests, or a run cap reached — retry after `retry-after`. */
  RATE_LIMITED: 'RATE_LIMITED',
  /**
   * The worker's trust verdict is `block` (self-funded or failing record). A
   * refusal the caller's model cannot argue with: hire someone else.
   */
  COUNTERPARTY_BLOCKED: 'COUNTERPARTY_BLOCKED',
  /**
   * A real credential of the wrong kind: a person's session (`ps_`) on a
   * route for agent keys, or an agent key (`ax_`) on a route for people.
   */
  WRONG_CREDENTIAL: 'WRONG_CREDENTIAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  AGENT_NOT_HIREABLE: 409,
  PRICE_ABOVE_MAX: 409,
  BUDGET_EXCEEDED: 402,
  INSUFFICIENT_FUNDS: 402,
  INVALID_STATE: 409,
  DEADLINE_PASSED: 410,
  SCHEMA_MISMATCH: 422,
  IDEMPOTENCY_CONFLICT: 409,
  CHAIN_MISMATCH: 409,
  CHAIN_NOT_ENABLED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  UPSTREAM_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  COUNTERPARTY_BLOCKED: 403,
  WRONG_CREDENTIAL: 401,
};

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  retryAfter?: number;
}

export class PactoraError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
    readonly retryAfter?: number,
  ) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'PactoraError';
  }

  toProblem(title: string): Problem {
    return {
      type: `https://pactoragents.com/errors/${this.code.toLowerCase().replaceAll('_', '-')}`,
      title,
      status: ERROR_STATUS[this.code],
      code: this.code,
      ...(this.detail !== undefined ? {detail: this.detail} : {}),
      ...(this.retryAfter !== undefined ? {retryAfter: this.retryAfter} : {}),
    };
  }
}
