/**
 * Fabricated NEAR blocks for the indexer tests, with logs that are
 * byte-for-byte what the contracts emit.
 *
 * GOLDEN holds log lines captured from the real code, not written by hand:
 * pactora-contracts-near `contracts/pactora/src/events.rs` (and
 * near-contract-standards 5.30.0's `FtTransfer`/`FtMint`), compiled against
 * near-sdk 5.30.0 with the contracts' own Cargo.lock and run under
 * `near_sdk::test_utils::get_logs()` on 2026-11-05. near-sdk enables
 * serde_json's `preserve_order`, so keys come out in source order, and
 * `emit()` wraps the single data object in an array. The builders below are
 * checked against these lines (events.test.ts), so a builder that drifts from
 * the contract fails a test instead of passing a fiction.
 */
import {fileURLToPath} from 'node:url';
import {loadConfig, type ChainConfig} from '@pactora/config';
import type {BlockRead, BlockSource, ReceiptExecution} from '@pactora/near';

const H = 'ab'.repeat(32);

export const GOLDEN = {
  jobCreated: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"job_created","data":[{"job_id":7,"client":1,"worker":2,"amount":"20000","fee":"200","spec_hash":"${H}","accept_deadline":1700000000,"work_deadline":1700003600}]}`,
  jobAccepted: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"job_accepted","data":[{"job_id":7,"worker":2,"bond":"1000","work_deadline":1700003600}]}`,
  resultSubmitted: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"result_submitted","data":[{"job_id":7,"result_hash":"${H}","review_deadline":1700007200}]}`,
  jobDisputed: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"job_disputed","data":[{"job_id":7,"dispute_bond":"500","dispute_deadline":1700010800,"reason_hash":"${H}"}]}`,
  jobDisputedNoReason: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"job_disputed","data":[{"job_id":7,"dispute_bond":"500","dispute_deadline":1700010800,"reason_hash":null}]}`,
  disputeResolved: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"dispute_resolved","data":[{"job_id":7,"for_worker":true,"arbiter":"arbiter.test.near"}]}`,
  disputeExpired: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"dispute_expired","data":[{"job_id":7}]}`,
  /** Contract 1.1.0: the client's bond is split on expiry, and the event says how. */
  disputeExpiredSplit: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"dispute_expired","data":[{"job_id":7,"bond_to_worker":"250","bond_to_client":"250"}]}`,
  jobSettled: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"job_settled","data":[{"job_id":7,"worker":2,"paid":"19800","fee":"200","outcome":"Success"}]}`,
  jobSettledUnresolved: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"job_settled","data":[{"job_id":7,"worker":2,"paid":"19800","fee":"200","outcome":"Unresolved"}]}`,
  jobRefundedUndelivered: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"job_refunded","data":[{"job_id":7,"client":1,"amount":"20000","reason":"undelivered","outcome":"Failed"}]}`,
  jobRefundedCancelled: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"job_refunded","data":[{"job_id":7,"client":1,"amount":"20000","reason":"cancelled","outcome":null}]}`,
  jobRefundedDispute: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"job_refunded","data":[{"job_id":7,"client":1,"amount":"20000","reason":"dispute","outcome":"DisputeLost"}]}`,
  bondSeized: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"bond_seized","data":[{"job_id":7,"worker":2,"client":1,"amount":"1000"}]}`,
  disputeBondSettled: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"dispute_bond_settled","data":[{"job_id":7,"to":1,"amount":"500"}]}`,
  directPaid: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"direct_paid","data":[{"job_id":8,"client":1,"worker":2,"amount":"20000","fee":"200","spec_hash":"${H}"}]}`,
  review: `EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"review","data":[{"job_id":7,"agent_id":2,"side":"worker","value":100}]}`,
  ftTransfer: `EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"alice.test.near","new_owner_id":"bob.test.near","amount":"100"}]}`,
  ftTransferMemo: `EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"alice.test.near","new_owner_id":"bob.test.near","amount":"100","memo":"refund"}]}`,
  ftMint: `EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_mint","data":[{"owner_id":"alice.test.near","amount":"5"}]}`,
} as const;

// ── log builders, in events.rs field order ───────────────────────────────

const pactora = (event: string, data: Record<string, unknown>) =>
  `EVENT_JSON:${JSON.stringify({standard: 'pactora', version: '1.0.0', event, data: [data]})}`;

type Id = number;
type Amt = bigint | number | string;
const s = (a: Amt) => String(a);

export const log = {
  /** events.rs `wallet_accepted` / `wallet_proposed`: an agent's wallet changing hands. */
  walletAccepted: (o: {agentId: Id; wallet: string; previous: string | null}) =>
    pactora('wallet_accepted', {agent_id: o.agentId, wallet: o.wallet, previous: o.previous}),
  walletProposed: (o: {agentId: Id; pendingWallet: string | null}) =>
    pactora('wallet_proposed', {agent_id: o.agentId, pending_wallet: o.pendingWallet}),
  /** events.rs `funded`: a deposit into an agent's balance or stake, through ft_transfer_call. */
  funded: (o: {agentId: Id; from: string; amount: Amt; kind: 'balance' | 'stake'}) =>
    pactora('funded', {agent_id: o.agentId, from: o.from, amount: s(o.amount), kind: o.kind}),
  jobCreated: (o: {
    jobId: Id;
    client: Id;
    worker: Id;
    amount: Amt;
    fee: Amt;
    specHash: string;
    acceptDeadline?: number;
    workDeadline?: number;
  }) =>
    pactora('job_created', {
      job_id: o.jobId,
      client: o.client,
      worker: o.worker,
      amount: s(o.amount),
      fee: s(o.fee),
      spec_hash: o.specHash,
      accept_deadline: o.acceptDeadline ?? 1700000000,
      work_deadline: o.workDeadline ?? 1700003600,
    }),
  jobAccepted: (o: {jobId: Id; worker: Id; bond: Amt; workDeadline?: number}) =>
    pactora('job_accepted', {
      job_id: o.jobId,
      worker: o.worker,
      bond: s(o.bond),
      work_deadline: o.workDeadline ?? 1700003600,
    }),
  resultSubmitted: (o: {jobId: Id; resultHash: string; reviewDeadline?: number}) =>
    pactora('result_submitted', {
      job_id: o.jobId,
      result_hash: o.resultHash,
      review_deadline: o.reviewDeadline ?? 1700007200,
    }),
  jobDisputed: (o: {jobId: Id; disputeBond: Amt; disputeDeadline?: number; reasonHash: string | null}) =>
    pactora('job_disputed', {
      job_id: o.jobId,
      dispute_bond: s(o.disputeBond),
      dispute_deadline: o.disputeDeadline ?? 1700010800,
      reason_hash: o.reasonHash,
    }),
  disputeResolved: (o: {jobId: Id; forWorker: boolean; arbiter: string}) =>
    pactora('dispute_resolved', {job_id: o.jobId, for_worker: o.forWorker, arbiter: o.arbiter}),
  /** 1.1.0 carries the bond split; without `bondToWorker` the 1.0.0 shape (job_id alone) is written. */
  disputeExpired: (o: {jobId: Id; bondToWorker?: Amt; bondToClient?: Amt}) =>
    pactora('dispute_expired', {
      job_id: o.jobId,
      ...(o.bondToWorker !== undefined
        ? {bond_to_worker: s(o.bondToWorker), bond_to_client: s(o.bondToClient ?? 0)}
        : {}),
    }),
  jobSettled: (o: {jobId: Id; worker: Id; paid: Amt; fee: Amt; outcome: string}) =>
    pactora('job_settled', {
      job_id: o.jobId,
      worker: o.worker,
      paid: s(o.paid),
      fee: s(o.fee),
      outcome: o.outcome,
    }),
  jobRefunded: (o: {jobId: Id; client: Id; amount: Amt; reason: string; outcome: string | null}) =>
    pactora('job_refunded', {
      job_id: o.jobId,
      client: o.client,
      amount: s(o.amount),
      reason: o.reason,
      outcome: o.outcome,
    }),
  bondSeized: (o: {jobId: Id; worker: Id; client: Id; amount: Amt}) =>
    pactora('bond_seized', {job_id: o.jobId, worker: o.worker, client: o.client, amount: s(o.amount)}),
  disputeBondSettled: (o: {jobId: Id; to: Id; amount: Amt}) =>
    pactora('dispute_bond_settled', {job_id: o.jobId, to: o.to, amount: s(o.amount)}),
  directPaid: (o: {jobId: Id; client: Id; worker: Id; amount: Amt; fee: Amt; specHash: string}) =>
    pactora('direct_paid', {
      job_id: o.jobId,
      client: o.client,
      worker: o.worker,
      amount: s(o.amount),
      fee: s(o.fee),
      spec_hash: o.specHash,
    }),
  review: (o: {jobId: Id; agentId: Id; side: string; value: number}) =>
    pactora('review', {job_id: o.jobId, agent_id: o.agentId, side: o.side, value: o.value}),
  /** near-contract-standards `FtTransfer::emit_many`: one log line, any number of entries. */
  ftTransfer: (entries: Array<{from: string; to: string; amount: Amt; memo?: string}>) =>
    `EVENT_JSON:${JSON.stringify({
      standard: 'nep141',
      version: '1.0.0',
      event: 'ft_transfer',
      data: entries.map((e) => ({
        old_owner_id: e.from,
        new_owner_id: e.to,
        amount: s(e.amount),
        ...(e.memo !== undefined ? {memo: e.memo} : {}),
      })),
    })}`,
  ftMint: (owner: string, amount: Amt) =>
    `EVENT_JSON:${JSON.stringify({
      standard: 'nep141',
      version: '1.0.0',
      event: 'ft_mint',
      data: [{owner_id: owner, amount: s(amount)}],
    })}`,
};

// ── chain config ─────────────────────────────────────────────────────────

/** The sandbox network from the backend's own `chain/` copy of the contracts config. */
export function sandboxChain(): ChainConfig {
  const config = loadConfig({
    contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
    env: {ENABLED_CHAINS: 'near:sandbox'},
  });
  return config.chain('near:sandbox');
}

// ── a fake chain ─────────────────────────────────────────────────────────

let receiptSeq = 0;

/** One receipt execution. Ids are unique per process unless given. */
export function receipt(o: {
  executor: string;
  logs: string[];
  ok?: boolean;
  receiptId?: string;
  txHash?: string;
}): ReceiptExecution {
  receiptSeq++;
  return {
    receiptId: o.receiptId ?? `R${receiptSeq.toString().padStart(6, '0')}`,
    executorId: o.executor,
    txHash: o.txHash ?? `T${receiptSeq.toString().padStart(6, '0')}`,
    logs: o.logs,
    ok: o.ok ?? true,
  };
}

/**
 * Final blocks from `start`, linked by prev_hash like the real chain, with
 * skipped heights where asked. `fork` changes every hash, so a cursor written
 * against one FakeChain does not link to another.
 */
export class FakeChain implements BlockSource {
  readonly kind = 'neardata' as const;
  readonly blocks = new Map<number, BlockRead | null>();
  /** Every height `blockAt` was asked for, in order. */
  readonly asked: number[] = [];
  private next: number;
  private lastHash: string;

  constructor(
    readonly start: number,
    private readonly fork = 'A',
    /** The hash of the block before `start`, as a cursor would hold it. */
    prevHash?: string,
  ) {
    this.next = start;
    this.lastHash = prevHash ?? `${fork}-genesis`;
  }

  hashAt(height: number): string {
    return `${this.fork}-${height}`;
  }

  /** Append a block holding these receipts; returns its height. */
  block(...receipts: ReceiptExecution[]): number {
    const height = this.next++;
    const b: BlockRead = {
      height,
      hash: this.hashAt(height),
      prevHash: this.lastHash,
      timestampNs: BigInt(1_762_300_000 + height) * 1_000_000_000n,
      receipts,
    };
    this.lastHash = b.hash;
    this.blocks.set(height, b);
    return height;
  }

  /** Append `n` heights with no block. */
  skip(n = 1): void {
    for (let i = 0; i < n; i++) this.blocks.set(this.next++, null);
  }

  /** Append `n` empty blocks. */
  empty(n: number): void {
    for (let i = 0; i < n; i++) this.block();
  }

  async finalHeight(): Promise<number> {
    return this.next - 1;
  }

  async blockAt(height: number): Promise<BlockRead | null> {
    this.asked.push(height);
    if (height >= this.next) throw new Error(`fake chain: block ${height} is not final yet`);
    return this.blocks.get(height) ?? null;
  }
}
