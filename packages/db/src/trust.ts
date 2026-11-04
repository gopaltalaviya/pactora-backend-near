import {sql} from 'drizzle-orm';
import type {Db} from './index.js';
import {reputationScoreSql} from './reputation.js';

/**
 * Whether a reputation deserves to be believed (v3).
 *
 * The score counts settled jobs, and only the escrow can write one, so every
 * review cost a real payment. That stops free reviews; it does not stop an
 * owner paying itself through wallets it controls. prooflines measured that
 * on Monad: 7,665 ratings of one agent, every rater funded by the agent's own
 * owner seconds before it paid. So the trust check asks what the score cannot:
 *
 *   - how many DIFFERENT owners paid this worker, and how much of its record
 *     comes from the largest one;
 *   - whether payment-token money flowed from the worker's side to a client
 *     shortly before that client hired it (`token_transfers`, recorded by the
 *     indexer from the token's own Transfer logs).
 *
 * It answers in words with the numbers behind them, because a second score
 * out of 100 would invite the same mistake it exists to correct.
 */

/** Below this many finished jobs (settled + failed) there is nothing to judge. */
export const MIN_HISTORY = 3;
/** A record where this share or more of the settlements were self-funded is farmed. */
export const SELF_FUNDED_SHARE = 0.2;
/** A failure rate above this is failing, however diverse the clients. */
export const MAX_FAIL_RATE = 0.3;
/** Fewer distinct client owners than this, or a top owner above this share, is concentrated. */
export const MIN_CLIENT_OWNERS = 3;
export const MAX_TOP_OWNER_SHARE = 0.5;
/** Settlements one owner can contribute to the trust score. */
export const PER_OWNER_CAP = 3;
/** How far before a payment a funding transfer counts: ~1 h of Monad blocks at ~0.4 s. */
export const DEFAULT_WINDOW_BLOCKS = 9_000;

export type Verdict = 'trusted' | 'new' | 'concentrated' | 'self-funded' | 'failing';

export interface TrustMetrics {
  settled: number;
  failed: number;
  /** Sum of the payments, base units. */
  volume: string;
  clientOwners: number;
  /** Settlements from the client owner that paid most often. */
  topOwnerSettled: number;
  /** Settlements whose client received money from the worker's side first. */
  selfFunded: number;
  /** The score recomputed from at most PER_OWNER_CAP settlements per owner, self-funded ones excluded. */
  trustScore: number;
}

export interface TrustReading {
  verdict: Verdict;
  reasons: string[];
  metrics: TrustMetrics;
}

/** The verdict and its reasons, from the numbers alone. Pure, so it is pinned by tests. */
export function verdictOf(m: TrustMetrics): {verdict: Verdict; reasons: string[]} {
  const finished = m.settled + m.failed;
  const pct = (n: number, d: number) => `${Math.round((100 * n) / Math.max(1, d))}%`;

  if (m.selfFunded > 0 && m.selfFunded / Math.max(1, m.settled) >= SELF_FUNDED_SHARE) {
    return {
      verdict: 'self-funded',
      reasons: [
        `${m.selfFunded} of ${m.settled} paid jobs (${pct(m.selfFunded, m.settled)}) were paid by a client that had just received payment-token money from this worker's side`,
      ],
    };
  }
  if (finished < MIN_HISTORY) {
    return {
      verdict: 'new',
      reasons: [`${finished} finished job(s); at least ${MIN_HISTORY} are needed to judge`],
    };
  }
  if (m.failed / finished > MAX_FAIL_RATE) {
    return {
      verdict: 'failing',
      reasons: [
        `${m.failed} of ${finished} finished jobs (${pct(m.failed, finished)}) failed or were lost in a dispute`,
      ],
    };
  }
  const reasons: string[] = [];
  if (m.clientOwners < MIN_CLIENT_OWNERS) {
    reasons.push(`paid by only ${m.clientOwners} distinct owner(s); ${MIN_CLIENT_OWNERS} or more are needed`);
  }
  if (m.settled > 0 && m.topOwnerSettled / m.settled > MAX_TOP_OWNER_SHARE) {
    reasons.push(
      `one owner paid for ${m.topOwnerSettled} of ${m.settled} jobs (${pct(m.topOwnerSettled, m.settled)})`,
    );
  }
  if (reasons.length > 0) return {verdict: 'concentrated', reasons};
  return {
    verdict: 'trusted',
    reasons: [
      `${m.settled} paid jobs from ${m.clientOwners} distinct owners; none self-funded; ${pct(m.failed, finished)} failed`,
    ],
  };
}

/**
 * Read a worker's trust from the database: payments, the owners behind its
 * clients, the funding transfers, and the failures `agent_stats` keeps.
 */
export async function readTrust(
  db: Db,
  args: {chainId: number; agentId: number; floor: number; windowBlocks?: number},
): Promise<TrustReading> {
  const {chainId, agentId, floor} = args;
  const window = args.windowBlocks ?? DEFAULT_WINDOW_BLOCKS;

  const [row] = (await db.execute(sql`
    WITH worker AS (
      SELECT lower(owner_address) AS owner FROM agents WHERE id = ${agentId}
    ),
    -- Every address on the worker's side: its owner, and every wallet of every
    -- agent that owner registered (a second identity is still the same hand).
    worker_side AS (
      SELECT owner AS address FROM worker
      UNION SELECT lower(wallet_address) FROM agents
        WHERE chain_id = ${chainId} AND lower(owner_address) = (SELECT owner FROM worker)
    ),
    pays AS (
      SELECT p.id, p.amount, p.block_number,
             lower(c.owner_address) AS client_owner, lower(c.wallet_address) AS client_wallet
        FROM payments p JOIN agents c ON c.id = p.from_agent_id
       WHERE p.chain_id = ${chainId} AND p.to_agent_id = ${agentId}
    ),
    flagged AS (
      SELECT DISTINCT pays.id FROM pays
        JOIN token_transfers t
          ON t.chain_id = ${chainId}
         AND t.to_address IN (pays.client_wallet, pays.client_owner)
         AND t.from_address IN (SELECT address FROM worker_side)
         AND t.block_number <= pays.block_number
         AND t.block_number >= pays.block_number - ${window}
    ),
    per_owner AS (
      SELECT client_owner, count(*) AS n,
             count(*) FILTER (WHERE id NOT IN (SELECT id FROM flagged)) AS clean
        FROM pays GROUP BY client_owner
    ),
    totals AS (
      SELECT
        (SELECT count(*) FROM pays)::int AS settled,
        COALESCE((SELECT sum(amount) FROM pays), 0)::text AS volume,
        (SELECT count(*) FROM per_owner)::int AS client_owners,
        COALESCE((SELECT max(n) FROM per_owner), 0)::int AS top_owner_settled,
        (SELECT count(*) FROM flagged)::int AS self_funded,
        COALESCE((SELECT sum(LEAST(clean, ${PER_OWNER_CAP})) FROM per_owner), 0)::int AS effective,
        COALESCE((SELECT failed FROM agent_stats WHERE agent_id = ${agentId}), 0)::int AS failed
    )
    SELECT totals.*, ${reputationScoreSql(sql`totals.effective`, sql`totals.failed`, floor)} AS trust_score
      FROM totals
  `)) as unknown as {
    settled: number;
    volume: string;
    client_owners: number;
    top_owner_settled: number;
    self_funded: number;
    failed: number;
    trust_score: number;
  }[];

  const metrics: TrustMetrics = {
    settled: Number(row?.settled ?? 0),
    failed: Number(row?.failed ?? 0),
    volume: String(row?.volume ?? '0'),
    clientOwners: Number(row?.client_owners ?? 0),
    topOwnerSettled: Number(row?.top_owner_settled ?? 0),
    selfFunded: Number(row?.self_funded ?? 0),
    trustScore: Number(row?.trust_score ?? 50),
  };
  return {...verdictOf(metrics), metrics};
}
