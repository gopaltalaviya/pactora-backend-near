import {sql, type SQL} from 'drizzle-orm';

/**
 * NEAR balances of the accounts this signer sends from.
 *
 * A drained wallet fails a run with an error at the worst moment. This reads
 * the balances in the background and keeps the last reading, so `/health` —
 * a liveness check a restart policy acts on — reports them without ever
 * waiting on an RPC, and `/v1/status` can say "the keeper is nearly out of
 * gas" before it actually is.
 */

export interface WatchedWallet {
  /** The NEAR account. */
  account: string;
  /** What the account is for: `signing-key`, `keeper`. */
  role: string;
}

export interface WalletReading extends WatchedWallet {
  /** Liquid balance in yoctoNEAR, as a decimal string; null when the account does not exist. */
  balanceYocto: string | null;
  low: boolean;
}

export interface WalletSnapshot {
  /** When the last successful reading was taken; null before the first. */
  checkedAt: string | null;
  wallets: WalletReading[];
  anyLow: boolean;
}

interface BalanceReader {
  balance(accountId: string): Promise<bigint | null>;
}

/** Balances read at once (audit M1): a long list of keys is not a burst of RPC reads. */
export const WALLET_READ_CONCURRENCY = 8;

/** `Promise.all(items.map(fn))` with at most `limit` calls in flight; results keep their order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  // One iterator shared by the workers: each takes the next item when it is free.
  const queue = items.entries();
  const worker = async () => {
    for (const [i, item] of queue) out[i] = await fn(item);
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return out;
}

/**
 * Of the accounts the signer holds keys for, those an agent row names as its
 * wallet on this chain (audit M1). A key is created before its account
 * exists, so the store also holds keys for accounts that were never made;
 * reading their balances said "no such account" into `/health`, which turned
 * `/v1/status` degraded for anyone who asked for a key and walked away.
 */
export async function signingAccountsToWatch(
  db: {execute(q: SQL): Promise<unknown>},
  chainId: string,
  held: string[],
): Promise<string[]> {
  if (held.length === 0) return [];
  const rows = (await db.execute(
    sql`SELECT DISTINCT wallet_address FROM agents WHERE chain_id = ${chainId} AND wallet_address IN ${held}`,
  )) as {wallet_address: string}[];
  const named = new Set(rows.map((r) => r.wallet_address));
  return held.filter((a) => named.has(a));
}

interface GaugeLike {
  labels(labels: Record<string, string>): {set(value: number): void};
}

export class WalletWatch {
  private last: WalletSnapshot = {checkedAt: null, wallets: [], anyLow: false};

  constructor(
    private readonly deps: {
      near: BalanceReader;
      /** Read on every check: the signer creates keys while it runs. */
      wallets: () => Promise<WatchedWallet[]> | WatchedWallet[];
      /** Below this, a wallet is low. */
      lowYocto: bigint;
      /** `signer_wallet_balance` in NEAR, one series per account. */
      gauge?: GaugeLike;
    },
  ) {}

  /** Read every balance once. A failed read keeps the previous snapshot. */
  async check(): Promise<void> {
    try {
      const watched = await this.deps.wallets();
      const balances = await mapBounded(watched, WALLET_READ_CONCURRENCY, (w) =>
        this.deps.near.balance(w.account),
      );
      const wallets = watched.map((w, i) => {
        const b = balances[i] ?? null;
        return {
          ...w,
          balanceYocto: b === null ? null : b.toString(),
          low: b === null || b < this.deps.lowYocto,
        };
      });
      for (const [i, w] of watched.entries()) {
        // NEAR for the gauge: yocto overflows a float's exact range.
        const b = balances[i] ?? 0n;
        this.deps.gauge?.labels({address: w.account, role: w.role}).set(Number(b / 10n ** 18n) / 1e6);
      }
      this.last = {checkedAt: new Date().toISOString(), wallets, anyLow: wallets.some((w) => w.low)};
    } catch {
      // Keep the last good reading; `checkedAt` says how old it is.
    }
  }

  snapshot(): WalletSnapshot {
    return this.last;
  }

  /** Check now and every `intervalMs`; returns the stop function. */
  start(intervalMs: number): () => void {
    void this.check();
    const timer = setInterval(() => void this.check(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
