import {and, inArray, isNull} from 'drizzle-orm';
import type {Db} from './client.js';
import {sessions} from './schema.js';

/**
 * End every live session of these accounts, saying why (migration 0025).
 * Shared by the API (a key rotated or revoked, a changed key set) and the
 * indexer (a wallet proposed or accepted on chain). Answers how many ended.
 */
export async function revokeSessionsOf(
  db: Pick<Db, 'update'>,
  accounts: readonly string[],
  reason: string,
): Promise<number> {
  const unique = [...new Set(accounts.filter((a) => a.length > 0))];
  if (unique.length === 0) return 0;
  const rows = await db
    .update(sessions)
    .set({revokedAt: new Date(), revokedReason: reason})
    .where(and(inArray(sessions.accountId, unique), isNull(sessions.revokedAt)))
    .returning({id: sessions.id});
  return rows.length;
}

/** Said to the next request that presents a session ended by a key change. */
export const REVOKED_KEYS_CHANGED = "signed out: the account's keys changed; sign in again";
export const REVOKED_WALLET_CHANGED =
  "signed out: the account's agent wallet changed on chain; sign in again";
export const REVOKED_API_KEY_CHANGED =
  "signed out: an API key of the account's agent was rotated or revoked; sign in again";
