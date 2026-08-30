import { describe, expect, it, vi } from 'vitest';
import type { RateLimiter } from '@app/domain';
import { createFallbackRateLimiter } from './fallback-rate-limiter';

function limiter(
  check: RateLimiter['check'],
): RateLimiter {
  return { check };
}

describe('createFallbackRateLimiter', () => {
  it('returns the primary result when the provider succeeds', async () => {
    const primaryCheck = vi.fn<RateLimiter['check']>().mockResolvedValue({
      ok: true,
      remaining: 4,
      resetMs: 1_000,
    });
    const fallbackCheck = vi.fn<RateLimiter['check']>();
    const rateLimiter = createFallbackRateLimiter({
      primary: limiter(primaryCheck),
      fallback: limiter(fallbackCheck),
    });

    await expect(rateLimiter.check('chat:user-1', { limit: 5, windowMs: 1_000 })).resolves.toEqual({
      ok: true,
      remaining: 4,
      resetMs: 1_000,
    });
    expect(fallbackCheck).not.toHaveBeenCalled();
  });

  it('uses the bounded fallback when the provider throws', async () => {
    const providerError = new Error('redis unavailable');
    const primaryCheck = vi.fn<RateLimiter['check']>().mockRejectedValue(providerError);
    const fallbackCheck = vi.fn<RateLimiter['check']>().mockResolvedValue({
      ok: false,
      retryAfterMs: 750,
    });
    const onFallback = vi.fn();
    const rateLimiter = createFallbackRateLimiter({
      primary: limiter(primaryCheck),
      fallback: limiter(fallbackCheck),
      onFallback,
    });

    await expect(rateLimiter.check('ticket:user-1', { limit: 1, windowMs: 1_000 })).resolves.toEqual({
      ok: false,
      retryAfterMs: 750,
    });
    expect(fallbackCheck).toHaveBeenCalledWith('ticket:user-1', { limit: 1, windowMs: 1_000 });
    expect(onFallback).toHaveBeenCalledWith({ key: 'ticket:user-1', error: providerError });
  });
});
