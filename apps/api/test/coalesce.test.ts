import {describe, expect, it, vi} from 'vitest';
import {coalesce} from '../src/coalesce.js';

/**
 * The signer probe behind /ready and /v1/status. With the signer's container
 * gone, every probe started a DNS lookup that sat on one of libuv's four
 * threads for ~4 s; a few of them starved the RPC lookup too, and the status
 * page reported the chain as down when only the signer was.
 */
describe('coalesce', () => {
  it('shares one call between concurrent callers', async () => {
    let release!: () => void;
    const fn = vi.fn(() => new Promise<void>((r) => (release = r)));
    const probe = coalesce(fn, 1_000);
    const all = Promise.all([probe(), probe(), probe()]);
    expect(fn).toHaveBeenCalledTimes(1);
    release();
    await all;
  });

  it('reuses a failure for the hold window, so a dead dependency is probed at most once per window', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn(() => Promise.reject(new Error('signer did not answer')));
      const probe = coalesce(fn, 5_000);
      await expect(probe()).rejects.toThrow('signer did not answer');
      await expect(probe()).rejects.toThrow('signer did not answer');
      expect(fn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5_001);
      await expect(probe()).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses a success for the hold window too, and probes again after it', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn(async () => 'up');
      const probe = coalesce(fn, 2_000);
      expect(await probe()).toBe('up');
      expect(await probe()).toBe('up');
      expect(fn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2_001);
      await probe();
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
