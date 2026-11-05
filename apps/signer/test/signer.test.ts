import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createServer, type Server} from 'node:http';
import {fileURLToPath} from 'node:url';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
  parseTransaction,
  recoverTransactionAddress,
  toFunctionSelector,
  type Abi,
  type Hex,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {sql} from 'drizzle-orm';
import {loadConfig, loadAbis} from '@pactora/config';
import {createDb, closeDb, createLockPool, closeLockPool, type Db, type LockPool} from '@pactora/db';
import {PactoraError, ErrorCode} from '@pactora/shared';
import {SignerService} from '../src/signer.js';
import {cloneCodeOf, delegationOf} from '../src/accounts.js';

/**
 * The signer, which is the only process in this system that holds a key.
 *
 * It had no tests. Everything it does — refusing a spend over the cap,
 * refusing to broadcast without gas, never reusing a nonce, returning the
 * original hash for a retry — is either custody or the thing that stops a
 * retry becoming a second payment, and none of it was covered.
 *
 * It builds its own RPC client from `chain.rpcUrl`, so rather than changing
 * production code to suit a test, these point that URL at a real JSON-RPC
 * server we control. That exercises the actual viem path: fee estimation,
 * nonce fetch, contract reads and broadcast, with the responses chosen per
 * test.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';

/** Anvil account #0 — a well-known test key, never used on a real network. */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const ACCOUNT = privateKeyToAccount(TEST_KEY);

const TX_HASH = `0x${'ab'.repeat(32)}`;

/** What the fake chain currently says. Each test sets what it needs. */
interface ChainState {
  balanceWei: bigint;
  nonce: number;
  perTaskCap: bigint;
  dailyCap: bigint;
  dailyRemaining: bigint;
  nextReleaseAt: bigint;
  /** A plain EOA: no code, so every contract read returns empty data. */
  eoa?: boolean;
  /** AgentAccount.owner(). Defaults to the held key. */
  owner: string;
  /** AgentAccount.sessionKeys(key).expiry, by lowercased key address. */
  sessionExpiry: Record<string, bigint>;
  /** The last broadcast, decoded — where it went and what it carried. */
  lastTx?: {to: string | undefined; data: Hex | undefined; raw: Hex};
  /** When set, eth_sendRawTransaction fails with this message. */
  broadcastError?: string;
  /** When set, eth_sendRawTransaction is answered with this HTTP status and a
   *  plain-text body, the way a proxy or load balancer in front of a node does. */
  broadcastHttpStatus?: number;
  /** When set, eth_estimateGas reverts with this ABI-encoded error data. */
  estimateRevert?: Hex;
  /** What eth_estimateGas answers. Default 21000. */
  estimateGas?: bigint;
  /** The chain id the RPC claims to serve. Default 31337. */
  rpcChainId?: number;
  /**
   * The wallet's runtime code. Default: none for an EOA, else an ERC-1167
   * clone of the factory's implementation — a real AgentAccount.
   */
  code?: Hex;
  /** TaskEscrow.getJob(id).disputeBond. */
  disputeBond?: bigint;
  /** The chain id of the last broadcast, as signed. */
  lastChainId?: number;
  broadcasts: number;
}

/** What the fake factory says its implementation is. */
const IMPL = ('0x' + '1a'.repeat(20)) as Hex;

let state: ChainState;
let server: Server;
let rpcUrl: string;
let db: Db;
let locks: LockPool;

function reset(): ChainState {
  return {
    balanceWei: 10n ** 18n,
    nonce: 4,
    perTaskCap: 100_000n,
    dailyCap: 500_000n,
    dailyRemaining: 400_000n,
    nextReleaseAt: 0n,
    owner: ACCOUNT.address,
    sessionExpiry: {},
    broadcasts: 0,
  };
}

const uint = (v: bigint) => encodeAbiParameters([{type: 'uint256'}], [v]);

const ABIS = loadAbis() as unknown as Record<string, Abi>;
const ESCROW_ABI = ABIS['TaskEscrow']!;

/** TaskEscrow.getJob, answered with a submitted job whose dispute bond is `bond`. */
function jobResult(bond: bigint): Hex {
  const zero = ('0x' + '00'.repeat(32)) as Hex;
  return encodeFunctionResult({
    abi: ESCROW_ABI,
    functionName: 'getJob',
    result: {
      clientAgentId: 1n,
      workerAgentId: 2n,
      amount: 20_000n,
      fee: 0n,
      acceptDeadline: 0n,
      workDeadline: 0n,
      reviewDeadline: 0n,
      state: 3,
      reviewWindow: 0,
      disputeTimeout: 0,
      disputeDeadline: 0n,
      specHash: zero,
      resultHash: zero,
      workerBond: 0n,
      disputeBond: bond,
    },
  } as never);
}

const SELECTORS = {
  implementation: toFunctionSelector('function implementation() view returns (address)'),
  getJob: toFunctionSelector('function getJob(uint256)'),
  dailyRemaining: toFunctionSelector('function dailyRemaining() view returns (uint128)'),
  nextReleaseAt: toFunctionSelector('function nextReleaseAt() view returns (uint256)'),
  owner: toFunctionSelector('function owner() view returns (address)'),
  sessionKeys: toFunctionSelector('function sessionKeys(address) view returns (uint64,uint128,uint128)'),
};

/** A JSON-RPC server that answers only what viem asks of this code path. */
function rpc(method: string, params: unknown[]): unknown {
  switch (method) {
    case 'eth_chainId':
      return `0x${(state.rpcChainId ?? 31337).toString(16)}`;
    case 'eth_getCode':
      return state.code ?? (state.eoa ? '0x' : cloneCodeOf(IMPL));
    case 'eth_getBalance':
      return `0x${state.balanceWei.toString(16)}`;
    case 'eth_getTransactionCount':
      return `0x${state.nonce.toString(16)}`;
    case 'eth_gasPrice':
      return '0x3b9aca00';
    case 'eth_maxPriorityFeePerGas':
      return '0x3b9aca00';
    case 'eth_estimateGas':
      if (state.estimateRevert) {
        throw Object.assign(new Error('execution reverted'), {code: 3, data: state.estimateRevert});
      }
      return `0x${(state.estimateGas ?? 21_000n).toString(16)}`;
    case 'eth_blockNumber':
      return '0x1';
    case 'eth_getBlockByNumber':
      return {number: '0x1', baseFeePerGas: '0x3b9aca00', timestamp: '0x1', hash: `0x${'11'.repeat(32)}`};
    case 'eth_call': {
      // Which AgentAccount getter is being read, by selector.
      //
      // COMPUTED, not written down from memory. Hard-coded guesses here fell
      // through to the policy() branch, so a call asking for the remaining
      // daily budget was answered with the per-task cap — and the test
      // reported the signer accepting a spend it had actually never been
      // asked about. A stub that answers the wrong question convincingly is
      // worse than one that fails.
      const data = String((params[0] as {data?: string}).data ?? '');
      if (data.startsWith(SELECTORS.getJob)) return jobResult(state.disputeBond ?? 0n);
      if (state.eoa) return '0x';
      if (data.startsWith(SELECTORS.implementation)) return encodeAbiParameters([{type: 'address'}], [IMPL]);
      if (data.startsWith(SELECTORS.dailyRemaining)) return uint(state.dailyRemaining);
      if (data.startsWith(SELECTORS.nextReleaseAt)) return uint(state.nextReleaseAt);
      if (data.startsWith(SELECTORS.owner))
        return encodeAbiParameters([{type: 'address'}], [state.owner as Hex]);
      if (data.startsWith(SELECTORS.sessionKeys)) {
        const key = `0x${data.slice(-40)}`.toLowerCase();
        return encodeAbiParameters(
          [{type: 'uint64'}, {type: 'uint128'}, {type: 'uint128'}],
          [state.sessionExpiry[key] ?? 0n, 0n, 0n],
        );
      }
      // policy() -> (uint128 perTaskCap, uint128 dailyCap, bool allowlistOnly)
      return encodeAbiParameters(
        [{type: 'uint128'}, {type: 'uint128'}, {type: 'bool'}],
        [state.perTaskCap, state.dailyCap, false],
      );
    }
    case 'eth_sendRawTransaction':
      if (state.broadcastError) throw new Error(state.broadcastError);
      state.broadcasts++;
      {
        const tx = parseTransaction(params[0] as Hex);
        state.lastTx = {to: tx.to ?? undefined, data: tx.data, raw: params[0] as Hex};
        if (tx.chainId !== undefined) state.lastChainId = tx.chainId;
      }
      // The pending nonce advances, as a real node's does.
      state.nonce++;
      return TX_HASH;
    default:
      return null;
  }
}

beforeAll(async () => {
  state = reset();
  db = createDb(DB_URL, {max: 3});
  locks = createLockPool(DB_URL, {max: 10});

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body) as {id: number; method: string; params: unknown[]};
      if (parsed.method === 'eth_sendRawTransaction' && state.broadcastHttpStatus) {
        res.statusCode = state.broadcastHttpStatus;
        res.end('upstream unavailable');
        return;
      }
      res.setHeader('content-type', 'application/json');
      try {
        res.end(
          JSON.stringify({jsonrpc: '2.0', id: parsed.id, result: rpc(parsed.method, parsed.params ?? [])}),
        );
      } catch (err) {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            error: {
              code: (err as {code?: number}).code ?? -32000,
              message: (err as Error).message,
              ...((err as {data?: string}).data ? {data: (err as {data?: string}).data} : {}),
            },
          }),
        );
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as {port: number}).port;
  rpcUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeDb(db);
  await closeLockPool(locks);
});

beforeEach(async () => {
  state = reset();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, runs, run_events, signer_txs RESTART IDENTITY CASCADE`,
  );
});

const baseConfig = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});

function makeSigner(
  over: {
    gasFloorWei?: bigint;
    withKey?: boolean;
    keys?: unknown;
    chain?: Partial<ReturnType<typeof baseConfig.chain>>;
    maxGas?: bigint;
  } = {},
): SignerService {
  const chain = {...baseConfig.chain(31337), rpcUrl, ...over.chain} as ReturnType<typeof baseConfig.chain>;
  return new SignerService({
    db,
    locks,
    chain,
    abis: loadAbis() as never,
    keys: (over.keys ?? {
      accountFor: async () => (over.withKey === false ? null : ACCOUNT),
      all: () => (over.withKey === false ? [] : [ACCOUNT]),
    }) as never,
    ...(over.gasFloorWei !== undefined ? {gasFloorWei: over.gasFloorWei} : {}),
    ...(over.maxGas !== undefined ? {maxGas: over.maxGas} : {}),
  });
}

/** An agent row whose wallet is the account the signer will use. */
async function anAgent(): Promise<number> {
  const rows = (await db.execute(
    sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
        VALUES (31337, ${ACCOUNT.address}, ${ACCOUNT.address}, 'Payer', 20000) RETURNING id`,
  )) as unknown as {id: number}[];
  return rows[0]!.id;
}

const ESCROW = baseConfig.chain(31337).contracts['TaskEscrow'] as Hex;
const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;

/** A call the API really sends: a hire when it spends, an accept when it does not. */
const escrowCall = (spend: bigint): Hex =>
  spend > 0n
    ? encodeFunctionData({
        abi: ESCROW_ABI,
        functionName: 'createJob',
        args: [1n, 2n, spend, ZERO32, 3600n, 3600n],
      })
    : encodeFunctionData({abi: ESCROW_ABI, functionName: 'acceptJob', args: [1n]});

const request = (
  agentId: number,
  over: Partial<{spend: bigint; idempotencyKey: string; chainId: number; target: Hex; data: Hex}> = {},
) => ({
  agentId,
  chainId: over.chainId ?? 31337,
  target: over.target ?? ESCROW,
  data: over.data ?? escrowCall(over.spend ?? 20_000n),
  spend: over.spend ?? 20_000n,
  idempotencyKey: over.idempotencyKey ?? `key-${Math.random()}`,
});

async function expectRefusal(promise: Promise<unknown>, code: ErrorCode): Promise<PactoraError> {
  let error: unknown;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  expect(error, 'the signer accepted a request it should have refused').toBeInstanceOf(PactoraError);
  expect((error as PactoraError).code).toBe(code);
  return error as PactoraError;
}

describe('what the signer refuses', () => {
  it('refuses a request for a chain it does not serve', async () => {
    const id = await anAgent();
    await expectRefusal(makeSigner().sign(request(id, {chainId: 143})), ErrorCode.CHAIN_MISMATCH);
    expect(state.broadcasts).toBe(0);
  });

  it('refuses when there is no signing key for the agent', async () => {
    const id = await anAgent();
    await expectRefusal(makeSigner({withKey: false}).sign(request(id)), ErrorCode.AGENT_NOT_HIREABLE);
    expect(state.broadcasts).toBe(0);
  });

  /**
   * Refusing beats broadcasting a transaction that will fail and still
   * consume a nonce — a consumed nonce with no result blocks everything
   * behind it.
   */
  it('refuses to broadcast below the gas floor', async () => {
    const id = await anAgent();
    state.balanceWei = 1n;
    await expectRefusal(makeSigner().sign(request(id)), ErrorCode.INSUFFICIENT_FUNDS);
    expect(state.broadcasts).toBe(0);
  });

  it('refuses a spend above the per-task cap', async () => {
    const id = await anAgent();
    state.perTaskCap = 10_000n;
    await expectRefusal(makeSigner().sign(request(id, {spend: 20_000n})), ErrorCode.BUDGET_EXCEEDED);
    expect(state.broadcasts).toBe(0);
  });

  it('refuses a spend above what is left today, and says when capacity returns', async () => {
    const id = await anAgent();
    state.dailyRemaining = 5_000n;
    // v3: the cap rolls; the account says when its oldest counted spend
    // leaves the window. Here, in an hour.
    state.nextReleaseAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const err = await expectRefusal(
      makeSigner().sign(request(id, {spend: 20_000n})),
      ErrorCode.BUDGET_EXCEEDED,
    );
    expect(err.retryAfter).toBeGreaterThan(3500);
    expect(err.retryAfter).toBeLessThanOrEqual(3600);
    expect(state.broadcasts).toBe(0);
  });

  it('allows a spend exactly at the cap', async () => {
    const id = await anAgent();
    state.perTaskCap = 20_000n;
    const result = await makeSigner().sign(request(id, {spend: 20_000n}));
    expect(result.txHash).toBe(TX_HASH);
  });
});

describe('signing, once', () => {
  it('broadcasts and records the nonce and hash', async () => {
    const id = await anAgent();
    const result = await makeSigner().sign(request(id, {idempotencyKey: 'once-1'}));

    expect(result).toMatchObject({txHash: TX_HASH, nonce: 4, replayed: false});
    const rows = (await db.execute(
      sql`SELECT status, nonce, tx_hash FROM signer_txs WHERE idempotency_key = 'once-1'`,
    )) as unknown as {status: string; nonce: string; tx_hash: string}[];
    expect(rows[0]).toMatchObject({status: 'broadcast', tx_hash: TX_HASH});
    expect(Number(rows[0]!.nonce)).toBe(4);
  });

  /**
   * The property the whole idempotency scheme exists for: a retried hire must
   * return the original payment, not make a second one.
   */
  it('returns the original hash for a repeated key without broadcasting again', async () => {
    const id = await anAgent();
    const signer = makeSigner();

    const first = await signer.sign(request(id, {idempotencyKey: 'same-key'}));
    const second = await signer.sign(request(id, {idempotencyKey: 'same-key'}));

    expect(second.txHash).toBe(first.txHash);
    expect(second.replayed).toBe(true);
    expect(state.broadcasts, 'a retry must not produce a second transaction').toBe(1);
  });

  it('treats a different key as a different payment', async () => {
    const id = await anAgent();
    const signer = makeSigner();

    await signer.sign(request(id, {idempotencyKey: 'key-one'}));
    state.nonce = 5;
    await signer.sign(request(id, {idempotencyKey: 'key-two'}));

    expect(state.broadcasts).toBe(2);
  });
});

describe('a failed broadcast', () => {
  /**
   * The row used to stay `pending` with no hash, which burned the key
   * forever: every retry was refused as "in flight", and topping the wallet
   * up did not help.
   */
  it('is recorded as failed rather than left pending', async () => {
    const id = await anAgent();
    state.broadcastError = 'insufficient funds for gas';

    await expectRefusal(
      makeSigner().sign(request(id, {idempotencyKey: 'fails-1'})),
      ErrorCode.INSUFFICIENT_FUNDS,
    );

    const rows = (await db.execute(
      sql`SELECT status, tx_hash FROM signer_txs WHERE idempotency_key = 'fails-1'`,
    )) as unknown as {status: string; tx_hash: string | null}[];
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.tx_hash).toBeNull();
  });

  it('names the wallet to fund when the failure is gas', async () => {
    const id = await anAgent();
    state.broadcastError = 'insufficient funds for gas * price + value';

    const err = await expectRefusal(makeSigner().sign(request(id)), ErrorCode.INSUFFICIENT_FUNDS);
    expect(err.message).toMatch(ACCOUNT.address);
    expect(err.message).toMatch(/top it up/i);
  });

  /**
   * Retrying REUSES the stored nonce. If the original did reach the mempool
   * after all, two transactions with one nonce means only one can be mined —
   * so recovering cannot double-spend.
   */
  it('lets the same key retry once the problem is fixed, on the same nonce', async () => {
    const id = await anAgent();
    const signer = makeSigner();
    state.broadcastError = 'insufficient funds for gas';

    await expectRefusal(
      signer.sign(request(id, {idempotencyKey: 'recover-1'})),
      ErrorCode.INSUFFICIENT_FUNDS,
    );

    // The wallet is topped up; the chain has moved on to a higher nonce.
    state.broadcastError = undefined as unknown as string;
    state.nonce = 99;

    const result = await signer.sign(request(id, {idempotencyKey: 'recover-1'}));
    expect(result.txHash).toBe(TX_HASH);
    expect(result.nonce, 'the retry must reuse the original nonce').toBe(4);
    expect(state.broadcasts).toBe(1);
  });

  it('reports an unreachable RPC as safe to retry, having broadcast nothing', async () => {
    const id = await anAgent();
    state.broadcastError = 'fetch failed';

    const err = await expectRefusal(makeSigner().sign(request(id)), ErrorCode.CHAIN_NOT_ENABLED);
    expect(err.message).toMatch(/NOT broadcast/);
    expect(state.broadcasts).toBe(0);
  });
});

describe('signing as the right agent', () => {
  /**
   * The signer asked the keystore for "a key for agent 7" and used whatever
   * came back. With a single dev key that is ALWAYS the deployer's — so every
   * transaction went out from one address regardless of which agent the API
   * said it was acting for.
   *
   * On chain that is not a subtle mismatch. `TaskEscrow.acceptJob` checks
   * `identityRegistry.getAgentWallet(workerAgentId) == msg.sender`, so every
   * accept, every submitResult and every approve reverted with
   * `NotAgentWallet` — reported as "Execution reverted for an unknown
   * reason", which is what it looks like when the revert data is a custom
   * error nobody decoded.
   *
   * The identity IS the wallet here. Signing on behalf of an agent with a key
   * that is not its own is not a demo shortcut; it is the signer claiming to
   * be someone it is not, and the chain is right to refuse.
   */
  it('refuses rather than signing with a key that is not the agent\u2019s', async () => {
    const id = await anAgent();
    // A key the keystore holds, for somebody else entirely.
    const stranger = privateKeyToAccount(`0x${'11'.repeat(32)}`);

    const signer = makeSigner({keys: {accountFor: async () => stranger}});

    const err = await expectRefusal(signer.sign(request(id)), ErrorCode.AGENT_NOT_HIREABLE);
    expect(err.message).toMatch(/wallet/i);
    expect(state.broadcasts).toBe(0);
  });

  it('signs when the key matches the wallet the agent is registered with', async () => {
    const id = await anAgent();
    const res = await makeSigner().sign(request(id));

    expect(res.txHash).toBe(TX_HASH);
    expect(state.broadcasts).toBe(1);
  });

  it('tells the keystore which wallet it needs, not only which agent', async () => {
    // A plain wallet signs for itself, so the keystore must produce ITS key.
    // (An AgentAccount wallet is signed for by a session key instead — below.)
    state.eoa = true;
    const id = await anAgent();
    await db.execute(
      sql`INSERT INTO spend_policies (agent_id, per_task_cap, daily_cap) VALUES (${id}, '100000', '1000000')`,
    );
    const asked: unknown[] = [];

    const signer = makeSigner({
      keys: {
        accountFor: async (...args: unknown[]) => {
          asked.push(args);
          return ACCOUNT;
        },
      },
    });

    await signer.sign(request(id));

    // A keystore holding one key per agent can only pick the right one if it
    // is told the address it has to match.
    expect(JSON.stringify(asked).toLowerCase()).toContain(ACCOUNT.address.toLowerCase());
  });
});

/**
 * An agent whose wallet is a plain EOA — which is every agent today.
 *
 * The caps were enforced nowhere for these. The signer read them from
 * `AgentAccount`, every read failed on an address with no code, and each
 * failure was treated as "no cap". `spend_policies.spent_today` was never
 * incremented, so `/v1/budget` never went down either. The claim the project
 * rests on — a hijacked agent cannot spend past its daily cap — held only for
 * a contract account nobody uses.
 */
describe('an EOA agent, which is every agent today', () => {
  async function withPolicy(
    perTaskCap: bigint,
    dailyCap: bigint,
    over: {spentToday?: bigint; hoursAgo?: number} = {},
  ) {
    const agentId = await anAgent();
    await db.execute(
      sql`INSERT INTO spend_policies (agent_id, per_task_cap, daily_cap, spent_today, day_start)
          VALUES (${agentId}, ${perTaskCap.toString()}, ${dailyCap.toString()}, ${(over.spentToday ?? 0n).toString()},
                  now() - make_interval(hours => ${over.hoursAgo ?? 0}))`,
    );
    return agentId;
  }

  const spentToday = async (agentId: number) =>
    BigInt(
      (
        (await db.execute(
          sql`SELECT spent_today FROM spend_policies WHERE agent_id = ${agentId}`,
        )) as unknown as {
          spent_today: string;
        }[]
      )[0]!.spent_today,
    );

  beforeEach(() => {
    state.eoa = true;
  });

  it('refuses a spend over the per-task cap', async () => {
    const agentId = await withPolicy(30_000n, 1_000_000n);
    await expectRefusal(makeSigner().sign(request(agentId, {spend: 40_000n})), ErrorCode.BUDGET_EXCEEDED);
    expect(state.broadcasts).toBe(0);
  });

  it('counts what it signs, and refuses once the day would pass the cap', async () => {
    const agentId = await withPolicy(50_000n, 60_000n);
    const signer = makeSigner();

    await signer.sign(request(agentId, {spend: 40_000n}));
    expect(await spentToday(agentId)).toBe(40_000n);

    const refused = await expectRefusal(
      signer.sign(request(agentId, {spend: 40_000n})),
      ErrorCode.BUDGET_EXCEEDED,
    );
    expect(refused.retryAfter).toBeGreaterThan(0);
    expect(state.broadcasts).toBe(1);
    expect(await spentToday(agentId)).toBe(40_000n);
  });

  it('does not charge the budget for a broadcast that failed', async () => {
    const agentId = await withPolicy(50_000n, 60_000n);
    state.broadcastError = 'insufficient funds for gas';
    await makeSigner()
      .sign(request(agentId, {spend: 40_000n}))
      .catch(() => undefined);
    expect(await spentToday(agentId)).toBe(0n);
  });

  it('does not charge twice for a retried request', async () => {
    const agentId = await withPolicy(50_000n, 60_000n);
    const signer = makeSigner();
    await signer.sign(request(agentId, {spend: 40_000n, idempotencyKey: 'same-key-001'}));
    await signer.sign(request(agentId, {spend: 40_000n, idempotencyKey: 'same-key-001'}));
    expect(await spentToday(agentId)).toBe(40_000n);
  });

  it('opens a new window once 24 hours have passed', async () => {
    const agentId = await withPolicy(50_000n, 60_000n, {spentToday: 60_000n, hoursAgo: 25});
    await makeSigner().sign(request(agentId, {spend: 40_000n}));
    expect(await spentToday(agentId)).toBe(40_000n);
  });

  /** No policy is not "no limit". */
  it('refuses to spend for an agent with no policy at all', async () => {
    const agentId = await anAgent();
    await expectRefusal(makeSigner().sign(request(agentId, {spend: 1n})), ErrorCode.BUDGET_EXCEEDED);
  });

  it('still signs calls that spend nothing', async () => {
    const agentId = await anAgent();
    const result = await makeSigner().sign(request(agentId, {spend: 0n}));
    expect(result.replayed).toBe(false);
  });
});

/**
 * An agent whose wallet is an AgentAccount — the contract the project's
 * headline claim rests on, and which no agent used until now.
 *
 * The signer used to sign every call as the wallet itself. For a contract
 * wallet that is impossible — nobody holds a contract's key — so the call
 * has to go TO the account, as execute(target, data), signed by a key the
 * account trusts; the account then makes the call and measures what it
 * spent against caps no hot key can change.
 */
describe('an agent whose wallet is an AgentAccount', () => {
  const CONTRACT = ('0x' + 'ac'.repeat(20)) as Hex;
  const HUMAN = '0x' + '0f'.repeat(20);

  async function accountAgent(): Promise<number> {
    const rows = (await db.execute(
      sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
          VALUES (31337, ${HUMAN}, ${CONTRACT}, 'Orchestrator', 0) RETURNING id`,
    )) as unknown as {id: number}[];
    return rows[0]!.id;
  }

  const asExecute = () => {
    const {functionName, args} = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'execute',
          stateMutability: 'nonpayable',
          inputs: [
            {name: 'target', type: 'address'},
            {name: 'data', type: 'bytes'},
          ],
          outputs: [{type: 'bytes'}],
        },
      ],
      data: state.lastTx!.data!,
    });
    return {functionName, target: String(args[0]).toLowerCase(), data: args[1]};
  };

  beforeEach(() => {
    state.owner = HUMAN;
    state.sessionExpiry = {[ACCOUNT.address.toLowerCase()]: BigInt(Math.floor(Date.now() / 1000) + 3600)};
  });

  it('sends execute(target, data) to the account, signed by a live session key', async () => {
    const agentId = await accountAgent();
    const req = request(agentId);

    await makeSigner().sign(req);

    expect(state.lastTx!.to!.toLowerCase()).toBe(CONTRACT);
    const call = asExecute();
    expect(call.functionName).toBe('execute');
    expect(call.target).toBe(req.target.toLowerCase());
    expect(call.data).toBe(req.data);
  });

  /** approve, dispute and cancel spend nothing and must still come from the account. */
  it('routes a call that spends nothing through the account too', async () => {
    const agentId = await accountAgent();
    await makeSigner().sign(request(agentId, {spend: 0n}));
    expect(state.lastTx!.to!.toLowerCase()).toBe(CONTRACT);
  });

  it('refuses when no key held here is trusted by the account', async () => {
    const agentId = await accountAgent();
    state.sessionExpiry = {[ACCOUNT.address.toLowerCase()]: BigInt(Math.floor(Date.now() / 1000) - 10)};

    const err = await expectRefusal(makeSigner().sign(request(agentId)), ErrorCode.AGENT_NOT_HIREABLE);
    expect(err.message).toMatch(/session key/);
    expect(state.broadcasts).toBe(0);
  });

  /** The chain holds these caps; a second, off-chain ledger would only drift from it. */
  it('leaves the cap to the account rather than to a policy row', async () => {
    const agentId = await accountAgent(); // no spend_policies row at all
    const result = await makeSigner().sign(request(agentId, {spend: 20_000n}));
    expect(result.replayed).toBe(false);
  });

  it('still refuses, before any gas, a spend the account would revert', async () => {
    const agentId = await accountAgent();
    await expectRefusal(makeSigner().sign(request(agentId, {spend: 150_000n})), ErrorCode.BUDGET_EXCEEDED);
    expect(state.broadcasts).toBe(0);
  });

  /**
   * A worker's account: caps of zero, because a worker never spends, and a
   * signer holding every demo agent's key. Accept and submit spend nothing,
   * so zero caps must not refuse them — and the key used must be the one
   * THIS account granted. The first key held is some other agent's; signing
   * with it reverts `NotAuthorized` and burns the gas limit.
   */
  it('signs a worker account’s zero-spend call with the key that account granted, not the first key held', async () => {
    const agentId = await accountAgent();
    const WORKER_KEY = privateKeyToAccount(`0x${'02'.repeat(32)}`);
    state.perTaskCap = 0n;
    state.dailyCap = 0n;
    state.dailyRemaining = 0n;
    state.sessionExpiry = {[WORKER_KEY.address.toLowerCase()]: BigInt(Math.floor(Date.now() / 1000) + 3600)};

    await makeSigner({keys: {accountFor: async () => null, all: () => [ACCOUNT, WORKER_KEY]}}).sign(
      request(agentId, {spend: 0n}),
    );

    expect(state.lastTx!.to!.toLowerCase()).toBe(CONTRACT);
    expect(asExecute().functionName).toBe('execute');
    const signedBy = await recoverTransactionAddress({serializedTransaction: state.lastTx!.raw as never});
    expect(signedBy.toLowerCase()).toBe(WORKER_KEY.address.toLowerCase());
  });
});

describe('after a broadcast that failed', () => {
  /**
   * A failed broadcast keeps its row — and its nonce — so a retry of the SAME
   * request reuses that nonce. But the chain never saw it, so the next
   * DIFFERENT request is given the same pending nonce, collides with the
   * failed row on (agent, nonce), and was refused as "a request with this key
   * is in flight". A live run lost a whole step to it: one gas shortfall
   * blocked every later hire by that agent.
   */
  it('lets the next request use the nonce the chain never saw', async () => {
    const agentId = await anAgent();
    const signer = makeSigner();

    state.broadcastError = 'insufficient funds for gas';
    await signer.sign(request(agentId)).catch(() => undefined);

    delete state.broadcastError;
    const next = await signer.sign(request(agentId));
    expect(next.replayed).toBe(false);
    expect(state.broadcasts).toBe(1);
  });

  it('still lets the failed request itself be retried', async () => {
    const agentId = await anAgent();
    const signer = makeSigner();
    const req = request(agentId, {idempotencyKey: 'retry-me-001'});

    state.broadcastError = 'insufficient funds for gas';
    await signer.sign(req).catch(() => undefined);
    await signer.sign(request(agentId)).catch(() => undefined); // a different request fails too
    delete state.broadcastError;

    expect((await signer.sign(req)).replayed).toBe(false);
  });
});

describe('what a failed broadcast is reported as', () => {
  /** The node's words were "Signer had insufficient balance"; we said the RPC was unreachable. */
  it('names an empty gas wallet as that, whatever the node calls it', async () => {
    const agentId = await anAgent();
    state.broadcastError = 'Signer had insufficient balance';
    await expectRefusal(makeSigner().sign(request(agentId)), ErrorCode.INSUFFICIENT_FUNDS);
  });

  /** "503" appeared inside the transaction's own hex, and matched the outage pattern. */
  it('does not read an outage into the hex of the transaction itself', async () => {
    const agentId = await anAgent();
    state.broadcastError = 'execution reverted: 0x4d11988c00005035030eb20edae3';
    const err = await expectRefusal(makeSigner().sign(request(agentId)), ErrorCode.INVALID_STATE);
    expect(err.message).not.toMatch(/unreachable/);
  });

  /**
   * A 503 from whatever sits in front of the node. viem reports it as
   * "HTTP request failed." with the status on the error, not in its words —
   * so it was called INVALID_STATE, the worker was told not to retry, and a
   * 20%-lossy chaos run abandoned finished work at submit.
   */
  it('reports an HTTP 503 from the RPC as safe to retry, having broadcast nothing', async () => {
    const agentId = await anAgent();
    state.broadcastHttpStatus = 503;
    const err = await expectRefusal(makeSigner().sign(request(agentId)), ErrorCode.CHAIN_NOT_ENABLED);
    expect(err.retryAfter).toBeDefined();
    expect(state.broadcasts).toBe(0);
  });
});

/**
 * The per-agent lock must be released on the connection that took it.
 *
 * `pg_advisory_lock` is SESSION-scoped, and the pool hands each query to
 * whichever connection is free — so a lock taken on one connection and
 * "released" on another is not released at all: the unlock returns false,
 * and the lock stays held by an idle pooled connection for as long as it
 * lives. The next sign for that agent, on any other connection, then waits
 * forever. Found by the Session 26 audit; this reproduces it.
 */
describe('the per-agent lock', () => {
  const KEYS = [1, 2, 3, 4, 5].map((i) => privateKeyToAccount(`0x${String(i).padStart(2, '0').repeat(32)}`));

  async function agentFor(key: (typeof KEYS)[number]): Promise<number> {
    const rows = (await db.execute(
      sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
          VALUES (31337, ${key.address}, ${key.address}, 'Locker', 0) RETURNING id`,
    )) as unknown as {id: number}[];
    return rows[0]!.id;
  }

  const heldAdvisoryLocks = async () =>
    Number(
      (
        (await db.execute(
          sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`,
        )) as unknown as {n: number}[]
      )[0]!.n,
    );

  it('holds no lock once concurrent signs across agents have finished', async () => {
    state.eoa = true;
    const signer = makeSigner({
      keys: {
        accountFor: async (_id: number, wallet: string) =>
          KEYS.find((k) => k.address.toLowerCase() === wallet.toLowerCase()) ?? null,
        all: () => KEYS,
      },
    });
    const agents = await Promise.all(KEYS.map(agentFor));

    // Concurrency is what makes the pool hand lock and unlock to different
    // connections; spend 0 needs no policy row.
    await Promise.all(
      Array.from({length: 4}, () => agents.map((id) => signer.sign(request(id, {spend: 0n})))).flat(),
    );
    expect(await heldAdvisoryLocks()).toBe(0);

    // And every agent can still be signed for, promptly.
    const again = Promise.all(agents.map((id) => signer.sign(request(id, {spend: 0n}))));
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('a sign waited on a stuck lock')), 5_000),
    );
    await Promise.race([again, timeout]);
  });

  it('releases the lock when the signing work throws', async () => {
    state.eoa = true;
    state.broadcastError = 'nonce too low';
    const agentId = await anAgent();
    await makeSigner()
      .sign(request(agentId, {spend: 0n}))
      .catch(() => undefined);
    expect(await heldAdvisoryLocks()).toBe(0);
  });
});

/**
 * A contract refusal, named. v1 reported any failed broadcast as INVALID_STATE
 * with viem's whole message — which can carry the transaction bytes, and
 * which hid WHICH rule refused. v2 adds rules a caller must be able to tell
 * apart: the same owner on both sides, a job below the minimum.
 */
describe('what a contract refusal is reported as', () => {
  const errorData = (signature: string, args: readonly unknown[] = []) =>
    (toFunctionSelector(signature) +
      (args.length
        ? encodeAbiParameters(
            args.map(() => ({type: 'uint128'})),
            args as never,
          ).slice(2)
        : '')) as Hex;

  it('names the escrow rule that refused, without the raw transaction', async () => {
    state.eoa = true;
    state.estimateRevert = errorData('SameOwner()');
    const agentId = await anAgent();
    const err = await expectRefusal(
      makeSigner().sign(request(agentId, {spend: 0n})),
      ErrorCode.INVALID_STATE,
    );
    expect(err.detail).toMatch(/SameOwner/);
    expect(err.detail).not.toMatch(/0x02f8|0xf8/);
    expect(state.broadcasts).toBe(0);
  });

  it('decodes arguments too, so the caller learns the minimum', async () => {
    state.eoa = true;
    state.estimateRevert = errorData('AmountBelowMinimum(uint128,uint128)', [1n, 10_000n]);
    const agentId = await anAgent();
    const err = await expectRefusal(
      makeSigner().sign(request(agentId, {spend: 0n})),
      ErrorCode.INVALID_STATE,
    );
    expect(err.detail).toMatch(/AmountBelowMinimum\(1, 10000\)/);
  });
});

/**
 * Audit H1: an idempotency key was global and bound to nothing. The replay
 * lookup matched the key alone, so a caller who reused — or pre-claimed —
 * another request's key got that request's transaction back as
 * `replayed: true`, and the API recorded a payment, an accept or a submit
 * that had never been sent for it.
 */
describe('an idempotency key replays only the request that made it', () => {
  const OTHER = privateKeyToAccount(`0x${'07'.repeat(32)}`);

  async function otherAgent(): Promise<number> {
    const rows = (await db.execute(
      sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
          VALUES (31337, ${OTHER.address}, ${OTHER.address}, 'Other', 0) RETURNING id`,
    )) as unknown as {id: number}[];
    return rows[0]!.id;
  }

  const bothKeys = {
    accountFor: async (_id: number, wallet: string) =>
      [ACCOUNT, OTHER].find((k) => k.address.toLowerCase() === wallet.toLowerCase()) ?? null,
    all: () => [ACCOUNT, OTHER],
  };

  beforeEach(() => {
    state.eoa = true;
  });

  it('does not hand one agent another agent’s transaction for the same key', async () => {
    const victim = await anAgent();
    const attacker = await otherAgent();
    const signer = makeSigner({keys: bothKeys});

    await signer.sign(request(victim, {spend: 0n, idempotencyKey: 'shared-key-0001'}));
    const second = await signer.sign(request(attacker, {spend: 0n, idempotencyKey: 'shared-key-0001'}));

    expect(second.replayed, 'the attacker was handed the victim’s transaction').toBe(false);
    expect(state.broadcasts).toBe(2);
    const signedBy = await recoverTransactionAddress({serializedTransaction: state.lastTx!.raw as never});
    expect(signedBy.toLowerCase()).toBe(OTHER.address.toLowerCase());
  });

  it('refuses the same key from the same agent for a different call', async () => {
    const id = await anAgent();
    const signer = makeSigner();
    await signer.sign(request(id, {spend: 0n, idempotencyKey: 'reused-key-001'}));

    const different = encodeFunctionData({abi: ESCROW_ABI, functionName: 'cancel', args: [9n]});
    await expectRefusal(
      signer.sign(request(id, {spend: 0n, idempotencyKey: 'reused-key-001', data: different})),
      ErrorCode.IDEMPOTENCY_CONFLICT,
    );
    expect(state.broadcasts).toBe(1);
  });

  it('will not retry a failed broadcast under its key with a different call', async () => {
    const id = await anAgent();
    const signer = makeSigner();
    state.broadcastError = 'insufficient funds for gas';
    await signer.sign(request(id, {spend: 0n, idempotencyKey: 'failed-key-001'})).catch(() => undefined);
    delete state.broadcastError;

    const different = encodeFunctionData({abi: ESCROW_ABI, functionName: 'cancel', args: [9n]});
    await expectRefusal(
      signer.sign(request(id, {spend: 0n, idempotencyKey: 'failed-key-001', data: different})),
      ErrorCode.IDEMPOTENCY_CONFLICT,
    );
    expect(state.broadcasts).toBe(0);
  });

  it('still replays an exact retry', async () => {
    const id = await anAgent();
    const signer = makeSigner();
    const first = await signer.sign(request(id, {spend: 0n, idempotencyKey: 'exact-retry-01'}));
    const again = await signer.sign(request(id, {spend: 0n, idempotencyKey: 'exact-retry-01'}));
    expect(again).toMatchObject({txHash: first.txHash, replayed: true});
    expect(state.broadcasts).toBe(1);
  });
});

/**
 * Audit H3: any contract that answered AgentAccount's view functions was
 * treated as one. A wallet must now PROVE it is ours, by its code.
 */
describe('a wallet that only claims to be an AgentAccount', () => {
  const CONTRACT = ('0x' + 'ac'.repeat(20)) as Hex;

  async function contractAgent(): Promise<number> {
    const rows = (await db.execute(
      sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
          VALUES (31337, ${'0x' + '0f'.repeat(20)}, ${CONTRACT}, 'Impostor', 0) RETURNING id`,
    )) as unknown as {id: number}[];
    return rows[0]!.id;
  }

  beforeEach(() => {
    // It answers policy(), owner() and sessionKeys() exactly as an account
    // would, and trusts the key held here — everything but the code.
    state.sessionExpiry = {[ACCOUNT.address.toLowerCase()]: BigInt(Math.floor(Date.now() / 1000) + 3600)};
  });

  it('is refused, and nothing is sent from a held key into it', async () => {
    state.code = '0x6080604052348015600f57600080fd5b50' as Hex;
    const id = await contractAgent();
    const err = await expectRefusal(
      makeSigner().sign(request(id, {spend: 0n})),
      ErrorCode.AGENT_NOT_HIREABLE,
    );
    expect(err.message).toMatch(/not an AgentAccount/i);
    expect(state.broadcasts).toBe(0);
  });

  it('is refused when it is a clone of some other implementation', async () => {
    state.code = cloneCodeOf('0x' + '99'.repeat(20)) as Hex;
    const id = await contractAgent();
    await expectRefusal(makeSigner().sign(request(id, {spend: 0n})), ErrorCode.AGENT_NOT_HIREABLE);
    expect(state.broadcasts).toBe(0);
  });

  it('is accepted when it is an EOA delegated to AgentDelegate (EIP-7702)', async () => {
    const DELEGATE = ('0x' + 'de'.repeat(20)) as Hex;
    state.code = delegationOf(DELEGATE) as Hex;
    const id = await contractAgent();
    const chain = {contracts: {...baseConfig.chain(31337).contracts, AgentDelegate: DELEGATE}};
    await makeSigner({chain}).sign(request(id, {spend: 0n}));
    expect(state.lastTx!.to!.toLowerCase()).toBe(CONTRACT);
  });

  it('is refused when delegated to anything other than AgentDelegate', async () => {
    state.code = delegationOf('0x' + '66'.repeat(20)) as Hex;
    const id = await contractAgent();
    const chain = {contracts: {...baseConfig.chain(31337).contracts, AgentDelegate: '0x' + 'de'.repeat(20)}};
    await expectRefusal(makeSigner({chain}).sign(request(id, {spend: 0n})), ErrorCode.AGENT_NOT_HIREABLE);
    expect(state.broadcasts).toBe(0);
  });

  /**
   * Off testnet a held key signs only for the agent it is mapped to. Anyone
   * can deploy a real AgentAccount and "grant" our hot key a session in it —
   * and the signer would then pay that account's gas from our key.
   */
  it('off testnet, uses only the key mapped to this agent, not any key the account trusts', async () => {
    const id = await contractAgent();
    const keys = {accountFor: async () => null, all: () => [ACCOUNT]};
    await expectRefusal(
      makeSigner({keys, chain: {testnet: false}}).sign(request(id, {spend: 0n})),
      ErrorCode.AGENT_NOT_HIREABLE,
    );
    expect(state.broadcasts).toBe(0);
  });

  /** Monad charges the whole gas limit, so an estimate is not a limit by itself. */
  it('refuses a call whose gas estimate is beyond the ceiling, rather than paying it', async () => {
    const id = await anAgent();
    state.estimateGas = 30_000_000n;
    await expectRefusal(
      makeSigner({maxGas: 1_500_000n}).sign(request(id, {spend: 0n})),
      ErrorCode.INVALID_STATE,
    );
    expect(state.broadcasts).toBe(0);
  });
});

/**
 * Audit M2: the signer sent with `chain: null`, so viem asked the RPC which
 * chain it was on and signed for that. A testnet signer pointed at a mainnet
 * RPC signed mainnet transactions.
 */
describe('the chain the RPC serves', () => {
  it('refuses to sign when the RPC serves a different chain', async () => {
    const id = await anAgent();
    state.rpcChainId = 143;
    await expectRefusal(makeSigner().sign(request(id, {spend: 0n})), ErrorCode.CHAIN_MISMATCH);
    expect(state.broadcasts).toBe(0);
  });

  it('signs for the configured chain id', async () => {
    const id = await anAgent();
    await makeSigner().sign(request(id, {spend: 0n}));
    expect(state.lastChainId).toBe(31337);
  });
});

/**
 * Audit M3: for a plain-EOA agent nothing on chain limits the call, and the
 * signer signed any target with any declared spend — `USDC.transfer(attacker,
 * balance)` with `spend: 0` went straight through.
 */
describe('what an EOA agent may sign', () => {
  async function eoaAgent(perTaskCap = 100_000n, dailyCap = 1_000_000n): Promise<number> {
    const id = await anAgent();
    await db.execute(
      sql`INSERT INTO spend_policies (agent_id, per_task_cap, daily_cap)
          VALUES (${id}, ${perTaskCap.toString()}, ${dailyCap.toString()})`,
    );
    return id;
  }

  const spent = async (id: number) =>
    BigInt(
      (
        (await db.execute(sql`SELECT spent_today FROM spend_policies WHERE agent_id = ${id}`)) as unknown as {
          spent_today: string;
        }[]
      )[0]!.spent_today,
    );

  beforeEach(() => {
    state.eoa = true;
  });

  it('refuses a call to anything but the escrow', async () => {
    const id = await eoaAgent();
    const token = baseConfig.chain(31337).contracts['MockUSDC'] as Hex;
    const transfer = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'transfer',
          stateMutability: 'nonpayable',
          inputs: [
            {name: 'to', type: 'address'},
            {name: 'amount', type: 'uint256'},
          ],
          outputs: [{type: 'bool'}],
        },
      ],
      functionName: 'transfer',
      args: [('0x' + 'ee'.repeat(20)) as Hex, 10n ** 12n],
    });
    await expectRefusal(
      makeSigner().sign(request(id, {spend: 0n, target: token, data: transfer})),
      ErrorCode.FORBIDDEN,
    );
    expect(state.broadcasts).toBe(0);
  });

  it('refuses an escrow function the API never sends', async () => {
    const id = await eoaAgent();
    const data = encodeFunctionData({abi: ESCROW_ABI, functionName: 'resolveDispute', args: [1n, true]});
    await expectRefusal(makeSigner().sign(request(id, {spend: 0n, data})), ErrorCode.FORBIDDEN);
    expect(state.broadcasts).toBe(0);
  });

  it('refuses a hire that declares less than it spends', async () => {
    const id = await eoaAgent();
    await expectRefusal(
      makeSigner().sign(request(id, {spend: 0n, data: escrowCall(90_000n)})),
      ErrorCode.SCHEMA_MISMATCH,
    );
    expect(state.broadcasts).toBe(0);
    expect(await spent(id)).toBe(0n);
  });

  it('counts what the call spends against the cap', async () => {
    const id = await eoaAgent(50_000n);
    const direct = encodeFunctionData({
      abi: ESCROW_ABI,
      functionName: 'directPay',
      args: [1n, 2n, 40_000n, ZERO32],
    });
    await makeSigner().sign(request(id, {spend: 40_000n, data: direct}));
    expect(await spent(id)).toBe(40_000n);
  });

  it('counts a dispute’s bond, read from the chain', async () => {
    const id = await eoaAgent();
    state.disputeBond = 7_000n;
    const dispute = encodeFunctionData({abi: ESCROW_ABI, functionName: 'dispute', args: [3n, ZERO32]});
    await expectRefusal(
      makeSigner().sign(request(id, {spend: 0n, data: dispute})),
      ErrorCode.SCHEMA_MISMATCH,
    );
    await makeSigner().sign(request(id, {spend: 7_000n, data: dispute}));
    expect(await spent(id)).toBe(7_000n);
  });
});
