/**
 * Gas balances of the wallets this signer sends from (v3).
 *
 * docs/17 had "wallet balance monitoring: none; checked by hand before
 * demos", and a drained key fails a run with a bare revert or an
 * insufficient-funds error at the worst moment. This reads the balances in
 * the background and keeps the last reading, so `/health` — a liveness check
 * a restart policy acts on — reports them without ever waiting on an RPC, and
 * `/v1/status` can say "degraded: the keeper is nearly out of gas" before it
 * actually is.
 */

export interface WatchedWallet {
  address: string;
  /** What the wallet is for: `signing-key`, `keeper`. */
  role: string;
}

export interface WalletReading extends WatchedWallet {
  balanceWei: string;
  low: boolean;
}

export interface WalletSnapshot {
  /** When the last successful reading was taken; null before the first. */
  checkedAt: string | null;
  wallets: WalletReading[];
  anyLow: boolean;
}

interface BalanceReader {
  getBalance(args: {address: `0x${string}`}): Promise<bigint>;
}

interface GaugeLike {
  labels(labels: Record<string, string>): {set(value: number): void};
}

export class WalletWatch {
  private last: WalletSnapshot = {checkedAt: null, wallets: [], anyLow: false};

  constructor(
    private readonly deps: {
      pub: BalanceReader;
      wallets: WatchedWallet[];
      /** Below this, a wallet is low. */
      lowWei: bigint;
      /** `signer_wallet_balance` in native units, one series per wallet. */
      gauge?: GaugeLike;
    },
  ) {}

  /** Read every balance once. A failed read keeps the previous snapshot. */
  async check(): Promise<void> {
    try {
      const balances = await Promise.all(
        this.deps.wallets.map((w) => this.deps.pub.getBalance({address: w.address as `0x${string}`})),
      );
      const wallets = this.deps.wallets.map((w, i) => ({
        ...w,
        balanceWei: balances[i]!.toString(),
        low: balances[i]! < this.deps.lowWei,
      }));
      for (const [i, w] of this.deps.wallets.entries()) {
        // Native units for the gauge: wei overflows a float's exact range.
        this.deps.gauge
          ?.labels({address: w.address, role: w.role})
          .set(Number(balances[i]! / 10n ** 12n) / 1e6);
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
