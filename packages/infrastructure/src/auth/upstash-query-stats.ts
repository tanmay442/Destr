import { Redis } from '@upstash/redis';
import type { QueryStats } from '@app/domain';

export function createUpstashQueryStats(): QueryStats {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set.');
  }
  const redis = new Redis({ url, token });
  const ZSET_KEY = 'query:global';
  const MAX_MEMBERS = 5_000;
  const TTL_SEC = 60 * 60 * 24 * 30;
  const userZset = (userId: string) => `query:user:${userId}`;

  return {
    async record(userId, query) {
      const text = query.trim().toLowerCase();
      if (!text) return;
      try {
        await redis.zincrby(ZSET_KEY, 1, text);
        await redis.zincrby(userZset(userId), 1, text);
        await redis.zremrangebyrank(ZSET_KEY, 0, -(MAX_MEMBERS + 1));
        await redis.expire(ZSET_KEY, TTL_SEC);
        await redis.expire(userZset(userId), TTL_SEC);
      } catch {
        // Best-effort analytics; never fail the request path.
      }
    },
    async top(limit) {
      const results = await redis.zrange<Array<{ member: string; score: number }>>(ZSET_KEY, 0, limit - 1, { rev: true, withScores: true });
      return results.map((r) => ({ q: String(r.member), count: Number(r.score) }));
    },
  };
}
