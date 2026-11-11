/**
 * Where the indexer reads final blocks from (docs/NEAR-WIRE.md §3, §7).
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
  readonly kind: 'neardata' | 'rpc' | 'accounts';
  /** Height of the newest final block. */
  finalHeight(): Promise<number>;
  /** The block at `height`, or null when no block was produced there. */
  blockAt(height: number): Promise<BlockRead | null>;
  /**
   * A sparse source (`accounts`) answers for a whole range at once with only
   * the blocks in which a watched account's receipts executed, in height
   * order. The indexer then cannot chain every block to its parent; it
   * relies on the source's own completeness bound (`finalHeight`) instead.
   */
  blocksIn?(from: number, to: number): Promise<BlockRead[]>;
  /**
   * The oldest height the source still holds, when it can say (an RPC node's
   * `sync_info.earliest_block_height`); null or absent: everything (archival).
   */
  earliestHeight?(): Promise<number | null>;
}

/**
 * A height the node once had and has garbage-collected (a non-archival RPC
 * keeps a few epochs). Not the same as a skipped height, which never had a
 * block: reading this as "empty" would silently skip the history.
 */
export class BlockPrunedError extends Error {
  override name = 'BlockPrunedError';
  constructor(
    readonly height: number,
    readonly earliest: number,
  ) {
    super(
      `UNKNOWN_BLOCK: block ${height} has been garbage collected by this RPC (its earliest block is ${earliest})`,
    );
  }
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

/**
 * `apiKey` is a FastNear key, sent as `?apiKey=` — the form neardata's README
 * gives (a Bearer header is lost on its redirects). Without one the free
 * tier's limit applies, which cannot keep pace with testnet's ~100 blocks a
 * minute (measured: HTTP 429, "30 blocks per minute"). The key is never logged:
 * errors name the path, not the URL.
 */
export function neardataSource(baseUrl: string, fetchImpl: FetchLike = fetch, apiKey?: string): BlockSource {
  const base = baseUrl.replace(/\/$/, '');
  const auth = apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : '';
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchImpl(`${base}${path}${auth}`, {signal: AbortSignal.timeout(20_000)});
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
  /** RPC `status` `sync_info.earliest_block_height`: the oldest block the node keeps. */
  earliestHeight?(): Promise<number | null>;
}

export function rpcSource(rpc: BlockRpc): BlockSource {
  return {
    kind: 'rpc',
    async finalHeight() {
      return (await rpc.finalBlock()).height;
    },
    ...(rpc.earliestHeight ? {earliestHeight: () => rpc.earliestHeight!()} : {}),
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
    /UNKNOWN_BLOCK|DB Not Found|does not exist|garbage collected|never been observed/i.test(
      `${(err as Error).message} ${JSON.stringify(err)}`,
    );
  /** Cached for a minute: it moves once an epoch, and is read only on a missing block. */
  let earliestCache: {at: number; v: number | null} | null = null;
  const earliestHeight = async (): Promise<number | null> => {
    if (earliestCache && Date.now() - earliestCache.at < 60_000) return earliestCache.v;
    const st = await rpc<{sync_info?: {earliest_block_height?: number | null}}>('status', []);
    const v = st.sync_info?.earliest_block_height ?? null;
    earliestCache = {at: Date.now(), v};
    return v;
  };
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
        if (!missing(err)) throw err;
        // UNKNOWN_BLOCK is both "no block at this height" and "garbage
        // collected"; the node's earliest height tells them apart.
        const earliest = await earliestHeight().catch(() => null);
        if (earliest !== null && height < earliest) throw new BlockPrunedError(height, earliest);
        return null;
      }
    },
    earliestHeight,
    async chunkTxs(chunkHash) {
      const c = await rpc<{transactions: Array<{hash: string; signer_id: string}>}>('chunk', {
        chunk_id: chunkHash,
      });
      return c.transactions.map((t) => ({hash: t.hash, signer_id: t.signer_id}));
    },
  };
}

/**
 * The `accounts` source (testnet, 2026-11-11): FastNEAR's transactions API
 * (`tx.test.fastnear.com`), asked only for the transactions that touch the
 * watched accounts (Pactora and its token), instead of reading every block.
 *
 * Why: testnet makes ~100 blocks a minute. neardata's free tier serves ~30
 * blocks a minute (measured: a burst of 32, then HTTP 429) and its key is a
 * paid plan; a free RPC throttles a block-and-chunks reader to ~22 blocks a
 * minute (measured: 232 of 21,000 calls answered). This source makes a few
 * calls per tick whatever the network's traffic.
 *
 * How it stays complete:
 * - `finalHeight` is the API's own newest indexed block, minus `holdBack`
 *   blocks, so the indexer never moves past a height whose transactions the
 *   API has not listed yet (a transaction is listed with all its receipts;
 *   holdBack covers the receipts still executing after its block).
 * - `blocksIn(from, to)` lists transactions from `from - lookBack` (receipts
 *   execute after their transaction's block) and keeps exactly the receipts
 *   that EXECUTED in [from, to], filed under their own block. Ranges do not
 *   overlap, so each receipt is read once.
 * - What it cannot do: chain every block to its parent (it reads only the
 *   blocks with our receipts). `openSource` checks its head hash against the
 *   RPC at start instead.
 */
export interface AccountsSourceOptions {
  /** e.g. `https://tx.test.fastnear.com` */
  baseUrl: string;
  /** The accounts whose transactions matter: Pactora and its payment token. */
  accounts: string[];
  fetchImpl?: PostLike;
  /** Blocks kept back from the API's head. Default 50 (~30 s on testnet). */
  holdBack?: number;
  /** How far before `from` a transaction may lie and still have receipts in range. Default 300. */
  lookBack?: number;
}

type PostLike = (
  url: string,
  init: {method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal},
) => Promise<{ok: boolean; status: number; json(): Promise<unknown>}>;

interface TxApiAccountPage {
  account_txs: Array<{transaction_hash: string; tx_block_height: number}>;
  resume_token?: string | null;
}
interface TxApiReceipt {
  receipt: {receipt_id: string; predecessor_id: string; receiver_id: string};
  execution_outcome: {
    id: string;
    block_hash: string;
    block_height: number;
    block_timestamp: number | string;
    index?: number;
    outcome: {executor_id: string; logs: string[]; status: Record<string, unknown>};
  };
}
interface TxApiTx {
  transaction: {hash: string; signer_id: string};
  receipts: TxApiReceipt[];
}

const TX_HASHES_PER_CALL = 20;
const ACCOUNT_PAGE = 200;

/** An `accounts` source, plus its API's raw head (for the startup network check). */
export type AccountsSource = BlockSource & {apiHead(): Promise<{height: number; hash: string}>};

export function accountsSource(opts: AccountsSourceOptions): AccountsSource {
  const base = opts.baseUrl.replace(/\/$/, '');
  const post = opts.fetchImpl ?? fetch;
  const holdBack = opts.holdBack ?? 50;
  const lookBack = opts.lookBack ?? 300;
  const accounts = [...new Set(opts.accounts)];
  if (accounts.length === 0) throw new Error('accountsSource: no accounts to watch');

  const call = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await post(`${base}${path}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`fastnear tx API ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };

  /** The API's newest indexed block: its own completeness bound. */
  const head = async () => {
    const r = await call<{
      blocks: Array<{block_height: number; block_hash: string; block_timestamp: string}>;
    }>('/v0/blocks', {});
    const b = r.blocks?.[0];
    if (!b) throw new Error('fastnear tx API /v0/blocks: no blocks');
    return b;
  };

  const hashesTouching = async (account: string, fromTx: number, to: number): Promise<string[]> => {
    const out: string[] = [];
    let resume: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const r = await call<TxApiAccountPage>('/v0/account', {
        account_id: account,
        from_tx_block_height: fromTx,
        to_tx_block_height: to,
        desc: false,
        limit: ACCOUNT_PAGE,
        ...(resume ? {resume_token: resume} : {}),
      });
      for (const row of r.account_txs) out.push(row.transaction_hash);
      if (!r.resume_token) return out;
      resume = r.resume_token;
    }
    throw new Error(
      `fastnear tx API /v0/account: more than ${1000 * ACCOUNT_PAGE} transactions for ${account}`,
    );
  };

  return {
    kind: 'accounts',
    async apiHead() {
      const h = await head();
      return {height: h.block_height, hash: h.block_hash};
    },
    async finalHeight() {
      return (await head()).block_height - holdBack;
    },
    async blockAt(height) {
      // Only the cursor seed asks for one block (the head); a sparse source
      // keeps no per-block chain, so the hash is informational.
      const h = await head();
      return {
        height,
        hash: h.block_height === height ? h.block_hash : '',
        prevHash: '',
        timestampNs: BigInt(h.block_timestamp),
        receipts: [],
      };
    },
    async blocksIn(from, to) {
      if (to < from) return [];
      const fromTx = Math.max(0, from - lookBack);
      const hashes = new Set<string>();
      for (const a of accounts) for (const h of await hashesTouching(a, fromTx, to)) hashes.add(h);
      const all = [...hashes];
      const byHeight = new Map<number, BlockRead & {order: Array<[number, ReceiptExecution]>}>();
      for (let i = 0; i < all.length; i += TX_HASHES_PER_CALL) {
        const r = await call<{transactions: Array<TxApiTx | null>}>('/v0/transactions', {
          tx_hashes: all.slice(i, i + TX_HASHES_PER_CALL),
        });
        for (const tx of r.transactions) {
          if (!tx) continue;
          for (const rc of tx.receipts ?? []) {
            const eo = rc.execution_outcome;
            if (eo.block_height < from || eo.block_height > to) continue;
            let b = byHeight.get(eo.block_height);
            if (!b) {
              b = {
                height: eo.block_height,
                hash: eo.block_hash,
                prevHash: '',
                timestampNs: BigInt(eo.block_timestamp),
                receipts: [],
                order: [],
              };
              byHeight.set(eo.block_height, b);
            }
            b.order.push([
              eo.index ?? 0,
              {
                receiptId: eo.id,
                executorId: eo.outcome.executor_id,
                predecessorId: rc.receipt.predecessor_id,
                txHash: tx.transaction.hash,
                logs: eo.outcome.logs,
                ok: !('Failure' in eo.outcome.status),
              },
            ]);
          }
        }
      }
      return [...byHeight.values()]
        .sort((a, b) => a.height - b.height)
        .map(({order, ...b}) => ({
          ...b,
          // In the order the block executed them (the outcome's index), then by id.
          receipts: order
            .sort((x, y) => x[0] - y[0] || x[1].receiptId.localeCompare(y[1].receiptId))
            .map(([, r]) => r),
        }));
    },
  };
}
