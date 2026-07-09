// Upstash Redis fixed-window limiter; falls back to in-memory when
// UPSTASH_REDIS_REST_URL is unset (factory in src/composition.ts).
import { Redis } from '@upstash/redis';
import type { RateLimiter } from '@app/domain';

export function createUpstashRateLimiter(): RateLimiter {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set.');
  }
  const redis = new Redis({ url, token });

  return {
    async check(key, opts) {
      const now = Date.now();
      const windowId = Math.floor(now / opts.windowMs);
      const redisKey = `ratelimit:${key}:${windowId}`;
      const count = await redis.incr(redisKey);
      if (count === 1) {
        await redis.expire(redisKey, Math.ceil(opts.windowMs / 1000) + 1);
      }
      const resetMs = (windowId + 1) * opts.windowMs - now;
      if (count > opts.limit) {
        return { ok: false, retryAfterMs: Math.max(0, resetMs) };
      }
      return {
        ok: true,
        remaining: opts.limit - count,
        resetMs: Math.max(0, resetMs),
      };
    },
  };
}
