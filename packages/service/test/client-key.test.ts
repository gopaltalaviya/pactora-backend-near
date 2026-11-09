import {describe, expect, it} from 'vitest';
import {clientKey} from '../src/index.js';

/**
 * Audit L1. Rate limits and per-requester caps were keyed on the exact
 * address. An IPv6 client has a /64 (or more) to itself, so every request
 * could come from a fresh address and a fresh bucket. The key is the /64 for
 * IPv6; IPv4, and IPv4 mapped into IPv6, stay the exact address.
 */
describe('clientKey', () => {
  it('keeps IPv4 as it is', () => {
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('127.0.0.1')).toBe('127.0.0.1');
  });

  it('keeps an IPv4-mapped IPv6 address as its IPv4', () => {
    expect(clientKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('::ffff:cb00:7109')).toBe('203.0.113.9');
  });

  it('reduces IPv6 to its /64, so one client cannot hop buckets inside its own prefix', () => {
    const a = clientKey('2001:db8:85a3:8d3:1319:8a2e:370:7348');
    const b = clientKey('2001:db8:85a3:8d3::1');
    const c = clientKey('2001:db8:85a3:8d4::1');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe('2001:db8:85a3:8d3::/64');
    expect(clientKey('::1')).toBe('::/64');
    expect(clientKey('fe80::1%eth0')).toBe('fe80::/64');
  });

  it('answers something stable for a value that is not an address', () => {
    expect(clientKey('')).toBe('');
    expect(clientKey('not-an-ip')).toBe('not-an-ip');
  });
});
