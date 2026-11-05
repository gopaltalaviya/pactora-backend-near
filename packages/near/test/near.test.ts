import {describe, expect, it} from 'vitest';
import {createServer} from 'node:http';
import {
  KeyPair,
  decodeSigned,
  eventsOf,
  neardataSource,
  parseEventLog,
  parseOutcome,
  rpcSource,
  sha256Hex,
  signFunctionCall,
  signFunctionCallWith,
  keyPairKey,
  nearClient,
  verifyNep413,
  TGAS,
  type AccessKeyInfo,
  type TxKey,
} from '../src/index.js';
import {signMessage} from 'near-api-js/nep413';
import {Account, KeyPairSigner, baseEncode} from 'near-api-js';

const ev = (event: string, data: unknown) =>
  `EVENT_JSON:${JSON.stringify({standard: 'pactora', version: '1.0.0', event, data})}`;

describe('sha256Hex', () => {
  it('is the 64-hex form the contract accepts', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('NEP-297 parsing', () => {
  it('reads an EVENT_JSON log', () => {
    expect(parseEventLog(ev('job_created', [{job_id: 1}]))).toEqual({
      standard: 'pactora',
      version: '1.0.0',
      event: 'job_created',
      data: [{job_id: 1}],
    });
  });

  it('ignores plain logs and malformed events', () => {
    expect(parseEventLog('hello')).toBeNull();
    expect(parseEventLog('EVENT_JSON:{not json')).toBeNull();
    expect(parseEventLog('EVENT_JSON:{"standard":"x"}')).toBeNull();
  });

  it('keeps only the watched contracts, and drops failed receipts', () => {
    const block = {height: 10, hash: 'H', timestampNs: 5_000_000_000n};
    const events = eventsOf(
      [
        {
          receiptId: 'r1',
          executorId: 'pactora.test.near',
          txHash: 't1',
          logs: ['plain', ev('job_created', [])],
          ok: true,
        },
        {
          receiptId: 'r2',
          executorId: 'other.test.near',
          txHash: 't1',
          logs: [ev('job_created', [])],
          ok: true,
        },
        {
          receiptId: 'r3',
          executorId: 'pactora.test.near',
          txHash: 't2',
          logs: [ev('job_settled', [])],
          ok: false,
        },
      ],
      block,
      new Set(['pactora.test.near']),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'job_created',
      contract: 'pactora.test.near',
      receiptId: 'r1',
      logIndex: 1,
      txHash: 't1',
      blockHeight: 10,
      blockTimestamp: 5,
    });
  });
});

describe('parseOutcome', () => {
  const receipt = (status: Record<string, unknown>) => ({
    id: 'r',
    outcome: {executor_id: 'c', logs: [] as string[], status},
  });

  it('decodes the JSON return value', () => {
    const raw = {
      status: {SuccessValue: Buffer.from('7').toString('base64')},
      receipts_outcome: [receipt({SuccessValue: ''})],
    };
    expect(parseOutcome(raw, 'h')).toMatchObject({status: 'success', returnValue: 7});
  });

  it('reports a failure with the node’s reason', () => {
    const raw = {
      status: {
        Failure: {
          ActionError: {kind: {FunctionCallError: {ExecutionError: 'Smart contract panicked: PAUSED'}}},
        },
      },
    };
    const out = parseOutcome(raw, 'h');
    expect(out.status).toBe('failure');
    expect(out.failure).toContain('PAUSED');
  });

  it('marks failed receipts', () => {
    const out = parseOutcome({status: {SuccessValue: ''}, receipts_outcome: [receipt({Failure: {}})]}, 'h');
    expect(out.receipts[0]!.ok).toBe(false);
  });
});

describe('signFunctionCall', () => {
  it('signs a function call the node can decode, with the hash known up front', async () => {
    const kp = KeyPair.fromRandom('ed25519');
    const signed = await signFunctionCall({
      signerId: 'bot.alice.testnet',
      keyPair: kp,
      receiverId: 'pactora.testnet',
      nonce: 42n,
      blockHash: '11111111111111111111111111111111',
      method: 'accept_job',
      args: {job_id: 3},
      gas: 100n * TGAS,
      deposit: 0n,
    });
    expect(signed.hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    const tx = decodeSigned(signed.bytes).transaction;
    expect(tx.signerId).toBe('bot.alice.testnet');
    expect(tx.receiverId).toBe('pactora.testnet');
    expect(tx.nonce).toBe(42n);
    const call = tx.actions[0]!.functionCall!;
    expect(call.methodName).toBe('accept_job');
    expect(JSON.parse(Buffer.from(call.args).toString())).toEqual({job_id: 3});
    expect(call.deposit).toBe(0n);
  });
});

describe('signFunctionCallWith (a key held elsewhere, e.g. a KMS)', () => {
  const base = {
    signerId: 'bot.alice.testnet',
    receiverId: 'pactora.testnet',
    nonce: 7n,
    blockHash: '11111111111111111111111111111111',
    method: 'cancel',
    args: {job_id: 1},
    gas: 100n * TGAS,
    deposit: 0n,
  };

  it('produces exactly the bytes and hash a local key pair does', async () => {
    const kp = KeyPair.fromRandom('ed25519');
    const local = await signFunctionCall({...base, keyPair: kp});
    const remote = await signFunctionCallWith({...base, key: keyPairKey(kp)});
    expect(remote.hash).toBe(local.hash);
    expect(Buffer.from(remote.bytes).equals(Buffer.from(local.bytes))).toBe(true);
  });

  it('signs sha256 of the borsh transaction, and the signature verifies', async () => {
    const kp = KeyPair.fromRandom('ed25519');
    let signedMessage: Uint8Array | undefined;
    const key: TxKey = {
      publicKey: kp.getPublicKey().toString(),
      async sign(message) {
        signedMessage = message;
        return kp.sign(message).signature;
      },
    };
    const signed = await signFunctionCallWith({...base, key});
    expect(signedMessage).toHaveLength(32);
    const decoded = decodeSigned(signed.bytes);
    expect(
      kp.getPublicKey().verify(signedMessage!, Uint8Array.from(decoded.signature.ed25519Signature!.data)),
    ).toBe(true);
    expect(baseEncode(signedMessage!)).toBe(signed.hash);
  });

  it('refuses a signature that does not verify against the declared key', async () => {
    const kp = KeyPair.fromRandom('ed25519');
    const other = KeyPair.fromRandom('ed25519');
    const key: TxKey = {
      publicKey: kp.getPublicKey().toString(),
      sign: async (m) => other.sign(m).signature,
    };
    await expect(signFunctionCallWith({...base, key})).rejects.toThrow(/does not verify/);
  });
});

describe('verifyNep413', () => {
  const kp = KeyPair.fromRandom('ed25519');
  const publicKey = kp.getPublicKey().toString();
  const nonce = new Uint8Array(32).fill(7);
  const payload = {message: 'register agent 5', recipient: 'pactora', nonce};

  const keys = (permission: AccessKeyInfo['permission'] | null) => ({
    accessKey: async (_a: string, pk: string) =>
      pk === publicKey && permission ? {nonce: 1n, permission} : null,
  });

  async function signed() {
    const signer = new Account('alice.testnet', undefined as never, new KeyPairSigner(kp));
    const s = await signMessage({signerAccount: signer, payload});
    return {
      accountId: 'alice.testnet',
      publicKey,
      signature: Buffer.from(s.signature).toString('base64'),
      ...payload,
    };
  }

  it('accepts a full-access key’s signature', async () => {
    expect(await verifyNep413(await signed(), keys('FullAccess'))).toBe(true);
  });

  it('refuses a function-call key, even with a valid signature', async () => {
    const fc = {FunctionCall: {receiver_id: 'pactora.testnet', method_names: [], allowance: null}};
    expect(await verifyNep413(await signed(), keys(fc))).toBe(false);
  });

  it('refuses a key the account does not have', async () => {
    expect(await verifyNep413(await signed(), keys(null))).toBe(false);
  });

  it('refuses a signature over a different message', async () => {
    expect(await verifyNep413({...(await signed()), message: 'register agent 6'}, keys('FullAccess'))).toBe(
      false,
    );
  });

  it('refuses a nonce that is not 32 bytes', async () => {
    expect(await verifyNep413({...(await signed()), nonce: new Uint8Array(16)}, keys('FullAccess'))).toBe(
      false,
    );
  });
});

describe('block sources', () => {
  it('neardata: reduces a block to its receipt executions; null is a skipped height', async () => {
    const block = {
      block: {header: {height: 9, hash: 'H9', prev_hash: 'H8', timestamp_nanosec: '1000000000'}},
      shards: [
        {
          receipt_execution_outcomes: [
            {
              tx_hash: 'T',
              receipt: {receipt_id: 'R', predecessor_id: 'bot.testnet', receiver_id: 'pactora.testnet'},
              execution_outcome: {
                id: 'R',
                outcome: {executor_id: 'pactora.testnet', logs: ['l'], status: {SuccessValue: ''}},
              },
            },
          ],
        },
      ],
    };
    const fetchImpl = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.endsWith('/v0/block/9') ? block : null),
    });
    const src = neardataSource('https://example.invalid/', fetchImpl);
    expect(await src.blockAt(8)).toBeNull();
    const b = await src.blockAt(9);
    expect(b).toMatchObject({height: 9, hash: 'H9', prevHash: 'H8'});
    expect(b!.receipts).toEqual([
      {
        receiptId: 'R',
        executorId: 'pactora.testnet',
        predecessorId: 'bot.testnet',
        txHash: 'T',
        logs: ['l'],
        ok: true,
      },
    ]);
  });

  it('rpc: reads each new chunk’s transactions, skipping repeated chunks', async () => {
    const seen: string[] = [];
    const src = rpcSource({
      finalBlock: async () => ({height: 5, hash: 'H5', timestampNs: 0n}),
      block: async (h) =>
        h === 5
          ? {
              header: {height: 5, hash: 'H5', prev_hash: 'H4', timestamp_nanosec: '0'},
              chunks: [
                {chunk_hash: 'C-new', height_included: 5},
                {chunk_hash: 'C-old', height_included: 4},
              ],
            }
          : null,
      chunkTxs: async (c) =>
        c === 'C-new' ? [{hash: 'T1', signer_id: 'bot.test.near'}] : [{hash: 'T0', signer_id: 'x'}],
      txOutcome: async (hash) => {
        seen.push(hash);
        return {
          status: 'success',
          txHash: hash,
          receipts: [{receiptId: 'R1', executorId: 'c', txHash: hash, logs: [], ok: true}],
        };
      },
    });
    expect(await src.finalHeight()).toBe(5);
    expect(await src.blockAt(4)).toBeNull();
    const b = await src.blockAt(5);
    expect(seen).toEqual(['T1']);
    expect(b!.receipts.map((r) => r.receiptId)).toEqual(['R1']);
  });
});

describe('nearClient against nearcore error shapes', () => {
  /** One JSON-RPC error per method, in nearcore's structured form (HANDLER_ERROR + cause.name). */
  async function nodeAnswering(errors: Record<string, {name: string; info: Record<string, unknown>}>) {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const {id, method} = JSON.parse(body) as {id: string; method: string};
        const cause = errors[method];
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {name: 'HANDLER_ERROR', cause, code: -32000, message: 'Server error'},
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
    return {
      client: nearClient(url, {retries: 1}),
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  it('reads UNKNOWN_TRANSACTION as pending, not as a failure', async () => {
    const node = await nodeAnswering({
      EXPERIMENTAL_tx_status: {name: 'UNKNOWN_TRANSACTION', info: {requested_transaction_hash: 'H'}},
    });
    try {
      await expect(node.client.txOutcome('H', 'a.testnet')).resolves.toMatchObject({status: 'pending'});
    } finally {
      await node.close();
    }
  });

  it('reads UNKNOWN_ACCESS_KEY and UNKNOWN_ACCOUNT as null', async () => {
    const pk = KeyPair.fromRandom('ed25519').getPublicKey().toString();
    const node = await nodeAnswering({
      query: {name: 'UNKNOWN_ACCESS_KEY', info: {public_key: pk, block_hash: 'B', block_height: 1}},
    });
    try {
      await expect(node.client.accessKey('a.testnet', pk)).resolves.toBeNull();
    } finally {
      await node.close();
    }
    const node2 = await nodeAnswering({
      query: {
        name: 'UNKNOWN_ACCOUNT',
        info: {requested_account_id: 'a.testnet', block_hash: 'B', block_height: 1},
      },
    });
    try {
      await expect(node2.client.balance('a.testnet')).resolves.toBeNull();
    } finally {
      await node2.close();
    }
  });
});
