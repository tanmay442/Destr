import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUpstashRateLimiter } from './upstash-rate-limiter';

const createRedisMock = () => ({
  eval: vi.fn(),
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

  it('allows the first request and sets expiry via the atomic eval', async () => {
    redisMock.eval.mockResolvedValue(1);
    const limiter = createUpstashRateLimiter();
    const result = await limiter.check('user:1', { limit: 30, windowMs: 60_000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.remaining).toBe(29);
    expect(redisMock.eval).toHaveBeenCalledOnce();
  });

  it('rejects requests over the limit', async () => {
    redisMock.eval.mockResolvedValue(31);
    const limiter = createUpstashRateLimiter();
    const result = await limiter.check('user:1', { limit: 30, windowMs: 60_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
  });
});
