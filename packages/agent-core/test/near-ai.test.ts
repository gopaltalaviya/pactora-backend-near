import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspect} from 'node:util';
import {afterAll, afterEach, describe, expect, it, vi} from 'vitest';
import {
  BrainInvalidOutput,
  BrainUnavailable,
  JUDGE_SYSTEM,
  Judge,
  NearAiBrain,
  buildBrain,
  buildJudgeBrain,
  cacheKey,
} from '../src/index.js';

/**
 * The NEAR AI Cloud judge (docs.near.ai/cloud: an OpenAI-compatible chat
 * completions API at https://cloud-api.near.ai/v1, Bearer auth).
 *
 * No test here reaches the network: `fetch` is replaced, and the bodies are
 * the fixtures beside this file. They are written to the documented
 * OpenAI shape, not captured live — a live call spends the owner's quota.
 */
const FIXTURES = join(import.meta.dirname, 'fixtures', 'near-ai');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const reply = (name: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(fixture(name), {status, headers: {'content-type': 'application/json', ...headers}});

/** Looks like a key, is not one. Every test checks it never leaks. */
const KEY = 'sk-nearai-TEST-ONLY-0123456789abcdef';

/** No real waiting between retries; attestation off (its own tests are in attestation.test.ts). */
class FastNearAi extends NearAiBrain {
  waits: number[] = [];
  constructor(model?: string, apiKey?: string, baseUrl?: string, requireAttestation = false) {
    super(model, apiKey, baseUrl, requireAttestation);
  }
  protected override sleep(ms: number) {
    this.waits.push(ms);
    return Promise.resolve();
  }
}

const judgeInput = {capability: 'market-research', task: {q: 'depth'}, result: {summary: 'x'}};
const noLeak = (err: unknown) => {
  expect(String((err as Error).message)).not.toContain(KEY);
  expect(String((err as Error).stack)).not.toContain(KEY);
};

afterEach(() => vi.restoreAllMocks());

/** A fetch that must not be called: it fails the call instead of reaching the network. */
const offline = () =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('a test tried to reach the network');
  });

describe('NEAR AI Cloud as the judge', () => {
  it('posts an OpenAI-style chat completion with the key as a Bearer token, and returns the verdict', async () => {
    const calls: {url: string; init: RequestInit}[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({url: String(url), init: init!});
      return reply('success.json');
    });
    const verdict = await new Judge(new FastNearAi(undefined, KEY)).evaluate(judgeInput);

    expect(verdict).toMatchObject({accept: true, rating: 'good', provider: 'near-ai', cached: false});
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://cloud-api.near.ai/v1/chat/completions');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe('Qwen/Qwen3.6-35B-A3B-FP8');
    // 2026-11-12: the model reasons before it answers; 4,096 cut real replies off.
    expect(body.max_tokens).toBe(8_192);
    expect(body.messages[0]).toEqual({role: 'system', content: JUDGE_SYSTEM});
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('Verdict');
    // The judge reasons: thinking stays on.
    expect(body).not.toHaveProperty('chat_template_kwargs');
  });

  // 2026-11-12: a worker's structured output gains nothing from the model's
  // thinking, which cost ~10x the tokens and cut replies off at the limit.
  it('a worker brain asks NEAR AI to answer without thinking', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return reply('success.json');
    });
    const brain = buildBrain({
      role: 'worker',
      env: {AGENT_MODE: 'live', BRAIN_CHAIN: 'near-ai', NEAR_AI_API_KEY: KEY},
      cacheDir: mkdtempSync(join(tmpdir(), 'nearai-')),
    });
    await new Judge(brain).evaluate(judgeInput).catch(() => undefined);
    expect(bodies[0]).toMatchObject({chat_template_kwargs: {enable_thinking: false}});
  });

  it('takes the model and base URL from configuration', async () => {
    let url = '';
    let model = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u, init) => {
      url = String(u);
      model = JSON.parse(String(init?.body)).model;
      return reply('success.json');
    });
    await new Judge(new FastNearAi('deepseek-ai/DeepSeek-V3.1', KEY, 'https://example.test/v1/')).evaluate(
      judgeInput,
    );
    expect(url).toBe('https://example.test/v1/chat/completions');
    expect(model).toBe('deepseek-ai/DeepSeek-V3.1');
  });

  it('a body that is not JSON (a proxy error page) is an outage, so the chain moves on', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(fixture('malformed-body.txt'), {status: 200, headers: {'content-type': 'text/html'}}),
    );
    const err = await new FastNearAi(undefined, KEY).complete(verdictReq()).catch((e) => e);
    expect(err).toBeInstanceOf(BrainUnavailable);
    expect((err as BrainUnavailable).reason).toBe('outage');
    noLeak(err);
  });

  it('a reply whose text is not JSON is the model failing its schema, not retried elsewhere', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply('malformed-content.json'));
    const err = await new FastNearAi(undefined, KEY).complete(verdictReq()).catch((e) => e);
    expect(err).toBeInstanceOf(BrainInvalidOutput);
  });

  it('a reply cut off at the token limit is the provider failing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply('truncated.json'));
    const err = await new FastNearAi(undefined, KEY).complete(verdictReq()).catch((e) => e);
    expect(err).toBeInstanceOf(BrainUnavailable);
    expect((err as BrainUnavailable).reason).toBe('outage');
  });

  it('401: the key is rejected — not retried, and the key is not in the error', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply('401.json', 401));
    const err = await new FastNearAi(undefined, KEY).complete(verdictReq()).catch((e) => e);
    expect(err).toBeInstanceOf(BrainUnavailable);
    expect((err as BrainUnavailable).reason).toBe('auth');
    expect(fetch).toHaveBeenCalledTimes(1);
    noLeak(err);
  });

  it('429: retried with backoff as every provider is, then reported as the rate limit', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => reply('429.json', 429, {'retry-after': '3'}));
    const brain = new FastNearAi(undefined, KEY);
    const err = await brain.complete(verdictReq()).catch((e) => e);
    expect(err).toBeInstanceOf(BrainUnavailable);
    expect((err as BrainUnavailable).reason).toBe('rate_limit');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(brain.waits).toEqual([3_000, 3_000]);
  });

  it('a 429 that clears on retry is answered', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply('429.json', 429, {'retry-after': '0'}))
      .mockResolvedValueOnce(reply('success.json'));
    const result = await new FastNearAi(undefined, KEY).complete(verdictReq());
    expect(result.provider).toBe('near-ai');
  });

  it('times out at the caller’s limit, without a retry', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const started = Date.now();
    const err = await new FastNearAi(undefined, KEY)
      .complete({...verdictReq(), timeoutMs: 50})
      .catch((e) => e);
    expect(err).toBeInstanceOf(BrainUnavailable);
    expect((err as BrainUnavailable).reason).toBe('timeout');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('never puts the key in an error, even when the provider echoes it back', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(`{"error":"bad request for key ${KEY}"}`, {status: 400}),
    );
    const err = await new FastNearAi(undefined, KEY).complete(verdictReq()).catch((e) => e);
    expect(err).toBeInstanceOf(BrainUnavailable);
    noLeak(err);
    expect((err as Error).message).toContain('[redacted]');
  });

  it('does not show the key when the brain itself is logged or serialised', () => {
    const brain = new NearAiBrain(undefined, KEY);
    expect(JSON.stringify(brain)).not.toContain(KEY);
    expect(inspect(brain, {depth: 5, showHidden: true})).not.toContain(KEY);
  });

  it('without a key it is not configured and calls nothing', async () => {
    const fetch = offline();
    const brain = new NearAiBrain(undefined, undefined);
    expect(await brain.available()).toBe(false);
    await expect(brain.complete(verdictReq())).rejects.toMatchObject({reason: 'not_configured'});
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('choosing the judge (buildJudgeBrain)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pactora-judge-'));
  afterAll(() => rmSync(dir, {recursive: true, force: true}));

  it('is off by default: the orchestrator’s own brain judges', () => {
    expect(buildJudgeBrain({env: {}, cacheDir: dir})).toBeUndefined();
    expect(buildJudgeBrain({env: {AGENT_MODE: 'live'}, cacheDir: dir})).toBeUndefined();
  });

  it('JUDGE_PROVIDER=near-ai without its key is refused, naming the key', () => {
    for (const mode of ['cached', 'live', 'record'])
      expect(() =>
        buildJudgeBrain({env: {AGENT_MODE: mode, JUDGE_PROVIDER: 'near-ai'}, cacheDir: dir}),
      ).toThrow(/NEAR_AI_API_KEY/);
    expect(() =>
      buildJudgeBrain({env: {JUDGE_PROVIDER: 'near-ai', NEAR_AI_API_KEY: ''}, cacheDir: dir}),
    ).toThrow(/NEAR_AI_API_KEY/);
  });

  it('an unknown provider is refused', () => {
    expect(() => buildJudgeBrain({env: {JUDGE_PROVIDER: 'openai'}, cacheDir: dir})).toThrow(/JUDGE_PROVIDER/);
  });

  it('a bad key is never echoed in the refusal', () => {
    let message = '';
    try {
      buildJudgeBrain({
        env: {JUDGE_PROVIDER: 'near-ai', NEAR_AI_API_KEY: KEY, NEAR_AI_BASE_URL: 'http://plain.example'},
        cacheDir: dir,
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/NEAR_AI_BASE_URL/);
    expect(message).not.toContain(KEY);
  });

  it('live: NEAR AI first, the recording as the backstop', () => {
    const brain = buildJudgeBrain({
      env: {AGENT_MODE: 'live', JUDGE_PROVIDER: 'near-ai', NEAR_AI_API_KEY: KEY},
      cacheDir: dir,
    });
    expect(brain?.name).toMatch(/near-ai.*cached/);
  });

  it('AGENT_MODE=cached (the default) replays, and never reaches the network, even with near-ai chosen', async () => {
    const fetch = offline();
    const env = {JUDGE_PROVIDER: 'near-ai', NEAR_AI_API_KEY: KEY};
    // A recording of this exact verdict request, as a cached run would have.
    const req = verdictReqFor(judgeInput);
    writeFileSync(
      join(dir, 'orchestrator.json'),
      JSON.stringify({
        [await cacheKey(req)]: {
          value: {
            accept: true,
            reason: 'Recorded verdict for the test.',
            rating: 'good',
            injectionAttempted: false,
          },
          provider: 'near-ai',
          model: 'zai-org/GLM-5.1-FP8',
          latencyMs: 0,
          recordedAt: '2026-11-09T00:00:00.000Z',
          promptPreview: '',
        },
      }),
    );
    const orchestratorBrain = buildBrain({role: 'orchestrator', env, cacheDir: dir});
    const judgeBrain = buildJudgeBrain({env, cacheDir: dir}) ?? orchestratorBrain;
    const verdict = await new Judge(judgeBrain).evaluate(judgeInput);
    expect(verdict.cached).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function verdictReq() {
  return verdictReqFor(judgeInput);
}

/** The request `Judge.evaluate` makes, captured from a spy brain. */
function verdictReqFor(input: typeof judgeInput) {
  let captured: Parameters<NearAiBrain['complete']>[0] | undefined;
  const spy = {
    name: 'spy',
    available: async () => true,
    complete: async (r: Parameters<NearAiBrain['complete']>[0]) => {
      captured = r;
      throw new Error('captured');
    },
  };
  void new Judge(spy as never).evaluate(input).catch(() => undefined);
  return captured!;
}
