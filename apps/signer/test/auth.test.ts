import {describe, expect, it} from 'vitest';
import {authorised, bindHost} from '../src/auth.js';

/**
 * The signer signs for any agent to any target on request, and listened on
 * every interface with no check at all — private networking was the only
 * thing between the internet and every agent's budget.
 */
describe('who may reach the signer', () => {
  const TOKEN = 'a'.repeat(48);

  it('refuses a request without the token once one is set', () => {
    expect(authorised(undefined, TOKEN)).toBe(false);
    expect(authorised('Bearer wrong', TOKEN)).toBe(false);
    expect(authorised(TOKEN, TOKEN)).toBe(false); // the scheme matters
  });

  it('accepts the token', () => {
    expect(authorised(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('does not throw on a presented token of a different length', () => {
    expect(authorised('Bearer short', TOKEN)).toBe(false);
  });
});

describe('where the signer listens', () => {
  it('stays on loopback without a token', () => {
    expect(bindHost({})).toBe('127.0.0.1');
  });

  it('refuses to open up without a token, rather than serving unauthenticated', () => {
    expect(() => bindHost({SIGNER_HOST: '0.0.0.0'})).toThrow(/SIGNER_TOKEN/);
  });

  it('listens widely only behind a token', () => {
    expect(bindHost({SIGNER_TOKEN: 'x'})).toBe('0.0.0.0');
  });
});
