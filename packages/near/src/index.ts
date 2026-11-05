/**
 * @pactora/near — the one place the backend talks to NEAR.
 *
 * Every service reaches the chain through `NearClient`, an interface, so tests
 * inject a fake and production uses `nearClient(rpcUrl)` (near-api-js 7.4's
 * `JsonRpcProvider` underneath). Wire shapes are docs/NEAR-PORT.md.
 */
import {createHash} from 'node:crypto';
import {
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  PublicKey,
  SignedTransaction,
  Signer,
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
} from 'near-api-js';
import {verifyMessage} from 'near-api-js/nep413';

export {KeyPair, PublicKey};

// ── hashes ───────────────────────────────────────────────────────────────

/** sha256 as 64 lowercase hex, no `0x` — the form the contract's `check_hash` accepts. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

// ── events (NEP-297) ─────────────────────────────────────────────────────

export interface Nep297Event {
  standard: string;
  version: string;
  event: string;
  data: unknown;
}

const EVENT_PREFIX = 'EVENT_JSON:';

/** Parse one log line; null when it is not a well-formed NEP-297 event. */
export function parseEventLog(log: string): Nep297Event | null {
  if (!log.startsWith(EVENT_PREFIX)) return null;
  try {
    const v = JSON.parse(log.slice(EVENT_PREFIX.length)) as Record<string, unknown>;
    if (
      typeof v['standard'] !== 'string' ||
      typeof v['version'] !== 'string' ||
      typeof v['event'] !== 'string'
    ) {
      return null;
    }
    return {standard: v['standard'], version: v['version'], event: v['event'], data: v['data']};
  } catch {
    return null;
  }
}

/** One event as it happened: which receipt, which log line, which contract. */
export interface ChainEvent extends Nep297Event {
  /** The contract that emitted it (the receipt's executor). */
  contract: string;
  /** The receipt it was logged in. With `logIndex`, unique on a chain. */
  receiptId: string;
  /** Position of the log line within the receipt's logs. */
  logIndex: number;
  /** The transaction the receipt descends from. */
  txHash: string;
  /** The block the receipt executed in. */
  blockHeight: number;
  blockHash: string;
  /** Block timestamp, seconds. */
  blockTimestamp: number;
}

/** A receipt execution, in the shape both block sources reduce to. */
export interface ReceiptExecution {
  receiptId: string;
  executorId: string;
  predecessorId?: string;
  txHash: string;
  logs: string[];
  /** Whether the receipt succeeded. A failed receipt's logs are rolled back with its state. */
  ok: boolean;
}

/**
 * The NEP-297 events of the given contracts in a list of receipt executions.
 *
 * A failed receipt is skipped: NEAR rolls its state back, so whatever it
 * logged did not happen.
 */
export function eventsOf(
  receipts: ReceiptExecution[],
  block: {height: number; hash: string; timestampNs: bigint},
  contracts: ReadonlySet<string>,
): ChainEvent[] {
  const out: ChainEvent[] = [];
  for (const r of receipts) {
    if (!r.ok || !contracts.has(r.executorId)) continue;
    r.logs.forEach((log, logIndex) => {
      const e = parseEventLog(log);
      if (!e) return;
      out.push({
        ...e,
        contract: r.executorId,
        receiptId: r.receiptId,
        logIndex,
        txHash: r.txHash,
        blockHeight: block.height,
        blockHash: block.hash,
        blockTimestamp: Number(block.timestampNs / 1_000_000_000n),
      });
    });
  }
  return out;
}

// ── the client interface ─────────────────────────────────────────────────

export interface FinalBlock {
  height: number;
  hash: string;
  /** Nanoseconds, as NEAR reports it. */
  timestampNs: bigint;
}

export type AccessKeyPermission =
  'FullAccess' | {FunctionCall: {receiver_id: string; method_names: string[]; allowance: string | null}};

export interface AccessKeyInfo {
  nonce: bigint;
  permission: AccessKeyPermission;
}

export interface TxOutcome {
  status: 'success' | 'failure' | 'pending';
  txHash: string;
  /** The JSON return value of the transaction's last call, when it succeeded. */
  returnValue?: unknown;
  /** Why it failed, as the node put it. */
  failure?: string;
  /** Every receipt the transaction produced, in the node's order. */
  receipts: ReceiptExecution[];
}

export interface NearClient {
  /** RPC `status.chain_id` — `testnet`, `mainnet`, or the sandbox's. */
  networkId(): Promise<string>;
  /** A view call. Throws if the method panics or the contract is missing. */
  view<T>(contract: string, method: string, args?: Record<string, unknown>): Promise<T>;
  /** The access key, or null when the account has no such key (or does not exist). */
  accessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo | null>;
  /** The account's liquid balance in yocto, or null when it does not exist. */
  balance(accountId: string): Promise<bigint | null>;
  finalBlock(): Promise<FinalBlock>;
  /** The transaction's outcome; `pending` while the node does not know it yet. */
  txOutcome(txHash: string, signerId: string): Promise<TxOutcome>;
  /** Broadcast a signed transaction and wait until it is final. */
  sendSigned(signed: SignedTx): Promise<TxOutcome>;
}

// ── signing ──────────────────────────────────────────────────────────────

export interface SignedTx {
  /** base58 transaction hash, known before broadcast. */
  hash: string;
  /** Borsh-encoded SignedTransaction. */
  bytes: Uint8Array;
}

export const TGAS = 1_000_000_000_000n;

export interface FunctionCallTx {
  signerId: string;
  keyPair: KeyPair;
  receiverId: string;
  nonce: bigint;
  /** base58 hash of a recent block (the transaction expires ~24 h after it). */
  blockHash: string;
  method: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
}

/** Build and sign a single function-call transaction. Pure: no network. */
export async function signFunctionCall(tx: FunctionCallTx): Promise<SignedTx> {
  const transaction = createTransaction(
    tx.signerId,
    tx.keyPair.getPublicKey(),
    tx.receiverId,
    tx.nonce,
    [actions.functionCall(tx.method, tx.args, tx.gas, tx.deposit)],
    baseDecode(tx.blockHash),
  );
  const {txHash, signedTransaction} = await new KeyPairSigner(tx.keyPair).signTransaction(transaction);
  return {hash: baseEncode(txHash), bytes: signedTransaction.encode()};
}

/**
 * An ed25519 key that may live somewhere else — in this process (`keyPairKey`)
 * or in a KMS. `sign` receives the 32-byte sha256 of the borsh transaction,
 * which is what NEAR verifies the signature against, and returns the raw
 * 64-byte ed25519 signature.
 */
export interface TxKey {
  /** `ed25519:<base58>` */
  readonly publicKey: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** A `TxKey` over an in-memory key pair. */
export function keyPairKey(keyPair: KeyPair): TxKey {
  return {
    publicKey: keyPair.getPublicKey().toString(),
    sign: async (message) => keyPair.sign(message).signature,
  };
}

/** near-api-js's own `Signer`, over a `TxKey`: the transaction hashing stays theirs. */
class TxKeySigner extends Signer {
  constructor(private readonly key: TxKey) {
    super();
  }
  async getPublicKey(): Promise<PublicKey> {
    return PublicKey.from(this.key.publicKey);
  }
  protected async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const signature = await this.key.sign(bytes);
    // A remote signer (a KMS) answering with the wrong key or format would
    // otherwise produce a transaction the node rejects only after broadcast.
    if (!PublicKey.from(this.key.publicKey).verify(bytes, signature)) {
      throw new Error(`the signature does not verify against ${this.key.publicKey}`);
    }
    return signature;
  }
}

/** `signFunctionCall`, with a `TxKey` in place of a key pair. Same bytes, same hash. */
export async function signFunctionCallWith(
  tx: Omit<FunctionCallTx, 'keyPair'> & {key: TxKey},
): Promise<SignedTx> {
  const transaction = createTransaction(
    tx.signerId,
    PublicKey.from(tx.key.publicKey),
    tx.receiverId,
    tx.nonce,
    [actions.functionCall(tx.method, tx.args, tx.gas, tx.deposit)],
    baseDecode(tx.blockHash),
  );
  const {txHash, signedTransaction} = await new TxKeySigner(tx.key).signTransaction(transaction);
  return {hash: baseEncode(txHash), bytes: signedTransaction.encode()};
}

// ── outcome parsing ──────────────────────────────────────────────────────

interface RawOutcome {
  status?: unknown;
  final_execution_status?: string;
  transaction?: {hash?: string};
  transaction_outcome?: {id?: string};
  receipts_outcome?: Array<{
    id: string;
    outcome: {executor_id: string; logs: string[]; status: Record<string, unknown> | string};
  }>;
}

function decodeReturn(b64: string): unknown {
  if (b64 === '') return undefined;
  const text = Buffer.from(b64, 'base64').toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Reduce an RPC FinalExecutionOutcome to `TxOutcome`. Exported for tests. */
export function parseOutcome(raw: RawOutcome, txHash: string): TxOutcome {
  const receipts: ReceiptExecution[] = (raw.receipts_outcome ?? []).map((r) => ({
    receiptId: r.id,
    executorId: r.outcome.executor_id,
    txHash,
    logs: r.outcome.logs,
    ok: typeof r.outcome.status === 'object' && r.outcome.status !== null && !('Failure' in r.outcome.status),
  }));
  const status = raw.status;
  if (typeof status === 'object' && status !== null) {
    if ('SuccessValue' in status) {
      return {
        status: 'success',
        txHash,
        returnValue: decodeReturn(String((status as {SuccessValue: string}).SuccessValue)),
        receipts,
      };
    }
    if ('Failure' in status) {
      return {
        status: 'failure',
        txHash,
        failure: JSON.stringify(status.Failure),
        receipts,
      };
    }
  }
  return {status: 'pending', txHash, receipts};
}

// ── NEP-413 ──────────────────────────────────────────────────────────────

export interface Nep413Proof {
  accountId: string;
  /** `ed25519:<base58>` */
  publicKey: string;
  /** base64 */
  signature: string;
  message: string;
  recipient: string;
  /** 32 bytes */
  nonce: Uint8Array;
}

/**
 * Whether `proof` is a NEP-413 signature by a **full-access** key of
 * `accountId` — near-api-js's `verifyMessage`, which checks both. A
 * function-call key (an agent's) cannot sign for its owner.
 */
export async function verifyNep413(
  proof: Nep413Proof,
  client: Pick<NearClient, 'accessKey'>,
): Promise<boolean> {
  if (proof.nonce.length !== 32) return false;
  let signature: Uint8Array;
  try {
    signature = new Uint8Array(Buffer.from(proof.signature, 'base64'));
    PublicKey.from(proof.publicKey);
  } catch {
    return false;
  }
  // The only provider method verifyMessage uses; see near-api-js lib/nep413.
  const provider = {
    viewAccessKey: async ({accountId, publicKey}: {accountId: string; publicKey: string | PublicKey}) => {
      const key = await client.accessKey(accountId, publicKey.toString());
      if (!key) throw new Error('no such access key');
      return {permission: key.permission, nonce: key.nonce};
    },
  };
  try {
    await verifyMessage({
      signerAccountId: proof.accountId,
      signerPublicKey: proof.publicKey,
      payload: {message: proof.message, recipient: proof.recipient, nonce: proof.nonce},
      signature,
      provider: provider as unknown as Parameters<typeof verifyMessage>[0]['provider'],
    });
    return true;
  } catch {
    return false;
  }
}

// ── the production client ────────────────────────────────────────────────

/** RPC error kinds that mean "not there", as opposed to "the node failed". */
function isMissing(err: unknown, ...kinds: string[]): boolean {
  const text = `${(err as {type?: string}).type ?? ''} ${(err as Error).message ?? ''} ${JSON.stringify(err)}`;
  return kinds.some((k) => text.includes(k));
}

export interface NearClientOptions {
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Retries on a failed request; 0 for health probes. */
  retries?: number;
}

export function nearClient(rpcUrl: string, opts: NearClientOptions = {}): NearClient {
  const provider = new JsonRpcProvider(
    {url: rpcUrl, ...(opts.timeoutMs ? {timeout: opts.timeoutMs} : {})},
    opts.retries !== undefined ? {retries: opts.retries} : {},
  );
  const rpc = <T>(method: string, params: unknown): Promise<T> =>
    provider.sendJsonRpc<never, never, T>(method as never, params as never);

  return {
    async networkId() {
      const s = await provider.viewNodeStatus();
      return s.chain_id;
    },

    async view<T>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
      return (await provider.callFunction({
        contractId: contract,
        method,
        args,
        blockQuery: {finality: 'final'},
      })) as T;
    },

    async accessKey(accountId, publicKey) {
      try {
        const k = await provider.viewAccessKey({accountId, publicKey, finalityQuery: {finality: 'final'}});
        return {nonce: BigInt(k.nonce), permission: k.permission as AccessKeyPermission};
      } catch (err) {
        if (
          isMissing(err, 'UNKNOWN_ACCESS_KEY', 'AccessKeyDoesNotExist', 'UNKNOWN_ACCOUNT', 'does not exist')
        )
          return null;
        throw err;
      }
    },

    async balance(accountId) {
      try {
        const a = await provider.viewAccount({accountId, blockQuery: {finality: 'final'}});
        return BigInt(a.amount);
      } catch (err) {
        if (isMissing(err, 'UNKNOWN_ACCOUNT', 'does not exist')) return null;
        throw err;
      }
    },

    async finalBlock() {
      const b = await provider.viewBlock({finality: 'final'});
      return {height: b.header.height, hash: b.header.hash, timestampNs: BigInt(b.header.timestamp_nanosec)};
    },

    async txOutcome(txHash, signerId) {
      try {
        const raw = await rpc<RawOutcome>('EXPERIMENTAL_tx_status', {
          tx_hash: txHash,
          sender_account_id: signerId,
          wait_until: 'NONE',
        });
        return parseOutcome(raw, txHash);
      } catch (err) {
        if (isMissing(err, 'UNKNOWN_TRANSACTION', "doesn't exist", 'does not exist')) {
          return {status: 'pending', txHash, receipts: []};
        }
        throw err;
      }
    },

    async sendSigned(signed) {
      const raw = await rpc<RawOutcome>('send_tx', {
        signed_tx_base64: Buffer.from(signed.bytes).toString('base64'),
        wait_until: 'FINAL',
      });
      return parseOutcome(raw, signed.hash);
    },
  };
}

/** Decode a borsh SignedTransaction (tests and fakes). */
export function decodeSigned(bytes: Uint8Array): SignedTransaction {
  return SignedTransaction.decode(bytes);
}
export * from './blocks.js';
