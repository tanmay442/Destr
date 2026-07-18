import { Redis } from '@upstash/redis';
import type { AnswerCache } from '@app/domain';

/**
 * Answer cache backed by the same Upstash Redis used for rate-limiting and query
 * stats — no second connection. Keys are opaque strings supplied by the caller
 * (which already pins the query + model ids). Values are the final answer text.
 *
 * Throws if `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are missing,
 * matching the other Upstash adapters; callers should fall back to an
 * in-memory cache when Redis is unavailable.
 *
 * Values are base64-wrapped before storage because the Upstash client
 * auto-deserializes JSON on read: an answer beginning with `{`, `[`, `"`, or a
 * number/`true`/`false`/`null` would otherwise be returned as a parsed value
 * instead of the original text (and `set` would re-serialize on write). The
 * `raw:` wrapper forces verbatim string round-tripping so this adapter behaves
 * identically to the in-memory adapter.
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
