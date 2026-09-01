import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createUpstashAnswerCache } from '../../upstash-answer-cache';
import { runAnswerCacheContract } from './answer-cache-contract';

const redisGet = vi.hoisted(() => vi.fn());
const redisSet = vi.hoisted(() => vi.fn());
const redisEval = vi.hoisted(() => vi.fn());

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { get: redisGet, set: redisSet, eval: redisEval };
  }),
}));

class RedisEmulator {
  private store = new Map<string, { value: string; expiresAt: number }>();
  private leases = new Map<string, { token: string; expiresAt: number }>();

  get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(null);
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }

  set(key: string, value: string, opts: { ex: number }): Promise<'OK'> {
    this.store.set(key, { value, expiresAt: Date.now() + opts.ex * 1000 });
    return Promise.resolve('OK');
  }

  eval(script: string, keys: string[], args: unknown[]): string | null {
    const key = keys[0]!;
    const currentTime = Date.now();
    const existing = this.leases.get(key);
    if (existing && existing.expiresAt <= currentTime) this.leases.delete(key);
    if (script.includes("'NX'")) {
      if (this.leases.has(key)) return null;
      const token = String(args[0]);
      this.leases.set(key, { token, expiresAt: currentTime + Number(args[1]) * 1_000 });
      return token;
    }
    if (script.includes("'expire'")) {
      if (this.leases.get(key)?.token !== String(args[0])) return '0';
      const current = this.leases.get(key);
      if (!current) return '0';
      current.expiresAt = currentTime + Number(args[1]) * 1_000;
      return '1';
    }
    if (keys.length === 2) {
      if (this.leases.get(key)?.token !== String(args[0])) return '0';
      this.store.set(keys[1]!, {
        value: String(args[1]),
        expiresAt: currentTime + Number(args[2]) * 1_000,
      });
      return '1';
    }
    if (this.leases.get(key)?.token === String(args[0])) {
      this.leases.delete(key);
      return '1';
    }
    return '0';
  }
}

describe('upstash answer cache contract', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'token');
    const emulator = new RedisEmulator();
    redisGet.mockImplementation((key: string) => emulator.get(key));
    redisSet.mockImplementation((key: string, value: string, opts: { ex: number }) =>
      emulator.set(key, value, opts),
    );
    redisEval.mockImplementation((script: string, keys: string[], args: unknown[]) =>
      emulator.eval(script, keys, args),
    );
  });

  runAnswerCacheContract(createUpstashAnswerCache);

  it('uses an owned distributed lease and rejects stale releases', async () => {
    const cache = createUpstashAnswerCache();
    const firstToken = await cache.lease?.tryAcquire('same-key', 60);
    const secondToken = await cache.lease?.tryAcquire('same-key', 60);

    expect(firstToken).toEqual(expect.any(String));
    expect(secondToken).toBeNull();
    await cache.lease?.release('same-key', 'stale-token');
    expect(await cache.lease?.tryAcquire('same-key', 60)).toBeNull();
    await cache.lease?.release('same-key', firstToken!);
    expect(await cache.lease?.tryAcquire('same-key', 60)).toEqual(expect.any(String));
  });

  it('returns unavailable when Redis cannot acquire a lease', async () => {
    redisEval.mockRejectedValueOnce(new Error('redis unavailable'));
    const cache = createUpstashAnswerCache();
    expect(cache.coordination).toBeDefined();
    if (!cache.coordination) return;
    expect(await cache.coordination.acquire('unavailable', 60)).toEqual({ kind: 'unavailable' });
  });

  it('does not report another owner released when Redis release fails', async () => {
    const cache = createUpstashAnswerCache();
    expect(cache.coordination).toBeDefined();
    if (!cache.coordination) return;
    const first = await cache.coordination.acquire('release-failure', 60);
    expect(first.kind).toBe('acquired');
    if (first.kind !== 'acquired') return;
    redisEval.mockRejectedValueOnce(new Error('redis unavailable'));
    expect(await first.handle.release()).toEqual({ kind: 'unavailable' });
    expect((await cache.coordination.acquire('release-failure', 60)).kind).toBe('held');
    expect(await first.handle.release()).toEqual({ kind: 'released' });
    expect((await cache.coordination.acquire('release-failure', 60)).kind).toBe('acquired');
  });

  it('renews only for the current owner', async () => {
    const cache = createUpstashAnswerCache();
    expect(cache.coordination).toBeDefined();
    if (!cache.coordination) return;
    const first = await cache.coordination.acquire('renew', 1);
    expect(first.kind).toBe('acquired');
    if (first.kind !== 'acquired') return;
    expect(await first.handle.renew(60)).toEqual({ kind: 'renewed' });
    await first.handle.release();
    const second = await cache.coordination.acquire('renew', 60);
    expect(second.kind).toBe('acquired');
    if (second.kind !== 'acquired') return;
    expect(await first.handle.renew(60)).toEqual({ kind: 'not-owner' });
    await second.handle.release();
  });

  it('atomically fences publication after the lease expires', async () => {
    vi.useFakeTimers();
    try {
      const cache = createUpstashAnswerCache();
      const first = await cache.coordination!.acquire('fenced', 1);
      expect(first.kind).toBe('acquired');
      if (first.kind !== 'acquired' || !first.handle.publish) return;
      expect(await first.handle.publish('first', 60)).toEqual({ kind: 'published' });
      expect(await cache.get('fenced')).toBe('first');

      await vi.advanceTimersByTimeAsync(1_001);
      const second = await cache.coordination!.acquire('fenced', 60);
      expect(second.kind).toBe('acquired');
      expect(await first.handle.publish('stale', 60)).toEqual({ kind: 'not-owner' });
      expect(await cache.get('fenced')).toBe('first');
      if (second.kind === 'acquired') await second.handle.release();
    } finally {
      vi.useRealTimers();
    }
  });
});
