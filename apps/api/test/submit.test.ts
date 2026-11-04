import {describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '@pactora/config';
import {makeSignerSubmit} from '../src/submit.js';

/** The API's half of the signer handshake: it must present the token it was given. */
describe('calling the signer', () => {
  const config = loadConfig({
    contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
    env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
  });

  const capture = () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify({txHash: '0x' + 'ab'.repeat(32)}), {status: 200});
    }) as unknown as typeof fetch;
    return {seen, fetchImpl};
  };

  const call = (submit: ReturnType<typeof makeSignerSubmit>) =>
    submit({
      agentId: 1,
      chainId: 31337,
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
    contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
    env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
  });
  const call = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
    makeSignerSubmit({signerUrl: 'http://signer', config, fetchImpl, timeoutMs: 50, ...over})({
      agentId: 1,
      chainId: 31337,
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
      return new Response(JSON.stringify({txHash: '0x' + 'ab'.repeat(32)}), {status: 200});
    }) as unknown as typeof fetch;
    await call(f);
    expect(seen['x-request-id']).toBe('trace-abc');
  });
});
