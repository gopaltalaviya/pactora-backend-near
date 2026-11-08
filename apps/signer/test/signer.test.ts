import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {sql} from 'drizzle-orm';
import {loadConfig} from '@pactora/config';
import {createDb, closeDb, createLockPool, closeLockPool, type Db, type LockPool} from '@pactora/db';
import {KeyPair, TGAS, keyPairKey, nearClient, type AccessKeyPermission, type TxKey} from '@pactora/near';
import {PactoraError, ErrorCode} from '@pactora/shared';
import {SignerService, walletLockKey, type SignRequest} from '../src/signer.js';
import type {KeySource} from '../src/keystore.js';
import {FakeNear, BLOCK_HASH} from './helpers/fake-near.js';

/**
 * The signer, the only process in this system that holds a key.
 *
 * Everything it does — refusing a spend over the cap, refusing to broadcast
 * without gas, never reusing a nonce, returning the original transaction for
 * a retry — is custody, or the thing that stops a retry becoming a second
 * payment. It talks to the chain through the PRODUCTION client
 * (`nearClient`, near-api-js underneath), pointed at a JSON-RPC node we
 * control, so the real request and response handling is exercised.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near_signer';

const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});
const CHAIN = config.chain('near:sandbox');
const PACTORA = CHAIN.contracts.Pactora;
const NEAR = 10n ** 24n;

const WALLET = 'payer.owner.test.near';
const WORKER_WALLET = 'worker.other.test.near';
/** The client agent's on-chain id, and the worker's. */
const CLIENT_ID = 5;
const WORKER_ID = 6;
const SPEC = 'a'.repeat(64);

const fake = new FakeNear();
let db: Db;
let locks: LockPool;
let kp: KeyPair;
let key: TxKey;

const fcKey = (over: Partial<{receiver_id: string; method_names: string[]; allowance: string | null}> = {}) =>
  ({
    FunctionCall: {receiver_id: PACTORA, method_names: [], allowance: (NEAR / 4n).toString(), ...over},
  }) satisfies AccessKeyPermission;

interface Purse {
  balance: string;
  per_task_cap: string;
  daily_cap: string;
  spent_today: string;
  daily_remaining: string;
  next_release_at: number;
}
let purse: Purse;
let jobs: Record<number, unknown>;
let agentsOnChain: Record<number, unknown>;

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  locks = createLockPool(DB_URL, {max: 10});
  await fake.start();
});

afterAll(async () => {
  await fake.stop();
  await closeDb(db);
  await closeLockPool(locks);
});

beforeEach(async () => {
  fake.reset();
  kp = KeyPair.fromRandom('ed25519');
  key = keyPairKey(kp);
  fake.addAccount(WALLET, NEAR);
  fake.addKey(WALLET, key.publicKey, fcKey());
  purse = {
    balance: '1000000',
    per_task_cap: '100000',
    daily_cap: '500000',
    spent_today: '100000',
    daily_remaining: '400000',
    next_release_at: 0,
  };
  jobs = {};
  agentsOnChain = {};
  fake.view(PACTORA, 'purse_of', () => purse);
  fake.view(PACTORA, 'get_job', (a) => jobs[a['job_id'] as number] ?? null);
  fake.view(PACTORA, 'get_agent', (a) => agentsOnChain[a['agent_id'] as number] ?? null);
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, runs, run_events, signer_txs, signer_wallet_txs, signer_keys RESTART IDENTITY CASCADE`,
  );
});

function makeSigner(over: {keys?: KeySource; gasFloorYocto?: bigint; withKey?: boolean} = {}): SignerService {
  const keys: KeySource = over.keys ?? {
    kind: 'test',
    keyFor: async (account) => (over.withKey !== false && account === WALLET ? key : null),
    accounts: async () => [WALLET],
  };
  return new SignerService({
    db,
    locks,
    chain: CHAIN,
    keys,
    near: nearClient(fake.url, {retries: 1}),
    ...(over.gasFloorYocto !== undefined ? {gasFloorYocto: over.gasFloorYocto} : {}),
  });
}

/** An agent row whose wallet is the account the test key belongs to. */
async function anAgent(wallet = WALLET, chainAgentId: number | null = CLIENT_ID): Promise<number> {
  const rows = (await db.execute(
    sql`INSERT INTO agents (chain_id, chain_agent_id, owner_address, wallet_address, name, price_per_task)
        VALUES ('near:sandbox', ${chainAgentId === null ? null : String(chainAgentId)}, 'owner.test.near',
                ${wallet}, 'Payer', 20000) RETURNING id`,
  )) as unknown as {id: number}[];
  return rows[0]!.id;
}

const hire = (amount = '20000') => ({
  method: 'create_job',
  args: {
    client_id: CLIENT_ID,
    worker_id: WORKER_ID,
    amount,
    spec_hash: SPEC,
    accept_window: 3600,
    work_window: 7200,
  },
  spend: BigInt(amount),
});

const request = (agentId: number, over: Partial<Omit<SignRequest, 'agentId'>> = {}): SignRequest => ({
  agentId,
  chainId: 'near:sandbox',
  ...hire(),
  idempotencyKey: `key-${Math.random()}`,
  ...over,
});

async function expectRefusal(promise: Promise<unknown>, code: ErrorCode): Promise<PactoraError> {
  let error: unknown;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  expect(error, 'the signer accepted a request it should have refused').toBeInstanceOf(PactoraError);
  expect((error as PactoraError).code, (error as Error).message).toBe(code);
  return error as PactoraError;
}

const rowsOf = async () =>
  (await db.execute(
    sql`SELECT idempotency_key, status, nonce::text AS nonce, tx_hash, result, failure FROM signer_txs ORDER BY id`,
  )) as unknown as {
    idempotency_key: string;
    status: string;
    nonce: string;
    tx_hash: string | null;
    result: unknown;
    failure: string | null;
  }[];

describe('what is sent', () => {
  it('calls Pactora with 0 deposit and 100 Tgas, signed by the wallet key, on nonce + 1', async () => {
    const id = await anAgent();
    fake.state.onSend = () => ({kind: 'success', value: 42});
    const result = await makeSigner().sign(request(id, {idempotencyKey: 'once-1'}));

    expect(fake.state.sent).toHaveLength(1);
    const tx = fake.state.sent[0]!;
    expect(tx).toMatchObject({
      signerId: WALLET,
      publicKey: key.publicKey,
      receiverId: PACTORA,
      nonce: 5_000_001n,
      blockHash: BLOCK_HASH,
      method: 'create_job',
      deposit: 0n,
      gas: 100n * TGAS,
      actions: 1,
    });
    expect(tx.args).toEqual({
      client_id: CLIENT_ID,
      worker_id: WORKER_ID,
      amount: '20000',
      spec_hash: SPEC,
      accept_window: 3600,
      work_window: 7200,
    });
    expect(result).toEqual({txHash: tx.hash, nonce: 5_000_001, replayed: false, result: 42});
    expect((await rowsOf())[0]).toMatchObject({
      status: 'final',
      tx_hash: tx.hash,
      nonce: '5000001',
      result: 42,
    });
  });

  it('sends every allowed method to Pactora, and nowhere else', async () => {
    const id = await anAgent();
    jobs[9] = {
      client: CLIENT_ID,
      worker: WORKER_ID,
      amount: '20000',
      state: 'Submitted',
      dispute_bond: '1000',
    };
    const calls: Array<Pick<SignRequest, 'method' | 'args' | 'spend'>> = [
      hire(),
      {
        method: 'direct_pay',
        args: {client_id: CLIENT_ID, worker_id: WORKER_ID, amount: '500', spec_hash: SPEC},
        spend: 500n,
      },
      {method: 'accept_job', args: {job_id: 9}, spend: 0n},
      {method: 'submit_result', args: {job_id: 9, result_hash: SPEC}, spend: 0n},
      {method: 'approve', args: {job_id: 9, review_hash: SPEC}, spend: 0n},
      {method: 'dispute', args: {job_id: 9, reason_hash: null}, spend: 1000n},
      {method: 'cancel', args: {job_id: 9}, spend: 0n},
      {method: 'accept_wallet', args: {agent_id: CLIENT_ID}, spend: 0n},
    ];
    for (const c of calls) await makeSigner().sign(request(id, c));
    expect(fake.state.sent.map((t) => t.method)).toEqual(calls.map((c) => c.method));
    expect(new Set(fake.state.sent.map((t) => t.receiverId))).toEqual(new Set([PACTORA]));
    expect(fake.state.sent.every((t) => t.deposit === 0n && t.gas === 100n * TGAS)).toBe(true);
  });

  it('sends ids as JSON numbers and amounts as strings, as near-sdk reads u64 and U128', async () => {
    const id = await anAgent();
    await makeSigner().sign(request(id, {...hire(), args: {...hire().args, client_id: '5', amount: 20000}}));
    expect(fake.state.sent[0]!.args).toMatchObject({client_id: 5, amount: '20000'});
  });

  it('fills an omitted optional hash as null', async () => {
    const id = await anAgent();
    await makeSigner().sign(request(id, {method: 'approve', args: {job_id: 3}, spend: 0n}));
    expect(fake.state.sent[0]!.args).toEqual({job_id: 3, review_hash: null});
  });
});

describe('what the signer refuses', () => {
  it('refuses a request for a chain it does not serve', async () => {
    const id = await anAgent();
    await expectRefusal(makeSigner().sign(request(id, {chainId: 'near:testnet'})), ErrorCode.CHAIN_MISMATCH);
    expect(fake.state.sent).toHaveLength(0);
  });

  it.each(['withdraw', 'ft_transfer', 'set_caps', 'expire_unaccepted', 'storage_withdraw'])(
    'refuses a method it does not make for an agent: %s',
    async (method) => {
      const id = await anAgent();
      await expectRefusal(makeSigner().sign(request(id, {method, args: {}, spend: 0n})), ErrorCode.FORBIDDEN);
      expect(fake.state.sent).toHaveLength(0);
    },
  );

  it.each([
    ['an unknown argument', {...hire().args, receiver_id: 'evil.near'}],
    ['an uppercase hash', {...hire().args, spec_hash: 'A'.repeat(64)}],
    ['a 0x hash', {...hire().args, spec_hash: `0x${'a'.repeat(62)}`}],
    ['a missing amount', {...hire().args, amount: undefined}],
    ['a negative window', {...hire().args, accept_window: -1}],
  ])('refuses %s', async (_label, args) => {
    const id = await anAgent();
    await expectRefusal(makeSigner().sign(request(id, {args})), ErrorCode.SCHEMA_MISMATCH);
    expect(fake.state.sent).toHaveLength(0);
  });

  it('refuses a hire whose client is another agent', async () => {
    const id = await anAgent();
    await expectRefusal(
      makeSigner().sign(request(id, {args: {...hire().args, client_id: 77}})),
      ErrorCode.FORBIDDEN,
    );
    expect(fake.state.sent).toHaveLength(0);
  });

  it('refuses when there is no signing key for the agent', async () => {
    const id = await anAgent();
    await expectRefusal(makeSigner({withKey: false}).sign(request(id)), ErrorCode.AGENT_NOT_HIREABLE);
    expect(fake.state.sent).toHaveLength(0);
  });

  it('refuses when the held key is not on the wallet', async () => {
    const id = await anAgent();
    fake.state.keys.clear();
    await expectRefusal(makeSigner().sign(request(id)), ErrorCode.AGENT_NOT_HIREABLE);
    expect(fake.state.sent).toHaveLength(0);
  });

  /** The signer must never hold an owner's key: it could move the account's NEAR, add keys, deploy. */
  it('refuses a FULL-ACCESS key, even though it would work', async () => {
    const id = await anAgent();
    fake.addKey(WALLET, key.publicKey, 'FullAccess');
    const err = await expectRefusal(makeSigner().sign(request(id)), ErrorCode.FORBIDDEN);
    expect(err.detail).toMatch(/FULL-ACCESS/);
    expect(fake.state.sent).toHaveLength(0);
  });

  it('refuses a key scoped to another receiver', async () => {
    const id = await anAgent();
    fake.addKey(WALLET, key.publicKey, fcKey({receiver_id: 'musdc.test.near'}));
    await expectRefusal(makeSigner().sign(request(id)), ErrorCode.FORBIDDEN);
    expect(fake.state.sent).toHaveLength(0);
  });

  it('refuses a call the key is not allowed to make, and allows one it is', async () => {
    const id = await anAgent();
    fake.addKey(WALLET, key.publicKey, fcKey({method_names: ['accept_job']}));
    await expectRefusal(makeSigner().sign(request(id)), ErrorCode.FORBIDDEN);
    await makeSigner().sign(request(id, {method: 'accept_job', args: {job_id: 1}, spend: 0n}));
    expect(fake.state.sent.map((t) => t.method)).toEqual(['accept_job']);
  });

  it('refuses a key whose gas allowance is nearly spent', async () => {
    const id = await anAgent();
    fake.addKey(WALLET, key.publicKey, fcKey({allowance: '1000'}));
    await expectRefusal(makeSigner().sign(request(id)), ErrorCode.INSUFFICIENT_FUNDS);
    expect(fake.state.sent).toHaveLength(0);
  });

  it('signs with a key whose allowance is unlimited', async () => {
    const id = await anAgent();
    fake.addKey(WALLET, key.publicKey, fcKey({allowance: null}));
    await makeSigner().sign(request(id));
    expect(fake.state.sent).toHaveLength(1);
  });

  /**
   * Refusing beats broadcasting a transaction the node rejects — and says
   * which account to fund.
   */
  it('refuses to send below the gas floor', async () => {
    const id = await anAgent();
    fake.addAccount(WALLET, NEAR / 100n);
    const err = await expectRefusal(makeSigner().sign(request(id)), ErrorCode.INSUFFICIENT_FUNDS);
    expect(err.detail).toContain(WALLET);
    expect(fake.state.sent).toHaveLength(0);
  });

  it('sends at the gas floor exactly', async () => {
    const id = await anAgent();
    fake.addAccount(WALLET, (5n * NEAR) / 100n);
    await makeSigner().sign(request(id));
    expect(fake.state.sent).toHaveLength(1);
  });
});

describe('the purse, checked before anything is sent', () => {
  it('refuses a spend above the per-task cap', async () => {
    const id = await anAgent();
    purse.per_task_cap = '10000';
    await expectRefusal(makeSigner().sign(request(id)), ErrorCode.BUDGET_EXCEEDED);
    expect(fake.state.sent).toHaveLength(0);
  });

  it('refuses a spend above what is left today, and says when capacity returns', async () => {
    const id = await anAgent();
    purse.daily_remaining = '5000';
    const now = Number(fake.state.block.timestampNs / 1_000_000_000n);
    purse.next_release_at = now + 3600;
    const err = await expectRefusal(makeSigner().sign(request(id)), ErrorCode.BUDGET_EXCEEDED);
    expect(err.retryAfter).toBe(3600);
    expect(fake.state.sent).toHaveLength(0);
  });

  it('refuses a spend above the balance', async () => {
    const id = await anAgent();
    purse.balance = '19999';
    await expectRefusal(makeSigner().sign(request(id)), ErrorCode.INSUFFICIENT_FUNDS);
    expect(fake.state.sent).toHaveLength(0);
  });

  it('allows a spend exactly at the cap', async () => {
    const id = await anAgent();
    purse.per_task_cap = '20000';
    await makeSigner().sign(request(id));
    expect(fake.state.sent).toHaveLength(1);
  });

  it('refuses a hire that declares less than it spends', async () => {
    const id = await anAgent();
    await expectRefusal(makeSigner().sign(request(id, {spend: 1n})), ErrorCode.SCHEMA_MISMATCH);
    expect(fake.state.sent).toHaveLength(0);
  });

  it('does not read the purse for a call that spends nothing', async () => {
    const id = await anAgent();
    purse.balance = '0';
    await makeSigner().sign(request(id, {method: 'accept_job', args: {job_id: 1}, spend: 0n}));
    expect(fake.state.sent).toHaveLength(1);
  });
});

describe('a dispute spends the job’s bond', () => {
  beforeEach(() => {
    jobs[4] = {
      client: CLIENT_ID,
      worker: WORKER_ID,
      amount: '20000',
      state: 'Submitted',
      dispute_bond: '7000',
    };
  });
  const dispute = (spend: bigint) => ({method: 'dispute', args: {job_id: 4, reason_hash: SPEC}, spend});

  it('counts the bond the job captured against the purse', async () => {
    const id = await anAgent();
    purse.daily_remaining = '6999';
    await expectRefusal(makeSigner().sign(request(id, dispute(7000n))), ErrorCode.BUDGET_EXCEEDED);
    purse.daily_remaining = '7000';
    await makeSigner().sign(request(id, dispute(7000n)));
    expect(fake.state.sent.map((t) => t.method)).toEqual(['dispute']);
  });

  it('refuses a dispute that declares less than the bond', async () => {
    const id = await anAgent();
    await expectRefusal(makeSigner().sign(request(id, dispute(0n))), ErrorCode.SCHEMA_MISMATCH);
  });

  it('refuses to dispute a job this agent is not the client of', async () => {
    const id = await anAgent();
    jobs[4] = {client: 99, worker: WORKER_ID, amount: '20000', state: 'Submitted', dispute_bond: '7000'};
    await expectRefusal(makeSigner().sign(request(id, dispute(7000n))), ErrorCode.FORBIDDEN);
  });

  it('refuses a job that does not exist', async () => {
    const id = await anAgent();
    await expectRefusal(
      makeSigner().sign(request(id, {method: 'dispute', args: {job_id: 404}, spend: 7000n})),
      ErrorCode.NOT_FOUND,
    );
  });
});

describe('an idempotency key', () => {
  /** The property the scheme exists for: a retried hire returns the original job, not a second one. */
  it('returns the original transaction and result for a repeat, without sending again', async () => {
    const id = await anAgent();
    fake.state.onSend = () => ({kind: 'success', value: 17});
    const first = await makeSigner().sign(request(id, {idempotencyKey: 'retry-1'}));
    const again = await makeSigner().sign(request(id, {idempotencyKey: 'retry-1'}));
    expect(fake.state.sent).toHaveLength(1);
    expect(again).toEqual({...first, replayed: true});
    expect(again.result).toBe(17);
  });

  it('treats a different key as a different payment', async () => {
    const id = await anAgent();
    await makeSigner().sign(request(id, {idempotencyKey: 'pay-1'}));
    await makeSigner().sign(request(id, {idempotencyKey: 'pay-2'}));
    expect(fake.state.sent).toHaveLength(2);
  });

  it('refuses the same key from the same agent for a different call', async () => {
    const id = await anAgent();
    await makeSigner().sign(request(id, {idempotencyKey: 'k-1'}));
    await expectRefusal(
      makeSigner().sign(request(id, {...hire('30000'), idempotencyKey: 'k-1'})),
      ErrorCode.IDEMPOTENCY_CONFLICT,
    );
    expect(fake.state.sent).toHaveLength(1);
  });

  it('does not hand one agent another agent’s transaction for the same key', async () => {
    const a = await anAgent();
    const kp2 = KeyPair.fromRandom('ed25519');
    const b = await anAgent(WORKER_WALLET, WORKER_ID);
    fake.addAccount(WORKER_WALLET, NEAR);
    fake.addKey(WORKER_WALLET, kp2.getPublicKey().toString(), fcKey());
    const keys: KeySource = {
      kind: 'test',
      keyFor: async (acc) => (acc === WALLET ? key : acc === WORKER_WALLET ? keyPairKey(kp2) : null),
      accounts: async () => [WALLET, WORKER_WALLET],
    };
    await makeSigner({keys}).sign(request(a, {idempotencyKey: 'shared'}));
    const other = await makeSigner({keys}).sign(
      request(b, {method: 'accept_job', args: {job_id: 1}, spend: 0n, idempotencyKey: 'shared'}),
    );
    expect(other.replayed).toBe(false);
    expect(fake.state.sent.map((t) => t.signerId)).toEqual([WALLET, WORKER_WALLET]);
  });
});

describe('nonces', () => {
  it('gives concurrent requests for one agent distinct, increasing nonces', async () => {
    const id = await anAgent();
    const signer = makeSigner();
    const results = await Promise.all(
      Array.from({length: 6}, (_, i) =>
        signer.sign(request(id, {method: 'accept_job', args: {job_id: i}, spend: 0n})),
      ),
    );
    const nonces = results.map((r) => r.nonce).sort((x, y) => x - y);
    expect(new Set(nonces).size).toBe(6);
    expect(nonces).toEqual([1, 2, 3, 4, 5, 6].map((n) => 5_000_000 + n));
  });

  /** A node that has not caught up must not get a nonce this signer already used. */
  it('never reuses a nonce it claimed, even when the chain still reports an older one', async () => {
    const id = await anAgent();
    fake.state.advanceNonce = false;
    const a = await makeSigner().sign(request(id, {method: 'accept_job', args: {job_id: 1}, spend: 0n}));
    const b = await makeSigner().sign(request(id, {method: 'accept_job', args: {job_id: 2}, spend: 0n}));
    expect(a.nonce).toBe(5_000_001);
    expect(b.nonce).toBe(5_000_002);
  });

  it('follows the chain when its nonce is ahead (the key was used elsewhere)', async () => {
    const id = await anAgent();
    await makeSigner().sign(request(id, {method: 'accept_job', args: {job_id: 1}, spend: 0n}));
    fake.addKey(WALLET, key.publicKey, fcKey(), 9_000_000n);
    const b = await makeSigner().sign(request(id, {method: 'accept_job', args: {job_id: 2}, spend: 0n}));
    expect(b.nonce).toBe(9_000_001);
  });

  it('holds no advisory lock once concurrent signs have finished', async () => {
    const id = await anAgent();
    const signer = makeSigner();
    await Promise.all(
      Array.from({length: 4}, (_, i) =>
        signer.sign(request(id, {method: 'accept_job', args: {job_id: i}, spend: 0n})),
      ),
    );
    const held = (await db.execute(
      sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`,
    )) as unknown as {n: number}[];
    expect(held[0]!.n).toBe(0);
  });

  it('releases the lock when the signing work throws', async () => {
    const id = await anAgent();
    fake.addAccount(WALLET, 1n);
    await expectRefusal(makeSigner().sign(request(id)), ErrorCode.INSUFFICIENT_FUNDS);
    fake.addAccount(WALLET, NEAR);
    // Would wait forever if the lock had been left held.
    await makeSigner().sign(request(id));
    expect(fake.state.sent).toHaveLength(1);
  });

  it('locks per (chain, wallet), never colliding across chains', () => {
    expect(walletLockKey('near:sandbox', WALLET)).not.toBe(walletLockKey('near:testnet', WALLET));
    expect(walletLockKey('near:sandbox', WALLET)).toBe(walletLockKey('near:sandbox', WALLET));
  });
});

describe('a call the contract refuses', () => {
  it.each([
    ['PerTaskCapExceeded', ErrorCode.BUDGET_EXCEEDED],
    ['DailyCapExceeded', ErrorCode.BUDGET_EXCEEDED],
    ['InsufficientBalance', ErrorCode.INSUFFICIENT_FUNDS],
    ['NotHireable', ErrorCode.AGENT_NOT_HIREABLE],
    ['AgentFrozen', ErrorCode.AGENT_NOT_HIREABLE],
    ['SameOwner', ErrorCode.AGENT_NOT_HIREABLE],
    ['DeadlinePassed', ErrorCode.DEADLINE_PASSED],
    ['InvalidState', ErrorCode.INVALID_STATE],
    ['NotAgentWallet', ErrorCode.FORBIDDEN],
    ['NoSuchJob', ErrorCode.NOT_FOUND],
  ])('reports %s as %s, by name', async (name, code) => {
    const id = await anAgent();
    fake.state.onSend = () => ({kind: 'panic', name});
    const err = await expectRefusal(makeSigner().sign(request(id, {idempotencyKey: 'refused'})), code);
    expect(err.detail).toContain(name);
    expect((await rowsOf())[0]).toMatchObject({status: 'reverted'});
  });

  it('answers a retry of the same key with the same refusal, sending nothing', async () => {
    const id = await anAgent();
    fake.state.onSend = () => ({kind: 'panic', name: 'SameOwner'});
    await expectRefusal(
      makeSigner().sign(request(id, {idempotencyKey: 'r-1'})),
      ErrorCode.AGENT_NOT_HIREABLE,
    );
    fake.state.onSend = () => ({kind: 'success', value: 1});
    await expectRefusal(
      makeSigner().sign(request(id, {idempotencyKey: 'r-1'})),
      ErrorCode.AGENT_NOT_HIREABLE,
    );
    expect(fake.state.sent).toHaveLength(1);
  });
});

describe('a transaction whose fate is not known at once', () => {
  it('a node rejection leaves the nonce unused, and the same key can retry', async () => {
    const id = await anAgent();
    fake.state.onSend = () => ({kind: 'rejected', invalidTx: {InvalidNonce: {tx_nonce: 1, ak_nonce: 2}}});
    await expectRefusal(
      makeSigner().sign(request(id, {idempotencyKey: 'rej'})),
      ErrorCode.UPSTREAM_UNAVAILABLE,
    );
    expect((await rowsOf())[0]).toMatchObject({status: 'failed', tx_hash: null});
    fake.state.onSend = () => ({kind: 'success', value: 3});
    const ok = await makeSigner().sign(request(id, {idempotencyKey: 'rej'}));
    expect(ok).toMatchObject({replayed: false, result: 3});
    expect(fake.state.sent).toHaveLength(1);
  });

  it('a node that says the wallet cannot pay is reported as INSUFFICIENT_FUNDS', async () => {
    const id = await anAgent();
    fake.state.onSend = () => ({
      kind: 'rejected',
      invalidTx: {NotEnoughBalance: {signer_id: WALLET, balance: '1', cost: '2'}},
    });
    await expectRefusal(makeSigner().sign(request(id)), ErrorCode.INSUFFICIENT_FUNDS);
  });

  it('a timeout is safe to retry: the retry returns the transaction that landed, never a second', async () => {
    const id = await anAgent();
    fake.state.onSend = () => ({kind: 'timeout', lands: false});
    await expectRefusal(
      makeSigner().sign(request(id, {idempotencyKey: 'slow'})),
      ErrorCode.UPSTREAM_UNAVAILABLE,
    );
    const row = (await rowsOf())[0]!;
    expect(row).toMatchObject({status: 'signed'});
    // It landed after all; the node now knows it.
    fake.land(row.tx_hash!, 11);
    fake.state.onSend = () => ({kind: 'success', value: 99});
    const again = await makeSigner().sign(request(id, {idempotencyKey: 'slow'}));
    expect(again).toMatchObject({txHash: row.tx_hash, replayed: true, result: 11});
    expect(fake.state.sent).toHaveLength(1);
    expect((await rowsOf())[0]).toMatchObject({status: 'final'});
  });

  it('a timeout the chain saw use its nonce, but whose outcome is unknown, is not re-sent', async () => {
    const id = await anAgent();
    fake.state.onSend = () => ({kind: 'timeout', lands: false});
    await expectRefusal(
      makeSigner().sign(request(id, {idempotencyKey: 'odd'})),
      ErrorCode.UPSTREAM_UNAVAILABLE,
    );
    fake.addKey(WALLET, key.publicKey, fcKey(), fake.state.sent[0]!.nonce);
    await expectRefusal(
      makeSigner().sign(request(id, {idempotencyKey: 'odd'})),
      ErrorCode.UPSTREAM_UNAVAILABLE,
    );
    expect(fake.state.sent).toHaveLength(1);
  });

  it('a timeout that never landed is re-signed on the SAME nonce, so only one can ever execute', async () => {
    const id = await anAgent();
    fake.state.onSend = () => ({kind: 'timeout', lands: false});
    await expectRefusal(
      makeSigner().sign(request(id, {idempotencyKey: 'lost'})),
      ErrorCode.UPSTREAM_UNAVAILABLE,
    );
    fake.state.onSend = () => ({kind: 'success', value: 8});
    const again = await makeSigner().sign(request(id, {idempotencyKey: 'lost'}));
    expect(fake.state.sent).toHaveLength(2);
    expect(fake.state.sent[1]!.nonce).toBe(fake.state.sent[0]!.nonce);
    expect(again).toMatchObject({replayed: false, result: 8, nonce: Number(fake.state.sent[0]!.nonce)});
  });

  it('an RPC that answers 503 on send is reported as safe to retry', async () => {
    const id = await anAgent();
    fake.state.onSend = () => ({kind: 'http', status: 503});
    await expectRefusal(makeSigner().sign(request(id)), ErrorCode.UPSTREAM_UNAVAILABLE);
  });
});

describe('accepting a wallet before its agent row exists', () => {
  const accept = (over: Partial<{walletAddress: string; chainAgentId: string; chainId: string}> = {}) => ({
    chainId: 'near:sandbox',
    walletAddress: WALLET,
    chainAgentId: String(CLIENT_ID),
    ...over,
  });

  it('sends accept_wallet with the agent id, 0 deposit, 100 Tgas', async () => {
    agentsOnChain[CLIENT_ID] = {
      id: CLIENT_ID,
      owner: 'owner.test.near',
      wallet: null,
      pending_wallet: WALLET,
      frozen: false,
    };
    const res = await makeSigner().acceptWallet(accept());
    expect(fake.state.sent).toHaveLength(1);
    expect(fake.state.sent[0]).toMatchObject({
      signerId: WALLET,
      receiverId: PACTORA,
      method: 'accept_wallet',
      args: {agent_id: CLIENT_ID},
      deposit: 0n,
      gas: 100n * TGAS,
    });
    expect(res).toEqual({txHash: fake.state.sent[0]!.hash, alreadyAccepted: false});
    const rows = (await db.execute(
      sql`SELECT status, nonce::text AS nonce FROM signer_wallet_txs`,
    )) as unknown as {
      status: string;
      nonce: string;
    }[];
    expect(rows).toEqual([{status: 'final', nonce: '5000001'}]);
  });

  it('answers alreadyAccepted, sending nothing, when the wallet is the agent’s', async () => {
    agentsOnChain[CLIENT_ID] = {
      id: CLIENT_ID,
      owner: 'o.test.near',
      wallet: WALLET,
      pending_wallet: null,
      frozen: false,
    };
    expect(await makeSigner().acceptWallet(accept())).toEqual({txHash: '', alreadyAccepted: true});
    expect(fake.state.sent).toHaveLength(0);
  });

  it('refuses when the agent’s pending wallet is another account', async () => {
    agentsOnChain[CLIENT_ID] = {
      id: CLIENT_ID,
      owner: 'o.test.near',
      wallet: null,
      pending_wallet: 'x.test.near',
      frozen: false,
    };
    const err = await expectRefusal(makeSigner().acceptWallet(accept()), ErrorCode.INVALID_STATE);
    expect(err.detail).toContain('x.test.near');
    expect(err.detail).toContain(WALLET);
  });

  it('refuses a wallet it holds no key for, and an agent that does not exist', async () => {
    await expectRefusal(makeSigner({withKey: false}).acceptWallet(accept()), ErrorCode.NOT_FOUND);
    await expectRefusal(makeSigner().acceptWallet(accept({chainAgentId: '404'})), ErrorCode.NOT_FOUND);
  });

  it('refuses a full-access key here too', async () => {
    agentsOnChain[CLIENT_ID] = {
      id: CLIENT_ID,
      owner: 'o.test.near',
      wallet: null,
      pending_wallet: WALLET,
      frozen: false,
    };
    fake.addKey(WALLET, key.publicKey, 'FullAccess');
    await expectRefusal(makeSigner().acceptWallet(accept()), ErrorCode.FORBIDDEN);
    expect(fake.state.sent).toHaveLength(0);
  });

  it('shares the wallet’s nonce discipline with /sign', async () => {
    agentsOnChain[CLIENT_ID] = {
      id: CLIENT_ID,
      owner: 'o.test.near',
      wallet: null,
      pending_wallet: WALLET,
      frozen: false,
    };
    fake.state.advanceNonce = false;
    await makeSigner().acceptWallet(accept());
    const id = await anAgent();
    const next = await makeSigner().sign(request(id, {method: 'accept_job', args: {job_id: 1}, spend: 0n}));
    expect(next.nonce).toBe(5_000_002);
  });
});

describe('a held payout (docs/26 F14)', () => {
  /** A job row the API knows: `chainJobId` on chain, `workerId` its worker's agent row. */
  async function jobRow(chainJobId: number, clientId: number, workerId: number) {
    await db.execute(
      sql`INSERT INTO jobs (chain_id, chain_job_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash, state)
          VALUES ('near:sandbox', ${String(chainJobId)}, ${clientId}, ${workerId}, 'escrow', 20000, '{}'::jsonb, ${SPEC}, 'submitted')`,
    );
  }

  it('refuses to sign approve while the worker is on hold or blocked, and signs once cleared', async () => {
    const client = await anAgent();
    const worker = await anAgent(WORKER_WALLET, WORKER_ID);
    await jobRow(41, client, worker);
    const approve = (key: string) =>
      makeSigner().sign(
        request(client, {method: 'approve', args: {job_id: 41}, spend: 0n, idempotencyKey: key}),
      );

    for (const standing of ['hold', 'blocked']) {
      await db.execute(sql`DELETE FROM account_standing`);
      await db.execute(
        sql`INSERT INTO account_standing (agent_id, standing, reason) VALUES (${worker}, ${standing}, 'a review is open')`,
      );
      const err = await expectRefusal(approve(`held-${standing}`), ErrorCode.FORBIDDEN);
      expect(err.message).toContain(`payout is held (${standing})`);
    }
    expect(fake.state.sent).toEqual([]);

    await db.execute(sql`DELETE FROM account_standing`);
    await approve('cleared');
    expect(fake.state.sent.map((t) => t.method)).toEqual(['approve']);
  });

  it('other calls for a held worker are not this gate (the API gates accepting)', async () => {
    const client = await anAgent();
    const worker = await anAgent(WORKER_WALLET, WORKER_ID);
    await jobRow(42, client, worker);
    await db.execute(
      sql`INSERT INTO account_standing (agent_id, standing, reason) VALUES (${worker}, 'hold', 'a review is open')`,
    );
    await makeSigner().sign(request(client, {method: 'cancel', args: {job_id: 42}, spend: 0n}));
    expect(fake.state.sent.map((t) => t.method)).toEqual(['cancel']);
    await db.execute(sql`DELETE FROM account_standing`);
  });
});

describe('the keeper skips held jobs (docs/26 F14)', () => {
  it('an open escrow job with a held or blocked party is not swept; the others are', async () => {
    const {openEscrowJobs} = await import('../src/keeper.js');
    const a = await anAgent('a.owner.test.near', 11);
    const b = await anAgent('b.owner.test.near', 12);
    const c = await anAgent('c.owner.test.near', 13);
    const row = (chainJobId: number, client: number, worker: number, state = 'accepted') =>
      db.execute(
        sql`INSERT INTO jobs (chain_id, chain_job_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash, state)
            VALUES ('near:sandbox', ${String(chainJobId)}, ${client}, ${worker}, 'escrow', 20000, '{}'::jsonb, ${SPEC}, ${state})`,
      );
    await row(1, a, b); // clear
    await row(2, a, c); // worker held
    await row(3, c, b); // client held
    await row(4, a, b, 'settled'); // not open
    expect((await openEscrowJobs(db, 'near:sandbox')).sort()).toEqual([1n, 2n, 3n]);
    await db.execute(
      sql`INSERT INTO account_standing (agent_id, standing, reason) VALUES (${c}, 'hold', 'a review is open')`,
    );
    expect(await openEscrowJobs(db, 'near:sandbox')).toEqual([1n]);
    await db.execute(
      sql`UPDATE account_standing SET standing = 'clear', reason = 'cleared by review' WHERE agent_id = ${c}`,
    );
    expect((await openEscrowJobs(db, 'near:sandbox')).sort()).toEqual([1n, 2n, 3n]);
    await db.execute(sql`DELETE FROM account_standing`);
  });
});
