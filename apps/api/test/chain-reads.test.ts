import {describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '@pactora/config';
import type {NearClient, TxOutcome} from '@pactora/near';
import {makePaymentReader, makeTxEventsReader} from '../src/chain-reads.js';

/**
 * Reading a transaction someone else signed (docs/26 "prepare → sign →
 * confirm", and x402): only the Pactora contract's own events, from receipts
 * that succeeded, count.
 */

const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});
const PACTORA = config.chain('near:sandbox').contracts.Pactora;
const H = 'ab'.repeat(32);

const line = (event: string, data: Record<string, unknown>, standard = 'pactora') =>
  `EVENT_JSON:${JSON.stringify({standard, version: '1.0.0', event, data: [data]})}`;

function clientWith(outcome: TxOutcome, asked: {txHash?: string; signerId?: string} = {}) {
  return () =>
    ({
      txOutcome: async (txHash: string, signerId: string) => {
        asked.txHash = txHash;
        asked.signerId = signerId;
        return outcome;
      },
    }) as unknown as NearClient;
}

const receipt = (logs: string[], o: {executor?: string; ok?: boolean} = {}) => ({
  receiptId: 'R',
  executorId: o.executor ?? PACTORA,
  txHash: 'T',
  logs,
  ok: o.ok ?? true,
});

describe('makeTxEventsReader', () => {
  it("returns the Pactora job events of ok receipts, with the transaction's signer", async () => {
    const asked: {txHash?: string; signerId?: string} = {};
    const read = makeTxEventsReader(
      config,
      clientWith(
        {
          status: 'success',
          txHash: 'T',
          signerId: 'alice.test.near',
          receipts: [
            receipt([
              line('job_accepted', {job_id: 7, worker: 2, bond: '1', work_deadline: 9}),
              line('review', {job_id: 7}),
              'not an event',
              'EVENT_JSON:{broken',
            ]),
            // Someone else's contract logging our standard: ignored.
            receipt([line('job_settled', {job_id: 7})], {executor: 'evil.test.near'}),
            // A failed receipt: rolled back, ignored.
            receipt([line('result_submitted', {job_id: 7, result_hash: H})], {ok: false}),
            receipt([line('job_created', {job_id: 8}, 'nep141')]),
          ],
        },
        asked,
      ),
    );
    const r = await read({chainId: 'near:sandbox', txHash: 'T', signerId: 'alice.test.near'});
    expect(r).toEqual({
      status: 'success',
      signerId: 'alice.test.near',
      events: [{event: 'job_accepted', data: {job_id: 7, worker: 2, bond: '1', work_deadline: 9}}],
    });
    expect(asked).toEqual({txHash: 'T', signerId: 'alice.test.near'});
  });

  it('says pending and reverted, and a null signer when the node gave none', async () => {
    const pending = makeTxEventsReader(config, clientWith({status: 'pending', txHash: 'T', receipts: []}));
    expect(await pending({chainId: 'near:sandbox', txHash: 'T', signerId: 'a'})).toEqual({status: 'pending'});
    const failed = makeTxEventsReader(config, clientWith({status: 'failure', txHash: 'T', receipts: []}));
    expect(await failed({chainId: 'near:sandbox', txHash: 'T', signerId: 'a'})).toEqual({status: 'reverted'});
    const anon = makeTxEventsReader(config, clientWith({status: 'success', txHash: 'T', receipts: []}));
    expect(await anon({chainId: 'near:sandbox', txHash: 'T', signerId: 'a'})).toEqual({
      status: 'success',
      signerId: null,
      events: [],
    });
  });
});

describe('makePaymentReader, on top of it', () => {
  it('still reads direct_paid and job_created for x402', async () => {
    const read = makePaymentReader(
      config,
      clientWith({
        status: 'success',
        txHash: 'T',
        receipts: [
          receipt([
            line('direct_paid', {job_id: 1, client: 3, worker: 4, amount: '20000', fee: '200', spec_hash: H}),
            line('job_created', {job_id: 2, client: 3, worker: 5, amount: '50000', fee: '500', spec_hash: H}),
            line('job_accepted', {job_id: 2, worker: 5, bond: '0', work_deadline: 1}),
          ]),
        ],
      }),
    );
    expect(await read({chainId: 'near:sandbox', txHash: 'T', signerId: 'a'})).toEqual({
      status: 'success',
      directPaid: [{clientAgentId: 3n, workerAgentId: 4n, amount: 20000n, specHash: H}],
      jobCreated: [{clientAgentId: 3n, workerAgentId: 5n, amount: 50000n, specHash: H}],
    });
    const reverted = makePaymentReader(config, clientWith({status: 'failure', txHash: 'T', receipts: []}));
    expect(await reverted({chainId: 'near:sandbox', txHash: 'T', signerId: 'a'})).toEqual({
      status: 'reverted',
    });
  });
});
