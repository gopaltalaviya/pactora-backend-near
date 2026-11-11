import {describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '@pactora/config';
import {contractCall, makeSignerSubmit, makeSignerWalletKeys} from '../src/submit.js';

/** The API's half of the signer handshake: it must present the token it was given. */
describe('calling the signer', () => {
  const config = loadConfig({
    contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
    env: {ENABLED_CHAINS: 'near:sandbox'},
  });

  const capture = () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify({txHash: 'Tx1'}), {status: 200});
    }) as unknown as typeof fetch;
    return {seen, fetchImpl};
  };

  const call = (submit: ReturnType<typeof makeSignerSubmit>) =>
    submit({
      agentId: 1,
      chainId: 'near:sandbox',
      kind: 'accept',
      job: {chainJobId: '7'} as never,
      spend: 0n,
      idempotencyKey: 'submit-test-1',
      payload: {},
    } as never);

  it('presents the token when it has one', async () => {
    const {seen, fetchImpl} = capture();
    await call(makeSignerSubmit({signerUrl: 'http://signer', signerToken: 'tok', config, fetchImpl}));
    expect(seen[0]!['authorization']).toBe('Bearer tok');
  });

  it('sends no authorization header when it has none', async () => {
    const {seen, fetchImpl} = capture();
    await call(makeSignerSubmit({signerUrl: 'http://signer', config, fetchImpl}));
    expect(seen[0]!['authorization']).toBeUndefined();
  });
});

/**
 * What the API reports when the signer does not answer as expected. v1 had no
 * timeout on this fetch, and reported ANY refusal without a recognised code as
 * INSUFFICIENT_FUNDS — telling an agent to top up gas when the signer was down.
 */
describe('when the signer misbehaves', () => {
  const config = loadConfig({
    contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
    env: {ENABLED_CHAINS: 'near:sandbox'},
  });
  const call = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
    makeSignerSubmit({signerUrl: 'http://signer', config, fetchImpl, timeoutMs: 50, ...over})({
      agentId: 1,
      chainId: 'near:sandbox',
      kind: 'accept',
      job: {chainJobId: '7'} as never,
      spend: 0n,
      idempotencyKey: 'submit-test-2',
      payload: {},
      traceId: 'trace-abc',
    } as never);
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      return (err as {code?: string}).code;
    }
    return 'resolved';
  };

  it('gives up after its timeout, as a retryable outage', async () => {
    const hangs = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
      )) as unknown as typeof fetch;
    expect(await codeOf(call(hangs))).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('reports a signer with no answer as an outage, not as an empty wallet', async () => {
    const down = (async () => new Response('bad gateway', {status: 502})) as unknown as typeof fetch;
    expect(await codeOf(call(down))).toBe('UPSTREAM_UNAVAILABLE');
    const refusedMe = (async () =>
      new Response(JSON.stringify({code: 'UNAUTHORIZED'}), {status: 401})) as unknown as typeof fetch;
    expect(await codeOf(call(refusedMe))).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('passes a real refusal through with its code', async () => {
    const capped = (async () =>
      new Response(JSON.stringify({code: 'BUDGET_EXCEEDED', detail: 'cap', retryAfter: 60}), {
        status: 402,
      })) as unknown as typeof fetch;
    expect(await codeOf(call(capped))).toBe('BUDGET_EXCEEDED');
  });

  it('forwards the request id, so one id follows a hire into the signer', async () => {
    let seen: Record<string, string> = {};
    const f = (async (_u: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return new Response(JSON.stringify({txHash: 'Tx1'}), {status: 200});
    }) as unknown as typeof fetch;
    await call(f);
    expect(seen['x-request-id']).toBe('trace-abc');
  });
});

/**
 * What the API asks the signer to call (docs/NEAR-WIRE.md §6): the contract's
 * own method and argument names, and the contract's agent ids — never the
 * database's serial.
 */
describe('the contract call for each action', () => {
  const config = loadConfig({
    contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
    env: {ENABLED_CHAINS: 'near:sandbox'},
  });
  const chain = config.chain('near:sandbox');
  const H = 'a'.repeat(64);
  const job = {id: 3, chainJobId: '17'};
  const hire = {clientChainAgentId: '1001', workerChainAgentId: '1002', specHash: H};

  it('hires through create_job with the windows from the config', () => {
    expect(contractCall('createJob', {job: undefined, payload: hire, chain, spend: 50_000n})).toEqual({
      method: 'create_job',
      args: {
        client_id: 1001,
        worker_id: 1002,
        amount: '50000',
        spec_hash: H,
        accept_window: chain.params.acceptWindowSeconds,
        work_window: chain.params.workWindowSeconds,
      },
    });
  });

  it('pays through direct_pay', () => {
    expect(contractCall('directPay', {job: undefined, payload: hire, chain, spend: 20_000n})).toEqual({
      method: 'direct_pay',
      args: {client_id: 1001, worker_id: 1002, amount: '20000', spec_hash: H},
    });
  });

  it('names the job by its on-chain id for every later step', () => {
    expect(contractCall('accept', {job, payload: {}, chain})).toEqual({
      method: 'accept_job',
      args: {job_id: 17},
    });
    expect(contractCall('submitResult', {job, payload: {resultHash: H}, chain})).toEqual({
      method: 'submit_result',
      args: {job_id: 17, result_hash: H},
    });
    expect(contractCall('approve', {job, payload: {}, chain})).toEqual({
      method: 'approve',
      args: {job_id: 17, review_hash: null},
    });
    expect(contractCall('dispute', {job, payload: {reasonHash: H}, chain})).toEqual({
      method: 'dispute',
      args: {job_id: 17, reason_hash: H},
    });
    expect(contractCall('cancel', {job, payload: {}, chain})).toEqual({method: 'cancel', args: {job_id: 17}});
  });

  it('refuses rather than guesses: no on-chain id, no agent ids, no hash, no amount', () => {
    expect(() => contractCall('accept', {job: {id: 3, chainJobId: null}, payload: {}, chain})).toThrow(
      /no on-chain id/,
    );
    expect(() =>
      contractCall('createJob', {job: undefined, payload: {specHash: H}, chain, spend: 1n}),
    ).toThrow(/clientChainAgentId/);
    expect(() =>
      contractCall('createJob', {job: undefined, payload: {...hire, specHash: '0x' + H}, chain, spend: 1n}),
    ).toThrow(/spec hash/);
    expect(() => contractCall('directPay', {job: undefined, payload: hire, chain, spend: 0n})).toThrow(
      /positive/,
    );
    expect(() => contractCall('submitResult', {job, payload: {}, chain})).toThrow(/sha256/);
  });

  it('sends {method, args} to /sign and reads the new job id from the result', async () => {
    let body: Record<string, unknown> = {};
    let url = '';
    const fetchImpl = (async (u: string, init: RequestInit) => {
      url = u;
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({txHash: 'Tx1', nonce: 5, replayed: false, result: 42}), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const out = await makeSignerSubmit({signerUrl: 'http://signer', config, fetchImpl})({
      agentId: 9,
      chainId: 'near:sandbox',
      kind: 'createJob',
      spend: 50_000n,
      idempotencyKey: 'k',
      payload: hire,
    });
    expect(url).toBe('http://signer/sign');
    expect(body).toMatchObject({agentId: 9, chainId: 'near:sandbox', method: 'create_job', spend: '50000'});
    expect(out).toEqual({txHash: 'Tx1', chainJobId: '42'});
  });

  it('asks the signer for wallet keys and acceptances (registration)', async () => {
    const calls: {url: string; body: unknown}[] = [];
    const fetchImpl = (async (u: string, init: RequestInit) => {
      calls.push({url: u, body: JSON.parse(String(init.body))});
      return new Response(
        JSON.stringify(
          u.endsWith('/keys') ? {publicKey: 'ed25519:abc'} : {txHash: 'Tx2', alreadyAccepted: false},
        ),
        {status: 200},
      );
    }) as unknown as typeof fetch;
    const keys = makeSignerWalletKeys({signerUrl: 'http://signer', config, fetchImpl});
    expect(await keys.publicKeyFor({chainId: 'near:sandbox', walletAddress: 'bot.alice.test.near'})).toBe(
      'ed25519:abc',
    );
    expect(
      await keys.accept({chainId: 'near:sandbox', walletAddress: 'bot.alice.test.near', chainAgentId: '5'}),
    ).toEqual({
      txHash: 'Tx2',
      alreadyAccepted: false,
    });
    expect(calls).toEqual([
      {url: 'http://signer/keys', body: {walletAddress: 'bot.alice.test.near'}},
      {
        url: 'http://signer/keys/accept',
        body: {chainId: 'near:sandbox', walletAddress: 'bot.alice.test.near', chainAgentId: '5'},
      },
    ]);
  });
});
