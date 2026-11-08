import {eq, sql} from 'drizzle-orm';
import type {Db} from './client.js';
import {accountStanding} from './schema.js';

/**
 * An agent's compliance standing (docs/26 F14): `clear` (no row), `hold`
 * (a screening match is under review) or `blocked` (a match was confirmed).
 * Read by the API (applying, claiming, accepting), the keeper and the
 * signer (approve). These gates are SOFT: the contract's permissionless
 * exits, `auto_approve` above all, bypass every one of them (docs/26 F13).
 */
export type Standing = 'clear' | 'hold' | 'blocked';

export async function standingOf(db: Pick<Db, 'query'>, agentId: number): Promise<Standing> {
  const row = await db.query.accountStanding.findFirst({where: eq(accountStanding.agentId, agentId)});
  return (row?.standing as Standing | undefined) ?? 'clear';
}

/** SQL: true when the agent (a column or value) is held or blocked. */
export const isHeldSql = (agentId: unknown) =>
  sql`EXISTS (SELECT 1 FROM account_standing s WHERE s.agent_id = ${agentId} AND s.standing <> 'clear')`;
