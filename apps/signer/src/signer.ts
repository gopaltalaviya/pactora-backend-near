import {and, eq, sql} from 'drizzle-orm';
import {z} from 'zod';
import type {ChainConfig} from '@pactora/config';
import {
  type Db,
  agents,
  jobs,
  signerTxs,
  signerWalletTxs,
  standingOf,
  withAdvisoryLock,
  type LockPool,
} from '@pactora/db';
import {
  TGAS,
  sha256Hex,
  signFunctionCallWith,
  type AccessKeyInfo,
  type NearClient,
  type TxKey,
  type TxOutcome,
} from '@pactora/near';
import {PactoraError, ErrorCode, canonicalize} from '@pactora/shared';
import type {KeySource} from './keystore.js';

/**
 * The signer: one process, one job, refuses everything else.
 *
 * Key material lives here and nowhere else — the API never touches it. Every
 * request is checked, deduplicated, nonce-ordered, and only then signed.
 *
 * On NEAR (docs/NEAR-WIRE.md §6) every call is a single function call to the
 * Pactora contract, signed with the agent wallet's FUNCTION-CALL key, 0
 * deposit, 100 Tgas, sent with `send_tx` and waited on until FINAL. The
 * checks here mirror what the contract enforces — its purse caps, its
 * balance — so the caller gets a useful error before any gas is spent; the
 * contract is still the authority, and if the two ever disagree the chain
 * refuses and the caller gets its error by name.
 */

/** The calls the API makes for an agent, and nothing else (NEAR-WIRE §6). */
export const ALLOWED_METHODS = [
  'create_job',
  'direct_pay',
  'accept_job',
  'submit_result',
  'approve',
  'dispute',
  'cancel',
  'accept_wallet',
] as const;
export type SignMethod = (typeof ALLOWED_METHODS)[number];

export interface SignRequest {
  agentId: number;
  chainId: string;
  method: string;
  /** The call's JSON arguments, by the contract's names. */
  args: unknown;
  /** The spend this call is expected to make, in token base units. */
  spend: bigint;
  /** Required. Agents retry, and a retried hire must not create a second job. */
  idempotencyKey: string;
}

export interface SignResult {
  /** base58 */
  txHash: string;
  nonce: number;
  /** True when this was a replay and the original transaction is being returned. */
  replayed: boolean;
  /** The call's JSON return value; the job id for `create_job` and `direct_pay`. */
  result: unknown;
}

export interface AcceptRequest {
  chainId: string;
  walletAddress: string;
  /** Decimal u64. */
  chainAgentId: string;
}

export interface AcceptResult {
  /** base58; '' when the wallet had already accepted and nothing was sent. */
  txHash: string;
  alreadyAccepted: boolean;
}

type Logger = {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
};

export interface SignerDeps {
  db: Db;
  /**
   * A pool used ONLY for the per-wallet advisory lock. Separate from `db`,
   * because the signing work inside the lock queries `db` too — sharing one
   * pool lets concurrent holders exhaust it and wait on each other.
   */
  locks: LockPool;
  chain: ChainConfig;
  keys: KeySource;
  near: NearClient;
  /** Refuse to sign when the wallet holds less NEAR than this. */
  gasFloorYocto?: bigint;
  /** Refuse to sign when the key's remaining allowance is below this. */
  allowanceFloorYocto?: bigint;
  logger?: Logger;
}

/** Every call: 100 Tgas (NEAR-WIRE §6). */
export const GAS = 100n * TGAS;

const NEAR = 10n ** 24n;

/**
 * A call prepays its gas: 100 Tgas × the gas price. Testnet's gas price on
 * 2026-11-05 was 10^8 yocto/gas (RPC `gas_price`) with a pessimistic
 * inflation ratio of 1 (`EXPERIMENTAL_protocol_config`), so one call costs
 * at most 10^22 yocto = 0.01 NEAR, and unused gas is refunded. 0.05 NEAR
 * leaves room for five such calls, and some for the account's own storage
 * stake, before the signer starts refusing instead of sending something the
 * node would reject.
 */
export const DEFAULT_GAS_FLOOR_YOCTO = (5n * NEAR) / 100n;

/**
 * A function-call key pays gas out of its allowance, and a transaction
 * whose prepaid gas exceeds what is left is rejected (`NotEnoughAllowance`).
 * One 100 Tgas call at the price above is 0.01 NEAR.
 */
export const DEFAULT_ALLOWANCE_FLOOR_YOCTO = NEAR / 100n;

const DAY_SECONDS = 24 * 60 * 60;

// ── argument shapes (the contract's JSON) ────────────────────────────────

/** u64: a JSON number on the wire, as near-sdk deserialises it. Accepts a decimal string. */
const U64 = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d{1,16}$/, 'must be a decimal u64')])
  .transform(Number)
  .refine(Number.isSafeInteger, 'too large for an id');
/** U128: a decimal string on the wire. */
const U128 = z
  .union([z.string().regex(/^\d{1,39}$/, 'must be a decimal amount'), z.number().int().nonnegative()])
  .transform((v) => BigInt(v))
  .refine((v) => v < 2n ** 128n, 'exceeds u128')
  .transform((v) => v.toString());
/** What the contract's `check_hash` accepts. */
const Hash = z.string().regex(/^[0-9a-f]{64}$/, 'must be sha256 as 64 lowercase hex, no 0x');
const OptionalHash = Hash.nullable()
  .optional()
  .transform((v) => v ?? null);

const ARGS: Record<SignMethod, z.ZodType<Record<string, unknown>>> = {
  create_job: z
    .object({
      client_id: U64,
      worker_id: U64,
      amount: U128,
      spec_hash: Hash,
      accept_window: U64,
      work_window: U64,
    })
    .strict(),
  direct_pay: z.object({client_id: U64, worker_id: U64, amount: U128, spec_hash: Hash}).strict(),
  accept_job: z.object({job_id: U64}).strict(),
  submit_result: z.object({job_id: U64, result_hash: Hash}).strict(),
  approve: z.object({job_id: U64, review_hash: OptionalHash}).strict(),
  dispute: z.object({job_id: U64, reason_hash: OptionalHash}).strict(),
  cancel: z.object({job_id: U64}).strict(),
  accept_wallet: z.object({agent_id: U64}).strict(),
};

/** The contract's `PurseView`. */
interface PurseView {
  balance: string;
  per_task_cap: string;
  daily_cap: string;
  spent_today: string;
  daily_remaining: string;
  next_release_at: number;
}

/** The parts of the contract's `Job` the signer reads. */
interface JobView {
  client: number;
  worker: number;
  amount: string;
  state: string;
  dispute_bond: string;
}

interface AgentView {
  id: number;
  owner: string;
  wallet: string | null;
  pending_wallet: string | null;
  frozen: boolean;
}

/** Where one transaction's progress is written: `signer_txs` or `signer_wallet_txs`. */
interface Ledger {
  signed(txHash: string): Promise<void>;
  final(result: unknown): Promise<void>;
  reverted(failure: string): Promise<void>;
  /** Never reached the chain: the nonce was not used. */
  unsent(): Promise<void>;
}

export class SignerService {
  private readonly log: Logger;
  private readonly gasFloor: bigint;
  private readonly allowanceFloor: bigint;

  constructor(private readonly deps: SignerDeps) {
    this.log = deps.logger ?? {info: () => {}, warn: () => {}, error: () => {}};
    this.gasFloor = deps.gasFloorYocto ?? DEFAULT_GAS_FLOOR_YOCTO;
    this.allowanceFloor = deps.allowanceFloorYocto ?? DEFAULT_ALLOWANCE_FLOOR_YOCTO;
  }

  private get pactora(): string {
    return this.deps.chain.contracts.Pactora;
  }

  async sign(req: SignRequest): Promise<SignResult> {
    const {db, chain, keys} = this.deps;

    if (req.chainId !== chain.chainId) {
      throw new PactoraError(
        ErrorCode.CHAIN_MISMATCH,
        `signer serves chain ${chain.chainId}, request was for ${req.chainId}`,
      );
    }
    if (!(ALLOWED_METHODS as readonly string[]).includes(req.method)) {
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        `"${req.method}" is not a call this signer makes for an agent (${ALLOWED_METHODS.join(', ')})`,
      );
    }
    const method = req.method as SignMethod;
    const parsed = ARGS[method].safeParse(req.args ?? {});
    if (!parsed.success) {
      throw new PactoraError(
        ErrorCode.SCHEMA_MISMATCH,
        `${method} args: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}`,
      );
    }
    const args = parsed.data;

    // docs/26 F14: no payout is signed for a worker on hold or blocked. A
    // soft gate: the contract's permissionless auto_approve still pays.
    if (method === 'approve') await this.refuseHeldPayout(chain.chainId, (args as {job_id: number}).job_id);

    // What this key is being used FOR. A replay must be the same call by the
    // same agent; anything else under the key is a conflict, never a replay.
    const payloadHash = payloadHashOf({method, args, spend: req.spend});

    // 1. Replay first — cheapest, and a final answer is already final.
    const existing = await this.findKey(req);
    if (existing) {
      assertSamePayload(existing, payloadHash);
      const settled = settledReplay(existing);
      if (settled) {
        this.log.info({idempotencyKey: req.idempotencyKey, txHash: existing.txHash}, 'replay');
        return settled;
      }
    }

    // 2. The agent, its on-chain id, its wallet, and the key held for it.
    const agent = await this.loadAgent(req.agentId);
    const wallet = agent.walletAddress;
    const chainAgentId = agent.chainAgentId === null ? null : Number(agent.chainAgentId);
    const own = (field: string) => {
      if (chainAgentId === null) {
        throw new PactoraError(
          ErrorCode.AGENT_NOT_HIREABLE,
          `agent ${req.agentId} has no on-chain id yet — it cannot act on chain`,
        );
      }
      if (args[field] !== chainAgentId) {
        throw new PactoraError(
          ErrorCode.FORBIDDEN,
          `${method}.${field} is ${String(args[field])}, but agent ${req.agentId} is on-chain agent ${chainAgentId}`,
        );
      }
    };
    if (method === 'create_job' || method === 'direct_pay') own('client_id');
    if (method === 'accept_wallet') own('agent_id');

    const key = await keys.keyFor(wallet);
    if (!key) {
      throw new PactoraError(
        ErrorCode.AGENT_NOT_HIREABLE,
        `no signing key held for agent ${req.agentId}'s wallet ${wallet} — create one with POST /keys`,
      );
    }

    // 3. Everything that reads a nonce or a balance happens under the wallet's lock.
    return this.withWalletLock(wallet, async () => {
      // Re-read under the lock: another holder may have finished this key.
      const row = await this.findKey(req);
      if (row) assertSamePayload(row, payloadHash);
      const settled = row && settledReplay(row);
      if (settled) return settled;

      let reuseNonce: number | null = null;
      if (row?.status === 'signed' && row.txHash) {
        const resolved = await this.resolveUncertain(row.txHash, row.nonce, wallet, key, {
          final: async (result) => {
            await db.update(signerTxs).set({status: 'final', result}).where(eq(signerTxs.id, row.id));
            return {txHash: row.txHash!, nonce: row.nonce, replayed: true, result};
          },
          reverted: async (failure) => {
            await db.update(signerTxs).set({status: 'reverted', failure}).where(eq(signerTxs.id, row.id));
          },
        });
        if (resolved.done) return resolved.done;
        reuseNonce = resolved.reuseNonce;
      }

      const access = await this.checkKey(wallet, key, method);
      await this.checkGas(wallet, req.agentId);
      const block = await this.deps.near.finalBlock();

      // 4. What the call spends, read from the arguments and the chain — not
      //    taken on trust from the request — and whether the purse allows it.
      const spend = await this.spendOf(method, args, chainAgentId);
      if (req.spend < spend) {
        throw new PactoraError(
          ErrorCode.SCHEMA_MISMATCH,
          `the call spends ${chain.formatToken(spend)}, but the request declared ${chain.formatToken(req.spend)}`,
        );
      }
      if (spend > 0n) await this.checkPurse(chainAgentId!, spend, block.timestampNs);

      const nonce = reuseNonce ?? (await this.nextNonce(wallet, access.nonce));

      // 5. Claim the slot BEFORE signing. If we crash after this, the row is
      //    'pending' with no hash: provably never sent, safely retried.
      let slotId: number;
      if (row) {
        await db
          .update(signerTxs)
          .set({status: 'pending', nonce, txHash: null, failure: null})
          .where(eq(signerTxs.id, row.id));
        slotId = row.id;
        this.log.warn({agentId: req.agentId, nonce, previous: row.txHash}, 'retrying an unfinished request');
      } else {
        const [claimed] = await db
          .insert(signerTxs)
          .values({
            chainId: chain.chainId,
            agentId: req.agentId,
            idempotencyKey: req.idempotencyKey,
            payloadHash,
            nonce,
            status: 'pending',
          })
          .onConflictDoNothing()
          .returning({id: signerTxs.id});
        // Under the lock, a conflict means the same key arrived for another
        // wallet's lock (the agent's wallet changed mid-flight). Refuse.
        if (!claimed) {
          throw new PactoraError(ErrorCode.IDEMPOTENCY_CONFLICT, 'a request with this key is in flight');
        }
        slotId = claimed.id;
      }

      const ledger: Ledger = {
        signed: async (txHash) => {
          await db.update(signerTxs).set({txHash, status: 'signed'}).where(eq(signerTxs.id, slotId));
        },
        final: async (result) => {
          await db
            .update(signerTxs)
            .set({status: 'final', result: result ?? null})
            .where(eq(signerTxs.id, slotId));
        },
        reverted: async (failure) => {
          await db.update(signerTxs).set({status: 'reverted', failure}).where(eq(signerTxs.id, slotId));
        },
        unsent: async () => {
          await db.update(signerTxs).set({status: 'failed', txHash: null}).where(eq(signerTxs.id, slotId));
        },
      };

      const sent = await this.send({wallet, key, nonce, blockHash: block.hash, method, args, ledger});
      this.log.info({agentId: req.agentId, method, nonce, txHash: sent.txHash}, 'signed, final');
      return {txHash: sent.txHash, nonce, replayed: false, result: sent.result};
    });
  }

  /**
   * `accept_wallet` for a wallet whose agent row does not exist yet: during
   * registration the wallet must accept BEFORE the API inserts the agent
   * (NEAR-WIRE §5 (d)), so there is no agent id to key `/sign` on.
   *
   * Idempotent through the chain itself: an already-accepted wallet answers
   * `alreadyAccepted` and nothing is sent. Its transactions are recorded in
   * `signer_wallet_txs` so the wallet's nonce discipline sees them.
   */
  async acceptWallet(req: AcceptRequest): Promise<AcceptResult> {
    const {db, chain, keys, near} = this.deps;
    if (req.chainId !== chain.chainId) {
      throw new PactoraError(
        ErrorCode.CHAIN_MISMATCH,
        `signer serves chain ${chain.chainId}, request was for ${req.chainId}`,
      );
    }
    const agentId = Number(req.chainAgentId);
    if (!/^\d{1,16}$/.test(req.chainAgentId) || !Number.isSafeInteger(agentId)) {
      throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, 'chainAgentId must be a decimal u64');
    }
    const wallet = req.walletAddress;
    const key = await keys.keyFor(wallet);
    if (!key) {
      throw new PactoraError(
        ErrorCode.NOT_FOUND,
        `this signer holds no key for ${wallet} — create one with POST /keys first`,
      );
    }

    const decide = async (): Promise<AcceptResult | null> => {
      const agent = await this.view<AgentView | null>('get_agent', {agent_id: agentId});
      if (!agent) throw new PactoraError(ErrorCode.NOT_FOUND, `no agent ${agentId} on ${this.pactora}`);
      if (agent.wallet === wallet) return {txHash: '', alreadyAccepted: true};
      if (agent.pending_wallet !== wallet) {
        throw new PactoraError(
          ErrorCode.INVALID_STATE,
          `agent ${agentId}'s pending wallet is ${agent.pending_wallet ?? 'none'}, not ${wallet} ` +
            `(its wallet is ${agent.wallet ?? 'none'}) — the owner must propose ${wallet} first`,
        );
      }
      return null;
    };

    const early = await decide();
    if (early) return early;

    return this.withWalletLock(wallet, async () => {
      // Again under the lock: a concurrent accept may have just landed.
      const now = await decide();
      if (now) return now;

      const access = await this.checkKey(wallet, key, 'accept_wallet');
      await this.checkGas(wallet, null);
      const block = await near.finalBlock();
      const nonce = await this.nextNonce(wallet, access.nonce);

      const [row] = await db
        .insert(signerWalletTxs)
        .values({
          chainId: chain.chainId,
          walletAddress: wallet,
          method: 'accept_wallet',
          chainAgentId: String(agentId),
          nonce,
          status: 'pending',
        })
        .returning({id: signerWalletTxs.id});
      const id = row!.id;
      const set = (v: Partial<typeof signerWalletTxs.$inferInsert>) =>
        db.update(signerWalletTxs).set(v).where(eq(signerWalletTxs.id, id));

      try {
        const sent = await this.send({
          wallet,
          key,
          nonce,
          blockHash: block.hash,
          method: 'accept_wallet',
          args: {agent_id: agentId},
          ledger: {
            signed: async (txHash) => void (await set({txHash, status: 'signed'})),
            final: async () => void (await set({status: 'final'})),
            reverted: async (failure) => void (await set({status: 'reverted', failure})),
            unsent: async () => void (await set({status: 'failed', txHash: null})),
          },
        });
        this.log.info({wallet, agentId, txHash: sent.txHash}, 'wallet accepted');
        return {txHash: sent.txHash, alreadyAccepted: false};
      } catch (err) {
        // An earlier accept whose outcome we never saw may have landed first,
        // and this one then fails NotPendingWallet: the goal is reached.
        const after = await this.view<AgentView | null>('get_agent', {agent_id: agentId}).catch(() => null);
        if (after?.wallet === wallet) return {txHash: '', alreadyAccepted: true};
        throw err;
      }
    });
  }

  // ── the checks ─────────────────────────────────────────────────────────

  /**
   * The key must be on chain, and must be a function-call key for the
   * Pactora contract. Asked of the chain on every call, never cached: a
   * deleted key must stop working on the next request.
   *
   * A FULL-ACCESS key is refused even though it would work: it can move the
   * account's NEAR, deploy code, add keys — it is an owner's key, and the
   * signer must never hold one. A key for another receiver is refused
   * because every call this signer makes goes to Pactora; the node would
   * reject it anyway, after a round trip.
   */
  private async checkKey(wallet: string, key: TxKey, method: string): Promise<AccessKeyInfo> {
    const access = await this.deps.near.accessKey(wallet, key.publicKey);
    if (!access) {
      throw new PactoraError(
        ErrorCode.AGENT_NOT_HIREABLE,
        `${wallet} has no access key ${key.publicKey} — its owner must add it (AddKey, FunctionCall for ${this.pactora})`,
      );
    }
    const p = access.permission;
    if (p === 'FullAccess') {
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        `the key held for ${wallet} is a FULL-ACCESS key — the signer only signs with a function-call key ` +
          `scoped to ${this.pactora}; the owner must replace it`,
      );
    }
    const fc = p.FunctionCall;
    if (fc.receiver_id !== this.pactora) {
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        `the key held for ${wallet} may call ${fc.receiver_id}, not ${this.pactora}`,
      );
    }
    if (fc.allowance !== null && BigInt(fc.allowance) < this.allowanceFloor) {
      throw new PactoraError(
        ErrorCode.INSUFFICIENT_FUNDS,
        `the key held for ${wallet} has ${fc.allowance} yocto of gas allowance left, below ${this.allowanceFloor} — ` +
          'the owner must add a new key',
      );
    }
    // An empty list means every method of the receiver (NEAR-WIRE §5 adds it so).
    if (fc.method_names.length > 0 && !fc.method_names.includes(method)) {
      throw new PactoraError(ErrorCode.FORBIDDEN, `the key held for ${wallet} may not call ${method}`);
    }
    return access;
  }

  private async checkGas(wallet: string, agentId: number | null): Promise<void> {
    const balance = await this.deps.near.balance(wallet);
    if (balance === null) {
      throw new PactoraError(ErrorCode.AGENT_NOT_HIREABLE, `the wallet account ${wallet} does not exist`);
    }
    if (balance < this.gasFloor) {
      throw new PactoraError(
        ErrorCode.INSUFFICIENT_FUNDS,
        `${agentId === null ? '' : `agent ${agentId}'s `}wallet ${wallet} has ${balance} yocto, below the ` +
          `${this.gasFloor} gas floor — top it up with NEAR`,
      );
    }
  }

  /** What the call takes from the client's purse: the amount for a hire, the job's bond for a dispute. */
  private async spendOf(
    method: SignMethod,
    args: Record<string, unknown>,
    chainAgentId: number | null,
  ): Promise<bigint> {
    if (method === 'create_job' || method === 'direct_pay') return BigInt(args['amount'] as string);
    if (method !== 'dispute') return 0n;
    // The contract spends `job.dispute_bond` — fixed when the job was created
    // (`dispute_bond_of(amount)` with the params of that moment), so reading
    // it back is exact even if `set_params` changed the bond rule since.
    const job = await this.view<JobView | null>('get_job', {job_id: args['job_id']});
    if (!job)
      throw new PactoraError(ErrorCode.NOT_FOUND, `no job ${String(args['job_id'])} on ${this.pactora}`);
    if (chainAgentId === null || job.client !== chainAgentId) {
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        `job ${String(args['job_id'])}'s client is agent ${job.client}, not this agent`,
      );
    }
    return BigInt(job.dispute_bond);
  }

  /**
   * The purse rules, in the contract's order (`spend`, then `budget::charge`):
   * balance, per-task cap, rolling daily cap. Read under the wallet lock and
   * after the previous call from this wallet is FINAL, so the view already
   * counts it. There is no off-chain reservation in `spend_policies`: the
   * contract bounds every wallet, and a second, off-chain copy of the caps
   * could only disagree with it.
   */
  private async checkPurse(chainAgentId: number, spend: bigint, nowNs: bigint): Promise<void> {
    const {chain} = this.deps;
    const purse = await this.view<PurseView | null>('purse_of', {agent_id: chainAgentId});
    if (!purse) throw new PactoraError(ErrorCode.AGENT_NOT_HIREABLE, `agent ${chainAgentId} has no purse`);
    const balance = BigInt(purse.balance);
    if (spend > balance) {
      throw new PactoraError(
        ErrorCode.INSUFFICIENT_FUNDS,
        `spend ${chain.formatToken(spend)} exceeds the agent's balance of ${chain.formatToken(balance)} — fund it`,
      );
    }
    const perTask = BigInt(purse.per_task_cap);
    if (spend > perTask) {
      throw new PactoraError(
        ErrorCode.BUDGET_EXCEEDED,
        `spend ${chain.formatToken(spend)} exceeds the per-task cap of ${chain.formatToken(perTask)}`,
      );
    }
    const remaining = BigInt(purse.daily_remaining);
    if (spend > remaining) {
      // The cap rolls: nothing "resets". next_release_at is when the oldest
      // counted spend leaves the window — the earliest anything changes.
      const now = Number(nowNs / 1_000_000_000n);
      const retry = purse.next_release_at > 0 ? Math.max(1, purse.next_release_at - now) : DAY_SECONDS;
      throw new PactoraError(
        ErrorCode.BUDGET_EXCEEDED,
        `spend ${chain.formatToken(spend)} exceeds today's remaining budget of ${chain.formatToken(remaining)}`,
        retry,
      );
    }
  }

  // ── nonce, send, outcome ───────────────────────────────────────────────

  /**
   * The access key's nonce + 1 — or past the highest nonce this signer has
   * already claimed for the wallet, if that is higher: a claimed nonce whose
   * transaction the node has not seen yet must never be handed out twice.
   * NEAR accepts any nonce above the key's, so a gap left by a request that
   * was never sent costs nothing.
   */
  private async nextNonce(wallet: string, chainNonce: bigint): Promise<number> {
    const {db, chain} = this.deps;
    const rows = (await db.execute(sql`
      SELECT GREATEST(
        (SELECT max(t.nonce) FROM signer_txs t JOIN agents a ON a.id = t.agent_id
          WHERE t.chain_id = ${chain.chainId} AND a.wallet_address = ${wallet}),
        (SELECT max(nonce) FROM signer_wallet_txs WHERE chain_id = ${chain.chainId} AND wallet_address = ${wallet})
      )::text AS last
    `)) as unknown as {last: string | null}[];
    const last = rows[0]?.last ? BigInt(rows[0].last) : 0n;
    const next = (chainNonce > last ? chainNonce : last) + 1n;
    if (next > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`nonce ${next} exceeds 2^53`);
    return Number(next);
  }

  /**
   * Sign, record the hash, broadcast, wait for FINAL, record the outcome.
   *
   * The hash is known before broadcast and written first, so a crash or a
   * timeout after this point leaves a row that says exactly which
   * transaction to look for (`resolveUncertain`).
   */
  private async send(opts: {
    wallet: string;
    key: TxKey;
    nonce: number;
    blockHash: string;
    method: string;
    args: Record<string, unknown>;
    ledger: Ledger;
  }): Promise<{txHash: string; result: unknown}> {
    const {near} = this.deps;
    const {ledger, wallet} = opts;

    let signed;
    try {
      signed = await signFunctionCallWith({
        signerId: wallet,
        key: opts.key,
        receiverId: this.pactora,
        nonce: BigInt(opts.nonce),
        blockHash: opts.blockHash,
        method: opts.method,
        args: opts.args,
        gas: GAS,
        deposit: 0n,
      });
    } catch (err) {
      await ledger.unsent();
      throw err;
    }
    await ledger.signed(signed.hash);

    let outcome: TxOutcome;
    try {
      outcome = await near.sendSigned(signed);
    } catch (err) {
      // Whatever the node said, the one fact that settles it is whether the
      // chain holds this transaction. Ask by hash first (idempotent), then
      // read the key's nonce: a nonce at or past ours means a transaction
      // with it executed — ours, or one that makes ours impossible.
      outcome = await near.txOutcome(signed.hash, wallet).catch(() => ({
        status: 'pending' as const,
        txHash: signed.hash,
        receipts: [],
      }));
      const name = errorName(err);
      if (outcome.status === 'pending' && REJECTED.has(name)) {
        // The node refused the transaction. Audit H1: that is NOT proof it
        // never executed — a broadcast whose answer was lost and re-sent is
        // refused as InvalidNonce by the node that already included it. Only
        // a key whose nonce is still below ours says the slot is unused.
        const used = await this.nonceUsed(wallet, opts.key, opts.nonce);
        if (used === false) {
          await ledger
            .unsent()
            .catch((e: unknown) => this.log.error({err: e}, 'could not mark a rejected tx'));
          this.log.warn({wallet, txHash: signed.hash, rejected: name}, 'transaction rejected by the node');
          throw rejectedError(name, wallet);
        }
        this.log.warn(
          {wallet, txHash: signed.hash, rejected: name, nonce: opts.nonce},
          used === null
            ? 'rejected by the node, but the key could not be read: outcome unknown'
            : 'rejected by the node, but its nonce is used: outcome unknown',
        );
        throw uncertainError(signed.hash);
      }
      if (outcome.status === 'pending') {
        // Timed out, or the RPC failed: it may or may not have landed.
        this.log.warn(
          {wallet, txHash: signed.hash, error: (err as Error).message?.slice(0, 500)},
          'broadcast outcome unknown',
        );
        throw uncertainError(signed.hash);
      }
    }

    if (outcome.status === 'success') {
      await ledger.final(outcome.returnValue ?? null);
      return {txHash: signed.hash, result: outcome.returnValue ?? null};
    }
    if (outcome.status === 'failure') {
      const failure = outcome.failure ?? 'unknown failure';
      await ledger.reverted(failure);
      this.log.warn(
        {wallet, txHash: signed.hash, failure: failure.slice(0, 1000)},
        'transaction failed on chain',
      );
      throw refusalOf(failure, signed.hash);
    }
    throw uncertainError(signed.hash);
  }

  /**
   * A transaction that was signed and maybe broadcast, whose outcome was never
   * seen. Ask the chain: final or failed settles it. Still unknown and the
   * key's nonce has not reached it → it never landed (yet); re-sign on the
   * SAME nonce, so at most one of the two can ever execute. Unknown but the
   * nonce is used → the node has not caught up; say so and keep the row.
   */
  private async resolveUncertain(
    txHash: string,
    nonce: number,
    wallet: string,
    key: TxKey,
    on: {final: (result: unknown) => Promise<SignResult>; reverted: (failure: string) => Promise<void>},
  ): Promise<{done: SignResult; reuseNonce?: never} | {done?: never; reuseNonce: number}> {
    const outcome = await this.deps.near.txOutcome(txHash, wallet);
    if (outcome.status === 'success') return {done: await on.final(outcome.returnValue ?? null)};
    if (outcome.status === 'failure') {
      await on.reverted(outcome.failure ?? 'unknown failure');
      throw refusalOf(outcome.failure ?? '', txHash);
    }
    const used = await this.nonceUsed(wallet, key, nonce);
    if (used !== false) throw uncertainError(txHash);
    return {reuseNonce: nonce};
  }

  /**
   * Whether the key's nonce on chain has reached `nonce`: true when a
   * transaction with it (or a later one) executed, false when the slot is
   * still free, null when the key could not be read — which is never taken
   * as "free".
   */
  private async nonceUsed(wallet: string, key: TxKey, nonce: number): Promise<boolean | null> {
    try {
      const access = await this.deps.near.accessKey(wallet, key.publicKey);
      return access !== null && access.nonce >= BigInt(nonce);
    } catch {
      return null;
    }
  }

  // ── plumbing ───────────────────────────────────────────────────────────

  private async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    try {
      return await this.deps.near.view<T>(this.pactora, method, args);
    } catch (err) {
      this.log.warn({method, error: (err as Error).message?.slice(0, 500)}, 'view failed');
      throw new PactoraError(
        ErrorCode.UPSTREAM_UNAVAILABLE,
        `could not read ${method} from ${this.pactora} — nothing was sent; retry shortly`,
        5,
      );
    }
  }

  /** This agent's use of this key, if any. A key belongs to the agent that used it. */
  /** The job's worker is on hold or blocked (docs/26 F14): refuse to sign its payout. */
  private async refuseHeldPayout(chainId: string, chainJobId: number): Promise<void> {
    const job = await this.deps.db.query.jobs.findFirst({
      where: and(eq(jobs.chainId, chainId), eq(jobs.chainJobId, String(chainJobId))),
    });
    if (!job) return; // a job the API does not know: the contract decides.
    const standing = await standingOf(this.deps.db, job.workerAgentId);
    if (standing !== 'clear') {
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        `the worker's payout is held (${standing}) while a compliance review is open or after it confirmed a match`,
      );
    }
  }

  private async findKey(req: SignRequest) {
    return this.deps.db.query.signerTxs.findFirst({
      where: and(
        eq(signerTxs.chainId, this.deps.chain.chainId),
        eq(signerTxs.agentId, req.agentId),
        eq(signerTxs.idempotencyKey, req.idempotencyKey),
      ),
    });
  }

  /** The agent row, or an actionable error naming the chain it is not on. */
  private async loadAgent(agentId: number) {
    const {db, chain} = this.deps;
    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.chainId, chain.chainId)),
    });
    if (!agent) {
      throw new PactoraError(ErrorCode.CHAIN_MISMATCH, `agent ${agentId} is not on chain ${chain.chainId}`);
    }
    return agent;
  }

  /**
   * Serialise per wallet account using a Postgres advisory lock — the unit a
   * nonce belongs to. One agent has one wallet, so this is a per-agent lock;
   * keying it on the wallet also covers `acceptWallet`,
   * which runs before there is an agent row. A database lock holds across
   * process restarts and replicas; an in-process mutex would not.
   */
  private async withWalletLock<T>(wallet: string, fn: () => Promise<T>): Promise<T> {
    return withAdvisoryLock(this.deps.locks, walletLockKey(this.deps.chain.chainId, wallet), fn);
  }
}

/** A signed 64-bit lock key for (chain, wallet): the first 8 bytes of a sha256. */
export function walletLockKey(chainId: string, wallet: string): bigint {
  return BigInt.asIntN(64, BigInt(`0x${sha256Hex(`pactora-signer|${chainId}|${wallet}`).slice(0, 16)}`));
}

/** sha256 of the canonical {method, args, spend}: the call an idempotency key was first used for. */
export function payloadHashOf(p: {method: string; args: Record<string, unknown>; spend: bigint}): string {
  return sha256Hex(canonicalize({method: p.method, args: p.args, spend: p.spend.toString()}));
}

/**
 * A key reused for a different call is a conflict, never a replay of the
 * first. A row from before payload hashes were stored never replays either.
 */
function assertSamePayload(row: {payloadHash: string | null}, payloadHash: string): void {
  if (row.payloadHash !== payloadHash) {
    throw new PactoraError(
      ErrorCode.IDEMPOTENCY_CONFLICT,
      'this idempotency key was already used for a different call — a new request needs a new key',
    );
  }
}

/** A row whose answer is already known: final → the original result; reverted → the original error. */
function settledReplay(row: {
  status: string;
  txHash: string | null;
  nonce: number;
  result: unknown;
  failure: string | null;
}): SignResult | null {
  if (row.status === 'final' && row.txHash) {
    return {txHash: row.txHash, nonce: row.nonce, replayed: true, result: row.result ?? null};
  }
  if (row.status === 'reverted' && row.txHash) throw refusalOf(row.failure ?? '', row.txHash);
  return null;
}

// ── what a failure is reported as ────────────────────────────────────────

/**
 * Contract panic names (pactora-contracts-near `errors.rs`) → the codes the
 * API and agents already branch on. A name not listed is INVALID_STATE, with
 * the name in the detail.
 */
export const PANIC_CODES: Record<string, ErrorCode> = {
  PerTaskCapExceeded: ErrorCode.BUDGET_EXCEEDED,
  DailyCapExceeded: ErrorCode.BUDGET_EXCEEDED,
  InsufficientBalance: ErrorCode.INSUFFICIENT_FUNDS,
  InsufficientBond: ErrorCode.INSUFFICIENT_FUNDS,
  InsufficientStorage: ErrorCode.INSUFFICIENT_FUNDS,
  NotHireable: ErrorCode.AGENT_NOT_HIREABLE,
  AgentFrozen: ErrorCode.AGENT_NOT_HIREABLE,
  SameOwner: ErrorCode.AGENT_NOT_HIREABLE,
  SelfDealing: ErrorCode.AGENT_NOT_HIREABLE,
  DeadlinePassed: ErrorCode.DEADLINE_PASSED,
  NoSuchJob: ErrorCode.NOT_FOUND,
  NoSuchAgent: ErrorCode.NOT_FOUND,
  NotAgentWallet: ErrorCode.FORBIDDEN,
  NotAgentOwner: ErrorCode.FORBIDDEN,
  NotPendingWallet: ErrorCode.FORBIDDEN,
  BadHash: ErrorCode.SCHEMA_MISMATCH,
  ZeroAmount: ErrorCode.SCHEMA_MISMATCH,
  AmountBelowMinimum: ErrorCode.SCHEMA_MISMATCH,
  AmountAboveMaximum: ErrorCode.SCHEMA_MISMATCH,
  AmountTooLargeForFastPath: ErrorCode.SCHEMA_MISMATCH,
  WindowTooLong: ErrorCode.SCHEMA_MISMATCH,
  InvalidState: ErrorCode.INVALID_STATE,
  DeadlineNotPassed: ErrorCode.INVALID_STATE,
  Paused: ErrorCode.INVALID_STATE,
  WalletTaken: ErrorCode.INVALID_STATE,
  NotEnoughGas: ErrorCode.INVALID_STATE,
};

/** An on-chain failure (the outcome's `Failure`, as JSON) as an actionable error. */
export function refusalOf(failure: string, txHash: string): PactoraError {
  // near-sdk's `require!`/`panic_str` surface as
  // FunctionCallError.ExecutionError "Smart contract panicked: <name>".
  const panic = /Smart contract panicked: ([A-Za-z]+)/.exec(failure)?.[1];
  if (panic) {
    return new PactoraError(
      PANIC_CODES[panic] ?? ErrorCode.INVALID_STATE,
      `the contract refused: ${panic} (transaction ${txHash}, nothing changed)`,
    );
  }
  if (/LackBalanceForState|NotEnoughBalance|NotEnoughAllowance/.test(failure)) {
    return new PactoraError(
      ErrorCode.INSUFFICIENT_FUNDS,
      `the wallet could not pay for the call (transaction ${txHash}) — top it up`,
    );
  }
  return new PactoraError(
    ErrorCode.INVALID_STATE,
    `the transaction ${txHash} failed on chain: ${failure.slice(0, 300)}`,
  );
}

/**
 * near-api-js error class names for a transaction the node REJECTED
 * (`INVALID_TRANSACTION`): never included, so its nonce is unused.
 */
const REJECTED = new Set([
  'InvalidNonceError',
  'NonceTooLargeError',
  'NotEnoughBalanceError',
  'NotEnoughBalanceForDepositError',
  'LackBalanceForStateActionError',
  'InvalidSignatureError',
  'InvalidSignerIdError',
  'InvalidReceiverIdError',
  'SignerDoesNotExistError',
  'TransactionExpiredError',
  'InvalidChainError',
  'ShardCongestedError',
  'ShardStuckError',
  'CostOverflowError',
  'TransactionSizeExceededError',
  'AccessKeyNotFoundActionError',
  'AccessKeyReceiverMismatchActionError',
  'AccessKeyMethodNameMismatchActionError',
  'AccessKeyNotEnoughAllowanceActionError',
  'AccessKeyRequiresFullAccessActionError',
  'AccessKeyDepositWithFunctionCallActionError',
]);

function errorName(err: unknown): string {
  return (err as {name?: string})?.name ?? (err as object)?.constructor?.name ?? '';
}

function rejectedError(name: string, wallet: string): PactoraError {
  if (/Balance|Allowance/.test(name)) {
    return new PactoraError(
      ErrorCode.INSUFFICIENT_FUNDS,
      `the node rejected the transaction (${name}): ${wallet} cannot pay for it — top it up, then retry the same request`,
    );
  }
  if (/^AccessKey/.test(name)) {
    return new PactoraError(ErrorCode.FORBIDDEN, `the node rejected the transaction: ${name}`);
  }
  return new PactoraError(
    ErrorCode.UPSTREAM_UNAVAILABLE,
    `the node rejected the transaction (${name}); nothing was executed — retrying the same request is safe`,
    2,
  );
}

function uncertainError(txHash: string): PactoraError {
  return new PactoraError(
    ErrorCode.UPSTREAM_UNAVAILABLE,
    `transaction ${txHash} was sent but its outcome is not known yet — retry the same request ` +
      '(same idempotency key): it returns this transaction, never a second one',
    5,
  );
}
