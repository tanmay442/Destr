import { Redis } from '@upstash/redis';
import type { AnswerCache } from '@app/domain';
import { registerAnswerCacheProvider } from './answer-cache-registry';

/**
 * Answer cache backed by Upstash Redis. Values are base64-wrapped to ensure
 * verbatim string round-tripping (Upstash auto-deserializes JSON on read).
 * Throws if Redis env vars are missing.
 */
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
  };
}

registerAnswerCacheProvider('upstash', createUpstashAnswerCache);
