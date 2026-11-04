import postgres from 'postgres';

/**
 * Advisory locks that are actually released.
 *
 * `pg_advisory_lock` is SESSION-scoped: only the connection that took a lock
 * can release it. Taken through a pool, the lock and the unlock land on
 * whichever connections are free — and an unlock on the wrong one returns
 * `false`, leaving the lock held by an idle pooled connection for as long as
 * that connection lives. The signer did exactly this; the next sign for the
 * same agent then waited forever, and Postgres reported deadlocks.
 *
 * So a lock is taken and released on ONE reserved connection, from a pool of
 * its own. Its own, because the work inside the lock makes queries too: if
 * the lock held a connection from the same pool, N concurrent holders could
 * exhaust it and each wait for a connection the others hold.
 */
export type LockPool = postgres.Sql;

export function createLockPool(url: string, opts: {max?: number} = {}): LockPool {
  return postgres(url, {max: opts.max ?? 10, idle_timeout: 30});
}

export async function closeLockPool(pool: LockPool): Promise<void> {
  await pool.end();
}

/**
 * Run `fn` holding the advisory lock `key`, released however `fn` ends.
 *
 * If the unlock itself fails — the connection dropped — Postgres has already
 * released the lock with the session, so nothing is left held.
 */
export async function withAdvisoryLock<T>(pool: LockPool, key: bigint, fn: () => Promise<T>): Promise<T> {
  const conn = await pool.reserve();
  try {
    await conn`SELECT pg_advisory_lock(${key.toString()}::bigint)`;
    try {
      return await fn();
    } finally {
      await conn`SELECT pg_advisory_unlock(${key.toString()}::bigint)`;
    }
  } finally {
    conn.release();
  }
}
