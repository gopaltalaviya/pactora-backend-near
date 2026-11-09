import type {FastifyInstance, FastifyRequest} from 'fastify';
import {eq, sql} from 'drizzle-orm';
import {z} from 'zod';
import {sessions, type Db} from '@pactora/db';
import {ErrorCode, PactoraError} from '@pactora/shared';
import {authenticatePerson} from '../auth.js';
import {audit} from '../compliance.js';
import {ADMIN_SESSION_MAX_MS} from './admin.js';

/**
 * The compliance audit log as a CSV, for reviewers (2026-11-09, round 3).
 *
 * Read from `compliance_audit` (append-only, trigger-guarded): sanctions
 * screening cases (opened, each decision), identity checks (started, each
 * result), standing changes, and report resolutions — when, which kind,
 * the case's public id, the reviewer's account (or `system`), the account
 * the row is about, and the outcome.
 *
 * What it never carries: document contents, legal or matched names, list
 * entry references, report details, or any reviewer's free-text reason or
 * note (a note can quote a name). The `note` column holds only values from
 * fixed lists: a report's reason (`scam`, `spam`, …) or a screening list's
 * source. Each export is itself audited, and the route is rate-limited.
 */

export const AUDIT_EXPORT_PER_MINUTE = 6;
export const AUDIT_EXPORT_MAX_ROWS = 50_000;
export const AUDIT_EXPORT_MAX_DAYS = 366;
export const AUDIT_CSV_COLUMNS = [
  'at',
  'kind',
  'action',
  'case_id',
  'reviewer',
  'subject_account',
  'outcome',
  'note',
] as const;

const DAY = 86_400_000;

const When = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, 'an ISO date or date-time')
  .transform((s, ctx) => {
    const d = new Date(/T/.test(s) && !/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? `${s}Z` : s);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({code: 'custom', message: 'not a date'});
      return z.NEVER;
    }
    return d;
  });

export const AuditLogQuery = z.object({from: When.optional(), to: When.optional()});

/** A spreadsheet must not run a cell as a formula (CSV injection). */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

interface AuditRow {
  at: Date | string;
  action: string;
  actor: string;
  case_public_id: string | null;
  detail_case: string | null;
  subject_account: string | null;
  result: string | null;
  report_reason: string | null;
  source: string | null;
}

/** compliance_audit's action → the export's kind, outcome and note. */
function toCsvRow(r: AuditRow): string[] {
  const [prefix, ...rest] = r.action.split('.');
  const tail = rest.join('.');
  const kind =
    prefix === 'case'
      ? 'screening'
      : prefix === 'kyc'
        ? 'kyc'
        : prefix === 'standing'
          ? 'standing'
          : 'report';
  let outcome = tail;
  let note = '';
  if (prefix === 'case') {
    // A decision names the case's resulting status; a strong match stays open after one clear.
    outcome =
      tail === 'opened' ? 'opened' : `${tail}${r.result && r.result !== tail ? ` (case ${r.result})` : ''}`;
    if (tail === 'opened' && r.source) note = r.source;
  } else if (prefix === 'kyc') {
    outcome = tail === 'session' ? 'started' : tail;
  } else if (prefix === 'report') {
    note = r.report_reason ?? '';
  }
  return [
    new Date(r.at).toISOString(),
    kind,
    r.action,
    r.case_public_id ?? r.detail_case ?? '',
    r.actor,
    r.subject_account ?? '',
    outcome,
    note,
  ];
}

export interface AuditLogRouteDeps {
  db: Db;
  reviewers: () => string[];
}

export async function registerAuditLogRoutes(app: FastifyInstance, deps: AuditLogRouteDeps): Promise<void> {
  const {db} = deps;

  async function reviewer(request: FastifyRequest): Promise<string> {
    const person = await authenticatePerson(db, request);
    const s = await db.query.sessions.findFirst({where: eq(sessions.id, person.sessionId)});
    if (!s || Date.now() - s.createdAt.getTime() > ADMIN_SESSION_MAX_MS) {
      throw new PactoraError(
        ErrorCode.UNAUTHORIZED,
        'admin needs a sign-in less than an hour old: sign in again',
      );
    }
    if (!deps.reviewers().includes(person.account)) {
      throw new PactoraError(ErrorCode.FORBIDDEN, 'only compliance reviewers may export the audit log');
    }
    return person.account;
  }

  const limited = {
    config: {
      rateLimit: {
        max: AUDIT_EXPORT_PER_MINUTE,
        timeWindow: '1 minute',
        // Per credential, so one reviewer's exports do not use up another's.
        keyGenerator: (req: FastifyRequest) => String(req.headers.authorization ?? req.ip),
      },
    },
  };

  app.get('/v1/admin/audit-log.csv', limited, async (request, reply) => {
    const who = await reviewer(request);
    const q = AuditLogQuery.parse(request.query ?? {});
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 30 * DAY);
    if (from.getTime() >= to.getTime()) {
      throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, '`from` must be before `to`');
    }
    if (to.getTime() - from.getTime() > AUDIT_EXPORT_MAX_DAYS * DAY) {
      throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, `at most ${AUDIT_EXPORT_MAX_DAYS} days per export`);
    }
    const rows = (await db.execute(sql`
      SELECT l.at, l.action, l.actor,
             c.public_id::text AS case_public_id,
             COALESCE(l.detail->>'verification', l.detail->>'report') AS detail_case,
             COALESCE(c.subject_account, a.owner_address) AS subject_account,
             l.detail->>'result' AS result,
             CASE WHEN l.action LIKE 'report.%' THEN l.detail->>'reason' END AS report_reason,
             CASE WHEN l.action = 'case.opened' THEN l.detail->>'source' END AS source
        FROM compliance_audit l
        LEFT JOIN compliance_cases c ON c.id = l.case_id
        LEFT JOIN agents a ON a.id = l.agent_id
       WHERE l.at >= ${from.toISOString()}::timestamptz AND l.at < ${to.toISOString()}::timestamptz
         AND (l.action LIKE 'case.%' OR l.action LIKE 'kyc.%' OR l.action LIKE 'standing.%'
              OR l.action LIKE 'report.%')
       ORDER BY l.at ASC, l.id ASC
       LIMIT ${AUDIT_EXPORT_MAX_ROWS + 1}`)) as unknown as AuditRow[];
    const truncated = rows.length > AUDIT_EXPORT_MAX_ROWS;
    const lines = [AUDIT_CSV_COLUMNS.join(',')];
    for (const r of rows.slice(0, AUDIT_EXPORT_MAX_ROWS)) lines.push(toCsvRow(r).map(csvCell).join(','));
    if (truncated)
      lines.push(
        ['', 'truncated', '', '', '', '', '', `more than ${AUDIT_EXPORT_MAX_ROWS} rows: narrow the window`]
          .map(csvCell)
          .join(','),
      );
    await audit(db, who, 'admin.audit_log.exported', {
      detail: {
        from: from.toISOString(),
        to: to.toISOString(),
        rows: Math.min(rows.length, AUDIT_EXPORT_MAX_ROWS),
      },
    });
    const day = (d: Date) => d.toISOString().slice(0, 10);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="pactora-audit-${day(from)}-${day(to)}.csv"`)
      .header('cache-control', 'private, no-store')
      .send(`${lines.join('\r\n')}\r\n`);
  });
}
