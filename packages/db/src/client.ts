import {drizzle} from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>;

/**
 * One connection factory for every service.
 *
 * `max` is deliberately small: Railway's Postgres plugin has a modest
 * connection ceiling and five services each opening a large pool is how you
 * exhaust it during a demo rather than under load.
 */
export function createDb(url: string, opts: {max?: number} = {}) {
  const client = postgres(url, {
    max: opts.max ?? 5,
    // Seconds. The driver's default is 30: with the database unreachable (not
    // refusing — gone), every request hung half a minute before failing.
    // Ten is plenty for a cold Railway Postgres, and a request answers 503 well
    // before a browser or an agent gives up on it.
    connect_timeout: 10,
    // Money columns are NUMERIC; return them as strings so nothing is ever
    // parsed through a float on the way out.
    types: {numeric: {to: 0, from: [1700], serialize: String, parse: String}},
  });
  return drizzle(client, {schema});
}

/**
 * Close the underlying pool.
 *
 * postgres.js keeps the event loop alive, so a script that forgets this
 * completes its work and then hangs forever — which looks identical to a
 * deadlock and wastes an afternoon.
 */
export async function closeDb(db: Db): Promise<void> {
  await (db.$client as unknown as {end: () => Promise<void>}).end();
}
