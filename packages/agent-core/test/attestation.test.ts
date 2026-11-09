import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ed25519} from '@noble/curves/ed25519';
import {secp256k1} from '@noble/curves/secp256k1';
import {keccak_256} from '@noble/hashes/sha3';
import {canonicalize, requireAttestation} from '@pactora/shared';
import {
  CachedBrain,
  FallbackBrain,
  Judge,
  JudgeAttestationFailed,
  NearAiBrain,
  buildJudgeBrain,
} from '../src/index.js';

/**
 * The NEAR AI judge's attestation (docs/24 §4): the response signature is
 * fetched, checked against the exact bytes exchanged and the signing key,
 * and a verdict that cannot be shown to come from the model is refused —
 * and not replaced by a recording. No network: `fetch` is a fake that signs
 * with keys this test holds (derived from fixed seeds, never real ones).
 */

const FIXTURES = join(import.meta.dirname, 'fixtures', 'near-ai');
const SUCCESS = readFileSync(join(FIXTURES, 'success.json'), 'utf8');
const SHAPE = JSON.parse(readFileSync(join(FIXTURES, 'signature.json'), 'utf8')) as Record<string, string>;
const KEY = 'sk-nearai-TEST-ONLY-0123456789abcdef';
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const judgeInput = {capability: 'market-research', task: {q: 'depth'}, result: {summary: 'x'}};

/** Test keys from fixed seeds: deterministic, and obviously not anyone's. */
const ED_PRIV = createHash('sha256').update('pactora-test-ed25519').digest();
const ED_PUB = Buffer.from(ed25519.getPublicKey(ED_PRIV)).toString('hex');
const EC_PRIV = createHash('sha256').update('pactora-test-secp256k1').digest();
const EC_ADDRESS = `0x${Buffer.from(keccak_256(secp256k1.getPublicKey(EC_PRIV, false).slice(1)).slice(-20)).toString('hex')}`;

function signEd25519(text: string): string {
  return Buffer.from(ed25519.sign(new TextEncoder().encode(text), ED_PRIV)).toString('hex');
}
function signEip191(text: string): string {
  const body = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const digest = keccak_256(Buffer.concat([prefix, body]));
  const sig = secp256k1.sign(digest, EC_PRIV);
  return `0x${Buffer.from(sig.toCompactRawBytes()).toString('hex')}${(sig.recovery + 27).toString(16)}`;
}

interface World {
  algo?: 'ed25519' | 'ecdsa';
  /** What the signature endpoint does instead of signing properly. */
  tamper?: 'signature' | 'text' | '404' | 'throw' | 'no-id';
}

/** A fake NEAR AI: the completion from the fixture, then a signature over exactly what was exchanged. */
function world(w: World = {}) {
  const algo = w.algo ?? 'ed25519';
  let requestBody = '';
  const responseBody = w.tamper === 'no-id' ? SUCCESS.replace('"id": "chatcmpl-fixture-0001",', '') : SUCCESS;
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith('/chat/completions')) {
      requestBody = String(init?.body);
      return new Response(responseBody, {status: 200, headers: {'content-type': 'application/json'}});
    }
    if (u.includes('/signature/')) {
      if (w.tamper === 'throw') throw new Error('a test tried to reach the network');
      if (w.tamper === '404') return new Response('{"error":"not found"}', {status: 404});
      const text = `${sha256(requestBody)}:${sha256(responseBody)}`;
      const signed = w.tamper === 'text' ? `${sha256('something else')}:${sha256(responseBody)}` : text;
      let signature = algo === 'ed25519' ? signEd25519(text) : signEip191(text);
      if (w.tamper === 'signature') signature = signature.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
      return new Response(
        JSON.stringify({
          ...SHAPE,
          text: signed,
          signature,
          signing_address: algo === 'ed25519' ? ED_PUB : EC_ADDRESS,
          signing_algo: algo,
        }),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  return {calls};
}

afterEach(() => vi.restoreAllMocks());

describe('the NEAR AI judge attestation', () => {
  it('ed25519: fetches the signature, checks it against the bytes exchanged, and returns the attestation with the verdict', async () => {
    const {calls} = world();
    const verdict = await new Judge(new NearAiBrain(undefined, KEY)).evaluate(judgeInput);
    expect(verdict).toMatchObject({accept: true, provider: 'near-ai'});
    expect(verdict.attestation).toMatchObject({
      provider: 'near-ai',
      model: 'zai-org/GLM-5.1-FP8',
      responseId: 'chatcmpl-fixture-0001',
      signingAlgo: 'ed25519',
      signingAddress: ED_PUB,
    });
    expect(verdict.attestation!.signedText).toMatch(/^[0-9a-f]{64}:[0-9a-f]{64}$/);
    const {attestation: _a, accept: _b, quality: _c, provider: _d, cached: _e, ...value} = verdict;
    void [_a, _b, _c, _d, _e];
    expect(verdict.attestation!.verdictHash).toBe(sha256(canonicalize({...value, accept: true})));
    expect(calls[1]).toBe('https://cloud-api.near.ai/v1/signature/chatcmpl-fixture-0001');
  });

  it('ecdsa (EIP-191): recovers the signer and matches the Ethereum address', async () => {
    world({algo: 'ecdsa'});
    const result = await new NearAiBrain(undefined, KEY).complete(verdictReq());
    expect(result.attestation).toMatchObject({signingAlgo: 'ecdsa', signingAddress: EC_ADDRESS});
  });

  it.each([
    ['a tampered signature', {tamper: 'signature'} as World, /does not verify/],
    ['a signature over other bytes', {tamper: 'text'} as World, /not the hash of the request and response/],
    ['no signature to fetch (404)', {tamper: '404'} as World, /answered 404/],
    ['a response without an id', {tamper: 'no-id'} as World, /no id/],
    ['a signature endpoint that cannot be reached', {tamper: 'throw'} as World, /could not be fetched/],
  ])('refuses the verdict on %s, and never falls back to a recording', async (_what, w, why) => {
    world(w);
    const nearAi = new NearAiBrain(undefined, KEY);
    const err = await nearAi.complete(verdictReq()).catch((e) => e);
    expect(err).toBeInstanceOf(JudgeAttestationFailed);
    expect((err as Error).message).toMatch(why);
    expect((err as Error).message).not.toContain(KEY);
    // The chain stops here: a cached verdict must not stand in for a signed one.
    const cached = new CachedBrain(join(FIXTURES, 'no-such-cache.json'));
    const chained = new FallbackBrain([nearAi, cached], {});
    await expect(chained.complete(verdictReq())).rejects.toBeInstanceOf(JudgeAttestationFailed);
  });

  it('with JUDGE_REQUIRE_ATTESTATION=0 an unsigned verdict is used, without an attestation', async () => {
    world({tamper: '404'});
    const result = await new NearAiBrain(undefined, KEY, undefined, false).complete(verdictReq());
    expect(result.value).toMatchObject({accept: true});
    expect(result.attestation).toBeUndefined();
  });

  it('is required by default for the near-ai judge, and switched off only by 0/false', () => {
    expect(requireAttestation({})).toBe(true);
    expect(requireAttestation({JUDGE_REQUIRE_ATTESTATION: '1'})).toBe(true);
    expect(requireAttestation({JUDGE_REQUIRE_ATTESTATION: '0'})).toBe(false);
    expect(requireAttestation({JUDGE_REQUIRE_ATTESTATION: 'false'})).toBe(false);
    expect(() =>
      buildJudgeBrain({
        env: {
          AGENT_MODE: 'live',
          JUDGE_PROVIDER: 'near-ai',
          NEAR_AI_API_KEY: KEY,
          JUDGE_REQUIRE_ATTESTATION: 'maybe',
        },
      }),
    ).toThrow(/JUDGE_REQUIRE_ATTESTATION/);
    expect(
      buildJudgeBrain({
        env: {
          AGENT_MODE: 'live',
          JUDGE_PROVIDER: 'near-ai',
          NEAR_AI_API_KEY: KEY,
          JUDGE_REQUIRE_ATTESTATION: '0',
        },
      })?.name,
    ).toMatch(/near-ai/);
  });
});

/** The request `Judge.evaluate` makes, captured from a spy brain. */
function verdictReq() {
  let captured: Parameters<NearAiBrain['complete']>[0] | undefined;
  const spy = {
    name: 'spy',
    available: async () => true,
    complete: async (r: Parameters<NearAiBrain['complete']>[0]) => {
      captured = r;
      throw new Error('captured');
    },
  };
  void new Judge(spy as never).evaluate(judgeInput).catch(() => undefined);
  return captured!;
}
