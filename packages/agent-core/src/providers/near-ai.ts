import {NEAR_AI_DEFAULT_BASE_URL, NEAR_AI_DEFAULT_MODEL} from '@pactora/shared';
import {JsonHttpBrain} from './json-provider.js';
import type {CompletionRequest, CompletionResult} from '../brain.js';

/**
 * NEAR AI Cloud (docs.near.ai/cloud): OpenAI-compatible chat completions,
 * Bearer auth, base URL `https://cloud-api.near.ai/v1`. Used as the judge
 * when `JUDGE_PROVIDER=near-ai`; off by default.
 *
 * Retries, timeouts and the status mapping (401/403 auth, 429 rate limit,
 * 5xx outage) are the shared `JsonHttpBrain`'s, so this provider fails the
 * way every other one does and the fallback chain treats it the same.
 *
 * The key is an ES private field: it does not appear when the brain is
 * logged, inspected or serialised, and it is scrubbed from any error text
 * (a provider that echoes a request back would otherwise put it in a log).
 */
export class NearAiBrain extends JsonHttpBrain {
  readonly name = 'near-ai';
  protected readonly model: string;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;

  constructor(
    model: string | undefined = undefined,
    apiKey: string | undefined = undefined,
    baseUrl: string | undefined = undefined,
  ) {
    super();
    this.model = model || NEAR_AI_DEFAULT_MODEL;
    this.#apiKey = apiKey || undefined;
    this.#baseUrl = (baseUrl || NEAR_AI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  override async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
    try {
      return await super.complete(req);
    } catch (err) {
      const key = this.#apiKey;
      if (key && err instanceof Error && (err.message.includes(key) || err.stack?.includes(key))) {
        err.message = err.message.split(key).join('[redacted]');
        if (err.stack) err.stack = err.stack.split(key).join('[redacted]');
      }
      throw err;
    }
  }

  protected endpoint(): string | null {
    return this.#apiKey ? `${this.#baseUrl}/chat/completions` : null;
  }

  protected buildRequest(req: CompletionRequest<unknown>, jsonSchema: object) {
    return {
      url: this.endpoint()!,
      headers: {authorization: `Bearer ${this.#apiKey}`},
      body: {
        model: this.model,
        // The hosted models reason before they answer, and the reasoning
        // counts against max_tokens (as Groq's gpt-oss and Gemini 3.x do).
        max_tokens: Math.max(req.maxTokens ?? 2_000, 4_096),
        messages: [
          {role: 'system', content: req.system},
          {role: 'user', content: req.prompt},
        ],
        // "Structured outputs" per the OpenAI-compatibility guide. Not strict:
        // the answer is validated against the schema here either way.
        response_format: {
          type: 'json_schema',
          json_schema: {name: req.schemaName, schema: jsonSchema, strict: false},
        },
      },
    };
  }

  protected extractText(payload: unknown): string | null {
    const p = payload as {choices?: {message?: {content?: string}}[]};
    return p.choices?.[0]?.message?.content ?? null;
  }

  protected override isTruncated(payload: unknown): boolean {
    const p = payload as {choices?: {finish_reason?: string}[]};
    return p.choices?.[0]?.finish_reason === 'length';
  }
}
