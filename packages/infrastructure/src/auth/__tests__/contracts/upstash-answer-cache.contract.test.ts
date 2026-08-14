import { describe, vi, beforeEach } from 'vitest';
import { createUpstashAnswerCache } from '../../upstash-answer-cache';
import { runAnswerCacheContract } from './answer-cache-contract';

const redisGet = vi.hoisted(() => vi.fn());
const redisSet = vi.hoisted(() => vi.fn());

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { get: redisGet, set: redisSet };
  }),
}));

class RedisEmulator {
  private store = new Map<string, { value: string; expiresAt: number }>();

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
  });

  runAnswerCacheContract(createUpstashAnswerCache);
});
