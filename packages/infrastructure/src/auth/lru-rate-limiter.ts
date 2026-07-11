// In-process sliding-window limiter; single-instance only (best-effort across replicas).
import type { RateLimiter } from '@app/domain';

const MAX_KEYS = 5_000;

interface Bucket { timestamps: number[]; lastTouched: number; }
const buckets = new Map<string, Bucket>();

function evictOldest() {
  // Map iterates in insertion order; the first key is the
  // least-recently-used. Stop once back at or below the cap.
  for (const k of buckets.keys()) {
    if (buckets.size <= MAX_KEYS) break;
    buckets.delete(k);
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
    // Re-insert to move the key to the most-recently-used position.
    buckets.set(key, bucket);

    if (buckets.size > MAX_KEYS) {
      evictOldest();
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
