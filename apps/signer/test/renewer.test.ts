import {describe, expect, it} from 'vitest';
import {Renewer, type RenewerDeps} from '../src/renewer.js';

/**
 * `AgentAccount` caps a session key at 24 hours (`MAX_SESSION_KEY_TTL`). A
 * hosted orchestrator therefore stopped hiring a day after it was set up:
 * nothing renewed its key. The renewer renews what is about to lapse.
 *
 * Audit F1 (2026-10-26): it used to do that as the account's OWNER, re-granting
 * — so the signer process held the owner key of every hosted account, and each
 * re-grant reset `spent`. It is now the account's SESSION MANAGER, which can
 * only extend an existing key's expiry; the owner key stays offline.
 */

const MANAGER = '0x00000000000000000000000000000000000000aa';
const STRANGER = '0x00000000000000000000000000000000000000bb';
const ORCH = '0x0000000000000000000000000000000000000001';
const WORKER = '0x0000000000000000000000000000000000000002';
const OTHERS = '0x0000000000000000000000000000000000000003';
const HOT = '0x00000000000000000000000000000000000000c1';
const WKEY = '0x00000000000000000000000000000000000000c2';
const NOW = 1_000_000n;
const H = 3_600n;

type Grant = {expiry: bigint; budget: bigint};

function world(over: Partial<RenewerDeps> = {}) {
  const grants = new Map<string, Grant>([
    [`${ORCH}:${HOT}`, {expiry: NOW + 2n * H, budget: 1_000_000n}], // due (within 6 h)
    [`${WORKER}:${WKEY}`, {expiry: NOW + 20n * H, budget: 0n}], // not due
    [`${OTHERS}:${HOT}`, {expiry: NOW + 1n * H, budget: 5n}], // due, but not our account
  ]);
  const sent: {account: string; key: string; expiry: bigint}[] = [];
  const deps: RenewerDeps = {
    manager: MANAGER,
    keys: [HOT, WKEY],
    renewBeforeSeconds: 6n * H,
    ttlSeconds: 23n * H,
    accounts: async () => [ORCH, WORKER, OTHERS],
    isAgentAccount: async () => true,
    managerOf: async (a) => (a === OTHERS ? STRANGER : MANAGER),
    grantOf: async (a, k) => grants.get(`${a}:${k}`) ?? {expiry: 0n, budget: 0n},
    now: async () => NOW,
    extend: async (account, key, expiry) => {
      sent.push({account, key, expiry});
      return '0xhash';
    },
    ...over,
  };
  return {deps, sent};
}

describe('session-key renewal', () => {
  it('extends only a grant that lapses within the window, to now + 23 h — never re-grants', async () => {
    const {deps, sent} = world();
    const result = await new Renewer(deps).renew();
    expect(sent).toEqual([{account: ORCH, key: HOT, expiry: NOW + 23n * H}]);
    expect(result.renewed).toHaveLength(1);
  });

  it('never touches an account that did not name it manager, or a key the account never granted', async () => {
    const {deps, sent} = world();
    await new Renewer(deps).renew();
    expect(sent.some((s) => s.account === OTHERS)).toBe(false);
    expect(sent.some((s) => s.account === WORKER && s.key === HOT)).toBe(false);
  });

  it('renews a grant that has ALREADY lapsed — the service may have been down', async () => {
    const {deps, sent} = world({
      grantOf: async (a, k) =>
        a === ORCH && k === HOT ? {expiry: NOW - H, budget: 7n} : {expiry: 0n, budget: 0n},
    });
    await new Renewer(deps).renew();
    expect(sent).toEqual([{account: ORCH, key: HOT, expiry: NOW + 23n * H}]);
  });

  it('skips a wallet whose session manager cannot be read', async () => {
    const {deps, sent} = world({
      managerOf: async (a) => {
        if (a === WORKER) throw new Error('execution reverted');
        return a === OTHERS ? STRANGER : MANAGER;
      },
    });
    await new Renewer(deps).renew();
    expect(sent.map((s) => s.account)).toEqual([ORCH]);
  });

  it('one failed grant does not stop the others', async () => {
    let first = true;
    const {deps, sent} = world({
      grantOf: async () => ({expiry: NOW + H, budget: 1n}), // every grant due
      extend: async (account, key, expiry) => {
        if (first) {
          first = false;
          throw new Error('nonce too low');
        }
        sent.push({account, key, expiry});
        return '0xhash';
      },
    });
    const result = await new Renewer(deps).renew();
    expect(result.failed).toHaveLength(1);
    expect(result.renewed.length).toBeGreaterThan(0);
  });

  /**
   * Audit H3: any wallet on the chain that ANSWERED as an account was renewed.
   * A contract claiming the renewer as its owner and every held key as a
   * lapsing grant had the renewer pay gas for it on every pass. Only a
   * wallet whose code proves it is an AgentAccount is asked anything.
   */
  it('never renews, or even asks, a wallet that is not proven to be an AgentAccount', async () => {
    const asked: string[] = [];
    const {deps, sent} = world({
      isAgentAccount: async (a) => a !== ORCH,
      managerOf: async (a) => {
        asked.push(a);
        return a === OTHERS ? STRANGER : MANAGER;
      },
    });
    await new Renewer(deps).renew();
    expect(sent.some((s) => s.account === ORCH)).toBe(false);
    expect(asked).not.toContain(ORCH);
  });

  it('compares managers case-insensitively (checksummed vs lowercase addresses)', async () => {
    const {deps, sent} = world({managerOf: async () => MANAGER.toUpperCase().replace('0X', '0x')});
    await new Renewer(deps).renew();
    expect(sent.length).toBeGreaterThan(0);
  });

  /** Audit F1: ownership is not what decides — the session manager is. */
  it('leaves an account it merely OWNS alone: owning means holding the owner key', async () => {
    const {deps, sent} = world({managerOf: async () => '0x0000000000000000000000000000000000000000'});
    await new Renewer(deps).renew();
    expect(sent).toEqual([]);
  });
});
