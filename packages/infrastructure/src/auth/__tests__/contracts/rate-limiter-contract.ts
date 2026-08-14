import { describe, it, expect, vi } from 'vitest';
import type { RateLimiter } from '@app/domain';

/**
 * Shared contract assertions every RateLimiter implementation must satisfy.
 * The harness constructs a fresh limiter per test via `makeLimiter` so state
 * never leaks between assertions.
 */
export function runRateLimiterContract(makeLimiter: () => RateLimiter): void {
  describe('rate limiter contract', () => {
    it('allows requests under the limit and decrements remaining', async () => {
      const limiter = makeLimiter();
      const first = await limiter.check('user:1', { limit: 5, windowMs: 60_000 });
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.remaining).toBe(4);
      const second = await limiter.check('user:1', { limit: 5, windowMs: 60_000 });
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.remaining).toBe(3);
    });

    it('blocks once the limit is reached and reports a retry delay', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const limiter = makeLimiter();
      for (let i = 0; i < 3; i++) {
        await limiter.check('user:1', { limit: 3, windowMs: 60_000 });
      }
      const blocked = await limiter.check('user:1', { limit: 3, windowMs: 60_000 });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.retryAfterMs).toBeGreaterThan(0);
      vi.useRealTimers();
    });

    it('recovers after the window expires', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const limiter = makeLimiter();
      for (let i = 0; i < 3; i++) {
        await limiter.check('user:1', { limit: 3, windowMs: 1_000 });
      }
      const blocked = await limiter.check('user:1', { limit: 3, windowMs: 1_000 });
      expect(blocked.ok).toBe(false);
      vi.setSystemTime(10_000 + 2_000);
      const allowed = await limiter.check('user:1', { limit: 3, windowMs: 1_000 });
      expect(allowed.ok).toBe(true);
      vi.useRealTimers();
    });

    it('keeps independent keys isolated', async () => {
      const limiter = makeLimiter();
      for (let i = 0; i < 2; i++) {
        await limiter.check('user:a', { limit: 2, windowMs: 60_000 });
      }
      const blocked = await limiter.check('user:a', { limit: 2, windowMs: 60_000 });
      expect(blocked.ok).toBe(false);
      const other = await limiter.check('user:b', { limit: 2, windowMs: 60_000 });
      expect(other.ok).toBe(true);
    });
  });
}
