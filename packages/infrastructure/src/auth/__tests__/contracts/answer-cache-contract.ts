import { describe, it, expect, vi } from 'vitest';
import type { AnswerCache } from '@app/domain';

/**
 * Shared contract assertions every AnswerCache implementation must satisfy.
 * TTL checks use fake timers with an explicit tolerance note: backends may
 * expire an entry anywhere between the configured TTL and the next read, so
 * the assertion only pins the expired state strictly after the TTL elapses.
 */
export function runAnswerCacheContract(makeCache: () => AnswerCache): void {
  describe('answer cache contract', () => {
    it('round-trips a value through set/get', async () => {
      const cache = makeCache();
      await cache.set('k1', 'hello world', 60);
      expect(await cache.get('k1')).toBe('hello world');
    });

    it('returns null for a missing key', async () => {
      const cache = makeCache();
      expect(await cache.get('missing')).toBeNull();
    });

    it('expires entries after the TTL (tolerance: expiry is enforced lazily)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const cache = makeCache();
      await cache.set('k-ttl', 'value', 1);
      expect(await cache.get('k-ttl')).toBe('value');
      vi.setSystemTime(10_000 + 1_001);
      expect(await cache.get('k-ttl')).toBeNull();
      vi.useRealTimers();
    });

    it('keeps distinct keys isolated', async () => {
      const cache = makeCache();
      await cache.set('a', 'value-a', 60);
      await cache.set('b', 'value-b', 60);
      expect(await cache.get('a')).toBe('value-a');
      expect(await cache.get('b')).toBe('value-b');
    });

    it('reports explicit ownership states through the coordination port', async () => {
      const cache = makeCache();
      const coordinator = cache.coordination;
      expect(coordinator).toBeDefined();
      if (!coordinator) return;

      const first = await coordinator.acquire('coordination-key', 60);
      expect(first.kind).toBe('acquired');
      if (first.kind !== 'acquired') return;

      expect((await coordinator.acquire('coordination-key', 60)).kind).toBe('held');
      expect((await coordinator.acquire('different-key', 60)).kind).toBe('acquired');
      expect((await first.handle.release()).kind).toBe('released');
      expect((await coordinator.acquire('coordination-key', 60)).kind).toBe('acquired');
    });

    it('renews only while the owner is still current', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(10_000);
        const cache = makeCache();
        const coordinator = cache.coordination;
        expect(coordinator).toBeDefined();
        if (!coordinator) return;

        const first = await coordinator.acquire('renew-key', 1);
        expect(first.kind).toBe('acquired');
        if (first.kind !== 'acquired') return;
        vi.advanceTimersByTime(800);
        expect((await first.handle.renew(1)).kind).toBe('renewed');
        vi.advanceTimersByTime(500);
        expect((await coordinator.acquire('renew-key', 1)).kind).toBe('held');
        expect((await first.handle.release()).kind).toBe('released');
      } finally {
        vi.useRealTimers();
      }
    });

    it('reclaims an expired lease before accepting a new owner', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(20_000);
        const cache = makeCache();
        const coordinator = cache.coordination;
        expect(coordinator).toBeDefined();
        if (!coordinator) return;

        expect((await coordinator.acquire('expired-key', 1)).kind).toBe('acquired');
        vi.advanceTimersByTime(1_001);
        expect((await coordinator.acquire('expired-key', 1)).kind).toBe('acquired');
      } finally {
        vi.useRealTimers();
      }
    });
  });
}
