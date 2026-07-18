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
  const userZset = (userId: string) => `query:user:${userId}`;

  return {
    async record(userId, query) {
      const text = query.trim().toLowerCase();
      if (!text) return;
      try {
        await redis.zincrby(ZSET_KEY, 1, text);
        await redis.zincrby(userZset(userId), 1, text);
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
