// In-process LRU; resets on cold start and is per-deployment, so analytics are best-effort.
import type { QueryStats } from '@app/domain';

const MAX_USERS = 5_000;
const MAX_QUERIES_PER_USER = 1_000;

interface UserBucket { queries: Map<string, number>; lastTouched: number; }
const users = new Map<string, UserBucket>();

const globalCounts = new Map<string, number>();
let cachedTop: Array<{ q: string; count: number }> | null = null;
let cachedLimit = 0;

function decrementGlobal(query: string, amount: number) {
  const prev = globalCounts.get(query) ?? 0;
  const next = prev - amount;
  if (next <= 0) globalCounts.delete(query);
  else globalCounts.set(query, next);
}

function trimBucket(bucket: UserBucket) {
  if (bucket.queries.size <= MAX_QUERIES_PER_USER) return;
  const entries = Array.from(bucket.queries.entries()).sort((a, b) => a[1] - b[1]);
  const drop = entries.length - MAX_QUERIES_PER_USER;
  for (let i = 0; i < drop; i++) {
    const entry = entries[i];
    if (entry) {
      decrementGlobal(entry[0], entry[1]);
      bucket.queries.delete(entry[0]);
    }
  }
}

function evictIfNeeded() {
  if (users.size <= MAX_USERS) return;
  let oldestKey: string | null = null;
  let oldestTouched = Number.POSITIVE_INFINITY;
  for (const [k, b] of users) {
    if (b.lastTouched < oldestTouched) {
      oldestTouched = b.lastTouched;
      oldestKey = k;
    }
  }
  if (oldestKey) {
    const bucket = users.get(oldestKey)!;
    for (const [q, c] of bucket.queries) decrementGlobal(q, c);
    users.delete(oldestKey);
  }
}

export const inMemoryQueryStats: QueryStats = {
  async record(userId, query) {
    const text = query.trim().toLowerCase();
    if (!text) return;
    let bucket = users.get(userId);
    if (!bucket) {
      bucket = { queries: new Map(), lastTouched: Date.now() };
      users.set(userId, bucket);
    }
    bucket.lastTouched = Date.now();
    bucket.queries.set(text, (bucket.queries.get(text) ?? 0) + 1);
    globalCounts.set(text, (globalCounts.get(text) ?? 0) + 1);
    cachedTop = null;
    trimBucket(bucket);
    evictIfNeeded();
  },
  async top(limit) {
    if (cachedTop && cachedLimit === limit) return cachedTop;
    cachedTop = Array.from(globalCounts.entries())
      .map(([q, count]) => ({ q, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
    cachedLimit = limit;
    return cachedTop;
  },
};

function __resetQueryStatsForTests(): void {
  users.clear();
  globalCounts.clear();
  cachedTop = null;
  cachedLimit = 0;
}
