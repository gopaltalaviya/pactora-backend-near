/**
 * One call at a time, its outcome reused for `holdMs` after it settles.
 *
 * For health probes of a dependency that may be gone. A probe that times out
 * is not a probe that stopped: Node's DNS lookup runs on one of libuv's four
 * threads and keeps it until the resolver gives up (~4 s for a compose service
 * whose container is stopped). /ready and /v1/status each probing the signer
 * on every request filled the pool, and the RPC lookup behind them timed out —
 * so the status page said the chain was down when only the signer was.
 * Coalesced, a dead dependency holds at most one thread.
 */
export function coalesce<T>(fn: () => Promise<T>, holdMs: number): () => Promise<T> {
  let current: {promise: Promise<T>; settledAt: number | null} | null = null;

  return () => {
    if (current && (current.settledAt === null || Date.now() - current.settledAt < holdMs)) {
      return current.promise;
    }
    const entry: {promise: Promise<T>; settledAt: number | null} = {promise: fn(), settledAt: null};
    const settle = () => {
      entry.settledAt = Date.now();
    };
    entry.promise.then(settle, settle);
    current = entry;
    return entry.promise;
  };
}
