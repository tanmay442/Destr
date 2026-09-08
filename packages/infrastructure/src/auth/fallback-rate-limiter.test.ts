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
    expect(fallbackCheck).toHaveBeenCalledWith('ticket:user-1', { limit: 1, windowMs: 1_000 }, undefined);
    expect(onFallback).toHaveBeenCalledWith({ key: 'ticket:user-1', error: providerError });
  });

  it('forwards the signal and never falls back on cancellation', async () => {
    let primarySignal: AbortSignal | undefined;
    const primaryCheck = vi.fn<RateLimiter['check']>(async (_key, _opts, signal) => {
      primarySignal = signal;
      throw new DOMException('Rate limit check was cancelled.', 'AbortError');
    });
    const fallbackCheck = vi.fn<RateLimiter['check']>().mockResolvedValue({ ok: true, remaining: 1, resetMs: 1000 });
    const onFallback = vi.fn();
    const rateLimiter = createFallbackRateLimiter({
      primary: limiter(primaryCheck),
      fallback: limiter(fallbackCheck),
      onFallback,
    });
    const controller = new AbortController();
    await expect(rateLimiter.check('ticket:user-1', { limit: 1, windowMs: 1000 }, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(primarySignal).toBe(controller.signal);
    expect(fallbackCheck).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('fences a primary result that arrives after cancellation', async () => {
    const controller = new AbortController();
    let releasePrimary!: () => void;
    const primaryCheck = vi.fn<RateLimiter['check']>(() => new Promise((resolve) => {
      releasePrimary = () => resolve({ ok: true, remaining: 1, resetMs: 1_000 });
    }));
    const fallbackCheck = vi.fn<RateLimiter['check']>().mockResolvedValue({ ok: true, remaining: 1, resetMs: 1_000 });
    const rateLimiter = createFallbackRateLimiter({
      primary: limiter(primaryCheck),
      fallback: limiter(fallbackCheck),
    });
    const pending = rateLimiter.check('chat:user-1', { limit: 1, windowMs: 1_000 }, controller.signal);
    controller.abort();
    releasePrimary();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fallbackCheck).not.toHaveBeenCalled();
  });

  it('throws immediately when already aborted without calling adapters', async () => {
    const primaryCheck = vi.fn<RateLimiter['check']>();
    const fallbackCheck = vi.fn<RateLimiter['check']>();
    const rateLimiter = createFallbackRateLimiter({
      primary: limiter(primaryCheck),
      fallback: limiter(fallbackCheck),
    });
    const controller = new AbortController();
    controller.abort();
    await expect(rateLimiter.check('k', { limit: 1, windowMs: 1000 }, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(primaryCheck).not.toHaveBeenCalled();
    expect(fallbackCheck).not.toHaveBeenCalled();
  });
});
