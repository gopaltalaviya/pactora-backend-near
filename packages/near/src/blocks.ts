/**
 * Where the indexer reads final blocks from (docs/NEAR-PORT.md §3, §7).
 *
 * Both sources reduce a block to the same thing: its header and the receipt
 * executions in it, each with its logs. The indexer does not know which one
 * it is reading.
 *
 * - **neardata** (testnet, mainnet): `GET <url>/v0/block/<height>` returns the
 *   whole block with `shards[].receipt_execution_outcomes` — exactly the
 *   receipts that executed in that block. `null` is a height with no block.
 * - **rpc** (the local sandbox, which neardata does not serve): `block`, then
 *   each chunk's transactions, then `EXPERIMENTAL_tx_status` for each. A
 *   transaction's receipts can execute in later blocks; this source files
 *   them all under the block that included the transaction. On a sandbox,
 *   where everything finishes within a block or two, that only shifts an
 *   event's block height by that much — never its order within a job.
 */
import {JsonRpcProvider} from 'near-api-js';
import {parseOutcome, type NearClient, type ReceiptExecution} from './index.js';

export interface BlockRead {
  height: number;
  hash: string;
  prevHash: string;
  timestampNs: bigint;
  receipts: ReceiptExecution[];
}

export interface BlockSource {
  readonly kind: 'neardata' | 'rpc';
  /** Height of the newest final block. */
  finalHeight(): Promise<number>;
  /** The block at `height`, or null when no block was produced there. */
  blockAt(height: number): Promise<BlockRead | null>;
}

type FetchLike = (
  url: string,
  init?: {signal?: AbortSignal},
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface NeardataOutcome {
  tx_hash: string | null;
  receipt: {receipt_id: string; predecessor_id: string; receiver_id: string};
  execution_outcome: {
    id: string;
    outcome: {executor_id: string; logs: string[]; status: Record<string, unknown>};
  };
}

interface NeardataBlock {
  block: {header: {height: number; hash: string; prev_hash: string; timestamp_nanosec: string}};
  shards: Array<{receipt_execution_outcomes: NeardataOutcome[]}>;
}

export function neardataSource(baseUrl: string, fetchImpl: FetchLike = fetch): BlockSource {
  const base = baseUrl.replace(/\/$/, '');
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchImpl(`${base}${path}`, {signal: AbortSignal.timeout(20_000)});
    if (!res.ok) throw new Error(`neardata ${path}: HTTP ${res.status}`);
    return res.json();
  };
  return {
    kind: 'neardata',
    async finalHeight() {
      const b = (await get('/v0/last_block/final')) as NeardataBlock;
      return b.block.header.height;
    },
    async blockAt(height) {
      const b = (await get(`/v0/block/${height}`)) as NeardataBlock | null;
      if (b === null) return null;
      const h = b.block.header;
      return {
        height: h.height,
        hash: h.hash,
        prevHash: h.prev_hash,
        timestampNs: BigInt(h.timestamp_nanosec),
        receipts: b.shards.flatMap((s) =>
          s.receipt_execution_outcomes.map((r) => ({
            receiptId: r.execution_outcome.id,
            executorId: r.execution_outcome.outcome.executor_id,
            predecessorId: r.receipt.predecessor_id,
            txHash: r.tx_hash ?? '',
            logs: r.execution_outcome.outcome.logs,
            ok: !('Failure' in r.execution_outcome.outcome.status),
          })),
        ),
      };
    },
  };
}

/** The slice of the RPC an `rpcSource` needs. */
export interface BlockRpc {
  finalBlock: NearClient['finalBlock'];
  txOutcome: NearClient['txOutcome'];
  /** RPC `block` by height; null for a skipped height. */
  block(height: number): Promise<{
    header: {height: number; hash: string; prev_hash: string; timestamp_nanosec: string};
    chunks: Array<{chunk_hash: string; height_included: number}>;
  } | null>;
  /** RPC `chunk`: its transactions' hashes and signers. */
  chunkTxs(chunkHash: string): Promise<Array<{hash: string; signer_id: string}>>;
}

export function rpcSource(rpc: BlockRpc): BlockSource {
  return {
    kind: 'rpc',
    async finalHeight() {
      return (await rpc.finalBlock()).height;
    },
    async blockAt(height) {
      const b = await rpc.block(height);
      if (b === null) return null;
      const receipts: ReceiptExecution[] = [];
      for (const c of b.chunks) {
        // A chunk not produced in this block is repeated from an earlier one.
        if (c.height_included !== b.header.height) continue;
        for (const tx of await rpc.chunkTxs(c.chunk_hash)) {
          const out = await rpc.txOutcome(tx.hash, tx.signer_id);
          receipts.push(...out.receipts);
        }
      }
      return {
        height: b.header.height,
        hash: b.header.hash,
        prevHash: b.header.prev_hash,
        timestampNs: BigInt(b.header.timestamp_nanosec),
        receipts,
      };
    },
  };
}

/** The production `BlockRpc`, over JSON-RPC. */
export function blockRpc(rpcUrl: string): BlockRpc {
  const provider = new JsonRpcProvider({url: rpcUrl});
  const rpc = <T>(method: string, params: unknown): Promise<T> =>
    provider.sendJsonRpc<never, never, T>(method as never, params as never);
  const missing = (err: unknown) =>
    /UNKNOWN_BLOCK|DB Not Found|does not exist/i.test(`${(err as Error).message} ${JSON.stringify(err)}`);
  return {
    async finalBlock() {
      const b = await provider.viewBlock({finality: 'final'});
      return {height: b.header.height, hash: b.header.hash, timestampNs: BigInt(b.header.timestamp_nanosec)};
    },
    async txOutcome(txHash, signerId) {
      // FINAL: the block is final, but its transactions' later receipts may not be yet.
      const raw = await rpc<Parameters<typeof parseOutcome>[0]>('EXPERIMENTAL_tx_status', {
        tx_hash: txHash,
        sender_account_id: signerId,
        wait_until: 'FINAL',
      });
      return parseOutcome(raw, txHash);
    },
    async block(height) {
      try {
        return await rpc('block', {block_id: height});
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },
    async chunkTxs(chunkHash) {
      const c = await rpc<{transactions: Array<{hash: string; signer_id: string}>}>('chunk', {
        chunk_id: chunkHash,
      });
      return c.transactions.map((t) => ({hash: t.hash, signer_id: t.signer_id}));
    },
  };
}
