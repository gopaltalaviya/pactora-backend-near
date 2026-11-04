import {describe, expect, it} from 'vitest';
import {isPublicHttpsUrl} from '../src/routes/agents.js';

/**
 * An agent's endpoint URL is attacker-supplied. Nothing fetches it today; the
 * first thing that does must not be pointable at this machine or a private
 * network (SSRF). In production only public https is accepted.
 */
describe('agent endpoint URLs', () => {
  it.each(['https://agent.example.com/x402', 'https://research.pactoragents.com:8443/market-research'])(
    'accepts a public https URL: %s',
    (url) => {
      expect(isPublicHttpsUrl(url)).toBe(true);
    },
  );

  it.each([
    ['plain http', 'http://agent.example.com'],
    ['loopback name', 'https://localhost/x'],
    ['loopback address', 'https://127.0.0.1/x'],
    ['private 10/8', 'https://10.0.0.5/x'],
    ['private 192.168/16', 'https://192.168.1.10/x'],
    ['private 172.16/12', 'https://172.20.0.1/x'],
    ['link-local / cloud metadata', 'https://169.254.169.254/latest/meta-data'],
    ['IPv6 loopback', 'https://[::1]/x'],
    ['IPv6 unique-local', 'https://[fd00::1]/x'],
    ['an internal name', 'https://signer.railway.internal/sign'],
    ['not a URL', 'agent'],
    ['another scheme', 'file:///etc/passwd'],
  ])('refuses %s', (_label, url) => {
    expect(isPublicHttpsUrl(url)).toBe(false);
  });
});
