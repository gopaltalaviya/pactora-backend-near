import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {sql} from 'drizzle-orm';
import {
  DEFAULT_WINDOW_BLOCKS,
  MIN_HISTORY,
  PER_OWNER_CAP,
  closeDb,
  createDb,
  readTrust,
  verdictOf,
  type Db,
  type TrustMetrics,
} from '../src/index.js';

/**
 * The trust check (v3). The score proves every review cost a payment; this
 * asks whether the payments came from many hands or one — and whether the
 * worker's side funded the client just before it paid, which is how
 * prooflines found Monad's ERC-8004 ratings were farmed.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const CHAIN = 'near:testnet';
let db: Db;
let seq = 0;

beforeAll(() => {
  db = createDb(DB_URL, {max: 2});
});
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, payments, token_transfers RESTART IDENTITY CASCADE`,
  );
  seq = 0;
});

const addr = (n: number) => `a${n}.testnet`;

async function agent(owner: string, wallet = addr(1000 + ++seq)): Promise<{id: number; wallet: string}> {
  const rows = (await db.execute(
    sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
        VALUES (${CHAIN}, ${owner}, ${wallet}, 'A', 20000) RETURNING id`,
  )) as unknown as {id: number}[];
  return {id: rows[0]!.id, wallet};
}

async function pay(clientId: number, workerId: number, block: number, amount = 50_000): Promise<void> {
  await db.execute(sql`INSERT INTO payments (chain_id, from_agent_id, to_agent_id, amount, tx_hash, block_number)
      VALUES (${CHAIN}, ${clientId}, ${workerId}, ${amount}, ${`tx${++seq}`}, ${block})`);
}

async function transfer(from: string, to: string, block: number): Promise<void> {
  const n = ++seq;
  await db.execute(sql`INSERT INTO token_transfers (chain_id, block_number, tx_hash, receipt_id, log_index, from_address, to_address, amount)
      VALUES (${CHAIN}, ${block}, ${`tx${n}`}, ${`receipt${n}`}, 0, ${from}, ${to}, 1000000)`);
}

async function failed(agentId: number, n: number): Promise<void> {
  await db.execute(sql`INSERT INTO agent_stats (agent_id, failed) VALUES (${agentId}, ${n})
      ON CONFLICT (agent_id) DO UPDATE SET failed = ${n}`);
}

const trust = (agentId: number) => readTrust(db, {chainId: CHAIN, agentId, floor: 25});

describe('readTrust', () => {
  it('calls an agent with too little history new', async () => {
    const worker = await agent(addr(1));
    for (let i = 0; i < MIN_HISTORY - 1; i++) {
      const c = await agent(addr(10 + i));
      await pay(c.id, worker.id, 1000 + i);
    }
    expect((await trust(worker.id)).verdict).toBe('new');
  });

  it('trusts a record paid by many owners, none self-funded', async () => {
    const worker = await agent(addr(1));
    for (let i = 0; i < 4; i++) {
      const c = await agent(addr(10 + i));
      await pay(c.id, worker.id, 1000 + i);
    }
    const r = await trust(worker.id);
    expect(r.verdict).toBe('trusted');
    expect(r.metrics).toMatchObject({settled: 4, clientOwners: 4, selfFunded: 0, volume: '200000'});
  });

  it('calls a record from one owner concentrated, and caps what it adds', async () => {
    const worker = await agent(addr(1));
    const owner = addr(77);
    for (let i = 0; i < 6; i++) {
      const c = await agent(owner); // six wallets, one hand
      await pay(c.id, worker.id, 1000 + i);
    }
    const r = await trust(worker.id);
    expect(r.verdict).toBe('concentrated');
    expect(r.metrics.clientOwners).toBe(1);
    expect(r.metrics.topOwnerSettled).toBe(6);

    // The same six from six owners scores higher: one owner adds at most PER_OWNER_CAP.
    const fair = await agent(addr(2));
    for (let i = 0; i < 6; i++) {
      const c = await agent(addr(200 + i));
      await pay(c.id, fair.id, 2000 + i);
    }
    expect((await trust(fair.id)).metrics.trustScore).toBeGreaterThan(r.metrics.trustScore);
    expect(PER_OWNER_CAP).toBeLessThan(6);
  });

  /** The prooflines pattern: the worker's owner funds the client, the client pays the worker. */
  it('catches a client the worker side funded just before it paid', async () => {
    const workerOwner = addr(1);
    const worker = await agent(workerOwner);
    for (let i = 0; i < 4; i++) {
      const c = await agent(addr(10 + i));
      if (i < 2) await transfer(workerOwner, c.wallet, 5000 + i * 10);
      await pay(c.id, worker.id, 5005 + i * 10);
    }
    const r = await trust(worker.id);
    expect(r.verdict).toBe('self-funded');
    expect(r.metrics.selfFunded).toBe(2);
    expect(r.reasons[0]).toMatch(/2 of 4 paid jobs/);
  });

  /**
   * A farmer funds its client agent's balance right after register_agent,
   * before the agent is linked through the API. The indexer cannot name the
   * wallet yet, so it records a transfer into the Pactora contract for that
   * agent's chain id; the check must still see it.
   */
  it('catches funding that reached the client before its agent was linked', async () => {
    const workerOwner = addr(1);
    const worker = await agent(workerOwner);
    const c = await agent(addr(10));
    await db.execute(sql`UPDATE agents SET chain_agent_id = 77 WHERE id = ${c.id}`);
    await db.execute(sql`INSERT INTO token_transfers (chain_id, block_number, tx_hash, receipt_id, log_index, from_address, to_address, to_chain_agent_id, amount)
        VALUES (${CHAIN}, 5000, 'txf', 'receiptf', 0, ${workerOwner}, 'pactora.testnet', 77, 1000000)`);
    await pay(c.id, worker.id, 5005);
    const r = await trust(worker.id);
    expect(r.metrics.selfFunded).toBe(1);
    expect(r.verdict).toBe('self-funded');
  });

  it("counts funding from the owner's OTHER identities as the worker's side", async () => {
    const workerOwner = addr(1);
    const worker = await agent(workerOwner);
    const sibling = await agent(workerOwner); // a second identity, same hand
    const c = await agent(addr(10));
    await transfer(sibling.wallet, c.wallet, 900);
    await pay(c.id, worker.id, 950);
    expect((await trust(worker.id)).metrics.selfFunded).toBe(1);
  });

  it('ignores funding older than the window, and funding after the payment', async () => {
    const workerOwner = addr(1);
    const worker = await agent(workerOwner);
    const old = await agent(addr(10));
    await transfer(workerOwner, old.wallet, 100);
    await pay(old.id, worker.id, 100 + DEFAULT_WINDOW_BLOCKS + 1);
    const later = await agent(addr(11));
    await pay(later.id, worker.id, 50_000);
    await transfer(workerOwner, later.wallet, 50_001);
    expect((await trust(worker.id)).metrics.selfFunded).toBe(0);
  });

  it('matches implicit (64-hex) accounts as well as named ones', async () => {
    const workerOwner = 'abcdef'.padEnd(64, '0');
    const worker = await agent(workerOwner);
    const c = await agent(addr(10), 'ffee'.padEnd(64, '1'));
    await transfer(workerOwner, c.wallet, 10);
    await pay(c.id, worker.id, 20);
    expect((await trust(worker.id)).metrics.selfFunded).toBe(1);
  });

  it('calls a worker that fails often failing, whoever paid it', async () => {
    const worker = await agent(addr(1));
    for (let i = 0; i < 4; i++) {
      const c = await agent(addr(10 + i));
      await pay(c.id, worker.id, 1000 + i);
    }
    await failed(worker.id, 3); // 3 of 7
    expect((await trust(worker.id)).verdict).toBe('failing');
  });

  it('excludes self-funded settlements from the trust score', async () => {
    const workerOwner = addr(1);
    const clean = await agent(addr(2));
    const farmed = await agent(workerOwner);
    for (let i = 0; i < 4; i++) {
      const a = await agent(addr(10 + i));
      await pay(a.id, clean.id, 1000 + i);
      const b = await agent(addr(100 + i));
      await transfer(workerOwner, b.wallet, 2000 + i);
      await pay(b.id, farmed.id, 2001 + i);
    }
    const [c, f] = [await trust(clean.id), await trust(farmed.id)];
    expect(f.metrics.trustScore).toBeLessThan(c.metrics.trustScore);
    expect(f.metrics.trustScore).toBe(50); // nothing clean left: unknown, not bad
  });
});

describe('verdictOf', () => {
  const m = (over: Partial<TrustMetrics>): TrustMetrics => ({
    settled: 10,
    failed: 0,
    volume: '0',
    clientOwners: 5,
    topOwnerSettled: 2,
    selfFunded: 0,
    trustScore: 70,
    ...over,
  });

  it('puts self-funding first: two farmed jobs are not "new"', () => {
    expect(verdictOf(m({settled: 2, selfFunded: 1, clientOwners: 2})).verdict).toBe('self-funded');
  });
  it('tolerates a self-funded share just under the threshold', () => {
    expect(verdictOf(m({settled: 10, selfFunded: 1})).verdict).toBe('trusted');
    expect(verdictOf(m({settled: 10, selfFunded: 2})).verdict).toBe('self-funded');
  });
  it('flags a top owner above half the record', () => {
    expect(verdictOf(m({topOwnerSettled: 6})).verdict).toBe('concentrated');
    expect(verdictOf(m({topOwnerSettled: 5})).verdict).toBe('trusted');
  });
  it('gives every verdict a reason with its numbers', () => {
    for (const over of [{}, {settled: 1, clientOwners: 1}, {failed: 9}, {clientOwners: 1}, {selfFunded: 9}]) {
      const r = verdictOf(m(over));
      expect(r.reasons.length).toBeGreaterThan(0);
      expect(r.reasons.join(' ')).toMatch(/\d/);
    }
  });
});
