import { Redis } from '@upstash/redis';
import { randomUUID } from 'node:crypto';
import type { AnswerCache } from '@app/domain';
import { registerAnswerCacheProvider } from './answer-cache-registry';

/**
 * Answer cache backed by Upstash Redis. Values are base64-wrapped to ensure
 * verbatim string round-tripping (Upstash auto-deserializes JSON on read).
 * Throws if Redis env vars are missing.
 */
export const ANSWER_CACHE_LEASE_ACQUIRE_LUA = `
  return redis.call('set', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) and ARGV[1] or nil
`;

export const ANSWER_CACHE_LEASE_RELEASE_LUA = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`;

export function createUpstashAnswerCache(): AnswerCache {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set.');
  }
  const redis = new Redis({ url, token });

  return {
    async get(key) {
      try {
        const wrapped = await redis.get<string>(key);
        if (wrapped == null) return null;
        return Buffer.from(wrapped, 'base64').toString('utf8');
      } catch {
        // A cache read failure must never break the request path.
        return null;
      }
    },
    async set(key, answer, ttlSec) {
      try {
        await redis.set(key, Buffer.from(answer, 'utf8').toString('base64'), { ex: ttlSec });
      } catch {
        // Best-effort cache write; never fail the request path.
      }
    },
    lease: {
      async tryAcquire(key, ttlSec) {
        const tokenValue = randomUUID();
        const acquired = await redis.eval(
          ANSWER_CACHE_LEASE_ACQUIRE_LUA,
          [`rag:answer-lease:${key}`],
          [tokenValue, Math.max(1, Math.ceil(ttlSec))],
        );
        return acquired === tokenValue ? tokenValue : null;
      },
      async release(key, tokenValue) {
        try {
          await redis.eval(
            ANSWER_CACHE_LEASE_RELEASE_LUA,
            [`rag:answer-lease:${key}`],
            [tokenValue],
          );
        } catch {
        }
      },
    },
  };
}

registerAnswerCacheProvider('upstash', createUpstashAnswerCache);
