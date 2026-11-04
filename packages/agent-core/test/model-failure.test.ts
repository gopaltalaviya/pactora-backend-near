import {describe, expect, it} from 'vitest';
import {BrainInvalidOutput, BrainUnavailable, MODEL_UNAVAILABLE, explainModelFailure} from '../src/index.js';

/**
 * A model failure reached the site as the provider's raw text — a JSON body
 * nested in "fallback(fallback(gemini:…" — so a reader could not tell "the
 * free AI quota is used up" from "the product is broken". One sentence, in
 * words, that names the cause and is easy to recognise.
 */
describe('explainModelFailure', () => {
  const chain = (inner: string) =>
    new BrainUnavailable('fallback(a→b)', 'outage', `every provider failed: ${inner}`);

  it('names a used-up quota as such', () => {
    const err = chain('gemini:a(rate_limit: rate limited), gemini:b(outage: 503 high demand)');
    expect(explainModelFailure(err)).toBe(`${MODEL_UNAVAILABLE}: its free request quota is used up for now`);
  });

  it('names a 429 from the provider text too', () => {
    expect(explainModelFailure(new Error('429 RESOURCE_EXHAUSTED quota'))).toMatch(/quota is used up/);
  });

  it('names overload and timeouts', () => {
    expect(explainModelFailure(chain('gemini:a(outage: 503 high demand)'))).toBe(
      `${MODEL_UNAVAILABLE}: the provider is overloaded right now`,
    );
    expect(explainModelFailure(new BrainUnavailable('gemini', 'timeout', 'aborted'))).toBe(
      `${MODEL_UNAVAILABLE}: it did not answer in time`,
    );
  });

  it('names a rejected key and a missing one', () => {
    expect(explainModelFailure(new BrainUnavailable('gemini', 'auth', 'rejected the key (403)'))).toMatch(
      /rejected its key/,
    );
    expect(explainModelFailure(new BrainUnavailable('gemini', 'not_configured', 'no key'))).toMatch(
      /no AI model is configured/,
    );
  });

  it('leaves anything that is not a model failure alone', () => {
    expect(explainModelFailure(new Error('BUDGET_EXCEEDED: over the daily cap'))).toBeNull();
    expect(explainModelFailure(new BrainInvalidOutput('gemini', 'bad json'))).toBeNull();
  });
});
