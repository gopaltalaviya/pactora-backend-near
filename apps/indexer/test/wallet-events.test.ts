import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {Indexer} from '../src/indexer.js';
import {decodeWalletChange} from '../src/events.js';
import {parseEventLog} from '@pactora/near';
import {FakeChain, log, receipt, sandboxChain} from './near-fixtures.js';
import {CLIENT, DB_URL, WORKER, reset, seedAgents} from './db.js';

/**
 * A wallet proposed or accepted for an agent ends the person sessions of
 * its owner and the wallets involved (migration 0025): what the account
 * signed in with may no longer be in its hands.
 */
const chain = sandboxChain();
const PACTORA = chain.contracts.Pactora;

let db: Db;
beforeAll(() => {
  db = createDb(DB_URL, {max: 2});
});
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  await reset(db);
  await db.execute(sql`TRUNCATE sessions`);
});

async function session(account: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO sessions (key_id, secret_hash, account_id, chain_id, expires_at)
    VALUES (${account.slice(0, 16).padEnd(16, '0')}, ${'sha256$' + '0'.repeat(64)}, ${account}, 'near:sandbox', now() + interval '7 days')`);
}
const live = async () =>
  (
    (await db.execute(
      sql`SELECT account_id, revoked_reason FROM sessions WHERE revoked_at IS NULL ORDER BY account_id`,
    )) as unknown as {account_id: string}[]
  ).map((r) => r.account_id);

describe('wallet events end sessions', () => {
  it('decodes wallet_accepted and wallet_proposed, and ignores anything else', () => {
    expect(
      decodeWalletChange(
        parseEventLog(log.walletAccepted({agentId: 2, wallet: 'new.test.near', previous: 'old.test.near'}))!,
      ),
    ).toEqual({agentId: 2, wallets: ['new.test.near', 'old.test.near'], event: 'wallet_accepted'});
    expect(decodeWalletChange(parseEventLog(log.walletProposed({agentId: 2, pendingWallet: null}))!)).toEqual(
      {
        agentId: 2,
        wallets: [],
        event: 'wallet_proposed',
      },
    );
    expect(decodeWalletChange(parseEventLog(log.jobAccepted({jobId: 7, worker: 2, bond: 1}))!)).toBeNull();
  });

  it("ends the owner's, the old and the new wallet's sessions, and no one else's", async () => {
    await seedAgents(db);
    for (const a of [WORKER.owner, WORKER.wallet, 'new-wallet.test.near', CLIENT.owner]) await session(a);
    const src = new FakeChain(chain.startBlock);
    src.block(
      receipt({
        executor: PACTORA,
        logs: [
          log.walletAccepted({
            agentId: WORKER.chainAgentId,
            wallet: 'new-wallet.test.near',
            previous: WORKER.wallet,
          }),
        ],
      }),
    );
    await new Indexer({db, chain, source: src}).tick();
    expect(await live()).toEqual([CLIENT.owner]);
    const [reason] = (await db.execute(
      sql`SELECT revoked_reason FROM sessions WHERE account_id = ${WORKER.owner}`,
    )) as unknown as [{revoked_reason: string}];
    expect(reason.revoked_reason).toMatch(/wallet changed/);
  });
});
