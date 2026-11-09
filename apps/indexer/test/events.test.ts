import {describe, expect, it} from 'vitest';
import {parseEventLog} from '@pactora/near';
import {decodeFtTransfers, decodePactoraEvent} from '../src/events.js';
import {GOLDEN, log} from './near-fixtures.js';

/**
 * NEP-297 → the indexer's kinds and payloads (docs/NEAR-PORT.md §7).
 *
 * Every input here is a log line the contract really emits (GOLDEN, captured
 * from events.rs). The payload keys are the camelCase ones the API and the
 * projection read; amounts and ids are decimal strings.
 */
const H = 'ab'.repeat(32);
const decode = (line: string) => decodePactoraEvent(parseEventLog(line)!);

describe('the fixture builders are the contract, byte for byte', () => {
  it('reproduces every captured log line', () => {
    expect(log.jobCreated({jobId: 7, client: 1, worker: 2, amount: 20000, fee: 200, specHash: H})).toBe(
      GOLDEN.jobCreated,
    );
    expect(log.jobAccepted({jobId: 7, worker: 2, bond: 1000})).toBe(GOLDEN.jobAccepted);
    expect(log.resultSubmitted({jobId: 7, resultHash: H})).toBe(GOLDEN.resultSubmitted);
    expect(log.jobDisputed({jobId: 7, disputeBond: 500, reasonHash: H})).toBe(GOLDEN.jobDisputed);
    expect(log.jobDisputed({jobId: 7, disputeBond: 500, reasonHash: null})).toBe(GOLDEN.jobDisputedNoReason);
    expect(log.disputeResolved({jobId: 7, forWorker: true, arbiter: 'arbiter.test.near'})).toBe(
      GOLDEN.disputeResolved,
    );
    expect(log.disputeExpired({jobId: 7})).toBe(GOLDEN.disputeExpired);
    expect(log.jobSettled({jobId: 7, worker: 2, paid: 19800, fee: 200, outcome: 'Success'})).toBe(
      GOLDEN.jobSettled,
    );
    expect(log.jobRefunded({jobId: 7, client: 1, amount: 20000, reason: 'cancelled', outcome: null})).toBe(
      GOLDEN.jobRefundedCancelled,
    );
    expect(log.bondSeized({jobId: 7, worker: 2, client: 1, amount: 1000})).toBe(GOLDEN.bondSeized);
    expect(log.disputeBondSettled({jobId: 7, to: 1, amount: 500})).toBe(GOLDEN.disputeBondSettled);
    expect(log.directPaid({jobId: 8, client: 1, worker: 2, amount: 20000, fee: 200, specHash: H})).toBe(
      GOLDEN.directPaid,
    );
    expect(log.review({jobId: 7, agentId: 2, side: 'worker', value: 100})).toBe(GOLDEN.review);
    expect(log.ftTransfer([{from: 'alice.test.near', to: 'bob.test.near', amount: 100}])).toBe(
      GOLDEN.ftTransfer,
    );
    expect(
      log.ftTransfer([{from: 'alice.test.near', to: 'bob.test.near', amount: 100, memo: 'refund'}]),
    ).toBe(GOLDEN.ftTransferMemo);
    expect(log.ftMint('alice.test.near', 5)).toBe(GOLDEN.ftMint);
  });
});

describe('pactora events → kind and payload', () => {
  it.each([
    [
      GOLDEN.jobCreated,
      'created',
      {
        jobId: '7',
        clientAgentId: '1',
        workerAgentId: '2',
        amount: '20000',
        fee: '200',
        specHash: H,
        acceptDeadline: '1700000000',
        workDeadline: '1700003600',
      },
    ],
    [
      GOLDEN.jobAccepted,
      'accepted',
      {jobId: '7', workerAgentId: '2', bond: '1000', workDeadline: '1700003600'},
    ],
    [GOLDEN.resultSubmitted, 'submitted', {jobId: '7', resultHash: H, reviewDeadline: '1700007200'}],
    [
      GOLDEN.jobDisputed,
      'disputed',
      {jobId: '7', disputeBond: '500', disputeDeadline: '1700010800', reasonHash: H},
    ],
    [
      GOLDEN.jobDisputedNoReason,
      'disputed',
      {jobId: '7', disputeBond: '500', disputeDeadline: '1700010800', reasonHash: null},
    ],
    [GOLDEN.disputeResolved, 'dispute_resolved', {jobId: '7', forWorker: true, arbiter: 'arbiter.test.near'}],
    // 1.0.0 wrote job_id alone; 1.1.0 adds the bond split. Both are read.
    [GOLDEN.disputeExpired, 'dispute_expired', {jobId: '7', bondToWorker: null, bondToClient: null}],
    [GOLDEN.disputeExpiredSplit, 'dispute_expired', {jobId: '7', bondToWorker: '250', bondToClient: '250'}],
    [
      GOLDEN.jobSettled,
      'settled',
      {jobId: '7', workerAgentId: '2', paid: '19800', fee: '200', outcome: 'Success'},
    ],
    [
      GOLDEN.jobSettledUnresolved,
      'settled',
      {jobId: '7', workerAgentId: '2', paid: '19800', fee: '200', outcome: 'Unresolved'},
    ],
    [
      GOLDEN.jobRefundedUndelivered,
      'refunded',
      {jobId: '7', clientAgentId: '1', amount: '20000', reason: 'undelivered', outcome: 'Failed'},
    ],
    [
      GOLDEN.jobRefundedCancelled,
      'refunded',
      {jobId: '7', clientAgentId: '1', amount: '20000', reason: 'cancelled', outcome: null},
    ],
    [
      GOLDEN.jobRefundedDispute,
      'refunded',
      {jobId: '7', clientAgentId: '1', amount: '20000', reason: 'dispute', outcome: 'DisputeLost'},
    ],
    [GOLDEN.bondSeized, 'bond_seized', {jobId: '7', workerAgentId: '2', clientAgentId: '1', amount: '1000'}],
    [GOLDEN.disputeBondSettled, 'dispute_bond_settled', {jobId: '7', toAgentId: '1', amount: '500'}],
    [
      GOLDEN.directPaid,
      'direct_paid',
      {
        jobId: '8',
        clientAgentId: '1',
        workerAgentId: '2',
        amount: '20000',
        fee: '200',
        specHash: H,
      },
    ],
  ])('%s', (line, kind, payload) => {
    const d = decode(line);
    expect(d).toEqual({kind, chainJobId: payload.jobId, payload});
  });

  it('ignores the events that are not about a job lifecycle', () => {
    expect(decode(GOLDEN.review)).toBeNull();
    expect(
      decode(
        'EVENT_JSON:{"standard":"pactora","version":"1.0.0","event":"agent_registered","data":[{"agent_id":1,"owner":"o.test.near","pending_wallet":"w.test.near","card_uri":"x"}]}',
      ),
    ).toBeNull();
  });

  it('ignores other standards', () => {
    expect(decode(GOLDEN.ftTransfer)).toBeNull();
  });

  it('refuses a version it was not written for, rather than misread money events', () => {
    expect(() => decode(GOLDEN.jobSettled.replace('"1.0.0"', '"2.0.0"'))).toThrow(/version 2\.0\.0/);
  });

  it('refuses a malformed event of a known kind', () => {
    // An amount as a JSON number would have lost precision above 2^53.
    expect(() => decode(GOLDEN.jobSettled.replace('"paid":"19800"', '"paid":19800'))).toThrow(/paid/);
    expect(() => decode(GOLDEN.jobSettled.replace('"outcome":"Success"', '"outcome":"Won"'))).toThrow(
      /outcome/,
    );
    expect(() => decode(GOLDEN.jobCreated.replace(`"spec_hash":"${H}"`, '"spec_hash":"0xab"'))).toThrow(
      /spec_hash/,
    );
    // Not wrapped in an array, as emit() always does.
    expect(() =>
      decode(GOLDEN.disputeExpired.replace('"data":[{"job_id":7}]', '"data":{"job_id":7}')),
    ).toThrow(/data/);
  });

  it('refuses a u64 that JSON.parse could not hold exactly', () => {
    expect(() =>
      decode(GOLDEN.disputeExpired.replace('"job_id":7', '"job_id":18446744073709551615')),
    ).toThrow(/job_id/);
  });
});

describe('nep141 ft_transfer → transfers', () => {
  it('reads every entry of a log line, with its position', () => {
    const line = log.ftTransfer([
      {from: 'alice.test.near', to: 'bob.test.near', amount: 100, memo: 'm'},
      {from: 'bob.test.near', to: 'carol.test.near', amount: '340282366920938463463374607431768211455'},
    ]);
    expect(decodeFtTransfers(parseEventLog(line)!)).toEqual([
      {from: 'alice.test.near', to: 'bob.test.near', amount: '100', entry: 0},
      {
        from: 'bob.test.near',
        to: 'carol.test.near',
        amount: '340282366920938463463374607431768211455',
        entry: 1,
      },
    ]);
  });

  it('reads the captured line', () => {
    expect(decodeFtTransfers(parseEventLog(GOLDEN.ftTransferMemo)!)).toEqual([
      {from: 'alice.test.near', to: 'bob.test.near', amount: '100', entry: 0},
    ]);
  });

  it('ignores mints, burns and other standards', () => {
    expect(decodeFtTransfers(parseEventLog(GOLDEN.ftMint)!)).toEqual([]);
    expect(decodeFtTransfers(parseEventLog(GOLDEN.jobSettled)!)).toEqual([]);
  });

  it('skips a malformed entry instead of storing it', () => {
    const line = GOLDEN.ftTransfer.replace('"amount":"100"', '"amount":100');
    expect(decodeFtTransfers(parseEventLog(line)!)).toEqual([]);
  });
});
