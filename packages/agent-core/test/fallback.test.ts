import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {
  BrainInvalidOutput,
  BrainUnavailable,
  CachedBrain,
  FallbackBrain,
  RecordingBrain,
  buildBrain,
  type Brain,
  type CompletionRequest,
  type CompletionResult,
} from '../src/index.js';

const Answer = z.object({summary: z.string(), confidence: z.number()});
const req = {
  schema: Answer,
  schemaName: 'Answer',
  system: 'You are a research agent.',
  prompt: 'How deep is the NEAR/USDC pool?',
} satisfies CompletionRequest<z.infer<typeof Answer>>;

const dir = mkdtempSync(join(tmpdir(), 'pactora-brain-'));
afterAll(() => rmSync(dir, {recursive: true, force: true}));

/** A brain that does exactly what the test tells it to. */
class StubBrain implements Brain {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly behaviour: 'ok' | BrainUnavailable['reason'] | 'invalid' | 'throw',
  ) {}

  async complete<T>(r: CompletionRequest<T>): Promise<CompletionResult<T>> {
    this.calls++;
    if (this.behaviour === 'invalid') throw new BrainInvalidOutput(this.name, 'summary: required');
    if (this.behaviour === 'throw') throw new Error('something unexpected');
    if (this.behaviour !== 'ok') throw new BrainUnavailable(this.name, this.behaviour, 'nope');
    return {
      value: r.schema.parse({summary: `from ${this.name}`, confidence: 0.9}),
      provider: this.name,
      model: `${this.name}-model`,
      cached: false,
    };
  }

  async available() {
    return this.behaviour === 'ok';
  }
}

describe('the fallback chain', () => {
  it('uses the first provider when it works', async () => {
    const a = new StubBrain('a', 'ok');
    const b = new StubBrain('b', 'ok');
    const result = await new FallbackBrain([a, b]).complete(req);

    expect(result.provider).toBe('a');
    expect(b.calls).toBe(0);
  });

  it('falls through a rate limit to the next provider', async () => {
    const a = new StubBrain('a', 'rate_limit');
    const b = new StubBrain('b', 'ok');
    const result = await new FallbackBrain([a, b]).complete(req);

    expect(result.provider).toBe('b');
    expect(result.value.summary).toBe('from b');
  });

  it('walks the whole chain if it has to', async () => {
    const chain = [
      new StubBrain('a', 'rate_limit'),
      new StubBrain('b', 'outage'),
      new StubBrain('c', 'timeout'),
      new StubBrain('d', 'ok'),
    ];
    expect((await new FallbackBrain(chain).complete(req)).provider).toBe('d');
    expect(chain.every((c) => c.calls === 1)).toBe(true);
  });

  /**
   * The rule that keeps the chain honest. A schema violation is a prompt or
   * schema bug that every provider reproduces; continuing would spend three
   * providers' quota and bury the real fault under "everything failed".
   */
  it('does NOT fall through a schema violation', async () => {
    const a = new StubBrain('a', 'invalid');
    const b = new StubBrain('b', 'ok');

    await expect(new FallbackBrain([a, b]).complete(req)).rejects.toThrow(BrainInvalidOutput);
    expect(b.calls).toBe(0);
  });

  it('treats an unrecognised error as an outage rather than dying', async () => {
    const a = new StubBrain('a', 'throw');
    const b = new StubBrain('b', 'ok');
    expect((await new FallbackBrain([a, b]).complete(req)).provider).toBe('b');
  });

  it('reports every provider that failed when none succeed', async () => {
    const chain = [new StubBrain('a', 'rate_limit'), new StubBrain('b', 'auth')];
    await expect(new FallbackBrain(chain).complete(req)).rejects.toThrow(/a\(rate_limit: .*b\(auth: /);
  });

  it('announces a fallback rather than degrading silently', async () => {
    const seen: string[] = [];
    await new FallbackBrain([new StubBrain('a', 'rate_limit'), new StubBrain('b', 'ok')], {
      onFallback: (from, to, reason) => seen.push(`${from}->${to}:${reason}`),
    }).complete(req);

    expect(seen).toEqual(['a->b:rate_limit']);
  });

  it('is available if any link is', async () => {
    const chain = new FallbackBrain([new StubBrain('a', 'outage'), new StubBrain('b', 'ok')]);
    expect(await chain.available()).toBe(true);
    expect(await chain.status()).toEqual([
      {provider: 'a', available: false},
      {provider: 'b', available: true},
    ]);
  });
});

describe('cached replay', () => {
  it('records a live answer and replays it for free', async () => {
    const path = join(dir, 'roundtrip.json');
    const live = new StubBrain('live', 'ok');

    const recorded = await new RecordingBrain(live, path).complete(req);
    expect(recorded.cached).toBe(false);

    const replayed = await new CachedBrain(path, {replayTiming: false}).complete(req);
    expect(replayed.value).toEqual(recorded.value);
    expect(replayed.cached).toBe(true);
    // Honest about its provenance rather than pretending to be live.
    expect(replayed.provider).toBe('cached(live)');
    expect(live.calls).toBe(1);
  });

  it('says what to do when a request was never recorded', async () => {
    const cached = new CachedBrain(join(dir, 'empty.json'), {replayTiming: false});
    await expect(cached.complete(req)).rejects.toThrow(/AGENT_MODE=record/);
  });

  /** The hint must name the mode that actually saves a recording (`live` only calls). */
  it('names a mode that records', async () => {
    const error = await new CachedBrain(join(dir, 'empty.json'), {replayTiming: false})
      .complete(req)
      .catch((e: unknown) => e as Error);
    const mode = /AGENT_MODE=(\w+)/.exec(String((error as Error).message))?.[1];
    expect(buildBrain({role: 'worker', env: {AGENT_MODE: mode}, cacheDir: dir})).toBeInstanceOf(
      RecordingBrain,
    );
  });

  /** A recording made against an older schema must fail loudly, not replay a stale shape. */
  it('refuses a recording that no longer matches the schema', async () => {
    const path = join(dir, 'stale.json');
    await new RecordingBrain(new StubBrain('live', 'ok'), path).complete(req);

    const Widened = {...req, schema: z.object({summary: z.string(), extra: z.string()})};
    await expect(new CachedBrain(path, {replayTiming: false}).complete(Widened)).rejects.toThrow(
      /no recording|re-record/,
    );
  });

  it('backs the live chain, so a total outage still answers', async () => {
    const path = join(dir, 'backstop.json');
    await new RecordingBrain(new StubBrain('live', 'ok'), path).complete(req);

    const chain = new FallbackBrain([
      new StubBrain('gemini', 'rate_limit'),
      new StubBrain('groq', 'outage'),
      new CachedBrain(path, {replayTiming: false}),
    ]);
    const result = await chain.complete(req);
    expect(result.cached).toBe(true);
  });

  /**
   * The demo runs three workers, each with its own recording brain, all on
   * `worker.json`. Each loaded the file once and rewrote the whole of it on
   * every call, so the last writer won and the others' recordings vanished.
   * A cached replay of the first live run that ever settled all three jobs
   * missed two of them — and a stale recording that survived the clobbering
   * changed a result, which changed the judge's prompt, which missed too.
   */
  it('keeps what another recorder wrote to the same file', async () => {
    const path = join(dir, 'shared.json');
    const first = new RecordingBrain(new StubBrain('research', 'ok'), path);
    const second = new RecordingBrain(new StubBrain('trading', 'ok'), path);
    const other = {...req, prompt: 'Should I open a position?'};

    await first.complete(req);
    await second.complete(other);

    const replay = new CachedBrain(path, {replayTiming: false});
    await expect(replay.complete(req)).resolves.toMatchObject({provider: 'cached(research)'});
    await expect(replay.complete(other)).resolves.toMatchObject({provider: 'cached(trading)'});
  });
});

describe('buildBrain configuration', () => {
  it('defaults to cached, so development spends nothing', async () => {
    const brain = buildBrain({role: 'worker', env: {}, cacheDir: dir});
    expect(brain.name).toBe('cached');
  });

  it('puts judgement on Claude and extraction on the free tiers', () => {
    const env = {AGENT_MODE: 'live', ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'k'};
    expect(buildBrain({role: 'orchestrator', env, cacheDir: dir}).name).toMatch(/claude.*gemini/);
    expect(buildBrain({role: 'worker', env, cacheDir: dir}).name).toMatch(/gemini.*claude/);
  });

  it('honours an explicit chain', () => {
    const brain = buildBrain({
      role: 'worker',
      env: {AGENT_MODE: 'live', BRAIN_CHAIN: 'groq,ollama'},
      cacheDir: dir,
    });
    expect(brain.name).toContain('groq→ollama');
  });

  // 2026-11-12: hosted workers on NEAR AI Cloud, the owner's capped credit.
  it('accepts near-ai in a chain, with the key and model from the environment', async () => {
    const brain = buildBrain({
      role: 'worker',
      env: {AGENT_MODE: 'live', BRAIN_CHAIN: 'near-ai', NEAR_AI_API_KEY: 'sk-test-only'},
      cacheDir: dir,
    });
    expect(brain.name).toContain('near-ai');
    const status = await (
      brain as unknown as {status(): Promise<{provider: string; available: boolean}[]>}
    ).status();
    expect(status.find((s) => s.provider === 'near-ai')?.available).toBe(true);
  });

  it('always keeps cached as the final backstop in live mode', () => {
    const brain = buildBrain({role: 'worker', env: {AGENT_MODE: 'live'}, cacheDir: dir});
    expect(brain.name).toContain('cached');
  });

  // One model overloaded ("503 high demand") while others on the same key
  // answered: gemini-3.8-flash and 3.7 were refusing, 3.6, 3.5 and
  // flash-latest were not (2026-10-05). A chain may list models to fall back to.
  it('accepts several Gemini models in one chain, each a provider of its own', async () => {
    const brain = buildBrain({
      role: 'orchestrator',
      env: {
        AGENT_MODE: 'live',
        GEMINI_API_KEY: 'k',
        BRAIN_CHAIN_ORCHESTRATOR: 'gemini,gemini:gemini-3.6-flash,gemini:gemini-flash-latest',
      },
      cacheDir: dir,
    });
    expect(brain.name).toContain('gemini→gemini:gemini-3.6-flash→gemini:gemini-flash-latest');
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      return new Response('{"error":{"message":"high demand"}}', {status: 400});
    });
    await brain.complete(req).catch(() => undefined);
    vi.restoreAllMocks();
    expect(urls.some((u) => u.includes('/models/gemini-3.6-flash:'))).toBe(true);
    expect(urls.some((u) => u.includes('/models/gemini-flash-latest:'))).toBe(true);
  });

  it('rejects an unknown provider by name instead of silently skipping it', () => {
    expect(() =>
      buildBrain({role: 'worker', env: {AGENT_MODE: 'live', BRAIN_CHAIN: 'gpt5'}, cacheDir: dir}),
    ).toThrow(/unknown brain "gpt5"/);
  });
});

describe('provider adapters report themselves unconfigured without a key', () => {
  it('does not pretend to be available', async () => {
    const {GeminiBrain, GroqBrain, ClaudeBrain} = await import('../src/index.js');
    expect(await new GeminiBrain(undefined, undefined).available()).toBe(false);
    expect(await new GroqBrain(undefined, undefined).available()).toBe(false);
    expect(await new ClaudeBrain(undefined, undefined).available()).toBe(false);
  });

  it('names the missing key rather than failing obscurely', async () => {
    const {GeminiBrain} = await import('../src/index.js');
    await expect(new GeminiBrain(undefined, undefined).complete(req)).rejects.toThrow(
      /no API key or endpoint configured/,
    );
  });
});

describe('when every provider fails', () => {
  it('keeps what each provider said, not only the category', async () => {
    const {FallbackBrain, BrainUnavailable} = await import('../src/index.js');
    const down = {
      name: 'gemini',
      complete: async () => {
        throw new BrainUnavailable('gemini', 'outage', '404 models/gemini-9 is not found');
      },
      available: async () => true,
    };
    await expect(new FallbackBrain([down as never]).complete(req)).rejects.toThrow(
      /gemini\(outage: gemini: 404 models\/gemini-9 is not found\)/,
    );
  });
});

describe('a key never travels in a URL', () => {
  /**
   * A URL is what ends up in error messages, proxy logs and traces. Gemini's
   * key was sent as `?key=` until 2026-09-30.
   */
  it('sends the Gemini key as a header', async () => {
    const {GeminiBrain} = await import('../src/index.js');
    const brain = new GeminiBrain('gemini-3.8-flash', 'test-key-not-real') as unknown as {
      buildRequest: (r: unknown, s: object) => {url: string; headers: Record<string, string>};
    };
    const {url, headers} = brain.buildRequest(req, {});
    expect(url).not.toContain('test-key-not-real');
    expect(headers['x-goog-api-key']).toBe('test-key-not-real');
  });
});

// Keep the unused import meaningful to the reader.
void writeFileSync;

describe('cached replay pacing', () => {
  // A recording whose one call took 3 s. Replay re-enacts that (capped at
  // 8 s) so a cached demo keeps the rhythm of a live one; AGENT_REPLAY_MAX_MS
  // lets a rehearsal or a recording session shorten it without re-recording.
  async function slowRecording(name: string): Promise<string> {
    const cacheDir = join(dir, name);
    const path = join(cacheDir, 'worker.json');
    await new RecordingBrain(new StubBrain('live', 'ok'), path).complete(req);
    const {readFileSync} = await import('node:fs');
    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, {latencyMs: number}>;
    for (const entry of Object.values(file)) entry.latencyMs = 3_000;
    writeFileSync(path, JSON.stringify(file));
    return cacheDir;
  }

  it('caps the replayed latency at AGENT_REPLAY_MAX_MS', async () => {
    const cacheDir = await slowRecording('capped');
    const brain = buildBrain({
      role: 'worker',
      cacheDir,
      env: {AGENT_MODE: 'cached', AGENT_REPLAY_MAX_MS: '50'},
    });
    const started = Date.now();
    await brain.complete(req);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('replays instantly with AGENT_REPLAY_MAX_MS=0', async () => {
    const cacheDir = await slowRecording('instant');
    const brain = buildBrain({
      role: 'worker',
      cacheDir,
      env: {AGENT_MODE: 'cached', AGENT_REPLAY_MAX_MS: '0'},
    });
    const started = Date.now();
    await brain.complete(req);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('refuses a value that is not a whole number of milliseconds', async () => {
    for (const bad of ['-1', 'fast', '1.5']) {
      expect(() =>
        buildBrain({role: 'worker', cacheDir: dir, env: {AGENT_MODE: 'cached', AGENT_REPLAY_MAX_MS: bad}}),
      ).toThrow(/AGENT_REPLAY_MAX_MS/);
    }
  });
});
