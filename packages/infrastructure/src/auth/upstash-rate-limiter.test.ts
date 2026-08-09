import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUpstashRateLimiter, RATE_LIMITER_LUA } from './upstash-rate-limiter';

const createRedisMock = () => ({
  eval: vi.fn(),
  pttl: vi.fn(),
});

let redisMock = createRedisMock();

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return redisMock;
  }),
}));

class RedisZsetEmulator {
  private sets = new Map<string, Map<string, number>>();
  private seqs = new Map<string, number>();

  eval(script: string, keys: string[], args: number[]): [number, number] {
    expect(script).toBe(RATE_LIMITER_LUA);
    const key = keys[0]!;
    const [now, windowMs, limit] = args as [number, number, number];
    const cutoff = now - windowMs;
    const members = this.sets.get(key) ?? new Map();
    for (const [member, score] of members) {
      if (score < cutoff) members.delete(member);
    }
    const count = members.size;
    if (count >= limit) {
      const oldest = Math.min(...members.values());
      return [0, oldest];
    }
    const seq = (this.seqs.get(key) ?? 0) + 1;
    this.seqs.set(key, seq);
    members.set(`${now}:${seq}`, now);
    this.sets.set(key, members);
    return [1, limit - count - 1];
  }
}

describe('createUpstashRateLimiter', () => {
  beforeEach(() => {
    redisMock = createRedisMock();
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('throws when env vars are missing', () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    expect(() => createUpstashRateLimiter()).toThrow('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set.');
  });

  it('sends the exported Lua fixture to Redis', async () => {
    redisMock.eval.mockResolvedValue([1, 29]);
    const limiter = createUpstashRateLimiter();
    await limiter.check('user:1', { limit: 30, windowMs: 60_000 });
    expect(redisMock.eval).toHaveBeenCalledWith(
      RATE_LIMITER_LUA,
      ['ratelimit:user:1'],
      [expect.any(Number), 60_000, 30],
    );
  });

  it('allows requests under the limit and decrements remaining', async () => {
    redisMock.eval.mockImplementation((script, keys, args) => new RedisZsetEmulator().eval(script, keys, args));
    const limiter = createUpstashRateLimiter();
    const result = await limiter.check('user:1', { limit: 30, windowMs: 60_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.remaining).toBe(29);
  });

  it('rejects requests over the limit and reports retryAfterMs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const emulator = new RedisZsetEmulator();
    redisMock.eval.mockImplementation((script, keys, args) => emulator.eval(script, keys, args));
    const limiter = createUpstashRateLimiter();
    for (let i = 0; i < 30; i++) {
      await limiter.check('user:1', { limit: 30, windowMs: 60_000 });
    }
    const result = await limiter.check('user:1', { limit: 30, windowMs: 60_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryAfterMs).toBe(60_000);
  });

  it('counts same-millisecond requests as distinct members', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const emulator = new RedisZsetEmulator();
    redisMock.eval.mockImplementation((script, keys, args) => emulator.eval(script, keys, args));
    const limiter = createUpstashRateLimiter();
    for (let i = 0; i < 30; i++) {
      const result = await limiter.check('user:1', { limit: 30, windowMs: 60_000 });
      expect(result.ok).toBe(true);
    }
    const result = await limiter.check('user:1', { limit: 30, windowMs: 60_000 });
    expect(result.ok).toBe(false);
  });

  it('handles string zset scores from Upstash without corrupting Retry-After (M2)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    redisMock.eval.mockResolvedValue([0, '10000']);
    const limiter = createUpstashRateLimiter();
    const result = await limiter.check('user:1', { limit: 30, windowMs: 60_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryAfterMs).toBe(60_000);
  });

  it('coerces string remaining counts in the allowed branch (M2)', async () => {
    redisMock.eval.mockResolvedValue([1, '29']);
    const limiter = createUpstashRateLimiter();
    const result = await limiter.check('user:1', { limit: 30, windowMs: 60_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.remaining).toBe(29);
  });

  it('uses a sliding window so old timestamps do not block new requests', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const emulator = new RedisZsetEmulator();
    redisMock.eval.mockImplementation((script, keys, args) => emulator.eval(script, keys, args));
    const limiter = createUpstashRateLimiter();
    for (let i = 0; i < 30; i++) {
      const result = await limiter.check('user:1', { limit: 30, windowMs: 1_000 });
      expect(result.ok).toBe(true);
      vi.setSystemTime(10_000 + i + 1);
    }
    vi.setSystemTime(10_000 + 30 + 2_000);
    const next = await limiter.check('user:1', { limit: 30, windowMs: 1_000 });
    expect(next.ok).toBe(true);
  });
});
