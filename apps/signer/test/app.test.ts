import {describe, expect, it} from 'vitest';
import {PactoraError, ErrorCode} from '@pactora/shared';
import {createMetrics} from '@pactora/service';
import {buildSignerApp} from '../src/app.js';
import type {AcceptRequest, SignRequest} from '../src/signer.js';

/**
 * The signer's HTTP surface: `/sign`, `/keys`, `/keys/accept`, `/health`.
 * Every body is a schema, every refusal RFC 7807 with a traceId, and a 500
 * never carries an internal message.
 */
const TOKEN = 't'.repeat(40);
const good = {
  agentId: 7,
  method: 'accept_job',
  args: {job_id: 3},
  spend: '0',
  idempotencyKey: 'hire-0001-abcdef',
};

function app(
  sign: (req: SignRequest) => Promise<unknown> = async () => ({
    txHash: 'H',
    nonce: 1,
    replayed: false,
    result: null,
  }),
  opts: {
    ensure?: (wallet: string) => Promise<{publicKey: string; created: boolean}>;
    accept?: (req: AcceptRequest) => Promise<unknown>;
  } = {},
) {
  const seen: SignRequest[] = [];
  const accepted: AcceptRequest[] = [];
  const instance = buildSignerApp({
    service: {
      sign: async (req) => {
        seen.push(req);
        return (await sign(req)) as never;
      },
      acceptWallet: async (req) => {
        accepted.push(req);
        return (await (opts.accept ?? (async () => ({txHash: 'A', alreadyAccepted: false})))(req)) as never;
      },
    },
    keys: {ensure: opts.ensure ?? (async () => ({publicKey: 'ed25519:PUB', created: true}))},
    chainId: 'near:testnet',
    keysKind: 'test',
    token: TOKEN,
    checks: {database: async () => 1},
    metrics: createMetrics('signer-test'),
    logger: {warn: () => {}, error: () => {}},
    wallets: () => ({
      checkedAt: 'now',
      wallets: [{account: 'bot.testnet', role: 'signing-key', balanceYocto: '5', low: true}],
      anyLow: true,
    }),
  });
  return {instance, seen, accepted};
}

const post = (
  a: ReturnType<typeof app>['instance'],
  payload: unknown,
  url = '/sign',
  auth = `Bearer ${TOKEN}`,
) => a.inject({method: 'POST', url, headers: {authorization: auth}, payload: payload as object});

describe('POST /sign', () => {
  it('passes a well-formed request through, defaulting the chain to its own', async () => {
    const {instance, seen} = app();
    const res = await post(instance, good);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({txHash: 'H', nonce: 1, replayed: false, result: null});
    expect(seen[0]).toEqual({
      agentId: 7,
      chainId: 'near:testnet',
      method: 'accept_job',
      args: {job_id: 3},
      spend: 0n,
      idempotencyKey: good.idempotencyKey,
    });
  });

  it('refuses without the token, as RFC 7807 with a traceId', async () => {
    const {instance, seen} = app();
    const res = await post(instance, good, '/sign', 'Bearer wrong');
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.json()).toMatchObject({code: 'UNAUTHORIZED', traceId: expect.any(String)});
    expect(seen).toHaveLength(0);
  });

  it.each([
    ['a missing agentId', {...good, agentId: undefined}],
    ['a missing idempotency key', {...good, idempotencyKey: undefined}],
    ['a missing method', {...good, method: undefined}],
    ['args that are not an object', {...good, args: 'job 3'}],
    ['a negative spend', {...good, spend: '-5'}],
  ])('refuses %s with 422, before signing anything', async (_label, payload) => {
    const {instance, seen} = app();
    const res = await post(instance, payload);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe(ErrorCode.SCHEMA_MISMATCH);
    expect(seen).toHaveLength(0);
  });

  it('passes a refusal through with its status, code and Retry-After', async () => {
    const {instance} = app(async () => {
      throw new PactoraError(ErrorCode.BUDGET_EXCEEDED, 'over the daily cap', 3600);
    });
    const res = await post(instance, good);
    expect(res.statusCode).toBe(402);
    expect(res.headers['retry-after']).toBe('3600');
    expect(res.json()).toMatchObject({code: 'BUDGET_EXCEEDED', detail: 'over the daily cap'});
  });

  /** An RPC error can carry a raw transaction; that is the log's business, not the caller's. */
  it('never returns the raw message of an internal error', async () => {
    const {instance} = app(async () => {
      throw new Error('rpc said: signed_tx_base64=AAAA private detail');
    });
    const res = await post(instance, good);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/signed_tx|private detail/);
    expect(res.json()).toMatchObject({code: 'INTERNAL', traceId: expect.any(String)});
  });

  it('counts refusals by code on /metrics', async () => {
    const {instance} = app(async () => {
      throw new PactoraError(ErrorCode.INSUFFICIENT_FUNDS, 'gas');
    });
    await post(instance, good);
    const metrics = (await instance.inject({url: '/metrics'})).body;
    expect(metrics).toMatch(/signer_refusals_total\{[^}]*code="INSUFFICIENT_FUNDS"[^}]*\} 1/);
  });
});

describe('POST /keys', () => {
  it('answers the wallet’s public key, and never anything secret', async () => {
    const asked: string[] = [];
    const {instance} = app(undefined, {
      ensure: async (w) => {
        asked.push(w);
        return {publicKey: 'ed25519:PUB', created: false};
      },
    });
    const res = await post(instance, {walletAddress: 'bot.alice.testnet'}, '/keys');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({publicKey: 'ed25519:PUB'});
    expect(asked).toEqual(['bot.alice.testnet']);
  });

  it('refuses an account id NEAR would not accept, another network, and no token', async () => {
    const {instance} = app();
    expect((await post(instance, {walletAddress: '0xABC'}, '/keys')).statusCode).toBe(422);
    const other = await post(instance, {walletAddress: 'a.near', chainId: 'near:mainnet'}, '/keys');
    expect(other.json().code).toBe('CHAIN_MISMATCH');
    expect((await post(instance, {walletAddress: 'a.testnet'}, '/keys', 'Bearer no')).statusCode).toBe(401);
  });
});

describe('POST /keys/accept', () => {
  const body = {chainId: 'near:testnet', walletAddress: 'bot.alice.testnet', chainAgentId: '12'};

  it('passes the request to the service and answers {txHash, alreadyAccepted}', async () => {
    const {instance, accepted} = app();
    const res = await post(instance, body, '/keys/accept');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({txHash: 'A', alreadyAccepted: false});
    expect(accepted).toEqual([body]);
  });

  it.each([
    ['a missing chainId', {...body, chainId: undefined}],
    ['a non-decimal agent id', {...body, chainAgentId: '0x0c'}],
    ['a numeric agent id', {...body, chainAgentId: 12}],
    ['a bad wallet', {...body, walletAddress: 'Bot!'}],
  ])('refuses %s with 422', async (_label, payload) => {
    const {instance, accepted} = app();
    expect((await post(instance, payload, '/keys/accept')).statusCode).toBe(422);
    expect(accepted).toHaveLength(0);
  });

  it('passes a refusal through', async () => {
    const {instance} = app(undefined, {
      accept: async () => {
        throw new PactoraError(ErrorCode.NOT_FOUND, 'no key');
      },
    });
    const res = await post(instance, body, '/keys/accept');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

describe('health and readiness', () => {
  it('reports readiness, the chain, and each account’s balance in yocto', async () => {
    const {instance} = app();
    const health = (await instance.inject({url: '/health'})).json();
    expect(health).toMatchObject({ok: true, chainId: 'near:testnet'});
    expect(health.wallets.wallets[0]).toMatchObject({account: 'bot.testnet', balanceYocto: '5'});
    expect((await instance.inject({url: '/ready'})).statusCode).toBe(200);
  });
});
