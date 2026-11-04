import {sql} from 'drizzle-orm';
import type {Db} from '@pactora/db';

/** Delete windows long past: one row per client would otherwise grow forever. */
export async function pruneRateLimits(db: Db): Promise<void> {
  await db.execute(sql`DELETE FROM rate_limits WHERE window_start < now() - interval '1 hour'`);
}

/** Prune once per this many increments, from whichever replica is counting. */
const PRUNE_EVERY = 1_000;

/**
 * A `@fastify/rate-limit` store that counts in Postgres (v3), so every API
 * replica shares one window per client instead of each allowing the full
 * limit (docs/17: "per process, so N× with N replicas").
 *
 * One atomic upsert per request: a window that has passed restarts at 1, a
 * live one counts up. Opt-in (`RATE_LIMIT_STORE=postgres`) — one replica, the
 * deployment today, needs no database write per request. The plugin is told
 * to skip on a store error: a limiter that fails closed would turn a database
 * hiccup into an API outage, for a protection whose job is to keep it up.
 */
export function postgresRateLimitStore(db: Db) {
  let counted = 0;
  return class PostgresRateLimitStore {
    /**
     * @param scope '' for the global limit; a route's own for a per-route one.
     *   The plugin does NOT namespace keys per route (the key is the client
     *   IP, plus an optional groupId); the in-memory store separates routes
     *   only by giving each child its own map. One shared table needs the
     *   route in the key instead.
     */
    constructor(readonly scope = '') {}

    incr(
      key: string,
      callback: (error: Error | null, result?: {current: number; ttl: number}) => void,
      timeWindow: number,
    ): void {
      const ms = Math.max(1, Math.trunc(timeWindow));
      key = `${this.scope}${key}`;
      if (++counted % PRUNE_EVERY === 0) void pruneRateLimits(db).catch(() => {});
      db.execute(
        sql`
        INSERT INTO rate_limits (key, count, window_start) VALUES (${key}, 1, now())
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN rate_limits.window_start + make_interval(secs => ${ms} / 1000.0) <= now()
                       THEN 1 ELSE rate_limits.count + 1 END,
          window_start = CASE WHEN rate_limits.window_start + make_interval(secs => ${ms} / 1000.0) <= now()
                              THEN now() ELSE rate_limits.window_start END
        RETURNING count,
          GREATEST(0, ${ms} - (EXTRACT(EPOCH FROM (now() - window_start)) * 1000))::bigint AS ttl
      `,
      )
        .then((rows) => {
          const row = (rows as unknown as {count: number; ttl: string | number}[])[0];
          callback(null, {current: Number(row?.count ?? 1), ttl: Number(row?.ttl ?? ms)});
        })
        .catch((err: unknown) => callback(err instanceof Error ? err : new Error(String(err))));
    }

    /** A per-route limit: same table, its own keys. */
    child(params: {routeInfo?: {method?: unknown; url?: unknown}}): PostgresRateLimitStore {
      const route = params.routeInfo;
      const method = typeof route?.method === 'string' ? route.method : '';
      const url = typeof route?.url === 'string' ? route.url : '';
      return new PostgresRateLimitStore(`${method} ${url}|`);
    }
  };
}
