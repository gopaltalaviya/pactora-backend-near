import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {and, eq, inArray, ne, sql} from 'drizzle-orm';
import {
  accountStanding,
  complianceAudit,
  complianceCases,
  complianceDecisions,
  sanctionsEntries,
  sanctionsListVersions,
  standingOf,
  type Db,
  type Standing,
} from '@pactora/db';
import {
  refreshDecision,
  screenName,
  sha256Text,
  type ListEntry,
  type RefreshDecision,
  type ScreeningHit,
} from '@pactora/compliance';
import {ErrorCode, PactoraError} from '@pactora/shared';

/**
 * Identity checks, sanctions screening, cases and standing (docs/26 F13,
 * F14, F27). Everything here is a SOFT gate: the API, the keeper and the
 * signer honour a hold, but the contract does not know about it, and its
 * permissionless exits (auto_approve above all) bypass every one. The docs
 * say so; nothing here claims otherwise.
 *
 * NEAR accounts are not screened: no sanctions list names one (checked on
 * the OFAC list of 2026-11-08: addresses for 16 assets, none NEAR). People
 * are screened by the legal name they give before an identity session.
 */

/** A hit at or above this is strong: the account is held and two reviewers must clear it. */
export const STRONG_MATCH = 0.97;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Writer = Db | Tx;

// ── lists ───────────────────────────────────────────────────────────────

/**
 * Store a freshly fetched list, if the guards allow: unchanged → skip; too
 * small, or under 70 % of the active copy → refuse and keep the old one;
 * else write the new entries and switch `active` in ONE transaction, so a
 * screening reads the old copy or the new one, never half of either.
 */
export async function storeList(
  db: Db,
  source: 'ofac' | 'un' | 'uk',
  rawText: string,
  entries: ListEntry[],
): Promise<RefreshDecision> {
  const sha256 = sha256Text(rawText);
  return db.transaction(async (tx) => {
    // One refresh per source at a time.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sanctions:${source}`}))`);
    const active = await tx.query.sanctionsListVersions.findFirst({
      where: and(eq(sanctionsListVersions.source, source), eq(sanctionsListVersions.active, true)),
    });
    const decision = refreshDecision(
      source,
      {sha256, entries: entries.length},
      active ? {sha256: active.sha256, entries: active.entryCount} : null,
    );
    if (decision.action !== 'replace') {
      await audit(tx, 'system', `sanctions.refresh.${decision.action}`, {
        detail: {source, reason: decision.reason},
      });
      return decision;
    }
    if (active)
      await tx
        .update(sanctionsListVersions)
        .set({active: false})
        .where(eq(sanctionsListVersions.id, active.id));
    const [v] = await tx
      .insert(sanctionsListVersions)
      .values({source, sha256, entryCount: entries.length, active: true})
      .returning({id: sanctionsListVersions.id});
    for (let i = 0; i < entries.length; i += 500) {
      await tx.insert(sanctionsEntries).values(
        entries.slice(i, i + 500).map((e) => ({
          versionId: v!.id,
          source,
          ref: e.ref,
          kind: e.kind,
          names: e.names,
          addresses: (e.addresses ?? []).map((a) => `${a.ticker} ${a.address}`),
        })),
      );
    }
    if (active) await tx.delete(sanctionsEntries).where(eq(sanctionsEntries.versionId, active.id));
    await audit(tx, 'system', 'sanctions.refresh.replace', {
      detail: {source, entries: entries.length, sha256},
    });
    return decision;
  });
}

/** The active entries, cached in memory until the set of active versions changes. */
export class SanctionsIndex {
  private key = '';
  private entries: ListEntry[] = [];
  constructor(private readonly db: Db) {}

  async load(): Promise<{
    entries: ListEntry[];
    versions: {source: string; entries: number; fetchedAt: Date}[];
  }> {
    const versions = await this.db
      .select()
      .from(sanctionsListVersions)
      .where(eq(sanctionsListVersions.active, true));
    const key = versions
      .map((v) => v.id)
      .sort()
      .join(',');
    if (key !== this.key) {
      const rows = versions.length
        ? await this.db
            .select()
            .from(sanctionsEntries)
            .where(
              inArray(
                sanctionsEntries.versionId,
                versions.map((v) => v.id),
              ),
            )
        : [];
      this.entries = rows.map((r) => ({
        source: r.source,
        ref: r.ref,
        kind: r.kind as ListEntry['kind'],
        names: r.names,
      }));
      this.key = key;
    }
    return {
      entries: this.entries,
      versions: versions.map((v) => ({source: v.source, entries: v.entryCount, fetchedAt: v.fetchedAt})),
    };
  }

  async screen(name: string): Promise<{hits: ScreeningHit[]; sources: string[]}> {
    const {entries, versions} = await this.load();
    return {hits: screenName(name, entries), sources: versions.map((v) => v.source)};
  }
}

// ── standing, cases, decisions ───────────────────────────────────────────

export async function audit(
  db: Writer,
  actor: string,
  action: string,
  extra: {agentId?: number; caseId?: number; detail?: Record<string, unknown>} = {},
): Promise<void> {
  await db.insert(complianceAudit).values({
    actor,
    action,
    ...(extra.agentId !== undefined ? {agentId: extra.agentId} : {}),
    ...(extra.caseId !== undefined ? {caseId: extra.caseId} : {}),
    detail: extra.detail ?? {},
  });
}

export async function setStanding(
  db: Writer,
  agentId: number,
  standing: Standing,
  reason: string,
  actor: string,
) {
  await db
    .insert(accountStanding)
    .values({agentId, standing, reason, updatedAt: new Date()})
    .onConflictDoUpdate({target: accountStanding.agentId, set: {standing, reason, updatedAt: new Date()}});
  await audit(db, actor, `standing.${standing}`, {agentId, detail: {reason}});
}

/** Refuse what a held or blocked account may not do, saying why. */
export async function requireClear(db: Db, agentId: number, what: string): Promise<void> {
  const s = await standingOf(db, agentId);
  if (s !== 'clear') {
    throw new PactoraError(
      ErrorCode.FORBIDDEN,
      s === 'blocked'
        ? `this account is blocked after a compliance review and cannot ${what}`
        : `this account is on hold while a compliance review is open, and cannot ${what} until it is cleared`,
    );
  }
}

/**
 * A payout to a held or blocked worker is refused by Pactora's own services
 * (the signer, the keeper): the API says so before anything is signed. Soft:
 * the contract's permissionless `auto_approve` pays regardless (docs/26 F13).
 */
export async function requireWorkerPayable(db: Db, workerAgentId: number): Promise<void> {
  const s = await standingOf(db, workerAgentId);
  if (s !== 'clear') {
    throw new PactoraError(
      ErrorCode.FORBIDDEN,
      `the worker's payout is held: their account is ${s === 'blocked' ? 'blocked after a compliance review' : 'on hold while a compliance review is open'}; the review window's auto_approve still pays on chain`,
    );
  }
}

/** Open one case per hit; a strong hit holds the account. Returns whether it was held. */
export async function openCases(
  tx: Writer,
  agentId: number,
  subjectAccount: string,
  queryName: string,
  hits: ScreeningHit[],
): Promise<{held: boolean; cases: number}> {
  let held = false;
  for (const h of hits) {
    const strong = h.score >= STRONG_MATCH;
    held ||= strong;
    const [c] = await tx
      .insert(complianceCases)
      .values({
        agentId,
        subjectAccount,
        source: h.entry.source,
        entryRef: h.entry.ref,
        queryName,
        matchedName: h.matchedName,
        score: h.score.toFixed(4),
        strength: strong ? 'strong' : 'weak',
      })
      .returning({id: complianceCases.id});
    await audit(tx, 'system', 'case.opened', {
      agentId,
      caseId: c!.id,
      detail: {
        source: h.entry.source,
        ref: h.entry.ref,
        score: h.score,
        strength: strong ? 'strong' : 'weak',
      },
    });
  }
  if (held) await setStanding(tx, agentId, 'hold', 'a strong sanctions-list match is under review', 'system');
  return {held, cases: hits.length};
}

export type Decision = 'clear' | 'confirm';

/**
 * A reviewer's decision on a case. Rules: the reviewer is not the subject;
 * the decision names the case version it read (stale → 409); one decision
 * per reviewer per case (the same again is a replay, a different one 409);
 * confirm blocks the account at once; clearing a STRONG match needs two
 * different reviewers; once no case of the account is open, the hold lifts.
 */
export async function decide(
  db: Db,
  input: {casePublicId: string; reviewer: string; decision: Decision; reason: string; caseVersion: number},
): Promise<{status: string; version: number; replayed: boolean; clearsSoFar: number}> {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 2000) {
    throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, 'reason is 10-2000 characters');
  }
  return db.transaction(async (tx) => {
    const [c] = await tx
      .select()
      .from(complianceCases)
      .where(eq(complianceCases.publicId, input.casePublicId))
      .for('update');
    if (!c) throw new PactoraError(ErrorCode.NOT_FOUND, `no case ${input.casePublicId}`);
    if (c.subjectAccount === input.reviewer) {
      throw new PactoraError(ErrorCode.FORBIDDEN, 'a reviewer may not decide a case about their own account');
    }
    const prior = await tx.query.complianceDecisions.findFirst({
      where: and(eq(complianceDecisions.caseId, c.id), eq(complianceDecisions.reviewer, input.reviewer)),
    });
    const clears = async () =>
      (
        await tx
          .select()
          .from(complianceDecisions)
          .where(and(eq(complianceDecisions.caseId, c.id), eq(complianceDecisions.decision, 'clear')))
      ).length;
    if (prior) {
      if (prior.decision === input.decision)
        return {status: c.status, version: c.version, replayed: true, clearsSoFar: await clears()};
      throw new PactoraError(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        `you already decided this case: ${prior.decision}`,
      );
    }
    if (c.status !== 'open')
      throw new PactoraError(ErrorCode.INVALID_STATE, `the case is already ${c.status}`);
    if (input.caseVersion !== c.version) {
      throw new PactoraError(
        ErrorCode.INVALID_STATE,
        `stale case: it is at version ${c.version}, you read ${input.caseVersion}`,
      );
    }
    await tx.insert(complianceDecisions).values({
      caseId: c.id,
      reviewer: input.reviewer,
      decision: input.decision,
      reason,
      caseVersion: c.version,
    });
    const version = c.version + 1;
    let status = 'open';
    if (input.decision === 'confirm') status = 'confirmed';
    else if (c.strength === 'weak' || (await clears()) >= 2) status = 'cleared';
    await tx
      .update(complianceCases)
      .set({version, status, ...(status !== 'open' ? {closedAt: new Date()} : {})})
      .where(eq(complianceCases.id, c.id));
    await audit(tx, input.reviewer, `case.${input.decision}`, {
      agentId: c.agentId,
      caseId: c.id,
      detail: {reason, version: c.version, result: status},
    });
    if (status === 'confirmed') {
      await setStanding(
        tx,
        c.agentId,
        'blocked',
        'a sanctions-list match was confirmed by a reviewer',
        input.reviewer,
      );
    } else if (status === 'cleared') {
      const stillOpen = await tx
        .select({id: complianceCases.id})
        .from(complianceCases)
        .where(
          and(
            eq(complianceCases.agentId, c.agentId),
            eq(complianceCases.status, 'open'),
            ne(complianceCases.id, c.id),
          ),
        );
      const current = await standingOf(tx, c.agentId);
      if (stillOpen.length === 0 && current === 'hold') {
        await setStanding(
          tx,
          c.agentId,
          'clear',
          'every screening match was cleared by review',
          input.reviewer,
        );
      }
    }
    return {status, version, replayed: false, clearsSoFar: await clears()};
  });
}

// ── identity providers ───────────────────────────────────────────────────

export type ProviderStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface IdentityDecision {
  status: ProviderStatus;
  documentVerified: boolean;
  /** What the provider was told this session is for; must be our verification's id. */
  vendorData: string;
}

/**
 * A KYC provider. Webhooks only tell us WHICH session changed: the decision
 * is always re-read from the provider (`fetchDecision`), so a forged or
 * replayed webhook can at most make us ask again.
 */
export interface IdentityProvider {
  readonly name: string;
  /** True for the simulated provider, which every screen labels as such. */
  readonly simulated: boolean;
  createSession(input: {vendorData: string}): Promise<{sessionId: string; url: string}>;
  fetchDecision(sessionId: string): Promise<IdentityDecision>;
  /** The session a genuine, fresh webhook names, or null. */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>, nowS: number): string | null;
}

/** HMAC-SHA256 over `${timestamp}.${rawBody}`, hex, ±300 s: the shape most vendors use. */
export function verifyHmacWebhook(
  secret: string,
  rawBody: string,
  headers: Record<string, string | undefined>,
  nowS: number,
): boolean {
  const t = Number(headers['x-timestamp']);
  const sig = headers['x-signature'] ?? '';
  if (!Number.isInteger(t) || Math.abs(nowS - t) > 300 || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(sig, 'hex'));
}

/**
 * Testnet only, and labelled everywhere it shows: no document is looked at.
 * A session is "completed" by the person pressing a button on the simulated
 * page (POST /v1/kyc/simulated/:sessionId), which records the outcome here.
 * Its webhook is signed like a real vendor's, so the same path is tested.
 */
export class SimulatedIdentityProvider implements IdentityProvider {
  readonly name = 'simulated';
  readonly simulated = true;
  private readonly sessions = new Map<string, IdentityDecision>();
  constructor(
    private readonly webhookSecret: string,
    private readonly pageBase: string,
  ) {}

  async createSession({vendorData}: {vendorData: string}) {
    const sessionId = `sim_${randomBytes(12).toString('hex')}`;
    this.sessions.set(sessionId, {status: 'pending', documentVerified: false, vendorData});
    return {sessionId, url: `${this.pageBase}/kyc/simulated?session=${sessionId}`};
  }

  async fetchDecision(sessionId: string): Promise<IdentityDecision> {
    const d = this.sessions.get(sessionId);
    if (!d) throw new PactoraError(ErrorCode.NOT_FOUND, `no simulated session ${sessionId}`);
    return d;
  }

  /** What the simulated page's buttons do; a real vendor's own UI does this. */
  complete(sessionId: string, outcome: 'approved' | 'rejected', documentVerified: boolean): void {
    const d = this.sessions.get(sessionId);
    if (!d) throw new PactoraError(ErrorCode.NOT_FOUND, `no simulated session ${sessionId}`);
    this.sessions.set(sessionId, {...d, status: outcome, documentVerified});
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>, nowS: number): string | null {
    if (!verifyHmacWebhook(this.webhookSecret, rawBody, headers, nowS)) return null;
    try {
      const body = JSON.parse(rawBody) as {sessionId?: unknown};
      return typeof body.sessionId === 'string' ? body.sessionId : null;
    } catch {
      return null;
    }
  }
}
