import { describe, expect, it, vi } from 'vitest';
import type { AnswerCache } from '@app/domain';
import { createCacheLease } from './cache-lease';

function cacheWithLease(overrides: Partial<NonNullable<AnswerCache['lease']>>): AnswerCache {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    lease: {
      tryAcquire: vi.fn().mockResolvedValue('token'),
      release: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  };
}

describe('createCacheLease', () => {
  it('releases only the token it acquired', async () => {
    const cache = cacheWithLease({});
    const lease = createCacheLease(cache, 'answer-key', 60);

    expect(await lease.acquire()).toBe(true);
    await lease.release();
    await lease.release();
    expect(cache.lease?.release).toHaveBeenCalledOnce();
    expect(cache.lease?.release).toHaveBeenCalledWith('answer-key', 'token');
  });

  it('uses a bounded local lease when the distributed provider fails', async () => {
    const cache = cacheWithLease({
      tryAcquire: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    });
    const first = createCacheLease(cache, 'answer-key', 60);
    const second = createCacheLease(cache, 'answer-key', 60);

    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    await first.release();
    expect(await second.acquire()).toBe(true);
  });
});
