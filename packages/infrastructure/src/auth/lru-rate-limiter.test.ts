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

  it('evicts the least-recently-used bucket, keeping hot buckets', async () => {
    const limiter = createLruRateLimiter();
    for (let i = 1; i <= 5_000; i++) {
      for (let j = 0; j < 5; j++) {
        await limiter.check(String(i), { limit: 5, windowMs: 60_000 });
      }
    }
    const refreshed = await limiter.check('1', { limit: 5, windowMs: 60_000 });
    expect(refreshed.ok).toBe(false);
    await limiter.check('5001', { limit: 5, windowMs: 60_000 });
    const hot = await limiter.check('1', { limit: 5, windowMs: 60_000 });
    expect(hot.ok).toBe(false);
    const evicted = await limiter.check('2', { limit: 5, windowMs: 60_000 });
    expect(evicted.ok).toBe(true);
    if (!evicted.ok) return;
    expect(evicted.remaining).toBe(4);
  });
});