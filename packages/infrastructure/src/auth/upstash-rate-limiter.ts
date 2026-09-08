import { Redis } from '@upstash/redis';
import type { RateLimiter } from '@app/domain';
import { registerRateLimiterProvider } from './rate-limiter-registry';

export const RATE_LIMITER_LUA = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])
  local seqKey = key .. ':seq'
  redis.call('zremrangebyscore', key, '-inf', now - window)
  local count = redis.call('zcard', key)
  if count >= limit then
    local oldest = redis.call('zrange', key, 0, 0, 'WITHSCORES')[2]
    return {0, oldest}
  end
  local seq = redis.call('incr', seqKey)
  redis.call('pexpire', seqKey, window)
  redis.call('zadd', key, now, now .. ':' .. seq)
  redis.call('pexpire', key, window)
  return {1, limit - count - 1}
`;

export function createUpstashRateLimiter(): RateLimiter {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set.');
  }
  const redis = new Redis({ url, token });

  return {
    async check(key, opts, signal) {
      if (signal?.aborted) throw new DOMException('Rate limit check was cancelled.', 'AbortError');
      const redisKey = `ratelimit:${key}`;
      const now = Date.now();
      const windowMs = opts.windowMs;
      // Upstash Redis v1.38 eval has no per-call AbortSignal slot; the
      // client-level signal is static at construction. The Lua script is
      // atomic and may still apply server-side after the caller stops
      // waiting. Cancellation only stops local waiting and must prevent all
      // downstream identity and ticket work.
      const evalPromise = redis.eval(
        RATE_LIMITER_LUA,
        [redisKey],
        [now, windowMs, opts.limit],
      ) as Promise<[unknown, unknown]>;
      let abortListener: (() => void) | undefined;
      const abortPromise = signal
        ? new Promise<never>((_, reject) => {
            if (signal.aborted) {
              reject(new DOMException('Rate limit check was cancelled.', 'AbortError'));
              return;
            }
            abortListener = (): void => {
              reject(new DOMException('Rate limit check was cancelled.', 'AbortError'));
            };
            signal.addEventListener('abort', abortListener, { once: true });
          })
        : null;
      try {
        const [rawOk, rawSecond] = abortPromise
          ? await Promise.race([evalPromise, abortPromise])
          : await evalPromise;
        if (signal?.aborted) throw new DOMException('Rate limit check was cancelled.', 'AbortError');
        // Upstash may surface integer zset values as strings; coerce before comparing.
        const ok = Number(rawOk);
        const second = Number(rawSecond);
        if (ok === 1) {
          return { ok: true, remaining: Math.max(0, second), resetMs: windowMs };
        }
        const oldest = second || now;
        return { ok: false, retryAfterMs: Math.max(0, oldest + windowMs - now) };
      } catch (error) {
        evalPromise.then(() => undefined, () => undefined);
        if (signal?.aborted) throw new DOMException('Rate limit check was cancelled.', 'AbortError');
        throw error;
      } finally {
        if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      }
    },
  };
}

registerRateLimiterProvider('upstash', createUpstashRateLimiter);
