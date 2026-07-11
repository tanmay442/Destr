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
      const ttlSeconds = Math.ceil(opts.windowMs / 1000);
      const redisKey = `ratelimit:${key}`;
      // Atomic incr + TTL: Lua keeps the count and expiry in one command,
      // so the key can never persist without a TTL (and we avoid the
      // fixed-window boundary double-count by anchoring the window to the
      // first request rather than a wall-clock id).
      const count = (await redis.eval(
        `local c = redis.call('incr', KEYS[1])
         if c == 1 then redis.call('expire', KEYS[1], ARGV[1]) end
         return c`,
        [redisKey],
        [ttlSeconds],
      )) as number;
      if (count > opts.limit) {
        return { ok: false, retryAfterMs: opts.windowMs };
      }
      return {
        ok: true,
        remaining: opts.limit - count,
        resetMs: opts.windowMs,
      };
    },
  };
}
