import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@pactora/config';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {
  X402_SCHEME,
  decodePaymentHeader,
  encodePaymentHeader,
  type PaymentRequirements,
} from '@pactora/shared';
import {buildApp, EventBus} from '../src/app.js';
import type {PaymentReading} from '../src/chain-reads.js';
import {addr, chainDeps, signedRegistration} from './helpers/register.js';

/**
 * The x402 facilitator: settle as the client, verify and redeem as the worker.
 *
 * The chain is a fake here, and deliberately a SUSPICIOUS one: every test
 * that expects a payment to be honoured has to make the fake emit the exact
 * `DirectPaid` the escrow would — right worker, right spec hash, enough
 * money. A fake that said "success" to anything would pass a facilitator
 * that checked nothing. The live check is `DEMO_X402=1 pnpm demo`.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';

const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});
const chain = config.chains['near:sandbox']!;
const TOKEN = chain.contracts['PaymentToken'] as string;
const WORKER_WALLET = addr('11');
/** A base58 transaction hash (NEAR's form): 44 characters, no 0, O, I or l. */
const fakeTx = (n: number) => `Tx${String(n).replace(/0/g, 'o')}`.padEnd(44, 'z');

let app: FastifyInstance;
let db: Db;
let submitted: {kind: string; spend: bigint; idempotencyKey: string}[] = [];
/** What the fake chain says about the next transaction asked about. */
let reading: PaymentReading | 'throw' = {status: 'pending'};

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    ...chainDeps(config),
    db,
    chains: config.chains,
    defaultChainId: 'near:sandbox',
    bus: new EventBus(),
    submit: async (args) => {
      submitted.push({kind: args.kind, spend: args.spend, idempotencyKey: args.idempotencyKey});
      return {
        txHash: fakeTx(submitted.length),
        chainJobId: String(submitted.length),
      };
    },
    readPayment: async () => {
      if (reading === 'throw') throw new Error('RPC unreachable');
      return reading;
    },
  });
});

afterAll(async () => {
  await app.close();
  await closeDb(db);
});

beforeEach(async () => {
  submitted = [];
  reading = {status: 'pending'};
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, x402_redemptions RESTART IDENTITY CASCADE`,
  );
});

async function register(name: string, wallet: string, price = '20000') {
  const res = await signedRegistration(app, {
    name,
    capabilities: ['market-research'],
    pricePerTask: price,
    walletAddress: wallet,
    ownerAddress: addr('22'),
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as {agentId: number; apiKey: string};
  return body;
}

const auth = (apiKey: string, key?: string) => ({
  authorization: `Bearer ${apiKey}`,
  ...(key ? {'idempotency-key': key} : {}),
});

function quote(workerId: number, over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: X402_SCHEME,
    network: 'near:sandbox',
    maxAmountRequired: '20000',
    resource: 'http://127.0.0.1:9402/market-research',
    description: '',
    mimeType: 'application/json',
    payTo: WORKER_WALLET,
    maxTimeoutSeconds: 300,
    asset: TOKEN,
    extra: {agentId: workerId, capability: 'market-research'},
    ...over,
  };
}

async function setup() {
  const worker = await register('ResearchBot', WORKER_WALLET);
  const client = await register('Orchestrator', addr('33'), '0');
  return {worker, client};
}

async function settle(clientKey: string, req: PaymentRequirements, key = 'x402-payment-0001') {
  return app.inject({
    method: 'POST',
    url: '/v1/x402/settle',
    headers: auth(clientKey, key),
    payload: {paymentRequirements: req},
  });
}

/** Make the fake chain report exactly the DirectPaid the escrow would emit for this job. */
async function chainConfirms(
  jobId: string,
  over: {workerChainId?: bigint; specHash?: string; amount?: bigint} = {},
) {
  const [row] = (await db.execute(
    sql`SELECT j.spec_hash, j.amount, a.chain_agent_id FROM jobs j JOIN agents a ON a.id = j.worker_agent_id WHERE j.public_id = ${jobId}`,
  )) as unknown as {spec_hash: string; amount: string; chain_agent_id: string}[];
  reading = {
    status: 'success',
    directPaid: [
      {
        clientAgentId: 1n,
        workerAgentId: over.workerChainId ?? BigInt(row!.chain_agent_id),
        amount: over.amount ?? BigInt(row!.amount),
        specHash: over.specHash ?? row!.spec_hash,
      },
    ],
  };
}

const redeem = (apiKey: string, req: PaymentRequirements, paymentHeader: string, route = 'redeem') =>
  app.inject({
    method: 'POST',
    url: `/v1/x402/${route}`,
    headers: auth(apiKey),
    payload: {paymentRequirements: req, paymentHeader},
  });

describe('POST /v1/x402/settle — the client pays', () => {
  it('pays through directPay, binds the job to the resource, and hands back the X-PAYMENT header', async () => {
    const {worker, client} = await setup();
    const res = await settle(client.apiKey, quote(worker.agentId));

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.network).toBe('near:sandbox');
    expect(body.payer).toBe(client.agentId);
    expect(submitted).toEqual([expect.objectContaining({kind: 'directPay', spend: 20_000n})]);

    const header = decodePaymentHeader(body.paymentHeader);
    expect(header.payload).toEqual({jobId: body.jobId, txHash: body.transaction});

    const [job] = (await db.execute(
      sql`SELECT path, state, spec FROM jobs WHERE public_id = ${body.jobId}`,
    )) as unknown as {
      path: string;
      state: string;
      spec: {input: {x402: {resource: string}}};
    }[];
    expect(job!.path).toBe('direct');
    expect(job!.state).toBe('settled');
    expect(job!.spec.input.x402.resource).toBe('http://127.0.0.1:9402/market-research');
  });

  it('is the same payment when retried with the same Idempotency-Key', async () => {
    const {worker, client} = await setup();
    const first = (await settle(client.apiKey, quote(worker.agentId), 'x402-retry-key')).json();
    const again = (await settle(client.apiKey, quote(worker.agentId), 'x402-retry-key')).json();

    expect(again.jobId).toBe(first.jobId);
    expect(again.transaction).toBe(first.transaction);
    const [rows] = (await db.execute(sql`SELECT count(*)::int AS n FROM jobs`)) as unknown as {n: number}[];
    expect(rows?.n).toBe(1);
  });

  it('refuses a quote whose payTo is not the named agent’s wallet, and pays nothing', async () => {
    const {worker, client} = await setup();
    const res = await settle(client.apiKey, quote(worker.agentId, {payTo: addr('ee')}));
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/redirects the money/);
    expect(submitted).toHaveLength(0);
  });

  it('refuses a quote in a token other than this chain’s', async () => {
    const {worker, client} = await setup();
    const res = await settle(client.apiKey, quote(worker.agentId, {asset: addr('ab')}));
    expect(res.statusCode).toBe(409);
    expect(submitted).toHaveLength(0);
  });

  it('refuses a quote above the fast-path cap, because x402 has no escrow to fall back on', async () => {
    const {worker, client} = await setup();
    const res = await settle(client.apiKey, quote(worker.agentId, {maxAmountRequired: '30001'}));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PRICE_ABOVE_MAX');
    expect(submitted).toHaveLength(0);
  });

  it('refuses a quote for another network', async () => {
    const {worker, client} = await setup();
    const res = await settle(client.apiKey, quote(worker.agentId, {network: 'near:testnet'}));
    expect(res.json().code).toBe('CHAIN_MISMATCH');
    expect(submitted).toHaveLength(0);
  });

  it('refuses when the worker charges more than the quote says', async () => {
    const {worker, client} = await setup();
    const res = await settle(client.apiKey, quote(worker.agentId, {maxAmountRequired: '10000'}));
    expect(res.json().code).toBe('PRICE_ABOVE_MAX');
    expect(submitted).toHaveLength(0);
  });

  it('requires an Idempotency-Key, like every other spend', async () => {
    const {worker, client} = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/x402/settle',
      headers: auth(client.apiKey),
      payload: {paymentRequirements: quote(worker.agentId)},
    });
    expect(res.json().code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('POST /v1/x402/redeem — the worker checks, once', () => {
  async function paid() {
    const {worker, client} = await setup();
    const req = quote(worker.agentId);
    const body = (await settle(client.apiKey, req)).json();
    return {worker, client, req, header: body.paymentHeader as string, jobId: body.jobId as string};
  }

  it('honours a payment the chain confirms, exactly once', async () => {
    const {worker, client, req, header, jobId} = await paid();
    await chainConfirms(jobId);

    const first = (await redeem(worker.apiKey, req, header)).json();
    expect(first).toEqual({isValid: true, payer: client.agentId});

    const second = (await redeem(worker.apiKey, req, header)).json();
    expect(second.isValid).toBe(false);
    expect(second.invalidReason).toBe('already_redeemed');

    // verify reports it too, and changes nothing.
    expect((await redeem(worker.apiKey, req, header, 'verify')).json().invalidReason).toBe(
      'already_redeemed',
    );
  });

  it('lets exactly one of several concurrent redemptions win', async () => {
    const {worker, req, header, jobId} = await paid();
    await chainConfirms(jobId);

    const results = await Promise.all(Array.from({length: 5}, () => redeem(worker.apiKey, req, header)));
    expect(results.filter((r) => r.json().isValid)).toHaveLength(1);
  });

  it('verify has no side effects: a verified payment can still be redeemed', async () => {
    const {worker, req, header, jobId} = await paid();
    await chainConfirms(jobId);

    expect((await redeem(worker.apiKey, req, header, 'verify')).json().isValid).toBe(true);
    expect((await redeem(worker.apiKey, req, header, 'verify')).json().isValid).toBe(true);
    expect((await redeem(worker.apiKey, req, header)).json().isValid).toBe(true);
  });

  it('says "pending" for a payment not yet confirmed, and does not burn it', async () => {
    const {worker, req, header, jobId} = await paid();

    const early = (await redeem(worker.apiKey, req, header)).json();
    expect(early.invalidReason).toBe('payment_pending');

    await chainConfirms(jobId);
    expect((await redeem(worker.apiKey, req, header)).json().isValid).toBe(true);
  });

  it('refuses a payment whose transaction reverted', async () => {
    const {worker, req, header} = await paid();
    reading = {status: 'reverted'};
    expect((await redeem(worker.apiKey, req, header)).json().invalidReason).toBe('payment_reverted');
  });

  it('refuses when the chain shows the money went to a different worker', async () => {
    const {worker, req, header, jobId} = await paid();
    await chainConfirms(jobId, {workerChainId: 999_999n});
    expect((await redeem(worker.apiKey, req, header)).json().invalidReason).toBe('transaction_mismatch');
  });

  it('refuses when the chain shows a payment for a different job', async () => {
    const {worker, req, header, jobId} = await paid();
    await chainConfirms(jobId, {specHash: '77'.repeat(32)});
    expect((await redeem(worker.apiKey, req, header)).json().invalidReason).toBe('transaction_mismatch');
  });

  it('refuses when the chain shows less than the resource costs', async () => {
    const {worker, req, header, jobId} = await paid();
    await chainConfirms(jobId, {amount: 1n});
    expect((await redeem(worker.apiKey, req, header)).json().invalidReason).toBe('transaction_mismatch');
  });

  it('refuses a header naming a transaction other than the one that paid', async () => {
    const {worker, req, header, jobId} = await paid();
    await chainConfirms(jobId);
    const forged = decodePaymentHeader(header);
    forged.payload.txHash = fakeTx(99);
    expect((await redeem(worker.apiKey, req, encodePaymentHeader(forged))).json().invalidReason).toBe(
      'transaction_mismatch',
    );
  });

  it('refuses a payment presented for a different resource', async () => {
    const {worker, req, header, jobId} = await paid();
    await chainConfirms(jobId);
    const other = {...req, resource: 'http://127.0.0.1:9402/something-else'};
    expect((await redeem(worker.apiKey, other, header)).json().invalidReason).toBe('wrong_resource');
  });

  it('refuses a cheaper payment for a dearer resource', async () => {
    const {worker, req, header, jobId} = await paid();
    await chainConfirms(jobId);
    const dearer = {...req, maxAmountRequired: '25000'};
    expect((await redeem(worker.apiKey, dearer, header)).json().invalidReason).toBe('insufficient_amount');
  });

  it('lets only the payee redeem — and a stranger’s attempt does not burn the payment', async () => {
    const {worker, client, req, header, jobId} = await paid();
    await chainConfirms(jobId);

    const stranger = (await redeem(client.apiKey, req, header)).json();
    expect(stranger.invalidReason).toBe('wrong_payee');

    expect((await redeem(worker.apiKey, req, header)).json().isValid).toBe(true);
  });

  it('refuses a payment that does not exist', async () => {
    const {worker, req, header} = await paid();
    const ghost = decodePaymentHeader(header);
    ghost.payload.jobId = '00000000-0000-4000-8000-000000000000';
    expect((await redeem(worker.apiKey, req, encodePaymentHeader(ghost))).json().invalidReason).toBe(
      'unknown_payment',
    );
  });

  it('refuses an escrow job presented as an x402 payment', async () => {
    const {worker, client, req} = await setup().then(async (s) => ({...s, req: quote(s.worker.agentId)}));
    const hired = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: auth(client.apiKey, 'escrow-hire-0001'),
      payload: {
        workerAgentId: String(worker.agentId),
        spec: {capability: 'market-research', input: {}},
        maxPrice: '20000',
        path: 'escrow',
      },
    });
    const {jobId, txHash} = hired.json();
    const header = encodePaymentHeader({
      x402Version: 1,
      scheme: X402_SCHEME,
      network: 'near:sandbox',
      payload: {jobId, txHash},
    });
    expect((await redeem(worker.apiKey, req, header)).json().invalidReason).toBe('not_direct_payment');
  });

  it('answers 422 to an X-PAYMENT that is not a payment at all', async () => {
    const {worker, req} = await paid();
    const res = await redeem(worker.apiKey, req, 'bm90IGEgcGF5bWVudA==');
    expect(res.statusCode).toBe(422);
  });

  it('treats an unreachable chain as an error, never as either answer', async () => {
    const {worker, req, header} = await paid();
    reading = 'throw';
    const res = await redeem(worker.apiKey, req, header);
    expect(res.statusCode).toBe(500);
    // …and nothing was marked used.
    const [rows] = (await db.execute(sql`SELECT count(*)::int AS n FROM x402_redemptions`)) as unknown as {
      n: number;
    }[];
    expect(rows?.n).toBe(0);
  });

  it('requires credentials', async () => {
    const {req, header} = await paid();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/x402/redeem',
      payload: {paymentRequirements: req, paymentHeader: header},
    });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * v3: the refundable scheme. `pactora-escrow` settles as an escrow job, so the
 * money waits in the escrow while the worker works and a failed job refunds.
 * Not capped at fastPathMax (nothing is paid before the work), only at the
 * escrow's maxJobAmount.
 */
describe('the escrow-backed scheme (pactora-escrow)', () => {
  const escrowQuote = (workerId: number, over: Partial<PaymentRequirements> = {}) =>
    quote(workerId, {scheme: 'pactora-escrow', ...over} as Partial<PaymentRequirements>);

  /** Make the fake chain report the JobCreated the escrow would emit for this job. */
  async function chainCreated(jobId: string, over: {workerChainId?: bigint} = {}) {
    const [row] = (await db.execute(
      sql`SELECT j.spec_hash, j.amount, a.chain_agent_id FROM jobs j JOIN agents a ON a.id = j.worker_agent_id WHERE j.public_id = ${jobId}`,
    )) as unknown as {spec_hash: string; amount: string; chain_agent_id: string}[];
    reading = {
      status: 'success',
      directPaid: [],
      jobCreated: [
        {
          clientAgentId: 1n,
          workerAgentId: over.workerChainId ?? BigInt(row!.chain_agent_id),
          amount: BigInt(row!.amount),
          specHash: row!.spec_hash,
        },
      ],
    };
  }

  it('settles as an escrow job and says so in the header', async () => {
    const {worker, client} = await setup();
    const res = await settle(client.apiKey, escrowQuote(worker.agentId));
    expect(res.statusCode).toBe(200);
    expect(submitted).toEqual([expect.objectContaining({kind: 'createJob', spend: 20_000n})]);
    const header = decodePaymentHeader(res.json().paymentHeader);
    expect(header.scheme).toBe('pactora-escrow');
    const [job] = (await db.execute(
      sql`SELECT path FROM jobs WHERE public_id = ${res.json().jobId}`,
    )) as unknown as {path: string}[];
    expect(job!.path).toBe('escrow');
  });

  it('takes a payment above the fast-path cap, up to maxJobAmount', async () => {
    const big = (chain.params.fastPathMax as bigint) * 2n;
    const worker = await register('Big', WORKER_WALLET, big.toString());
    const client = await register('C', addr('33'), '0');
    const ok = await settle(client.apiKey, escrowQuote(worker.agentId, {maxAmountRequired: big.toString()}));
    expect(ok.statusCode).toBe(200);
    const over = (chain.params.maxJobAmount as bigint) + 1n;
    const refused = await settle(
      client.apiKey,
      escrowQuote(worker.agentId, {maxAmountRequired: over.toString()}),
      'x402-too-big-0001',
    );
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('is redeemed against the JobCreated the escrow emitted, not a DirectPaid', async () => {
    const {worker, client} = await setup();
    const paid = (await settle(client.apiKey, escrowQuote(worker.agentId))).json();
    reading = {status: 'success', directPaid: [], jobCreated: []};
    const none = (await redeem(worker.apiKey, escrowQuote(worker.agentId), paid.paymentHeader)).json();
    expect(none).toMatchObject({isValid: false, invalidReason: 'transaction_mismatch'});

    await chainCreated(paid.jobId);
    const good = (await redeem(worker.apiKey, escrowQuote(worker.agentId), paid.paymentHeader)).json();
    expect(good).toMatchObject({isValid: true, payer: client.agentId});
  });

  it('refuses a payment the client already took back', async () => {
    const {worker, client} = await setup();
    const paid = (await settle(client.apiKey, escrowQuote(worker.agentId))).json();
    await chainCreated(paid.jobId);
    await db.execute(sql`UPDATE jobs SET state = 'refunded' WHERE public_id = ${paid.jobId}`);
    const res = (await redeem(worker.apiKey, escrowQuote(worker.agentId), paid.paymentHeader)).json();
    expect(res).toMatchObject({isValid: false, invalidReason: 'payment_withdrawn'});
  });

  it('refuses a payment made under one scheme and presented under the other', async () => {
    const {worker, client} = await setup();
    const paid = (await settle(client.apiKey, escrowQuote(worker.agentId))).json();
    await chainCreated(paid.jobId);
    const res = (await redeem(worker.apiKey, quote(worker.agentId), paid.paymentHeader)).json();
    expect(res).toMatchObject({isValid: false, invalidReason: 'wrong_scheme'});
  });
});
