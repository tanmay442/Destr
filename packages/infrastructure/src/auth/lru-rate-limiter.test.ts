import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLruRateLimiter } from './lru-rate-limiter';

afterEach(() => {
  vi.useRealTimers();
});

describe('createLruRateLimiter', () => {
  it('allows requests under the limit and decrements remaining', async () => {
    const limiter = createLruRateLimiter();
    const result = await limiter.check('user:1', { limit: 30, windowMs: 60_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.remaining).toBe(29);
  });

  it('rejects requests over the limit and reports retryAfterMs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const limiter = createLruRateLimiter();
    for (let i = 0; i < 3; i++) {
      await limiter.check('user:1', { limit: 3, windowMs: 60_000 });
    }
    const result = await limiter.check('user:1', { limit: 3, windowMs: 60_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryAfterMs).toBe(60_000);
  });

  it('slides the window so old timestamps stop blocking', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const limiter = createLruRateLimiter();
    for (let i = 0; i < 30; i++) {
      const result = await limiter.check('user:1', { limit: 30, windowMs: 1_000 });
      expect(result.ok).toBe(true);
      vi.setSystemTime(10_000 + i + 1);
    }
    vi.setSystemTime(10_000 + 30 + 2_000);
    const next = await limiter.check('user:1', { limit: 30, windowMs: 1_000 });
    expect(next.ok).toBe(true);
  });

  it("never evicts a live bucket: capacity pressure cannot reset someone's window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const limiter = createLruRateLimiter();
    for (let i = 1; i <= 5_000; i++) {
      for (let j = 0; j < 5; j++) {
        await limiter.check(String(i), { limit: 5, windowMs: 60_000 });
      }
    }
    const victim = await limiter.check('5000', { limit: 5, windowMs: 60_000 });
    expect(victim.ok).toBe(false);
    if (victim.ok) return;
    expect(victim.retryAfterMs).toBeGreaterThan(0);
    for (let i = 0; i < 100; i++) {
      const newKey = await limiter.check(`attacker:${i}`, { limit: 5, windowMs: 60_000 });
      expect(newKey.ok).toBe(false);
      if (newKey.ok) return;
      expect(newKey.retryAfterMs).toBeGreaterThan(0);
    }
    const stillBlocked = await limiter.check('5000', { limit: 5, windowMs: 60_000 });
    expect(stillBlocked.ok).toBe(false);
    if (stillBlocked.ok) return;
    expect(stillBlocked.retryAfterMs).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('rejects new keys once capacity is exhausted, without admitting them', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const limiter = createLruRateLimiter();
    for (let i = 1; i <= 5_000; i++) {
      await limiter.check(String(i), { limit: 5, windowMs: 60_000 });
    }
    const rejected = await limiter.check('new-key', { limit: 5, windowMs: 60_000 });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
    const again = await limiter.check('new-key', { limit: 5, windowMs: 60_000 });
    expect(again.ok).toBe(false);
  });

  it('evicts expired buckets so they no longer count toward capacity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const limiter = createLruRateLimiter();
    for (let i = 1; i <= 5_000; i++) {
      await limiter.check(String(i), { limit: 5, windowMs: 60_000 });
    }
    vi.setSystemTime(10_000 + 61_000);
    const admitted = await limiter.check('new-key', { limit: 5, windowMs: 60_000 });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.remaining).toBe(4);
    const refreshed = await limiter.check('1', { limit: 5, windowMs: 60_000 });
    expect(refreshed.ok).toBe(true);
  });
});