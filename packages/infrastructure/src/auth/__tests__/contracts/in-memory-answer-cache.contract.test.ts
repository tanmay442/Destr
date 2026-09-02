import { describe, expect, it, vi } from 'vitest';
import { createInMemoryAnswerCache } from '../../in-memory-answer-cache';
import { runAnswerCacheContract } from './answer-cache-contract';

describe('in-memory answer cache contract', () => {
  runAnswerCacheContract(createInMemoryAnswerCache);

  it('does not allow a stale token to release a newer lease', async () => {
    const cache = createInMemoryAnswerCache();
    const firstToken = await cache.lease?.tryAcquire('same-key', 60);
    expect(firstToken).toEqual(expect.any(String));
    await cache.lease?.release('same-key', 'stale-token');
    expect(await cache.lease?.tryAcquire('same-key', 60)).toBeNull();
    await cache.lease?.release('same-key', firstToken!);
    expect(await cache.lease?.tryAcquire('same-key', 60)).toEqual(expect.any(String));
  });

  it('rejects the 257th active lease without evicting an earlier owner', async () => {
    const cache = createInMemoryAnswerCache();
    const coordinator = cache.coordination;
    expect(coordinator).toBeDefined();
    if (!coordinator || !('size' in coordinator) || !('dispose' in coordinator)) return;
    if (typeof coordinator.size !== 'function' || typeof coordinator.dispose !== 'function') return;

    const handles = [];
    for (let index = 0; index < 256; index += 1) {
      const result = await coordinator.acquire(`active-${index}`, 60);
      expect(result.kind).toBe('acquired');
      if (result.kind === 'acquired') handles.push(result.handle);
    }
    expect((await coordinator.acquire('active-256', 60)).kind).toBe('unavailable');
    expect((await coordinator.acquire('active-0', 60)).kind).toBe('held');
    expect(coordinator.size()).toBe(256);
    for (const handle of handles) await handle.release();
    expect(coordinator.size()).toBe(0);
    coordinator.dispose();
  });

  it('reclaims expired entries even when no new key arrives first', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const cache = createInMemoryAnswerCache();
      const coordinator = cache.coordination;
      expect(coordinator).toBeDefined();
      if (!coordinator || !('size' in coordinator) || !('dispose' in coordinator)) return;
      if (typeof coordinator.size !== 'function' || typeof coordinator.dispose !== 'function') return;
      const result = await coordinator.acquire('idle', 1);
      expect(result.kind).toBe('acquired');
      expect(coordinator.size()).toBe(1);
      vi.advanceTimersByTime(1_001);
      expect(coordinator.size()).toBe(0);
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renews an owned lease and rejects a stale release after reacquisition', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000);
      const cache = createInMemoryAnswerCache();
      const coordinator = cache.coordination;
      expect(coordinator).toBeDefined();
      if (!coordinator || !('dispose' in coordinator) || typeof coordinator.dispose !== 'function') return;
      const first = await coordinator.acquire('renew', 1);
      expect(first.kind).toBe('acquired');
      if (first.kind !== 'acquired') return;
      expect((await first.handle.renew(2)).kind).toBe('renewed');
      vi.advanceTimersByTime(1_500);
      expect((await coordinator.acquire('renew', 1)).kind).toBe('held');
      expect((await first.handle.release()).kind).toBe('released');
      const second = await coordinator.acquire('renew', 1);
      expect(second.kind).toBe('acquired');
      if (second.kind !== 'acquired') return;
      expect((await first.handle.release()).kind).toBe('not-owner');
      await second.handle.release();
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
