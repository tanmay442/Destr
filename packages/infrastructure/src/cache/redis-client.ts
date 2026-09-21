import { Redis } from '@upstash/redis';

/**
 * Shared Redis client factory for the WP-8 retrieval cache layers (WP-9 wiring).
 *
 * Returns null when the Upstash credentials are absent so callers fall back
 * to bounded in-memory stores. Construction never connects; failures degrade
 * per call inside the cache adapters, never here.
 */
export interface CacheRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { readonly ex?: number | undefined }): Promise<unknown>;
}

export function createCacheRedisClient(env: NodeJS.ProcessEnv = process.env): CacheRedisClient | null {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    return new Redis({ url, token });
  } catch {
    return null;
  }
}
