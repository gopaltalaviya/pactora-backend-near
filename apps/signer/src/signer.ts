import {
  BaseError,
  HttpRequestError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  http,
  keccak256,
  type Abi,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import {and, eq, gte, isNull, sql} from 'drizzle-orm';
import type {ChainConfig} from '@pactora/config';
import {type Db, signerTxs, agents, withAdvisoryLock, type LockPool} from '@pactora/db';
import {PactoraError, ErrorCode} from '@pactora/shared';
import type {KeySource} from './keystore.js';
import {viemChainOf, walletVerifier, type WalletVerifier} from './accounts.js';

/**
 * The signer: one process, one job, refuses everything else.
 *
 * Key material lives here and nowhere else — the API never touches it. Every
 * request is policy-checked, deduplicated, nonce-ordered, and only then
 * signed.
 *
 * The off-chain policy check duplicates what AgentAccount enforces on-chain,
 * deliberately: the off-chain one gives a useful error, the on-chain one gives
 * the guarantee. If they ever disagree, the chain wins and the caller gets a
 * revert — which is the correct failure direction.
 */

export interface SignRequest {
  agentId: number;
  chainId: number;
  target: Hex;
  data: Hex;
  /** The spend this call is expected to make, in base units. */
  spend: bigint;
  /** Required. Agents retry, and a retried hire must not create a second job. */
  idempotencyKey: string;
}

export interface SignResult {
  txHash: Hex;
  nonce: number;
  /** True when this was a replay and the original hash is being returned. */
  replayed: boolean;
}

export interface SignerDeps {
  db: Db;
  /**
   * A pool used ONLY for the per-agent advisory lock. Separate from `db`,
   * because the signing work inside the lock queries `db` too — sharing one
   * pool lets concurrent holders exhaust it and wait on each other.
   */
  locks: LockPool;
  chain: ChainConfig;
  keys: KeySource;
  abis: Record<string, Abi>;
  /** Refuse to sign below this much native currency, rather than emitting a failing tx. */
  gasFloorWei?: bigint;
  /** The most gas one transaction may use; a larger estimate is refused, not paid. */
  maxGas?: bigint;
  logger?: {
    info: (o: unknown, m?: string) => void;
    warn: (o: unknown, m?: string) => void;
    error: (o: unknown, m?: string) => void;
  };
}

/**
 * Monad charges the whole gas LIMIT, not the gas used, so the limit is money.
 * A v3 settlement — the costliest call sent — reserves two review budgets,
 * ~1.1 M gas (PROGRESS, v3); this leaves a third again over that. A call
 * estimating higher is not one this system makes, and is refused.
 */
export const DEFAULT_MAX_GAS = 1_500_000n;

/**
 * What a plain-EOA agent may sign: the escrow calls the API makes, and
 * nothing else. Nothing on chain bounds such an agent, so this list is the
 * bound.
 */
const EOA_CALLS = new Set([
  'createJob',
  'directPay',
  'acceptJob',
  'submitResult',
  'approve',
  'dispute',
  'cancel',
]);

export class SignerService {
  private readonly pub: PublicClient;
  private readonly log: NonNullable<SignerDeps['logger']>;
  private readonly gasFloor: bigint;
  private readonly maxGas: bigint;
  private readonly wallets: WalletVerifier;
  private readonly viemChain: Chain;

  constructor(private readonly deps: SignerDeps) {
    this.pub = createPublicClient({transport: http(deps.chain.rpcUrl)});
    this.log = deps.logger ?? {info: () => {}, warn: () => {}, error: () => {}};
    this.gasFloor = deps.gasFloorWei ?? 10n ** 16n; // 0.01 native
    this.maxGas = deps.maxGas ?? DEFAULT_MAX_GAS;
    this.wallets = walletVerifier(this.pub, deps.chain);
    this.viemChain = viemChainOf(deps.chain);
  }

  async sign(req: SignRequest): Promise<SignResult> {
    const {db, chain, keys} = this.deps;

    if (req.chainId !== chain.chainId) {
      throw new PactoraError(
        ErrorCode.CHAIN_MISMATCH,
        `signer serves chain ${chain.chainId}, request was for ${req.chainId}`,
      );
    }

    // What this key is being used FOR. A replay must be the same call by the
    // same agent; anything else under the key is a conflict, never a replay.
    const payloadHash = payloadHashOf(req);

    // 1. Replay first — cheapest, and the answer is already final.
    const existing = await this.findKey(req);
    if (existing) assertSamePayload(existing, payloadHash);
    if (existing?.txHash) {
      this.log.info({idempotencyKey: req.idempotencyKey, txHash: existing.txHash}, 'replay');
      return {txHash: existing.txHash as Hex, nonce: existing.nonce, replayed: true};
    }

    // The agent's registered wallet — the address the CHAIN will check.
    //
    // `TaskEscrow` resolves a job's worker and client through the identity
    // registry and compares the result to `msg.sender`. So the key is not a
    // detail of custody: it IS the agent's identity, and the keystore has to
    // be told which address it must produce.
    const agent = await this.loadAgent(req.agentId);
    const wallet = agent.walletAddress as Hex;

    // 2. What the wallet IS, from its code — never from what it answers.
    const kind = await this.wallets.kindOf(wallet);
    if (kind === 'foreign') {
      throw new PactoraError(
        ErrorCode.AGENT_NOT_HIREABLE,
        `agent ${req.agentId}'s wallet ${wallet} is a contract, but not an AgentAccount from this ` +
          "deployment's factory or an EOA delegated to its AgentDelegate — nothing is signed for it",
      );
    }
    const capsOnChain = kind === 'account';

    // 3. Policy: the account's own caps, mirrored for a useful error; or, for
    //    a plain EOA, what the call actually spends — decoded, not declared.
    let spend = req.spend;
    if (capsOnChain) await this.checkPolicy(req, wallet);
    else spend = await this.eoaSpend(req);

    // Two kinds of wallet, two ways to sign.
    //
    // An AgentAccount is a contract: the call goes TO the account as
    // `execute(target, data)`, signed by its owner or a session key it has
    // granted, and the account makes the call — so `msg.sender` at the escrow
    // is the account, the registered wallet, and the caps are enforced by the
    // account itself, on chain. A plain EOA signs for itself.
    let account: Account | null;
    let to: Hex = req.target;
    let data: Hex = req.data;

    if (capsOnChain) {
      account = await this.keyTrustedBy(wallet, req.agentId);
      if (!account) {
        throw new PactoraError(
          ErrorCode.AGENT_NOT_HIREABLE,
          `agent ${req.agentId}'s wallet ${wallet} is an AgentAccount, and no key held here for it is its owner ` +
            'or an unexpired session key — the owner must grant one',
        );
      }
      to = wallet;
      data = encodeFunctionData({abi: EXECUTE_ABI, functionName: 'execute', args: [req.target, req.data]});
    } else {
      account = await keys.accountFor(req.agentId, wallet);
      if (!account) {
        throw new PactoraError(ErrorCode.AGENT_NOT_HIREABLE, `no signing key for agent ${req.agentId}`);
      }

      // Signing with somebody else's key produces a transaction that is valid,
      // costs gas, and reverts — `NotAgentWallet`, surfaced as "execution
      // reverted for an unknown reason" because the revert data is a custom
      // error. A single shared dev key made that the outcome of every accept,
      // submitResult and approve in the system. Refusing here says which two
      // addresses disagree, before any gas is spent.
      if (account.address.toLowerCase() !== wallet.toLowerCase()) {
        throw new PactoraError(
          ErrorCode.AGENT_NOT_HIREABLE,
          `agent ${req.agentId} is registered to wallet ${wallet}, but the only key available signs as ` +
            `${account.address} — the chain checks msg.sender against the registered wallet, so this would revert`,
        );
      }
    }
    const signer = account;

    // 4. Gas. Refusing is better than broadcasting a transaction that will
    //    fail and still consume a nonce.
    const balance = await this.pub.getBalance({address: signer.address});
    if (balance < this.gasFloor) {
      throw new PactoraError(
        ErrorCode.INSUFFICIENT_FUNDS,
        `agent ${req.agentId} has ${balance} wei, below the ${this.gasFloor} gas floor — top up from FUNDER`,
      );
    }

    // 5. The RPC must serve the chain this signer is configured for (audit
    //    M2). viem checks again at send; this says so in words, and before
    //    a slot is claimed.
    const served = await this.pub.getChainId();
    if (served !== chain.chainId) {
      throw new PactoraError(
        ErrorCode.CHAIN_MISMATCH,
        `the RPC serves chain ${served}, not ${chain.chainId} — refusing to sign`,
      );
    }

    // 6. Nonce under a per-agent advisory lock. Two concurrent hires for the
    //    same agent must not produce the same nonce, and a database lock is
    //    the only thing that holds across process restarts and replicas.
    return this.withAgentLock(req.agentId, async () => {
      const nonce = await this.pub.getTransactionCount({
        address: signer.address,
        blockTag: 'pending',
      });

      // A failed broadcast that never reached the chain still holds its
      // nonce in our ledger, and the next request — given that same nonce by
      // the node — collided with it and was refused as "in flight". The
      // chain's own pending count proves such a nonce was never used (had
      // the transaction reached even the mempool, the count would be past
      // it), so the stale claim is released. A retry of that request simply
      // claims a fresh slot.
      await db
        .delete(signerTxs)
        .where(
          and(
            eq(signerTxs.chainId, chain.chainId),
            eq(signerTxs.agentId, req.agentId),
            eq(signerTxs.status, 'failed'),
            isNull(signerTxs.txHash),
            gte(signerTxs.nonce, nonce),
          ),
        );

      // Claim the slot BEFORE broadcasting. If we crash between claiming and
      // broadcasting, the row is 'pending' with no hash and is visible for
      // reconciliation — far better than an untracked in-flight transaction.
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
        .returning();

      let slot = claimed;

      if (!slot) {
        const now = await this.findKey(req);
        // Claimed meanwhile for a different call: a conflict, not a replay.
        if (now) assertSamePayload(now, payloadHash);
        if (now?.txHash) return {txHash: now.txHash as Hex, nonce: now.nonce, replayed: true};

        // A previous attempt claimed the key and then failed to broadcast —
        // the wallet was out of gas, or the RPC was down.
        //
        // Without this the key is burned forever: the row exists, has no
        // hash, and every retry is refused as "in flight". Topping the wallet
        // up would not help, which is the opposite of the recovery the chaos
        // checklist asks for.
        //
        // The retry REUSES THE STORED NONCE. If the original somehow did
        // reach the mempool after all, two transactions with one nonce means
        // only one can ever be mined — so recovering cannot double-spend.
        // And it is the SAME call, checked above: a failed row's key cannot
        // be taken over to send something else on its nonce.
        if (now && now.status === 'failed') {
          const [reclaimed] = await db
            .update(signerTxs)
            .set({status: 'pending'})
            .where(eq(signerTxs.id, now.id))
            .returning();
          slot = reclaimed;
          this.log.warn({agentId: req.agentId, nonce: now.nonce}, 'retrying a failed broadcast');
        }
      }

      if (!slot) {
        // Another request holds this key right now.
        throw new PactoraError(ErrorCode.IDEMPOTENCY_CONFLICT, 'a request with this key is in flight');
      }

      // No AgentAccount, so nothing on-chain will stop this spend: the cap
      // is ours to hold. Reserved here — under the lock, after a replay has
      // already returned, before anything is broadcast — so two concurrent
      // hires cannot both fit into the same remaining budget.
      const reserved = !capsOnChain && spend > 0n;
      if (reserved) {
        try {
          await this.reserveOffChain(req.agentId, spend);
        } catch (err) {
          // Free the key: a spend refused today may be allowed tomorrow.
          await db.update(signerTxs).set({status: 'failed'}).where(eq(signerTxs.id, slot.id));
          throw err;
        }
      }

      const client = createWalletClient({
        account: signer,
        chain: this.viemChain,
        transport: http(chain.rpcUrl),
      });

      let txHash: Hex;
      try {
        // Estimated, then bounded: the estimate is what the code says it
        // needs, the ceiling what this system will ever pay for one call. On
        // Monad the limit is charged in full, so it is not padded either.
        const gas = await this.pub.estimateGas({account: signer, to, data});
        if (gas > this.maxGas) {
          throw new PactoraError(
            ErrorCode.INVALID_STATE,
            `the call would use ${gas} gas, over this signer's ceiling of ${this.maxGas} — not sent`,
          );
        }
        txHash = await client.sendTransaction({
          // For an AgentAccount this is the account, carrying execute(...).
          to,
          data,
          // The slot's nonce, which on a retry is the original one.
          nonce: slot.nonce,
          gas,
          // Explicit, never null: viem then checks the RPC serves this chain
          // and signs for it, rather than for whatever the RPC says it is.
          chain: this.viemChain,
        });
      } catch (err) {
        // Nothing left the building, so nothing was spent.
        // Neither of these may hide the broadcast error below, so neither
        // rethrows — but neither is silent any more. A lost release leaves the
        // agent's budget wrongly reduced; a lost status update leaves the row
        // 'pending', and every retry of the key is refused as "in flight".
        // Both are an operator's to fix, so both are logged at error level.
        if (reserved) {
          await this.releaseOffChain(req.agentId, spend).catch((releaseErr: unknown) =>
            this.log.error(
              {err: releaseErr, agentId: req.agentId, spend: spend.toString()},
              'could not release a reserved spend after a failed broadcast — the budget is under-reported',
            ),
          );
        }

        await db
          .update(signerTxs)
          .set({status: 'failed'})
          .where(eq(signerTxs.id, slot.id))
          .catch((statusErr: unknown) =>
            this.log.error(
              {err: statusErr, signerTxId: slot.id, idempotencyKey: req.idempotencyKey},
              'could not mark a failed broadcast as failed — the key stays "in flight" until fixed',
            ),
          );

        // The caller gets a sentence; the log keeps the whole error. A live
        // run once failed as "Missing or invalid parameters" and nothing
        // anywhere recorded what the node had actually said.
        const e = err as {shortMessage?: string; details?: string; message?: string};
        this.log.warn(
          {
            agentId: req.agentId,
            to,
            signer: signer.address,
            short: e.shortMessage,
            details: e.details,
            message: e.message?.slice(0, 2000),
          },
          'broadcast failed',
        );
        if (err instanceof PactoraError) throw err;
        throw asActionableError(err, chain.network.nativeCurrency.symbol, signer.address, this.deps.abis);
      }

      await db.update(signerTxs).set({txHash, status: 'broadcast'}).where(eq(signerTxs.id, slot.id));

      this.log.info({agentId: req.agentId, nonce: slot.nonce, txHash}, 'signed and broadcast');
      return {txHash, nonce: slot.nonce, replayed: false};
    });
  }

  /** This agent's use of this key, if any. A key belongs to the agent that used it. */
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
   * The on-chain caps of a PROVEN AgentAccount, checked here so the caller
   * gets an actionable error instead of a bare revert.
   *
   * Whether the wallet is an account is no longer read from these answers —
   * any contract can answer them (audit H3). The account enforces its caps
   * regardless, so a cap that cannot be read is left to it.
   */
  private async checkPolicy(req: SignRequest, wallet: Hex): Promise<void> {
    const {chain, abis} = this.deps;

    const accountAbi = abis['AgentAccount'];
    if (!accountAbi) return;

    // Read the caps from the chain, not from our cache. The cache exists for
    // fast rejection; the contract is the authority, and a stale cache that
    // lets a call through only to have it revert is the worse failure.
    const [perTaskCap, dailyRemaining, nextReleaseAt] = await Promise.all([
      this.pub
        .readContract({
          address: wallet,
          abi: accountAbi,
          functionName: 'policy',
        })
        .then((p) => (p as readonly [bigint, bigint, boolean])[0])
        .catch(() => null),
      this.pub
        .readContract({
          address: wallet,
          abi: accountAbi,
          functionName: 'dailyRemaining',
        })
        .then((v) => v as bigint)
        .catch(() => null),
      this.pub
        .readContract({
          address: wallet,
          abi: accountAbi,
          functionName: 'nextReleaseAt',
        })
        .then((v) => v as bigint)
        .catch(() => null),
    ]);

    if (perTaskCap !== null && req.spend > perTaskCap) {
      throw new PactoraError(
        ErrorCode.BUDGET_EXCEEDED,
        `spend ${chain.formatToken(req.spend)} exceeds the per-task cap of ${chain.formatToken(perTaskCap)}`,
      );
    }

    if (dailyRemaining !== null && req.spend > dailyRemaining) {
      throw new PactoraError(
        ErrorCode.BUDGET_EXCEEDED,
        `spend ${chain.formatToken(req.spend)} exceeds today's remaining budget of ${chain.formatToken(dailyRemaining)}`,
        this.secondsUntilRelease(nextReleaseAt),
      );
    }
  }

  /**
   * What a plain-EOA agent's call spends — and whether it may be signed at
   * all (audit M3).
   *
   * Nothing on chain bounds an EOA, so this is the bound: the escrow, one of
   * the calls the API makes, and a spend read from the calldata rather than
   * taken on trust from the request. A declared spend below what the call
   * moves is refused; that was `USDC.transfer(attacker, balance)` signed as
   * spend 0. The amount reserved against the cap is the decoded one.
   */
  private async eoaSpend(req: SignRequest): Promise<bigint> {
    const {chain, abis} = this.deps;
    const escrow = chain.contracts['TaskEscrow'];
    const abi = abis['TaskEscrow'];
    if (!escrow || !abi || req.target.toLowerCase() !== escrow.toLowerCase()) {
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        `agent ${req.agentId} has a plain wallet: it may call only the TaskEscrow, not ${req.target}`,
      );
    }

    let call: {functionName: string; args?: readonly unknown[] | undefined};
    try {
      call = decodeFunctionData({abi, data: req.data});
    } catch {
      throw new PactoraError(ErrorCode.FORBIDDEN, 'the calldata is not a TaskEscrow call');
    }
    if (!EOA_CALLS.has(call.functionName)) {
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        `TaskEscrow.${call.functionName} is not a call this signer makes for an agent`,
      );
    }

    const args = call.args ?? [];
    let moves = 0n;
    if (call.functionName === 'createJob' || call.functionName === 'directPay') {
      moves = args[2] as bigint;
    } else if (call.functionName === 'dispute') {
      // v3: the bond the job captured at creation, read from the chain.
      const job = await this.pub
        .readContract({address: escrow as Hex, abi, functionName: 'getJob', args: [args[0]]})
        .catch(() => null);
      if (!job) {
        throw new PactoraError(
          ErrorCode.CHAIN_NOT_ENABLED,
          "the job's dispute bond could not be read — nothing was sent; retry shortly",
          5,
        );
      }
      moves = BigInt((job as {disputeBond: bigint}).disputeBond);
    }

    if (req.spend < moves) {
      throw new PactoraError(
        ErrorCode.SCHEMA_MISMATCH,
        `the call spends ${chain.formatToken(moves)}, but the request declared ${chain.formatToken(req.spend)}`,
      );
    }
    return moves;
  }

  /**
   * A key held here that this AgentAccount will accept: its owner, or a
   * session key it granted that has not expired. Asked of the account every
   * time rather than cached — a revoke must take effect on the next call.
   *
   * The key mapped to this agent is asked first, and off testnet it is the
   * only one asked: anyone can deploy a genuine AgentAccount and grant OUR
   * hot key a session in it, and a signer that tried every key it held would
   * then pay that stranger's gas from ours. Testnet dev keys are listed
   * without agent ids, so there every held key is still tried.
   */
  private async keyTrustedBy(wallet: Hex, agentId: number): Promise<Account | null> {
    const {keys, chain} = this.deps;
    const bound = await keys.accountFor(agentId, wallet);
    const others = chain.testnet ? (keys.all?.() ?? []).filter((k) => k.address !== bound?.address) : [];
    const held = [...(bound ? [bound] : []), ...others];
    if (held.length === 0) return null;

    const owner = await this.pub
      .readContract({address: wallet, abi: ACCOUNT_KEYS_ABI, functionName: 'owner'})
      .catch(() => null);
    const now = BigInt(Math.floor(Date.now() / 1000));

    // Prefer a session key: bounded in time and budget, which is the point.
    // The owner's key is the fallback, and on a real deployment is not here.
    let ownerKey: Account | null = null;
    for (const key of held) {
      const [expiry] = await this.pub
        .readContract({
          address: wallet,
          abi: ACCOUNT_KEYS_ABI,
          functionName: 'sessionKeys',
          args: [key.address],
        })
        .catch(() => [0n, 0n, 0n] as const);
      // A minute of margin: a key that expires while its transaction is in
      // the mempool reverts, and costs gas doing it.
      if (expiry > now + 60n) return key;
      if (owner && owner.toLowerCase() === key.address.toLowerCase()) ownerKey = key;
    }
    return ownerKey;
  }

  /**
   * Check and reserve a spend against the stored policy, atomically.
   *
   * One UPDATE decides and records: the window rolls over after 24 hours
   * (rolling, like AgentAccount's, not UTC midnight), the per-task cap and
   * the daily cap are both tested, and if either fails no row changes.
   */
  private async reserveOffChain(agentId: number, spend: bigint): Promise<void> {
    const {db, chain} = this.deps;
    const amount = spend.toString();
    const rows = (await db.execute(sql`
      UPDATE spend_policies SET
        spent_today = CASE WHEN day_start <= now() - interval '24 hours'
                           THEN ${amount}::numeric ELSE spent_today + ${amount}::numeric END,
        day_start   = CASE WHEN day_start <= now() - interval '24 hours' THEN now() ELSE day_start END
      WHERE agent_id = ${agentId}
        AND per_task_cap >= ${amount}::numeric
        AND (CASE WHEN day_start <= now() - interval '24 hours' THEN 0 ELSE spent_today END)
            + ${amount}::numeric <= daily_cap
      RETURNING agent_id
    `)) as unknown as {agent_id: number}[];
    if (rows.length > 0) return;

    // Refused. Say which rule, and when it lifts.
    const [policy] = (await db.execute(sql`
      SELECT per_task_cap, daily_cap, spent_today,
             GREATEST(0, EXTRACT(EPOCH FROM (day_start + interval '24 hours' - now())))::int AS resets_in
      FROM spend_policies WHERE agent_id = ${agentId}
    `)) as unknown as {per_task_cap: string; daily_cap: string; spent_today: string; resets_in: number}[];

    if (!policy) {
      throw new PactoraError(
        ErrorCode.BUDGET_EXCEEDED,
        `agent ${agentId} has no spending policy — nothing may be spent until one is set`,
      );
    }
    if (spend > BigInt(policy.per_task_cap)) {
      throw new PactoraError(
        ErrorCode.BUDGET_EXCEEDED,
        `spend ${chain.formatToken(spend)} exceeds the per-task cap of ${chain.formatToken(BigInt(policy.per_task_cap))}`,
      );
    }
    const remaining = BigInt(policy.daily_cap) - BigInt(policy.spent_today);
    throw new PactoraError(
      ErrorCode.BUDGET_EXCEEDED,
      `spend ${chain.formatToken(spend)} exceeds today's remaining budget of ${chain.formatToken(remaining > 0n ? remaining : 0n)}`,
      Math.max(1, policy.resets_in),
    );
  }

  private async releaseOffChain(agentId: number, spend: bigint): Promise<void> {
    await this.deps.db.execute(sql`
      UPDATE spend_policies SET spent_today = GREATEST(0, spent_today - ${spend.toString()}::numeric)
      WHERE agent_id = ${agentId}
    `);
  }

  /**
   * Serialise per agent using a Postgres advisory lock.
   *
   * Two concurrent hires for the same agent must not read the same nonce. An
   * in-process mutex would not survive a second replica, which Railway will
   * happily give us.
   */
  private async withAgentLock<T>(agentId: number, fn: () => Promise<T>): Promise<T> {
    const key = BigInt(this.deps.chain.chainId) * 1_000_000n + BigInt(agentId);
    // Lock and unlock on ONE reserved connection. Through the shared pool
    // they landed on different connections, the unlock silently failed, and
    // the lock stayed held by an idle connection — the next sign for the
    // agent waited forever (reproduced in signer.test.ts, "the per-agent lock").
    return withAdvisoryLock(this.deps.locks, key, fn);
  }

  /**
   * When the daily cap next gives capacity back.
   *
   * v3: `AgentAccount`'s cap is ROLLING — no 24 hours may see more than the
   * cap — so nothing "resets". `nextReleaseAt` is when the oldest counted
   * spend leaves the window. That may free less than this request needs, but
   * it is the earliest moment anything changes; a later hint would make a
   * caller wait longer than it must, an earlier one would just be refused
   * again. Zero means nothing is counted (the cap itself is too small): a
   * full day is the honest answer.
   */
  private secondsUntilRelease(nextReleaseAt: bigint | null): number {
    if (nextReleaseAt === null || nextReleaseAt === 0n) return DAY_SECONDS;
    return Math.max(0, Number(nextReleaseAt) - Math.floor(Date.now() / 1000));
  }
}

const DAY_SECONDS = 24 * 60 * 60;

/** keccak256(target ‖ data ‖ spend): the call an idempotency key was first used for. */
export function payloadHashOf(req: Pick<SignRequest, 'target' | 'data' | 'spend'>): Hex {
  return keccak256(encodePacked(['address', 'bytes', 'uint256'], [req.target, req.data, req.spend]));
}

/**
 * A key reused for a different call is a conflict, never a replay of the
 * first. A row from before payload hashes were stored never replays either.
 */
function assertSamePayload(row: {payloadHash: string | null}, payloadHash: Hex): void {
  if (row.payloadHash?.toLowerCase() !== payloadHash.toLowerCase()) {
    throw new PactoraError(
      ErrorCode.IDEMPOTENCY_CONFLICT,
      'this idempotency key was already used for a different call — a new request needs a new key',
    );
  }
}

/** AgentAccount.execute — the only way a call leaves an account. */
const EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'target', type: 'address'},
      {name: 'data', type: 'bytes'},
    ],
    outputs: [{name: 'result', type: 'bytes'}],
  },
] as const;

/** Who an AgentAccount will take a call from. */
const ACCOUNT_KEYS_ABI = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{name: '', type: 'address'}],
  },
  {
    type: 'function',
    name: 'sessionKeys',
    stateMutability: 'view',
    inputs: [{name: 'key', type: 'address'}],
    outputs: [
      {name: 'expiry', type: 'uint64'},
      {name: 'budget', type: 'uint128'},
      {name: 'spent', type: 'uint128'},
    ],
  },
] as const;

/**
 * Turn a broadcast failure into something the operator can act on.
 *
 * "execution reverted" and a 900-character viem stack are the same thing to
 * whoever is watching a demo fail: unreadable. The two that actually happen —
 * an empty gas wallet and an unreachable RPC — get a sentence each, naming
 * the address to fund, because at that moment the useful output is an
 * address and not a stack trace.
 */
function asActionableError(
  err: unknown,
  gasSymbol: string,
  from: string,
  abis: Record<string, Abi> = {},
): PactoraError {
  const message = err instanceof Error ? err.message : String(err);

  // A contract said no, and said which rule. Name it — and only it: viem's
  // message can carry the whole signed transaction, which is the log's
  // business, not the caller's.
  const refused = contractRefusal(err, abis);
  if (refused) {
    return new PactoraError(ErrorCode.INVALID_STATE, `the contract refused: ${refused}`);
  }
  // Classify on what the node SAID, not on viem's full message: that carries
  // the whole request body, and "503" inside a transaction's hex once turned
  // an empty gas wallet into "the RPC endpoint is unreachable".
  const e = err as {shortMessage?: string; details?: string};
  const said = [e.shortMessage, e.details].filter(Boolean).join(' ') || message;

  if (/insufficient (funds|balance)|exceeds the balance|gas required exceeds/i.test(said)) {
    return new PactoraError(
      ErrorCode.INSUFFICIENT_FUNDS,
      `the agent wallet ${from} has no ${gasSymbol} left for gas — top it up and retry the same request`,
    );
  }

  // A proxy or load balancer answering for the node puts its status on the
  // error, not in its words: viem says only "HTTP request failed." — which was
  // called INVALID_STATE, so a worker gave up a submit that was safe to retry.
  const httpStatus =
    err instanceof BaseError
      ? (err.walk((c) => c instanceof HttpRequestError) as HttpRequestError | null)?.status
      : undefined;
  const transportDown = httpStatus !== undefined && (httpStatus === 429 || httpStatus >= 500);

  if (transportDown || /fetch failed|ECONNREFUSED|ETIMEDOUT|socket hang up|\b50[234]\b/i.test(said)) {
    return new PactoraError(
      ErrorCode.CHAIN_NOT_ENABLED,
      `the RPC endpoint is unreachable — the transaction was NOT broadcast, so retrying the same request is safe (${message})`,
      5,
    );
  }

  return new PactoraError(ErrorCode.INVALID_STATE, `broadcast failed: ${said.slice(0, 300)}`);
}

/**
 * The custom error a contract reverted with, decoded against the escrow and
 * account ABIs, as `Name(arg, arg)`. An AgentAccount wraps its target's revert
 * in `CallFailed(bytes)`, so that is unwrapped once to reach the real reason.
 */
function contractRefusal(err: unknown, abis: Record<string, Abi>): string | null {
  const data = revertData(err);
  if (!data) return null;
  const abi = [
    ...(abis['TaskEscrow'] ?? []),
    ...(abis['AgentAccount'] ?? []),
    ...(abis['StakeVault'] ?? []),
  ] as Abi;
  const decode = (hex: Hex): string | null => {
    try {
      const {errorName, args} = decodeErrorResult({abi, data: hex});
      if (errorName === 'CallFailed' && typeof args?.[0] === 'string') {
        return decode(args[0] as Hex) ?? errorName;
      }
      return `${errorName}(${(args ?? []).map(String).join(', ')})`;
    } catch {
      return null;
    }
  };
  return decode(data);
}

/** Revert data carried anywhere in a viem error's cause chain. */
function revertData(err: unknown): Hex | null {
  let current: unknown = err;
  for (let depth = 0; current && depth < 8; depth++) {
    const data = (current as {data?: unknown}).data;
    if (typeof data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(data)) return data as Hex;
    if (data && typeof data === 'object' && typeof (data as {data?: unknown}).data === 'string') {
      return (data as {data: Hex}).data;
    }
    current = (current as {cause?: unknown}).cause;
  }
  return null;
}
