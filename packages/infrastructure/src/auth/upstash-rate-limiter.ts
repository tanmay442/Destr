import { Redis } from '@upstash/redis';
import type { RateLimiter } from '@app/domain';

export function createUpstashRateLimiter(): RateLimiter {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set.');
  }
  const redis = new Redis({ url, token });

  const lua = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local window = tonumber(ARGV[2])
    local limit = tonumber(ARGV[3])
    local cutoff = now - window
    redis.call('zremrangebyscore', key, '-inf', cutoff)
    local count = redis.call('zcard', key)
    if count >= limit then
      local oldest = redis.call('zrange', key, 0, 0, 'WITHSCORES')[2]
      return {0, oldest}
    end
    redis.call('zadd', key, now, now)
    redis.call('pexpire', key, window)
    return {1, limit - count - 1}
  `;

  return {
    async check(key, opts) {
      const redisKey = `ratelimit:${key}`;
      const now = Date.now();
      const windowMs = opts.windowMs;
      const [ok, second] = (await redis.eval(
        lua,
        [redisKey],
        [now, windowMs, opts.limit],
      )) as [number, number];
      if (ok === 1) {
        return { ok: true, remaining: Math.max(0, second), resetMs: windowMs };
      }
      const oldest = second || now;
      return { ok: false, retryAfterMs: Math.max(0, oldest + windowMs - now) };
    },
  };
}
