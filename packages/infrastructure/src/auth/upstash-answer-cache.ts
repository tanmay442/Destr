import { Redis } from '@upstash/redis';
import { randomUUID } from 'node:crypto';
import type {
  AnswerCache,
  AnswerCacheLease,
  CacheLeaseCoordinator,
  LeaseAcquireResult,
  LeaseHandle,
  LeasePublishResult,
  LeaseReleaseResult,
  LeaseRenewResult,
} from '@app/domain';
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

export const ANSWER_CACHE_LEASE_RENEW_LUA = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('expire', KEYS[1], ARGV[2])
  end
  return 0
`;

export const ANSWER_CACHE_LEASE_PUBLISH_LUA = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3])
    return 1
  end
  return 0
`;

function leaseKey(key: string): string {
  return `rag:answer-lease:${key}`;
}

function ttlSecOrDefault(ttlSec: number): number {
  return Number.isFinite(ttlSec) && ttlSec > 0 ? Math.max(1, Math.ceil(ttlSec)) : 60;
}

function createRedisCoordinator(redis: Redis): CacheLeaseCoordinator {
  return {
    scope: 'distributed',
    async acquire(key, ttlSec): Promise<LeaseAcquireResult> {
      const token = randomUUID();
      try {
        const acquired = await redis.eval(
          ANSWER_CACHE_LEASE_ACQUIRE_LUA,
          [leaseKey(key)],
          [token, ttlSecOrDefault(ttlSec)],
        );
        if (typeof acquired !== 'string' || acquired !== token) return { kind: 'held' };
        let active = true;
        const handle: LeaseHandle = {
          renewalSupported: true,
          async renew(durationSec): Promise<LeaseRenewResult> {
            if (!active) return { kind: 'not-owner' };
            try {
              const renewed = await redis.eval(
                ANSWER_CACHE_LEASE_RENEW_LUA,
                [leaseKey(key)],
                [token, ttlSecOrDefault(durationSec)],
              );
              if (renewed === 1 || renewed === '1' || renewed === true) return { kind: 'renewed' };
              active = false;
              return { kind: 'not-owner' };
            } catch {
              return { kind: 'unavailable' };
            }
          },
          async publish(value, durationSec): Promise<LeasePublishResult> {
            if (!active) return { kind: 'not-owner' };
            try {
              const published = await redis.eval(
                ANSWER_CACHE_LEASE_PUBLISH_LUA,
                [leaseKey(key), key],
                [token, Buffer.from(value, 'utf8').toString('base64'), ttlSecOrDefault(durationSec)],
              );
              if (published === 1 || published === '1' || published === true) return { kind: 'published' };
              active = false;
              return { kind: 'not-owner' };
            } catch {
              return { kind: 'unavailable' };
            }
          },
          async release(): Promise<LeaseReleaseResult> {
            if (!active) return { kind: 'not-owner' };
            try {
              const released = await redis.eval(
                ANSWER_CACHE_LEASE_RELEASE_LUA,
                [leaseKey(key)],
                [token],
              );
              if (released === 1 || released === '1' || released === true) {
                active = false;
                return { kind: 'released' };
              }
              active = false;
              return { kind: 'not-owner' };
            } catch {
              // Keep the local handle active so a transient release failure can
              // be retried. The compare-and-delete Lua script prevents a stale
              // token from deleting a newer owner's lease.
              return { kind: 'unavailable' };
            }
          },
        };
        return { kind: 'acquired', handle };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}

function createLegacyLease(
  coordinator: CacheLeaseCoordinator,
): AnswerCacheLease {
  const handles = new Map<string, { handle: LeaseHandle; timer: ReturnType<typeof setTimeout> }>();
  const remove = (identity: string): void => {
    const entry = handles.get(identity);
    if (!entry) return;
    clearTimeout(entry.timer);
    handles.delete(identity);
  };
  return {
    async tryAcquire(key, ttlSec) {
      const result = await coordinator.acquire(key, ttlSec);
      if (result.kind !== 'acquired') return null;
      const token = randomUUID();
      const identity = `${key}\u0000${token}`;
      const timer = setTimeout(() => remove(identity), ttlSecOrDefault(ttlSec) * 1_000);
      const candidate: unknown = timer;
      if (
        typeof candidate === 'object' &&
        candidate !== null &&
        'unref' in candidate &&
        typeof candidate.unref === 'function'
      ) {
        candidate.unref();
      }
      handles.set(identity, { handle: result.handle, timer });
      return token;
    },
    async release(key, token) {
      const identity = `${key}\u0000${token}`;
      const entry = handles.get(identity);
      if (!entry) return;
      const result = await entry.handle.release();
      if (result.kind !== 'unavailable') remove(identity);
    },
  };
}

export function createUpstashAnswerCache(): AnswerCache {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set.');
  }
  const redis = new Redis({ url, token });
  const coordination = createRedisCoordinator(redis);

  return {
    coordination,
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
        await redis.set(key, Buffer.from(answer, 'utf8').toString('base64'), { ex: ttlSecOrDefault(ttlSec) });
      } catch {
        // Best-effort cache write; never fail the request path.
      }
    },
    // Compatibility for older consumers. New callers use `coordination`.
    lease: createLegacyLease(coordination),
  };
}

registerAnswerCacheProvider('upstash', createUpstashAnswerCache);
