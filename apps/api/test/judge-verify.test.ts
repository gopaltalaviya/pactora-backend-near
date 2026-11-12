import {describe, expect, it, vi} from 'vitest';
import {nearAiSigningAddress} from '../src/judge-verify.js';

/**
 * Reading NEAR AI's public attestation report (2026-11-12). The shape is the
 * one `GET https://cloud-api.near.ai/v1/attestation/report?model=…` answered
 * that day, trimmed to the fields read here.
 */

const MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';
const REPORT = {
  gateway_attestation: {signing_address: '0xb98a789cdc4817275f5155593ba73ef2a957e779', signing_algo: 'ecdsa'},
  model_attestations: [
    {model_name: MODEL, signing_address: '0xfdbd7952498b333206f360d71d97a1e0961e8ddf', signing_algo: 'ecdsa'},
  ],
};

describe('nearAiSigningAddress', () => {
  it("answers the model's enclave key, not the gateway's, asking for the algorithm by name", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(REPORT)));
    const lookup = nearAiSigningAddress(
      'https://cloud-api.near.ai/v1/',
      fetchImpl as unknown as typeof fetch,
    );
    expect(await lookup(MODEL, 'ecdsa')).toBe('0xfdbd7952498b333206f360d71d97a1e0961e8ddf');
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(
      'https://cloud-api.near.ai/v1/attestation/report?model=Qwen%2FQwen3.6-35B-A3B-FP8&signing_algo=ecdsa',
    );
  });

  it('answers null for a model the report does not list, or another algorithm', async () => {
    const lookup = nearAiSigningAddress(
      undefined,
      (async () => new Response(JSON.stringify(REPORT))) as unknown as typeof fetch,
    );
    expect(await lookup('other/model', 'ecdsa')).toBeNull();
    expect(await lookup(MODEL, 'ed25519')).toBeNull();
  });

  it('asks once per model in ten minutes, and throws on an error status', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(REPORT)));
    const lookup = nearAiSigningAddress(undefined, fetchImpl as unknown as typeof fetch);
    await lookup(MODEL, 'ecdsa');
    await lookup(MODEL, 'ecdsa');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const down = nearAiSigningAddress(
      undefined,
      (async () => new Response('no', {status: 503})) as unknown as typeof fetch,
    );
    await expect(down(MODEL, 'ecdsa')).rejects.toThrow(/503/);
  });
});

/**
 * The attestation of a real NEAR AI verdict (2026-11-12, Qwen/Qwen3.6-35B-A3B-FP8,
 * ECDSA): the sandbox demo's judged job, whose verdict hash the contract holds
 * as its review_hash. Public data only: a signature, its address and hashes.
 */
describe('checkJudge on a real NEAR AI attestation', async () => {
  const {checkJudge} = await import('../src/judge-verify.js');
  const {realAttestation} = await import('./fixtures/near-ai-attestation-2026-11-12.js');
  const real = {...realAttestation};
  const nearAi = async () => '0xfdbd7952498b333206f360d71d97a1e0961e8ddf';

  it('verifies, against the key NEAR AI attests for the model', async () => {
    expect(await checkJudge(real, nearAi)).toEqual({ok: true});
  });

  it('a changed signed text is refused, and another attested key is not stored', async () => {
    const tampered = {
      ...real,
      signedText: real.signedText.replace(/.$/, (c: string) => (c === '0' ? '1' : '0')),
    };
    expect(await checkJudge(tampered, nearAi)).toMatchObject({
      ok: false,
      refuse: expect.stringMatching(/does not verify/),
    });
    expect(await checkJudge(real, async () => '0x' + '11'.repeat(20))).toMatchObject({
      ok: false,
      drop: expect.any(String),
    });
  });
});
