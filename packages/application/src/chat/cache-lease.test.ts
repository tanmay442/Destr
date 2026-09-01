import { describe, expect, it, vi } from 'vitest';
import type { AnswerCache } from '@app/domain';
import { createCacheLease, createLocalCacheLeaseCoordinator } from './cache-lease';

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

  it('returns unavailable instead of falling back in strict mode', async () => {
    const cache = cacheWithLease({
      tryAcquire: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    });
    const lease = createCacheLease(cache, 'strict-key', 60, { policy: 'strict' });
    expect(await lease.acquireResult()).toEqual({ kind: 'unavailable' });
    expect(lease.isOwned()).toBe(false);
    expect(await lease.acquire()).toBe(false);
  });

  it('keeps local capacity bounded without evicting active owners', async () => {
    const coordinator = createLocalCacheLeaseCoordinator({ maxLeases: 2 });
    const first = await coordinator.acquire('first', 60);
    const second = await coordinator.acquire('second', 60);
    expect(first.kind).toBe('acquired');
    expect(second.kind).toBe('acquired');
    expect(await coordinator.acquire('third', 60)).toEqual({ kind: 'unavailable' });
    expect(await coordinator.acquire('first', 60)).toEqual({ kind: 'held' });
    if (first.kind === 'acquired') await first.handle.release();
    if (second.kind === 'acquired') await second.handle.release();
    expect(coordinator.size()).toBe(0);
    coordinator.dispose();
  });

  it('requires explicit degraded mode for a process-local coordinator', async () => {
    const coordinator = createLocalCacheLeaseCoordinator();
    const cache: AnswerCache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      coordination: coordinator,
    };
    expect(await createCacheLease(cache, 'strict-local', 60, { policy: 'strict' }).acquireResult()).toEqual({ kind: 'unavailable' });
    const degraded = createCacheLease(cache, 'degraded-local', 60, { policy: 'degraded' });
    expect((await degraded.acquireResult()).kind).toBe('acquired');
    await degraded.release();
    coordinator.dispose();
  });
});
