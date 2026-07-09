// In-process sliding-window limiter. Single instance only; a soft cap
// when multiple instances run concurrently.
import type { RateLimiter } from '@app/domain';

const MAX_KEYS = 5_000;
const EVICT_BATCH = 500;

interface Bucket { timestamps: number[]; lastTouched: number; }
const buckets = new Map<string, Bucket>();
let evictionCounter = 0;

function evictStale(now: number, windowMs: number) {
  const evictThreshold = now - windowMs;
  let evicted = 0;
  for (const [k, b] of buckets) {
    if (evicted >= EVICT_BATCH) break;
    if (b.lastTouched < evictThreshold) {
      buckets.delete(k);
      evicted++;
    }
  }
}

export const lruRateLimiter: RateLimiter = {
  async check(key, opts) {
    const now = Date.now();
    const cutoff = now - opts.windowMs;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [], lastTouched: now };
      buckets.set(key, bucket);
    }
    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
    bucket.lastTouched = now;

    // Periodic eviction: every 100 checks, evict stale entries
    if (buckets.size > MAX_KEYS && ++evictionCounter % 100 === 0) {
      evictStale(now, opts.windowMs);
    }

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

function __resetRateLimitForTests(): void {
  buckets.clear();
  evictionCounter = 0;
}
