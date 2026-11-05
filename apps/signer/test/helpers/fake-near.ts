import {createHash} from 'node:crypto';
import {createServer, type Server} from 'node:http';
import {baseEncode, decodeSigned, type AccessKeyPermission} from '@pactora/near';

/**
 * A NEAR JSON-RPC node we control, answering exactly the methods the
 * production client (`nearClient`, near-api-js's JsonRpcProvider) sends:
 * `status`, `query` (view_access_key, view_account, call_function), `block`,
 * `send_tx`, `EXPERIMENTAL_tx_status`. Errors use nearcore's structured
 * shape (`HANDLER_ERROR` + `cause.name`), so near-api-js parses them into its
 * own error classes the way it does against a real node.
 */

export interface SentTx {
  hash: string;
  signerId: string;
  publicKey: string;
  receiverId: string;
  nonce: bigint;
  blockHash: string;
  method: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
  actions: number;
}

export type SendResult =
  | {kind: 'success'; value?: unknown}
  | {kind: 'panic'; name: string}
  | {kind: 'rejected'; invalidTx: unknown}
  | {kind: 'timeout'; lands: boolean}
  | {kind: 'http'; status: number};

export interface NearState {
  networkId: string;
  /** Liquid balances, yocto. */
  accounts: Map<string, bigint>;
  /** `${account} ${publicKey}` → key. */
  keys: Map<string, {nonce: bigint; permission: AccessKeyPermission}>;
  /** Contract views: `${contract}.${method}` → answer for the parsed args. */
  views: Map<string, (args: Record<string, unknown>) => unknown>;
  block: {height: number; hash: string; timestampNs: bigint};
  /** What the next send does. Default success with `null`. */
  onSend: (tx: SentTx) => SendResult;
  /** Whether a successful tx advances the key's nonce (a lagging node does not). */
  advanceNonce: boolean;
  /** Every transaction that reached the node. */
  sent: SentTx[];
  /** Known outcomes for EXPERIMENTAL_tx_status, by hash. */
  outcomes: Map<string, unknown>;
}

export const BLOCK_HASH = '11111111111111111111111111111111';

export function freshState(): NearState {
  return {
    networkId: 'sandbox',
    accounts: new Map(),
    keys: new Map(),
    views: new Map(),
    block: {height: 1_000, hash: BLOCK_HASH, timestampNs: 1_800_000_000_000_000_000n},
    onSend: () => ({kind: 'success', value: null}),
    advanceNonce: true,
    sent: [],
    outcomes: new Map(),
  };
}

class RpcFault extends Error {
  constructor(readonly error: unknown) {
    super('rpc fault');
  }
}

const handlerError = (name: string, info: unknown = {}, data?: unknown) =>
  new RpcFault({
    name: 'HANDLER_ERROR',
    cause: {name, info},
    code: -32000,
    message: 'Server error',
    ...(data !== undefined ? {data} : {}),
  });

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');

function outcome(tx: SentTx, status: unknown) {
  return {
    final_execution_status: 'FINAL',
    status,
    transaction: {hash: tx.hash, signer_id: tx.signerId, receiver_id: tx.receiverId, nonce: Number(tx.nonce)},
    transaction_outcome: {id: tx.hash, outcome: {executor_id: tx.signerId, logs: [], status: {}}},
    receipts_outcome: [
      {
        id: `r-${tx.hash}`,
        outcome: {
          executor_id: tx.receiverId,
          logs: [],
          status: typeof status === 'object' && status && 'Failure' in status ? status : {SuccessValue: ''},
        },
      },
    ],
  };
}

const panicStatus = (name: string) => ({
  Failure: {
    ActionError: {index: 0, kind: {FunctionCallError: {ExecutionError: `Smart contract panicked: ${name}`}}},
  },
});

export class FakeNear {
  state: NearState = freshState();
  private server!: Server;
  url = '';
  /** HTTP status to answer the next send_tx with, once. */
  private httpOnce: number | null = null;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body) as {id: string; method: string; params: unknown};
        const reply = (payload: object) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({jsonrpc: '2.0', id: parsed.id, ...payload}));
        };
        try {
          const result = this.rpc(parsed.method, parsed.params);
          if (this.httpOnce !== null) {
            res.statusCode = this.httpOnce;
            this.httpOnce = null;
            res.end('upstream unavailable');
            return;
          }
          reply({result});
        } catch (err) {
          if (err instanceof RpcFault) reply({error: err.error});
          else reply({error: {name: 'INTERNAL_ERROR', cause: {info: {error_message: String(err)}}}});
        }
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as {port: number}).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  reset(): void {
    this.state = freshState();
  }

  addAccount(account: string, balance: bigint): void {
    this.state.accounts.set(account, balance);
  }

  addKey(account: string, publicKey: string, permission: AccessKeyPermission, nonce = 5_000_000n): void {
    this.state.keys.set(`${account} ${publicKey}`, {nonce, permission});
  }

  /** A sent transaction the node did not take at first lands now, successfully. */
  land(hash: string, value: unknown = null): void {
    const tx = this.state.sent.find((t) => t.hash === hash);
    if (!tx) throw new Error(`no transaction ${hash} was sent`);
    const key = this.state.keys.get(`${tx.signerId} ${tx.publicKey}`);
    if (key) key.nonce = tx.nonce;
    this.state.outcomes.set(hash, outcome(tx, {SuccessValue: b64(value)}));
  }

  view(contract: string, method: string, answer: (args: Record<string, unknown>) => unknown): void {
    this.state.views.set(`${contract}.${method}`, answer);
  }

  private rpc(method: string, params: unknown): unknown {
    const s = this.state;
    const block = {block_height: s.block.height, block_hash: s.block.hash};
    switch (method) {
      case 'status':
        return {chain_id: s.networkId, sync_info: {latest_block_height: s.block.height}};
      case 'block':
        return {
          header: {
            height: s.block.height,
            hash: s.block.hash,
            prev_hash: s.block.hash,
            timestamp_nanosec: s.block.timestampNs.toString(),
          },
          chunks: [],
        };
      case 'query': {
        const p = params as Record<string, string>;
        if (p['request_type'] === 'view_access_key') {
          const k = s.keys.get(`${p['account_id']} ${p['public_key']}`);
          if (!k) throw handlerError('UNKNOWN_ACCESS_KEY', {public_key: p['public_key'], ...block});
          return {nonce: Number(k.nonce), permission: k.permission, ...block};
        }
        if (p['request_type'] === 'view_account') {
          const amount = s.accounts.get(p['account_id']!);
          if (amount === undefined) {
            throw handlerError('UNKNOWN_ACCOUNT', {requested_account_id: p['account_id'], ...block});
          }
          return {
            amount: amount.toString(),
            locked: '0',
            code_hash: BLOCK_HASH,
            storage_usage: 182,
            ...block,
          };
        }
        if (p['request_type'] === 'call_function') {
          const answer = s.views.get(`${p['account_id']}.${p['method_name']}`);
          if (!answer) {
            throw handlerError('CONTRACT_EXECUTION_ERROR', {
              vm_error: `MethodNotFound ${p['method_name']}`,
              ...block,
            });
          }
          const args = JSON.parse(Buffer.from(p['args_base64']!, 'base64').toString() || '{}');
          return {result: [...Buffer.from(JSON.stringify(answer(args) ?? null))], logs: [], ...block};
        }
        throw new Error(`unexpected query ${p['request_type']}`);
      }
      case 'send_tx': {
        const p = params as {signed_tx_base64: string; wait_until: string};
        if (p.wait_until !== 'FINAL') throw new Error(`send_tx wait_until ${p.wait_until}, expected FINAL`);
        const signed = decodeSigned(new Uint8Array(Buffer.from(p.signed_tx_base64, 'base64')));
        const t = signed.transaction;
        const call = t.actions[0]!.functionCall!;
        const tx: SentTx = {
          hash: baseEncode(createHash('sha256').update(t.encode()).digest()),
          signerId: t.signerId,
          publicKey: t.publicKey.toString(),
          receiverId: t.receiverId,
          nonce: BigInt(t.nonce),
          blockHash: baseEncode(Uint8Array.from(t.blockHash)),
          method: call.methodName,
          args: JSON.parse(Buffer.from(call.args).toString()),
          gas: BigInt(call.gas),
          deposit: BigInt(call.deposit),
          actions: t.actions.length,
        };
        const r = s.onSend(tx);
        if (r.kind === 'http') {
          this.httpOnce = r.status;
          return null;
        }
        if (r.kind === 'rejected') {
          throw handlerError('INVALID_TRANSACTION', {}, {TxExecutionError: {InvalidTxError: r.invalidTx}});
        }
        s.sent.push(tx);
        // Included (or about to be): it uses its nonce. A timeout that never
        // lands is a transaction the chain did not take.
        const included = r.kind !== 'timeout' || r.lands;
        const key = s.keys.get(`${tx.signerId} ${tx.publicKey}`);
        if (key && included && s.advanceNonce) key.nonce = tx.nonce;
        const status =
          r.kind === 'panic'
            ? panicStatus(r.name)
            : {SuccessValue: b64(r.kind === 'success' ? (r.value ?? null) : null)};
        if (r.kind === 'timeout') {
          if (r.lands) s.outcomes.set(tx.hash, outcome(tx, status));
          throw handlerError('TIMEOUT_ERROR');
        }
        const o = outcome(tx, status);
        s.outcomes.set(tx.hash, o);
        return o;
      }
      case 'EXPERIMENTAL_tx_status': {
        const p = params as {tx_hash: string};
        const o = s.outcomes.get(p.tx_hash);
        if (!o) throw handlerError('UNKNOWN_TRANSACTION', {requested_transaction_hash: p.tx_hash});
        return o;
      }
      default:
        throw new Error(`unexpected method ${method}`);
    }
  }
}
