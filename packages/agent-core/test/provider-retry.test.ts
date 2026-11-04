import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {BrainUnavailable, ClaudeBrain, GeminiBrain, GroqBrain} from '../src/index.js';

/**
 * Gemini answers 503 "This model is currently experiencing high demand.
 * Spikes in demand are usually temporary" — and a hosted rehearsal run failed
 * at the plan because the provider gave up on the FIRST one. A transient
 * status is retried with backoff before the provider is declared down.
 */
const Plan = z.object({steps: z.array(z.string())});
const req = {schema: Plan, schemaName: 'Plan', system: 's', prompt: 'p'};
const ok = () =>
  new Response(JSON.stringify({candidates: [{content: {parts: [{text: '{"steps":["a"]}'}]}}]}), {
    status: 200,
  });
const status = (n: number, headers: Record<string, string> = {}) =>
  new Response('{"error":{"message":"This model is currently experiencing high demand."}}', {
    status: n,
    headers,
  });

/** No real waiting in tests: the delays are recorded instead. */
class FastGemini extends GeminiBrain {
  waits: number[] = [];
  protected override sleep(ms: number) {
    this.waits.push(ms);
    return Promise.resolve();
  }
}

afterEach(() => vi.restoreAllMocks());

describe('a provider under transient failure', () => {
  it('retries a 503 and succeeds when the spike passes', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(status(503))
      .mockResolvedValueOnce(status(503))
      .mockResolvedValueOnce(ok());
    const brain = new FastGemini('m', 'key');
    const result = await brain.complete(req);
    expect(result.value).toEqual({steps: ['a']});
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(brain.waits).toHaveLength(2);
    expect(brain.waits[1]!).toBeGreaterThan(brain.waits[0]!); // backs off
  });

  it('retries 429 and 504 too (and 500, 502), and honours retry-after (capped)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(status(429, {'retry-after': '7'}))
      .mockResolvedValueOnce(status(504))
      .mockResolvedValueOnce(ok());
    const brain = new FastGemini('m', 'key');
    await brain.complete(req);
    expect(brain.waits[0]).toBe(7_000);
  });

  it('gives up after its attempts with the provider marked unavailable, so the fallback chain moves on', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => status(503));
    const brain = new FastGemini('m', 'key');
    await expect(brain.complete(req)).rejects.toBeInstanceOf(BrainUnavailable);
    expect(fetch).toHaveBeenCalledTimes(3); // the first try and two retries
  });

  it('never retries a client error or a rejected key — those do not fix themselves', async () => {
    for (const n of [400, 401, 403, 404]) {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(status(n));
      await expect(new FastGemini('m', 'key').complete(req)).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
  });
});

describe('a provider that cannot be reached', () => {
  it('retries a dropped connection, but not a request that already timed out', async () => {
    const drop = Object.assign(new TypeError('fetch failed'), {name: 'TypeError'});
    let fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(drop).mockResolvedValueOnce(ok());
    await new FastGemini('m', 'key').complete(req);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();

    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(timeout);
    await expect(new FastGemini('m', 'key').complete(req)).rejects.toBeInstanceOf(BrainUnavailable);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('a model that wraps its JSON in prose', () => {
  // gemini-3.6-flash answered a worker's triage with "Here is the JSON
  // requested:" and a fenced block — and the worker failed the job, though the
  // JSON inside was valid (hosted rehearsal, 2026-10-05).
  const reply = (text: string) =>
    new Response(JSON.stringify({candidates: [{content: {parts: [{text}]}}]}), {status: 200});
  const fence = '`'.repeat(3);

  it.each([
    ['prose, then a fenced block', `Here is the JSON requested:\n${fence}json\n{"steps":["a"]}\n${fence}`],
    ['a fenced block, then prose', `${fence}json\n{"steps":["a"]}\n${fence}\nLet me know if you need more.`],
    ['an unfenced object inside prose', 'Sure. {"steps":["a"]} Hope that helps.'],
    ['plain JSON, as asked', '{"steps":["a"]}'],
  ])('finds the JSON in %s', async (_, text) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(text));
    expect((await new FastGemini('m', 'key').complete(req)).value).toEqual({steps: ['a']});
  });

  it('still refuses a reply with no JSON in it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply('I cannot help with that.'));
    await expect(new FastGemini('m', 'key').complete(req)).rejects.toThrow(/not valid JSON/);
  });
});

describe('a fenced block is preferred to a brace hunt', () => {
  it('takes the fenced JSON even when the prose around it has braces of its own', async () => {
    const fence = '`'.repeat(3);
    const text = `Format {like this}:\n${fence}json\n{"steps":["a"]}\n${fence}\n(see {docs})`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({candidates: [{content: {parts: [{text}]}}]}), {status: 200}),
    );
    expect((await new FastGemini('m', 'key').complete(req)).value).toEqual({steps: ['a']});
  });
});

describe('a thinking model and a small token budget', () => {
  // Gemini 3.x counts its thinking against maxOutputTokens. A worker's triage
  // asks for 400; the model thought, then wrote `{"` and stopped — and the
  // worker failed the job (hosted rehearsal, 2026-10-05).
  it('asks Gemini for headroom, whatever the caller asked for', async () => {
    let sent: {generationConfig?: {maxOutputTokens?: number}} = {};
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return ok();
    });
    await new FastGemini('m', 'key').complete({...req, maxTokens: 400});
    expect(sent.generationConfig?.maxOutputTokens).toBeGreaterThanOrEqual(4096);
  });

  it('a reply cut off at the token limit is the provider failing, so the chain moves on', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({candidates: [{finishReason: 'MAX_TOKENS', content: {parts: [{text: '{"'}]}}]}),
        {
          status: 200,
        },
      ),
    );
    await expect(new FastGemini('m', 'key').complete(req)).rejects.toBeInstanceOf(BrainUnavailable);
  });
});

/**
 * A worker has 45 s to accept an offer. One model that hung for its full 60 s
 * outlasted that, although the next model in the chain answered in one: the
 * job timed out while a working fallback sat unused. The caller sets the
 * per-call limit; the default stays generous.
 */
describe('a caller-set timeout', () => {
  it('gives up on a hanging model at the time the caller asked for', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const started = Date.now();
    const err = await new FastGemini('m', 'key').complete({...req, timeoutMs: 50}).catch((e) => e);
    expect(err).toBeInstanceOf(BrainUnavailable);
    expect((err as BrainUnavailable).reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('Claude cut off at its token limit', () => {
  it('is the provider failing, not a bad answer, so the chain moves on', async () => {
    const brain = new ClaudeBrain('claude-test', 'key');
    (brain as unknown as {client: unknown}).client = {
      messages: {
        create: async () => ({stop_reason: 'max_tokens', content: [{type: 'text', text: '{"steps":["a'}]}),
      },
    };
    const err = await brain.complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(BrainUnavailable);
    expect((err as Error).message).toMatch(/token limit/);
  });
});

/**
 * Groq's strict JSON mode refuses any schema with an optional field ("required
 * is required to be supplied and to be an array including every key"), and the
 * triage answer has one (`blocker`). Every Groq call failed with a 400, live,
 * the first time Groq was tried (2026-10-08). Strict only when it can be;
 * the answer is validated against the schema either way.
 */
describe('Groq and optional fields', () => {
  const capture = () => {
    const bodies: {response_format: {json_schema: {strict: boolean}}}[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({choices: [{message: {content: '{"steps":["a"]}'}}]}), {
        status: 200,
      });
    });
    return bodies;
  };

  it('asks for strict JSON when every field is required', async () => {
    const bodies = capture();
    await new GroqBrain('m', 'key').complete(req);
    expect(bodies[0]!.response_format.json_schema.strict).toBe(true);
  });

  it('does not ask for strict JSON when a field is optional', async () => {
    const bodies = capture();
    const Opt = z.object({steps: z.array(z.string()), note: z.string().optional()});
    await new GroqBrain('m', 'key').complete({...req, schema: Opt});
    expect(bodies[0]!.response_format.json_schema.strict).toBe(false);
  });
});

/**
 * Groq's gpt-oss models reason before they answer, and the reasoning counts
 * against max_tokens. A worker's 400-token triage came back EMPTY on the live
 * server ("json_validate_failed", failed_generation: "") — the model spent the
 * budget thinking. Same cure as Gemini's thinking models: headroom, and the
 * caller's effort passed on so a short decision thinks briefly.
 */
describe('Groq reasoning models', () => {
  const capture = () => {
    const bodies: {max_tokens: number; reasoning_effort?: string}[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({choices: [{message: {content: '{"steps":["a"]}'}}]}), {
        status: 200,
      });
    });
    return bodies;
  };

  it('gives a reasoning model headroom above a small budget, and passes the effort', async () => {
    const bodies = capture();
    await new GroqBrain('openai/gpt-oss-120b', 'key').complete({...req, maxTokens: 400, effort: 'low'});
    expect(bodies[0]!.max_tokens).toBeGreaterThanOrEqual(4_096);
    expect(bodies[0]!.reasoning_effort).toBe('low');
  });

  it('leaves a non-reasoning model as asked', async () => {
    const bodies = capture();
    await new GroqBrain('llama-3.3-70b-versatile', 'key').complete({...req, maxTokens: 400});
    expect(bodies[0]!.max_tokens).toBe(400);
    expect(bodies[0]!.reasoning_effort).toBeUndefined();
  });
});
