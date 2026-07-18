import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUpstashRateLimiter } from './upstash-rate-limiter';

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

describe('createUpstashRateLimiter', () => {
  beforeEach(() => {
    redisMock = createRedisMock();
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when env vars are missing', () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    expect(() => createUpstashRateLimiter()).toThrow('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set.');
  });

  it('allows requests under the limit and decrements remaining', async () => {
    redisMock.eval.mockResolvedValue([1, 29]);
    const limiter = createUpstashRateLimiter();
    const result = await limiter.check('user:1', { limit: 30, windowMs: 60_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.remaining).toBe(29);
    expect(redisMock.eval).toHaveBeenCalledOnce();
  });

  it('rejects requests over the limit and reports retryAfterMs', async () => {
    redisMock.eval.mockResolvedValue([0, 1_000]);
    const limiter = createUpstashRateLimiter();
    const result = await limiter.check('user:1', { limit: 30, windowMs: 60_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('uses a sliding window so old timestamps do not block new requests', async () => {
    const members = new Map<number, number>();
    let clock = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    redisMock.eval.mockImplementation(async (_lua: string, _keys: string[], args: number[]) => {
      const now = args[0] ?? 0;
      const windowMs = args[1] ?? 0;
      const limit = args[2] ?? 0;
      for (const ts of Array.from(members.keys())) {
        if (ts < now - windowMs) members.delete(ts);
      }
      if (members.size >= limit) {
        const oldest = Math.min(...members.keys());
        return [0, oldest];
      }
      members.set(now + members.size, 1);
      return [1, limit - members.size];
    });
    const limiter = createUpstashRateLimiter();
    for (let i = 0; i < 30; i++) {
      await limiter.check('user:1', { limit: 30, windowMs: 1_000 });
      clock += 1;
    }
    clock += 2_000;
    const next = await limiter.check('user:1', { limit: 30, windowMs: 1_000 });
    expect(next.ok).toBe(true);
  });
});
