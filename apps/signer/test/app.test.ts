import {describe, expect, it} from 'vitest';
import {PactoraError, ErrorCode} from '@pactora/shared';
import {createMetrics} from '@pactora/service';
import {buildSignerApp} from '../src/app.js';
import type {SignRequest} from '../src/signer.js';

/**
 * The signer's HTTP surface. `/sign` used to cast its body unchecked — a
 * missing agentId became NaN, a missing idempotencyKey became the literal
 * string "undefined" (shared by every malformed request), and a 500 sent the
 * raw error message back to the caller.
 */
const TOKEN = 't'.repeat(40);
const good = {
  agentId: 7,
  target: `0x${'22'.repeat(20)}`,
  data: '0xdeadbeef',
  spend: '20000',
  idempotencyKey: 'hire-0001-abcdef',
};

function app(
  sign: (req: SignRequest) => Promise<unknown> = async () => ({txHash: '0xab', nonce: 1, replayed: false}),
) {
  const seen: SignRequest[] = [];
  const instance = buildSignerApp({
    service: {
      sign: async (req) => {
        seen.push(req);
        return (await sign(req)) as never;
      },
    },
    chainId: 10143,
    keysKind: 'raw',
    token: TOKEN,
    checks: {database: async () => 1},
    metrics: createMetrics('signer-test'),
    logger: {warn: () => {}, error: () => {}},
  });
  return {instance, seen};
}

const post = (a: ReturnType<typeof app>['instance'], payload: unknown, auth = `Bearer ${TOKEN}`) =>
  a.inject({method: 'POST', url: '/sign', headers: {authorization: auth}, payload: payload as object});

describe('POST /sign', () => {
  it('signs a well-formed request, defaulting the chain to its own', async () => {
    const {instance, seen} = app();
    const res = await post(instance, good);
    expect(res.statusCode).toBe(200);
    expect(seen[0]).toEqual({
      agentId: 7,
      chainId: 10143,
      target: good.target,
      data: '0xdeadbeef',
      spend: 20_000n,
      idempotencyKey: good.idempotencyKey,
    });
  });

  it('refuses without the token, as RFC 7807 with a traceId', async () => {
    const {instance, seen} = app();
    const res = await post(instance, good, 'Bearer wrong');
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.json()).toMatchObject({code: 'UNAUTHORIZED', traceId: expect.any(String)});
    expect(seen).toHaveLength(0);
  });

  it.each([
    ['a missing agentId', {...good, agentId: undefined}],
    ['a missing idempotency key', {...good, idempotencyKey: undefined}],
    ['a target that is not an address', {...good, target: '0x1234'}],
    ['calldata that is not hex', {...good, data: 'call me'}],
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
      throw new Error('rpc said: 0xf86c808504a817c800825208 private detail');
    });
    const res = await post(instance, good);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/0xf86c|private detail/);
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

describe('health and readiness', () => {
  it('reports readiness from its checks', async () => {
    const {instance} = app();
    expect((await instance.inject({url: '/health'})).json()).toMatchObject({ok: true, chainId: 10143});
    expect((await instance.inject({url: '/ready'})).statusCode).toBe(200);
  });
});
