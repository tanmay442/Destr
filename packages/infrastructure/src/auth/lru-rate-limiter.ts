// In-process sliding-window limiter; single-instance only (best-effort across replicas).
import type { RateLimiter } from '@app/domain';
import { rateLimiterRegistry, registerRateLimiterProvider } from './rate-limiter-registry';

const MAX_KEYS = 5_000;

interface Bucket { timestamps: number[]; }

export function createLruRateLimiter(): RateLimiter {
  const buckets = new Map<string, Bucket>();

  return {
    async check(key, opts) {
      const now = Date.now();
      const cutoff = now - opts.windowMs;
      const existing = buckets.get(key);
      if (existing) {
        // Re-set to keep insertion order (MRU at the end).
        buckets.delete(key);
        existing.timestamps = existing.timestamps.filter((t) => t > cutoff);
        buckets.set(key, existing);
      } else if (buckets.size >= MAX_KEYS) {
        // Never evict a live bucket to admit a new key: attacker keys would
        // wipe every victim's sliding window. Reclaim only expired buckets.
        let earliestLiveMs = Infinity;
        for (const [k, bucket] of buckets) {
          let firstLive = Infinity;
          for (const t of bucket.timestamps) {
            if (t > cutoff && t < firstLive) firstLive = t;
          }
          if (firstLive < Infinity) {
            if (firstLive < earliestLiveMs) earliestLiveMs = firstLive;
          } else {
            buckets.delete(k);
          }
        }
        if (buckets.size >= MAX_KEYS) {
          return {
            ok: false,
            retryAfterMs: Number.isFinite(earliestLiveMs)
              ? Math.max(0, earliestLiveMs + opts.windowMs - now)
              : opts.windowMs,
          };
        }
        buckets.set(key, { timestamps: [] });
      } else {
        buckets.set(key, { timestamps: [] });
      }

      const bucket = buckets.get(key)!;
      if (bucket.timestamps.length >= opts.limit) {
        const oldest = bucket.timestamps[0] ?? now;
        return { ok: false, retryAfterMs: Math.max(0, oldest + opts.windowMs - now) };
      }
      bucket.timestamps.push(now);
      return {
        ok: true,
        remaining: opts.limit - bucket.timestamps.length,
        resetMs: (bucket.timestamps[0] ?? now) + opts.windowMs - now,
      };
    },
  };
}

export const lruRateLimiter: RateLimiter = createLruRateLimiter();

registerRateLimiterProvider('lru', () => lruRateLimiter);

export function createRateLimiter(): RateLimiter {
  const provider = process.env.UPSTASH_REDIS_REST_URL ? 'upstash' : 'lru';
  const factory = rateLimiterRegistry.get(provider);
  if (!factory) throw new Error(`Unknown rate limiter provider: ${provider}`);
  return factory();
}
